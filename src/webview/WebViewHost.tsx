/**
 * WebViewHost — the persistent layer that owns every WebView instance (spec
 * Tier 3). Because a WKWebView cannot be reparented across screen trees,
 * instances live here (above the expo-router `<Stack>`, outside its screens)
 * instead of on a pushed route. The host renders the always-mounted root
 * portal plus a **custom sub-page stack** it animates itself: `pushSub` slides
 * a new instance in from the right (Reanimated) and a full-screen `Gesture.Pan`
 * drives swipe-back to pop it — replacing the old expo-router native-stack
 * `/webview` screen.
 *
 * It also owns the launch connectivity gate (moved out of `app/index.tsx`) and
 * registers itself as the orchestrator's {@link StackNavigator}, so the debug
 * controller's `restoreSession` (popToRoot + push loop) keeps working unchanged.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Dimensions,
  Linking,
  Platform,
  StyleSheet,
  ToastAndroid,
  useColorScheme,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import WebViewInstance from '../components/WebViewInstance';
import { isConnected } from '../native/network';
import { getInitialNavPath } from '../push/messaging';
import { backgroundColorFor } from '../theme';
import { PORTAL_HOST, ROOT_URL, STRINGS } from './constants';
import { useWebViewController, useWebViewRegistry } from './WebViewContext';

const SCREEN_WIDTH = Dimensions.get('window').width;
/** Fraction of the screen a swipe must cross (or fling) to commit the pop. */
const POP_DISTANCE = SCREEN_WIDTH * 0.33;
const POP_VELOCITY = 800;

// Tier 3 warm pool tuning. No numeric guidance in the design doc — these are
// starting defaults; adjust from the Phase 5 warm-hit-vs-cold measurements.
/** Idle delay after the shell signals interactive before booting the warm slot. */
const WARM_LAZY_DELAY_MS = 1500;
/** How long an un-adopted warm slot survives before eviction (memory reclaim). */
const WARM_TTL_MS = 60_000;

type GateStatus = 'checking' | 'offline' | 'online';
type SubEntry = {
  key: string;
  url: string;
  path: string;
  /** Set only for a promoted (ex-warm) entry — see WebViewInstance's `active` prop. */
  active?: boolean;
};
/** A parked warm instance: booted at `url` (the shell), SPA-routed to `path`. */
type WarmSlot = { key: string; url: string; path: string; alive: boolean };
type SubLayerHandle = { close: () => void };

/** True when `url` points at the portal host and is therefore safe to host. */
function isPortalUrl(url: string): boolean {
  try {
    return new URL(url).host === PORTAL_HOST;
  } catch {
    return false;
  }
}

/**
 * One animated sub-page layer. Owns its own slide transform so a host-driven
 * `close()` (back button / `goBack` / restoreSession) and an interactive
 * swipe-back share the same animation and never jump. Removal is deferred until
 * the layer has slid fully off-screen, via `onRemoved`.
 */
const SubLayer = forwardRef<SubLayerHandle, {
  isTop: boolean;
  /**
   * false keeps the layer parked off-screen and non-interactive (a warm
   * slot); true slides it in. Firing on a `revealed` transition rather than
   * on mount lets the same already-booted instance (same `key`, never
   * remounted) later animate in when adopted — see `pushSub`'s promotion path.
   */
  revealed: boolean;
  onRemoved: () => void;
  children: ReactNode;
}>(function SubLayer({ isTop, revealed, onRemoved, children }, ref) {
  const tx = useSharedValue(SCREEN_WIDTH);
  const startX = useSharedValue(0);

  // (`.set`/`.get` is the React-Compiler-safe shared-value API — plain
  // `.value =` trips react-hooks/immutability.)
  useEffect(() => {
    if (revealed) tx.set(withTiming(0, { duration: 280 }));
  }, [revealed, tx]);

  const close = useCallback(() => {
    tx.set(
      withTiming(SCREEN_WIDTH, { duration: 220 }, (finished) => {
        if (finished) runOnJS(onRemoved)();
      }),
    );
  }, [onRemoved, tx]);

  useImperativeHandle(ref, () => ({ close }), [close]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isTop)
        // Only claim clearly-horizontal drags so vertical scroll still reaches
        // the WebView; fail fast on vertical movement.
        .activeOffsetX(12)
        .failOffsetY([-16, 16])
        .onBegin(() => {
          startX.set(tx.get());
        })
        .onUpdate((e) => {
          const next = startX.get() + e.translationX;
          tx.set(next < 0 ? 0 : next);
        })
        .onEnd((e) => {
          if (tx.get() > POP_DISTANCE || e.velocityX > POP_VELOCITY) {
            tx.set(
              withTiming(SCREEN_WIDTH, { duration: 180 }, (finished) => {
                if (finished) runOnJS(onRemoved)();
              }),
            );
          } else {
            tx.set(withSpring(0, { damping: 22, stiffness: 220 }));
          }
        }),
    [isTop, onRemoved, startX, tx],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[styles.layer, animatedStyle]}
        // Covered layers must not receive touches through the top one.
        pointerEvents={isTop ? 'auto' : 'none'}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
});

/**
 * Android hardware-back handler. Split into its own component so it can read the
 * reactive controller without re-rendering the heavy WebView instance tree.
 */
function HostBackHandler({ hasSubs }: { hasSubs: boolean }) {
  const controller = useWebViewController();
  const lastBackRef = useRef(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const active = controller.getActive();
      // Sub-page open, or the active WebView still has SPA history: walk its
      // history first, then pop the native layer (goBackActive does both).
      if (hasSubs || active?.canGoBack) {
        controller.goBackActive();
        return true;
      }
      // Root with no history: press-back-twice to exit.
      const now = Date.now();
      if (now - lastBackRef.current < 2000) {
        BackHandler.exitApp();
        return true;
      }
      lastBackRef.current = now;
      ToastAndroid.show('뒤로 가기를 한 번 더 누르면 종료됩니다.', ToastAndroid.SHORT);
      return true;
    });
    return () => sub.remove();
  }, [controller, hasSubs]);

  return null;
}

export default function WebViewHost() {
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);
  const registry = useWebViewRegistry();

  const [status, setStatus] = useState<GateStatus>('checking');
  const [initialNavPath, setInitialNavPath] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubEntry[]>([]);
  const [warm, setWarm] = useState<WarmSlot | null>(null);
  // `goHome` drives root's own SPA via the same targetPath/pendingTargetRef
  // mechanism the warm pool uses to pre-navigate a parked instance — root is
  // always already loaded, so it takes effect immediately.
  const [rootTargetPath, setRootTargetPath] = useState<string | undefined>(undefined);

  // Mirror the live stack into refs so the stable navigator actions read fresh
  // values without re-creating themselves.
  const subsRef = useRef<SubEntry[]>(subs);
  useEffect(() => {
    subsRef.current = subs;
  }, [subs]);
  const warmRef = useRef<WarmSlot | null>(warm);
  useEffect(() => {
    warmRef.current = warm;
  }, [warm]);
  const layersRef = useRef(new Map<string, SubLayerHandle>());
  const seqRef = useRef(0);
  const warmSeqRef = useRef(0);
  const rootBootedRef = useRef(false);
  const lazyWarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmTtlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Launch gate (moved from app/index.tsx) --------------------------------
  // Function declaration (hoisted) so the retry action can recurse into it.
  // React Compiler is enabled, so no manual memoization is needed.
  async function check() {
    setStatus('checking');
    if (await isConnected()) {
      setStatus('online');
      return;
    }
    setStatus('offline');
    Alert.alert(STRINGS.network.title, STRINGS.network.message, [
      { text: STRINGS.network.retry, onPress: () => void check() },
      Platform.OS === 'ios'
        ? { text: STRINGS.network.exit, style: 'destructive' }
        : { text: STRINGS.network.close, style: 'cancel', onPress: () => BackHandler.exitApp() },
    ]);
  }

  useEffect(() => {
    void getInitialNavPath().then(setInitialNavPath);
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Tier 3 warm pool: 1 slot, lazy-warmed, TTL-evicted ---------------------
  const clearWarmTtl = useCallback(() => {
    if (warmTtlTimerRef.current) {
      clearTimeout(warmTtlTimerRef.current);
      warmTtlTimerRef.current = null;
    }
  }, []);

  const scheduleWarmTtl = useCallback(() => {
    clearWarmTtl();
    warmTtlTimerRef.current = setTimeout(() => {
      // Unused long enough — reclaim the WebContent process; re-warms lazily
      // on the next prewarm intent.
      setWarm(null);
    }, WARM_TTL_MS);
  }, [clearWarmTtl]);

  // Boots a fresh warm slot at the shared shell URL (same origin/bundle as
  // root — any portal URL triggers the same JS boot) and SPA-navigates it to
  // `initialTargetPath` once loaded. A still-alive slot is left untouched.
  const spawnWarm = useCallback((initialTargetPath?: string) => {
    if (warmRef.current?.alive) return;
    const key = `warm-${++warmSeqRef.current}`;
    setWarm({ key, url: ROOT_URL, path: initialTargetPath ?? '/', alive: true });
    scheduleWarmTtl();
  }, [scheduleWarmTtl]);

  const markWarmDead = useCallback(() => {
    setWarm((w) => (w ? { ...w, alive: false } : w));
  }, []);

  // Root's `prewarm` (touchstart intent). The payload's `url` is always
  // same-origin as ROOT_URL in this app (the web computes it as
  // `${location.origin}${path}`), so warming always reuses the already-booted
  // shell and SPA-navigates by path — there is no cross-origin reload path to
  // handle here.
  const handlePrewarm = useCallback((_url: string, path: string) => {
    if (warmRef.current?.alive) {
      setWarm((w) => (w ? { ...w, path } : w)); // latest intent overrides
      scheduleWarmTtl();
    } else {
      spawnWarm(path);
    }
  }, [spawnWarm, scheduleWarmTtl]);

  // Lazy warm: once root's shell signals interactive (first routeChange),
  // boot the warm slot after an idle delay at a neutral route.
  const handleRootRouteChange = useCallback(() => {
    if (rootBootedRef.current) return;
    rootBootedRef.current = true;
    lazyWarmTimerRef.current = setTimeout(() => spawnWarm(), WARM_LAZY_DELAY_MS);
  }, [spawnWarm]);

  useEffect(() => {
    return () => {
      if (lazyWarmTimerRef.current) clearTimeout(lazyWarmTimerRef.current);
      clearWarmTtl();
    };
  }, [clearWarmTtl]);

  // --- Custom sub-stack navigation -------------------------------------------
  const removeSub = useCallback((key: string) => {
    layersRef.current.delete(key);
    setSubs((prev) => prev.filter((s) => s.key !== key));
  }, []);

  const pushSub = useCallback((url: string, path: string) => {
    // Defence in depth: navigateTo should only pass portal URLs; anything else
    // is handed to the system browser (matches the old webview.tsx guard).
    if (!isPortalUrl(url)) {
      if (url) Linking.openURL(url).catch(() => {});
      return;
    }

    // Adopt-on-navigateTo: promote a matching, alive warm slot instead of
    // cold-loading. Same `key` moves from `warm` into `subs` in this one
    // batched update, so React reconciles it as the same still-mounted
    // instance (no remount, no JS re-boot) — see SubLayer's `revealed` prop.
    const w = warmRef.current;
    if (w?.alive && w.path === path) {
      clearWarmTtl();
      setSubs((prev) => [...prev, { key: w.key, url: w.url, path: w.path, active: true }]);
      setWarm(null);
      // `setWarm` is async — it won't update `warmRef.current` until the
      // mirroring effect commits, which hasn't happened yet at this point in
      // the same synchronous call. Assign it directly so the very next line's
      // `spawnWarm()` sees a cleared ref instead of bailing on the stale
      // (still-`alive`) warm object we just adopted — without this, every
      // adopt would silently skip re-warming the next slot.
      warmRef.current = null;
      spawnWarm(); // re-warm a fresh slot for the next +1
      return;
    }

    const key = `sub-${++seqRef.current}`;
    setSubs((prev) => [...prev, { key, url, path }]);
  }, [clearWarmTtl, spawnWarm]);

  const pop = useCallback(() => {
    const top = subsRef.current[subsRef.current.length - 1];
    if (top) layersRef.current.get(top.key)?.close();
  }, []);

  const popToRoot = useCallback(() => {
    // Collapse immediately (used by restoreSession before it re-pushes).
    layersRef.current.clear();
    setSubs([]);
  }, []);

  // Return to a home-tab path from anywhere in the stack (root or any pushed
  // sub-page): collapse to root, then drive root's own SPA there via
  // `rootTargetPath` (root's `targetPath` prop below). Composes the same two
  // primitives `restoreSession` already uses (`popToRoot` + driving root's
  // handle), but the destination is fixed to a home path instead of a saved
  // session snapshot.
  const goHome = useCallback((path: string) => {
    popToRoot();
    setRootTargetPath(path);
  }, [popToRoot]);

  // Reuse the orchestrator: register the host as the stack navigator so the
  // controller (goBackActive / restoreSession / popToRoot) drives it unchanged.
  useEffect(() => {
    registry.registerNavigator({ push: pushSub, pop, popToRoot });
    return () => registry.registerNavigator(null);
  }, [registry, pushSub, pop, popToRoot]);

  // Tier 3 warm pool: `subs` and `warm` are merged into ONE array for
  // rendering. This is load-bearing, not cosmetic — React only preserves a
  // keyed element's identity (no remount) when it moves within the SAME
  // array/`.map()` across renders. Rendering the warm slot as a separate
  // sibling JSX expression (`{warm && <SubLayer/>}`) would put it in a
  // different reconciliation "slot" than `{subs.map(...)}`, so promoting it
  // (moving the same key from one slot to the other) would remount — and
  // silently re-pay the exact JS-boot cost the whole feature exists to skip.
  const renderLayers = useMemo(() => {
    const list: { key: string; url: string; path: string; active?: boolean; isWarm: boolean }[] =
      subs.map((s) => ({ ...s, isWarm: false }));
    if (warm) list.push({ key: warm.key, url: warm.url, path: warm.path, isWarm: true });
    return list;
  }, [subs, warm]);
  const lastSubIndex = renderLayers.reduce((acc, l, idx) => (l.isWarm ? acc : idx), -1);

  if (status !== 'online') {
    return (
      <View style={[styles.host, styles.center, { backgroundColor }]}>
        {status === 'checking' && <ActivityIndicator />}
      </View>
    );
  }

  return (
    // Absolutely fill so the host overlays the router <Stack>; box-none lets the
    // transparent host frame pass touches through — only instance layers are
    // interactive.
    <View style={styles.host} pointerEvents="box-none">
      {/* Root portal — always mounted, beneath every sub-page. */}
      <View style={styles.layer} pointerEvents={subs.length === 0 ? 'auto' : 'none'}>
        <WebViewInstance
          mode="root"
          url={ROOT_URL}
          initialNavPath={initialNavPath}
          targetPath={rootTargetPath}
          onNavigateTo={pushSub}
          onGoBack={pop}
          onGoHome={goHome}
          onPrewarm={handlePrewarm}
          onRouteChange={handleRootRouteChange}
        />
      </View>

      {renderLayers.map((layer, i) => (
        <SubLayer
          key={layer.key}
          isTop={!layer.isWarm && i === lastSubIndex}
          // Warm stays parked off-screen (revealed=false) and non-interactive;
          // it isn't registered with the controller until adopted
          // (WebViewInstance gates registration on `active !== false`).
          revealed={!layer.isWarm}
          onRemoved={() => removeSub(layer.key)}
          ref={(handle) => {
            if (handle) layersRef.current.set(layer.key, handle);
            else layersRef.current.delete(layer.key);
          }}
        >
          <WebViewInstance
            mode="sub"
            url={layer.url}
            active={layer.isWarm ? false : layer.active}
            targetPath={layer.isWarm ? layer.path : undefined}
            onNavigateTo={pushSub}
            onGoBack={pop}
            onGoHome={goHome}
            onContentProcessTerminated={layer.isWarm ? markWarmDead : undefined}
          />
        </SubLayer>
      ))}

      <HostBackHandler hasSubs={subs.length > 0} />
    </View>
  );
}

const fillAbsolute = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  // The host overlays the router stack, so it (and its layers) fill absolutely.
  host: fillAbsolute,
  center: { alignItems: 'center', justifyContent: 'center' },
  layer: fillAbsolute,
});
