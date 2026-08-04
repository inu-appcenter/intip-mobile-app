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
  Alert,
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import WebView, {
  type WebViewMessageEvent,
  type WebViewNavigation,
} from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import * as WebBrowser from 'expo-web-browser';

// Shared bridge is vendored as a git submodule under packages/intip-bridge and
// compiled from source (no npm package / registry). See AGENTS.md.
import { createNativeChannel } from '../../packages/intip-bridge/src/adapters/native';
import {
  APP_UA_SUFFIX,
  PORTAL_HOST,
  STRINGS,
  isEdgeToEdgePath,
  isMainTabPath,
} from '../webview/constants';
import {
  INJECTED_SCRIPT,
  LAUNCH_CLEANUP_SCRIPT,
  buildBridgeShimScript,
} from '../webview/injectedScript';
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
import { backgroundColorFor } from '../theme';
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
  // eslint-disable-next-line react-hooks/refs
  const bridge = useMemo(() => createNativeChannel(webViewRef), []);
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
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);
  const isRoot = mode === 'root';
  // Stable for the container's lifetime — `url` never changes after mount, so
  // this can't flip mid-session and remount the WebView (losing its JS context).
  const edgeToEdge = useMemo(() => {
    if (isRoot) return true;
    try {
      return isEdgeToEdgePath(new URL(url).pathname);
    } catch {
      return false;
    }
  }, [isRoot, url]);

  // Connect this container to the WebView orchestrator (shared dev controller).
  const registry = useWebViewRegistry();
  const [id] = useState(() => `${mode}-${nextWebViewSeq()}`);

  const [currentPath, setCurrentPath] = useState<string>('/');
  const canGoBackRef = useRef(false);
  const lastBackPressRef = useRef(0);
  const pendingNavRef = useRef<string | null>(null);
  const permissionsPrimedRef = useRef(false);
  const cleanupStartedRef = useRef(false);
  // Dev controller "load full URL": the URL a developer asked to load in place.
  // Lets `onShouldStartLoadWithRequest` allow that one navigation even off-portal
  // (which the security guard would otherwise divert to the system browser).
  const devLoadUrlRef = useRef<string | null>(null);

  // Launch overlay (root only): a branded screen held over the WebView until
  // the web cleanup loop reports back, masking the service-worker/cache purge.
  const [overlayVisible, setOverlayVisible] = useState(isRoot);
  const [overlayOpacity] = useState(() => new Animated.Value(1));

  // Prime camera (photo upload) + location (campus map) once logged in.
  const primeWebPermissions = useCallback(() => {
    if (permissionsPrimedRef.current) return;
    permissionsPrimedRef.current = true;
    void ensureCameraPermission();
    void ensureLocationPermission();
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

  const dismissOverlay = useCallback(() => {
    if (!isRoot) return;
    Animated.timing(overlayOpacity, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start(() => setOverlayVisible(false));
  }, [isRoot, overlayOpacity]);

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
        // Land ON TOP of whatever is open (don't collapse the user's stack).
        router.push({ pathname: '/webview', params: { url: intent.url, path: intent.path } });
      } else {
        // spa: a main-tab destination — collapse to root and drive it there.
        // Also queue for the cold-start case where root's SPA hasn't loaded
        // yet; the queued path is flushed in onLoadEnd.
        goHome(intent.path);
        pendingNavRef.current = intent.path;
      }
    },
    [goHome, router],
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
        Alert.alert(STRINGS.appUpdate.title, STRINGS.appUpdate.message, [
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
        Alert.alert('', message, [{ text: STRINGS.appUpdate.confirm }]);
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
    }
  }, [isRoot, navigateSpa, postFcmToken]);

  // Jetsam recovery (iOS content-process termination / Android render-process
  // gone): a visible container just reloads itself in place.
  const onContentProcessDied = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  // Root sits on the main tabs -> no WebView-level swipe-back; sub-pages let the
  // native stack own the swipe so it pops the screen (spec §3.C.2 / §6.5).
  const webViewSwipeBack = isRoot && !isMainTabPath(currentPath);

  const webView = (
    <WebView
      ref={webViewRef}
      source={{ uri: url }}
      style={[styles.fill, { backgroundColor }]}
      // Identify as the official app so the web enables multi-WebView routing.
      applicationNameForUserAgent={APP_UA_SUFFIX}
      // Cache: never serve from cache; we also clearCache() on mount.
      cacheEnabled={false}
      // Dev builds only: chrome://inspect (Android) / Safari Web Inspector (iOS).
      webviewDebuggingEnabled={__DEV__}
      // Bridge wiring: shims + alert override before content, observers after.
      onMessage={onWebViewMessage}
      injectedJavaScriptBeforeContentLoaded={BEFORE_CONTENT_SCRIPT}
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

  return (
    // Fill the screen; ignore the bottom inset so content reaches the edge.
    <View style={[styles.fill, { backgroundColor }]}>
      {edgeToEdge ? (
        // Root (and sub-pages migrated to own their top inset via
        // env(safe-area-inset-*)) go fully edge-to-edge; the web owns the insets.
        webView
      ) : (
        <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
          {webView}
        </SafeAreaView>
      )}

      {overlayVisible && (
        <Animated.View
          pointerEvents="none"
          style={[styles.overlay, { backgroundColor, opacity: overlayOpacity }]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
});
