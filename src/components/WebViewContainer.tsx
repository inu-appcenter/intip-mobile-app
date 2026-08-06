/**
 * A single INTIP WebView container — the unit of the native multi-WebView stack.
 * The root portal (`mode="root"`) hosts the main-tab SPA and is the
 * always-mounted launch screen; every sub-page is a pushed instance
 * (`mode="sub"`) on its own expo-router native-stack screen, so it gets the
 * slide-in animation and swipe-back **natively** from react-native-screens.
 *
 * This replaces the Tier 3 custom `WebViewHost` (persistent layer + Reanimated
 * slide + warm pool). That design existed to reuse warmed WebView instances,
 * but its real-world hit rate was near-zero and driving a live Android WebView
 * with a JS transform flickered (half-white flash on push/pop). Native-stack
 * transitions are OS-composited, so that flicker is gone; the trade-off is no
 * warm reuse (every sub-page cold-loads), which the measurements showed costs
 * little.
 *
 * Both modes share the full JS <-> Native bridge. The root additionally owns the
 * push-notification lifecycle, the native-stack navigator registration (for the
 * dev controller / `restoreSession`), and the launch cache-purge overlay.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Linking,
  Platform,
  StyleSheet,
  ToastAndroid,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useFocusEffect, useNavigationContainerRef, useRouter } from 'expo-router';
import WebView, {
  type WebViewMessageEvent,
  type WebViewNavigation,
} from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import * as WebBrowser from 'expo-web-browser';

// Shared bridge is vendored as a git submodule under packages/intip-bridge and
// compiled from source (no npm package / registry). See AGENTS.md.
import { createNativeChannel } from '../../packages/intip-bridge/src/adapters/native';
import { nativeAlert } from '../../modules/intip-native-dialog';
import {
  APP_UA_SUFFIX,
  PORTAL_HOST,
  STRINGS,
  isMainTabPath,
} from '../webview/constants';
import {
  INJECTED_SCRIPT,
  LAUNCH_CLEANUP_SCRIPT,
  buildBridgeShimScript,
  buildSafeAreaInsetsScript,
} from '../webview/injectedScript';
import { openSubPageDepth } from '../webview/subPageStack';
import { relayWebConsoleMessage, WEB_CONSOLE_SCRIPT } from '../webview/webConsole';
import { clearWebViewCache, clearCacheAndReload } from '../native/cache';
import { saveDownload } from '../native/downloads';
import { ensureCameraPermission, ensureLocationPermission } from '../native/permissions';
import { clearTokenInfo, saveTokenInfo } from '../native/secureTokenStore';
import {
  getFcmTokenWithRetry,
  getInitialNavIntent,
  setupForegroundNotifications,
  subscribeNotificationOpen,
  type NavIntent,
} from '../push/messaging';
import { flushPendingFcmToken } from '../push/fcmTokenSync';
import { backgroundColorFor, INDICATOR_COLOR } from '../theme';
import {
  nextWebViewSeq,
  useWebViewRegistry,
  type WebViewHandle,
} from '../webview/WebViewContext';

/** Extensions we treat as downloads on Android (iOS uses onFileDownload). */
const DOWNLOAD_EXTENSIONS = [
  '.pdf', '.hwp', '.hwpx', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.zip', '.csv', '.txt', '.png', '.jpg', '.jpeg',
];

/** Hard cap on how long the launch overlay waits for the web cleanup signal. */
const CLEANUP_OVERLAY_TIMEOUT_MS = 4000;

/** Hard cap on how long a sub-page holds its reveal overlay waiting for load. */
const REVEAL_OVERLAY_TIMEOUT_MS = 4000;

/** Cross-fade used to reveal the WebView once its content is ready. */
const OVERLAY_FADE_MS = 250;

/**
 * Width (dp) of the band along each screen edge that Android reserves for the
 * system back gesture. AOSP's inset is 20dp; OEM skins (One UI) can widen it,
 * so guard slightly more than the platform minimum.
 */
const SYSTEM_BACK_GESTURE_EDGE_DP = 24;

/** Travel (dp) that commits a touch to being a swipe rather than a tap. */
const EDGE_GUARD_SLOP_DP = 8;

/**
 * Camera/location permission priming happens at most once per app session —
 * module-scoped, not per `WebViewContainer` instance. `INJECTED_SCRIPT` posts
 * `loginSuccess` unconditionally on every page load whenever a token is
 * already in localStorage (not just on a fresh login), so every freshly
 * pushed sub-page's own `loginSuccess` handler would otherwise re-prime on
 * its first load — surfacing as a permission dialog popping up out of
 * nowhere when entering e.g. the timetable edit page.
 */
let permissionsPrimed = false;

/** Bridge shim is platform-specific (see injectedScript.ts). */
const BRIDGE_SHIM_SCRIPT = buildBridgeShimScript(Platform.OS === 'ios' ? 'ios' : 'android');

/** Dev builds also relay the web's console.* to the Metro log (webConsole.ts). */
const BEFORE_CONTENT_SCRIPT = __DEV__
  ? BRIDGE_SHIM_SCRIPT + WEB_CONSOLE_SCRIPT
  : BRIDGE_SHIM_SCRIPT;

function looksLikeDownload(url: string): boolean {
  const path = url.split('?')[0].toLowerCase();
  return DOWNLOAD_EXTENSIONS.some((ext) => path.endsWith(ext));
}

type Props = {
  /** Absolute URL this container loads. */
  url: string;
  /** Root portal hosts the main tabs; sub-pages are pushed on top. */
  mode: 'root' | 'sub';
};

export default function WebViewContainer({ url, mode }: Props) {
  const webViewRef = useRef<WebView>(null);
  // PlatformChannel over the single react-native-webview channel. `onMessage`
  // is wired to the WebView prop; Web->Native handlers are registered below.
  //
  // The cast below papers over a duplicate-install quirk, not a real type
  // mismatch: the bridge submodule (packages/intip-bridge) has its own
  // node_modules/react-native-webview (13.17.0) separate from the app's root
  // one (13.16.1), so TS resolves two structurally-different `WebView`
  // classes (their default generic differs: `{}` vs `undefined`) for what is
  // the exact same runtime ref at build/run time.
  const nativeChannelRef = webViewRef as unknown as Parameters<typeof createNativeChannel>[0];
  // eslint-disable-next-line react-hooks/refs
  const bridge = useMemo(() => createNativeChannel(nativeChannelRef), [nativeChannelRef]);
  // Dev only: peel relayed web console messages off before the bridge channel
  // parses the stream (they're not part of the intip-bridge contract).
  const onWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (__DEV__) {
        let tag = url;
        try {
          tag = new URL(url).pathname;
        } catch {}
        if (relayWebConsoleMessage(event.nativeEvent.data, tag)) return;
      }
      bridge.onMessage(event);
    },
    [bridge, url],
  );
  const router = useRouter();
  // Read-only access to the live navigation state (push-tap dedupe below).
  // Stable across renders — expo-router hands out the store's single ref.
  const navigationRef = useNavigationContainerRef();
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);
  const isRoot = mode === 'root';
  // Root reserves no inset natively (the web owns all four via
  // env(safe-area-inset-*) + the injected --native-safe-area-inset-* below).
  // Sub-pages still let native reserve left/right (notch/landscape), but never
  // the top — every pushed page now pads its own header itself, the same way
  // the migrated pages used to (see the insets injection below).
  const insets = useSafeAreaInsets();
  // Combined with the static bridge-shim script so the very first paint
  // already has the native insets available as CSS vars — before content
  // loads, ahead of the page's own layout. Re-injected live below whenever
  // insets change (rotation, foldable), since this only re-runs on a fresh
  // navigation, not a live prop change. `insets` is reference-stable across
  // no-op re-renders (react-native-safe-area-context only swaps the object
  // when a value actually changes), so depending on it directly is safe.
  const beforeContentScript = useMemo(
    () => BEFORE_CONTENT_SCRIPT + buildSafeAreaInsetsScript(insets),
    [insets],
  );

  // Connect this container to the WebView orchestrator (shared dev controller).
  const registry = useWebViewRegistry();
  const [id] = useState(() => `${mode}-${nextWebViewSeq()}`);

  const [currentPath, setCurrentPath] = useState<string>('/');
  const canGoBackRef = useRef(false);
  const lastBackPressRef = useRef(0);
  const pendingNavRef = useRef<string | null>(null);
  const cleanupStartedRef = useRef(false);
  // Dev controller "load full URL": the URL a developer asked to load in place.
  // Lets `onShouldStartLoadWithRequest` allow that one navigation even off-portal
  // (which the security guard would otherwise divert to the system browser).
  const devLoadUrlRef = useRef<string | null>(null);

  // Reveal overlay: a flat themed screen held over the WebView until its
  // content is ready, then cross-faded out. Without it a pushed sub-page slides
  // in as a bare background-coloured card and the page *pops* in whenever the
  // cold load happens to finish — the visible "black (dark) / white (light)
  // flash" during the native-stack transition. Root reuses the same overlay to
  // additionally mask the launch service-worker/cache purge.
  //  - root: lifted by `onLaunchWebCleanupFinished` (or CLEANUP_OVERLAY_TIMEOUT_MS)
  //  - sub:  lifted by `onLoadEnd` (or REVEAL_OVERLAY_TIMEOUT_MS)
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayOpacity] = useState(() => new Animated.Value(1));
  const overlayDismissedRef = useRef(false);

  // Prime camera (photo upload) + location (campus map) once logged in, at
  // most once per app session (see `permissionsPrimed` above). Requested
  // sequentially — firing both `request()` calls concurrently races two
  // system permission dialogs, and the OS auto-dismisses/cancels one of
  // them, which then silently re-requests later. Await each one before
  // starting the next.
  const primeWebPermissions = useCallback(() => {
    if (permissionsPrimed) return;
    permissionsPrimed = true;
    void (async () => {
      await ensureCameraPermission();
      await ensureLocationPermission();
    })();
  }, []);

  // --- Native -> Web helpers -------------------------------------------------
  const postFcmToken = useCallback(async () => {
    const token = await getFcmTokenWithRetry();
    if (token) {
      bridge.channel.send('receiveFcmToken', token);
      registry.mergeSession({ fcmToken: token });
    }
    flushPendingFcmToken();
  }, [bridge, registry]);

  const navigateSpa = useCallback((path: string) => {
    bridge.channel.send('navigate', path);
  }, [bridge]);

  // Idempotent: the load signal and the safety timeout race, and whichever
  // lands first owns the fade.
  const dismissOverlay = useCallback(() => {
    if (overlayDismissedRef.current) return;
    overlayDismissedRef.current = true;
    Animated.timing(overlayOpacity, {
      toValue: 0,
      duration: OVERLAY_FADE_MS,
      useNativeDriver: true,
    }).start(() => setOverlayVisible(false));
  }, [overlayOpacity]);

  // Collapse the native sub-stack back to root, then drive root's SPA to a
  // main-tab path. Root is always mounted (the index screen), so `driveRoot`
  // works whether or not any sub-pages are currently on top of it.
  const goHome = useCallback((path: string) => {
    if (router.canGoBack()) {
      try {
        router.dismissAll();
      } catch {
        while (router.canGoBack()) router.back();
      }
    }
    registry.driveRoot(path);
  }, [registry, router]);

  // Push-notification tap / cold-start routing (root only).
  const handleNavIntent = useCallback(
    (intent: NavIntent) => {
      if (intent.kind === 'external') {
        WebBrowser.openBrowserAsync(intent.url).catch(() => {});
      } else if (intent.kind === 'push') {
        // Land ON TOP of whatever is open (don't collapse the user's stack) —
        // but never stack a second copy of a page that is already open. Chat
        // notifications for one room arrive as separate notifications with
        // separate ids, so `pendingIntent`'s id dedupe doesn't cover this:
        // without the stack lookup, tapping n of them opened n identical chat
        // screens the user then had to back out of one by one.
        const depth = navigationRef.isReady()
          ? openSubPageDepth(navigationRef.getRootState(), intent.url)
          : null;
        if (depth === null) {
          router.push({ pathname: '/webview', params: { url: intent.url, path: intent.path } });
        } else if (depth > 0) {
          // Already open underneath: come back to it instead of duplicating it.
          router.dismiss(depth);
        }
        // depth === 0: it is the top-most screen already — nothing to do.
      } else {
        // spa: a main-tab destination — collapse to root and drive it there.
        // Also queue for the cold-start case where root's SPA hasn't loaded
        // yet; the queued path is flushed in onLoadEnd.
        goHome(intent.path);
        pendingNavRef.current = intent.path;
      }
    },
    [goHome, navigationRef, router],
  );

  // --- Lifecycle: cache + notifications (root only) --------------------------
  useEffect(() => {
    // Sub-pages share the process-wide WebView cache; only the launch screen
    // clears it (login/cookies preserved) and owns the notification lifecycle.
    if (!isRoot) return;
    clearWebViewCache(webViewRef);

    const unsubForeground = setupForegroundNotifications();
    const unsubOpen = subscribeNotificationOpen(handleNavIntent);
    // Cold-start deep link: same branching as a live tap.
    void getInitialNavIntent().then((intent) => {
      if (intent) handleNavIntent(intent);
    });
    // Re-post the FCM token whenever the app returns to the foreground.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void postFcmToken();
    });
    // Safety net: never leave the overlay stuck if the web never signals back.
    const timeout = setTimeout(dismissOverlay, CLEANUP_OVERLAY_TIMEOUT_MS);
    return () => {
      unsubForeground();
      unsubOpen();
      appStateSub.remove();
      clearTimeout(timeout);
    };
  }, [dismissOverlay, handleNavIntent, isRoot, postFcmToken]);

  // Sub-pages lift the reveal overlay from `onLoadEnd`; this is the safety net
  // for a load that errors out or never ends (root has its own above).
  useEffect(() => {
    if (isRoot) return;
    const timeout = setTimeout(dismissOverlay, REVEAL_OVERLAY_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [dismissOverlay, isRoot]);

  // Keep the page's safe-area CSS vars current across an insets change after
  // the initial load (rotation, foldable fold/unfold). The initial value is
  // covered by `beforeContentScript` above, so skip the redundant first run.
  const skipFirstInsetsPushRef = useRef(true);
  useEffect(() => {
    if (skipFirstInsetsPushRef.current) {
      skipFirstInsetsPushRef.current = false;
      return;
    }
    webViewRef.current?.injectJavaScript(buildSafeAreaInsetsScript(insets));
  }, [insets]);

  // --- Orchestrator: register this container + expose its imperative handle --
  useEffect(() => {
    const handle: WebViewHandle = {
      reload: () => webViewRef.current?.reload(),
      reloadClearCache: () => clearCacheAndReload(webViewRef),
      goBackSpa: () => webViewRef.current?.goBack(),
      navigateSpa: (path) => navigateSpa(path),
      // Dev-only: navigate this WebView to a full URL (not an SPA hop). Records
      // the target so the off-portal guard lets it through this once.
      loadUrl: (target) => {
        if (!__DEV__) return;
        devLoadUrlRef.current = target;
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(target)}; true;`,
        );
      },
      refreshFcmToken: () => void postFcmToken(),
      sendTokenInfo: (tokenInfo) => bridge.channel.send('tokenInfoUpdated', tokenInfo),
      sendBroadcastSync: (message) => bridge.channel.send('broadcastSyncMessage', message),
    };
    registry.registerWebView({ id, mode, url, path: '/' }, handle);
    return () => registry.unregisterWebView(id);
  }, [id, mode, url, registry, navigateSpa, postFcmToken, bridge]);

  // The root owns the expo-router stack, so it registers native-stack navigation
  // (push/pop/popToRoot) the controller uses to restore a saved session.
  useEffect(() => {
    if (!isRoot) return;
    registry.registerNavigator({
      push: (target, path) =>
        router.push({ pathname: '/webview', params: { url: target, path } }),
      pop: () => {
        if (router.canGoBack()) router.back();
      },
      popToRoot: () => {
        try {
          if (router.canGoBack()) router.dismissAll();
        } catch {
          while (router.canGoBack()) router.back();
        }
      },
    });
    return () => registry.registerNavigator(null);
  }, [isRoot, registry, router]);

  // --- Android hardware back (only while this screen is focused) -------------
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        // Sub-page: the back button pops this native screen.
        if (!isRoot) {
          if (router.canGoBack()) router.back();
          return true;
        }
        // Root: walk the SPA history while it has any, else "press to exit".
        if (canGoBackRef.current) {
          webViewRef.current?.goBack();
          return true;
        }
        const now = Date.now();
        if (now - lastBackPressRef.current < 2000) {
          BackHandler.exitApp();
          return true;
        }
        lastBackPressRef.current = now;
        ToastAndroid.show('뒤로 가기를 한 번 더 누르면 종료됩니다.', ToastAndroid.SHORT);
        return true;
      });
      return () => sub.remove();
    }, [isRoot, router]),
  );

  // --- Bridge: Web -> Native -------------------------------------------------
  useEffect(() => {
    const { channel } = bridge;
    const offs = [
      // Push a new native sub-page screen (spec §3.B/§4). The web only emits
      // this for non-main-tab destinations.
      channel.on('navigateTo', ({ path, url: target }) => {
        router.push({ pathname: '/webview', params: { url: target, path } });
      }),
      // Pop the top-most screen (spec §3.C). No-op on the root.
      channel.on('goBack', () => {
        if (router.canGoBack()) router.back();
      }),
      // Return to a home-tab path — collapse the stack to root and drive root
      // there, regardless of which page (root or a sub) sent it.
      channel.on('goHome', ({ path }) => {
        goHome(path);
      }),
      channel.on('loginSuccess', () => {
        void postFcmToken();
        primeWebPermissions();
        registry.mergeSession({ loggedIn: true, loginAt: Date.now() });
      }),
      // Mirror the web's JWT into SecureStore so the shell can call
      // authenticated backend endpoints on its own (background FCM token
      // registration) without a live WebView. An empty accessToken is the
      // web's logout signal — clear the native copy too.
      channel.on('syncTokenInfo', (tokenInfo) => {
        void (tokenInfo.accessToken ? saveTokenInfo(tokenInfo) : clearTokenInfo());
      }),
      // Multi-WebView state sync fallback/second path (see WebViewContext's
      // `relayBroadcastSync` doc comment): relay to every other mounted WebView.
      channel.on('relayBroadcastSync', (message) => {
        registry.relayBroadcastSync(message, id);
      }),
      channel.on('routeChange', (path) => {
        setCurrentPath(path || '/');
        registry.updateWebView(id, { path: path || '/' });
      }),
      channel.on('requestAppUpdate', () => {
        nativeAlert(STRINGS.appUpdate.title, STRINGS.appUpdate.message, [
          { text: STRINGS.appUpdate.cancel, style: 'cancel' },
          {
            text: STRINGS.appUpdate.confirm,
            onPress: () => clearCacheAndReload(webViewRef),
          },
        ]);
      }),
      channel.on('openAppSettings', () => {
        Linking.openSettings().catch(() => {});
      }),
      channel.on('requestPermissionSettings', () => {
        Linking.openSettings().catch(() => {});
      }),
      channel.on('logWebDiagnostics', (diag) => {
        console.log('[web-diagnostics]', diag);
      }),
      // Cleanup loop done: reveal the WebView (spec §5.B step 4).
      channel.on('onLaunchWebCleanupFinished', () => {
        dismissOverlay();
      }),
      channel.on('jsAlert', (message) => {
        // Web `alert()` has no title, so this is message-only.
        nativeAlert('', message, [{ text: STRINGS.common.confirm }]);
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [bridge, dismissOverlay, goHome, id, postFcmToken, primeWebPermissions, registry, router]);

  // --- External links + Android downloads ------------------------------------
  const onShouldStartLoadWithRequest = useCallback((request: ShouldStartLoadRequest) => {
    const { url: target } = request;
    // Allow sub-frame / resource loads (iOS reports these too).
    if (request.isTopFrame === false) return true;

    // Dev controller "load full URL": let the exact URL a developer asked to
    // load navigate in place, even if off-portal (the guard below would send it
    // to the system browser). One-shot; cleared once consumed.
    if (__DEV__ && devLoadUrlRef.current === target) {
      devLoadUrlRef.current = null;
      return true;
    }

    let host = '';
    try {
      host = new URL(target).host;
    } catch {
      // Non-standard scheme (mailto:, tel:, intent:, market:, blob:) -> hand off.
      if (!/^https?:/i.test(target)) {
        Linking.openURL(target).catch(() => {});
        return false;
      }
    }

    // Android downloads are not surfaced via onFileDownload — catch them here.
    if (Platform.OS === 'android' && looksLikeDownload(target)) {
      void saveDownload(target);
      return false;
    }

    // Any off-portal navigation opens in the system browser (spec §6.4).
    if (host && host !== PORTAL_HOST) {
      Linking.openURL(target).catch(() => {});
      return false;
    }
    return true;
  }, []);

  const onNavigationStateChange = useCallback(
    (nav: WebViewNavigation) => {
      canGoBackRef.current = nav.canGoBack;
      registry.updateWebView(id, { canGoBack: nav.canGoBack, url: nav.url });
    },
    [id, registry],
  );

  const onLoadEnd = useCallback(() => {
    // Push the FCM token into the web context after every page load (spec §5.A).
    void postFcmToken();

    if (isRoot) {
      // Kick off the one-time service-worker/cache cleanup loop (spec §5.B).
      if (!cleanupStartedRef.current) {
        cleanupStartedRef.current = true;
        webViewRef.current?.injectJavaScript(LAUNCH_CLEANUP_SCRIPT);
      }
      // Resolve any queued notification deep-link now the SPA is ready.
      if (pendingNavRef.current) {
        navigateSpa(pendingNavRef.current);
        pendingNavRef.current = null;
      }
    } else {
      // Sub-page: the document is loaded, so the page has (or is one frame from)
      // its first paint — cross-fade the reveal overlay away instead of letting
      // the content pop in on top of the slide-in transition.
      dismissOverlay();
    }
  }, [dismissOverlay, isRoot, navigateSpa, postFcmToken]);

  // Jetsam recovery (iOS content-process termination / Android render-process
  // gone): a visible container just reloads itself in place.
  const onContentProcessDied = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  // Root sits on the main tabs -> no WebView-level swipe-back; sub-pages let the
  // native stack own the swipe so it pops the screen (spec §3.C.2 / §6.5).
  const webViewSwipeBack = isRoot && !isMainTabPath(currentPath);

  // Android's system back gesture starts inside a narrow band at each screen
  // edge, and the app keeps receiving those touches until SystemUI decides the
  // swipe really is a back gesture. The WebView acts on them in the meantime:
  // hold near the edge for the long-press timeout and the page kicks off a text
  // selection / image drag *while the user is swiping back*, so the content
  // visibly smears under the transition.
  //
  // These two pans live only in that band and deliberately do nothing — the
  // point is the activation itself, which makes gesture-handler cancel the
  // touch stream in the WebView underneath, so the long-press never fires. They
  // only claim the touch once it travels inward horizontally (the direction the
  // back gesture pulls) and bail on a vertical drag, so tapping and scrolling
  // near the edge still reach the page exactly as before. A touch that just
  // rests at the edge never activates them and still long-presses normally —
  // that mis-grab is rare enough not to be worth blocking.
  const backGestureGuard = useMemo(() => {
    const guard = (edge: 'left' | 'right') =>
      Gesture.Pan()
        .hitSlop(
          edge === 'left'
            ? { left: 0, width: SYSTEM_BACK_GESTURE_EDGE_DP }
            : { right: 0, width: SYSTEM_BACK_GESTURE_EDGE_DP },
        )
        .activeOffsetX(edge === 'left' ? EDGE_GUARD_SLOP_DP : -EDGE_GUARD_SLOP_DP)
        .failOffsetY([-EDGE_GUARD_SLOP_DP, EDGE_GUARD_SLOP_DP])
        // iOS has no equivalent problem: the native stack owns the edge swipe
        // and WKWebView does not start a selection mid-gesture.
        .enabled(Platform.OS === 'android');
    return Gesture.Race(guard('left'), guard('right'));
  }, []);

  const webView = (
    <WebView
      hideKeyboardAccessoryView
      ref={webViewRef}
      source={{ uri: url }}
      style={[styles.fill, { backgroundColor }]}
      // Identify as the official app so the web enables multi-WebView routing.
      applicationNameForUserAgent={APP_UA_SUFFIX}
      // Cache: ON. Freshness is enforced *once per launch* — the root clears the
      // HTTP cache on mount and the cleanup script purges service workers +
      // CacheStorage — so nothing stale survives a launch. Keeping the HTTP
      // cache disabled for the whole session instead made every pushed sub-page
      // re-download the entire SPA bundle over the network, which is what
      // stretched the blank reveal gap on push (spec §5.B still holds).
      cacheEnabled
      // Dev builds only: chrome://inspect (Android) / Safari Web Inspector (iOS).
      webviewDebuggingEnabled={__DEV__}
      // Bridge wiring: shims + alert override before content, observers after.
      onMessage={onWebViewMessage}
      injectedJavaScriptBeforeContentLoaded={beforeContentScript}
      injectedJavaScript={INJECTED_SCRIPT}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      onNavigationStateChange={onNavigationStateChange}
      onLoadEnd={onLoadEnd}
      onContentProcessDidTerminate={onContentProcessDied}
      onRenderProcessGone={onContentProcessDied}
      onFileDownload={({ nativeEvent }) => saveDownload(nativeEvent.downloadUrl)}
      // Inline media — videos must not auto-fullscreen (spec §6.3).
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction
      mediaCapturePermissionGrantType="grantIfSameHostElseDeny"
      allowsBackForwardNavigationGestures={webViewSwipeBack}
      contentInsetAdjustmentBehavior="never"
      geolocationEnabled
      allowsFullscreenVideo={false}
      originWhitelist={['https://*', 'http://*', 'about:*']}
      pullToRefreshEnabled={false}
    />
  );

  // The guard wraps the WebView in its own host view rather than attaching to
  // the WebView directly, so gesture-handler's ref does not fight `webViewRef`.
  const guardedWebView = (
    <GestureDetector gesture={backGestureGuard}>
      <View style={styles.fill} collapsable={false}>
        {webView}
      </View>
    </GestureDetector>
  );

  return (
    // Fill the screen; ignore the bottom inset so content reaches the edge.
    <View style={[styles.fill, { backgroundColor }]}>
      {isRoot ? (
        // Root goes fully edge-to-edge on every side; the web owns all four
        // insets via env(safe-area-inset-*) / the injected CSS vars above.
        guardedWebView
      ) : (
        // Sub-pages keep native left/right (notch/landscape) reservation, but
        // no longer reserve the top inset — every pushed page pads its own
        // header itself using the safe-area values injected above.
        <SafeAreaView style={styles.fill} edges={['left', 'right']}>
          {guardedWebView}
        </SafeAreaView>
      )}

      {overlayVisible && (
        <Animated.View
          pointerEvents="none"
          style={[styles.overlay, { backgroundColor, opacity: overlayOpacity }]}
        >
          <ActivityIndicator size="large" color={INDICATOR_COLOR} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
