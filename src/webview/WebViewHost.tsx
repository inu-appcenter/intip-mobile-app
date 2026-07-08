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

type GateStatus = 'checking' | 'offline' | 'online';
type SubEntry = { key: string; url: string; path: string };
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
  onRemoved: () => void;
  children: ReactNode;
}>(function SubLayer({ isTop, onRemoved, children }, ref) {
  const tx = useSharedValue(SCREEN_WIDTH);
  const startX = useSharedValue(0);

  // Slide in from the right on mount. (`.set`/`.get` is the React-Compiler-safe
  // shared-value API — plain `.value =` trips react-hooks/immutability.)
  useEffect(() => {
    tx.set(withTiming(0, { duration: 280 }));
  }, [tx]);

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

  // Mirror the live stack into refs so the stable navigator actions read fresh
  // values without re-creating themselves.
  const subsRef = useRef<SubEntry[]>(subs);
  useEffect(() => {
    subsRef.current = subs;
  }, [subs]);
  const layersRef = useRef(new Map<string, SubLayerHandle>());
  const seqRef = useRef(0);

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
    const key = `sub-${++seqRef.current}`;
    setSubs((prev) => [...prev, { key, url, path }]);
  }, []);

  const pop = useCallback(() => {
    const top = subsRef.current[subsRef.current.length - 1];
    if (top) layersRef.current.get(top.key)?.close();
  }, []);

  const popToRoot = useCallback(() => {
    // Collapse immediately (used by restoreSession before it re-pushes).
    layersRef.current.clear();
    setSubs([]);
  }, []);

  // Reuse the orchestrator: register the host as the stack navigator so the
  // controller (goBackActive / restoreSession / popToRoot) drives it unchanged.
  useEffect(() => {
    registry.registerNavigator({ push: pushSub, pop, popToRoot });
    return () => registry.registerNavigator(null);
  }, [registry, pushSub, pop, popToRoot]);

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
          onNavigateTo={pushSub}
          onGoBack={pop}
        />
      </View>

      {subs.map((s, i) => (
        <SubLayer
          key={s.key}
          isTop={i === subs.length - 1}
          onRemoved={() => removeSub(s.key)}
          ref={(handle) => {
            if (handle) layersRef.current.set(s.key, handle);
            else layersRef.current.delete(s.key);
          }}
        >
          <WebViewInstance
            mode="sub"
            url={s.url}
            onNavigateTo={pushSub}
            onGoBack={pop}
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
