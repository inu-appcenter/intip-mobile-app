/**
 * A single INTIP WebView container — the unit of the native multi-WebView stack
 * (spec §3). The root portal (`mode="root"`) hosts the main-tab SPA; every
 * sub-page is a pushed instance (`mode="sub"`) shown on its own native screen
 * so it gets slide animation + swipe-back for free from the native stack.
 *
 * Both modes share the full JS <-> Native bridge: `navigateTo` pushes a new
 * container, `goBack` pops the top one, and the rest of the web→native API
 * (app update, settings, downloads, FCM token) is handled here.
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

import { createNativeChannel } from '@inu-appcenter/intip-bridge/native';
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
} from '../webview/injectedScript';
import { clearWebViewCache, clearCacheAndReload } from '../native/cache';
import { saveDownload } from '../native/downloads';
import { ensureCameraPermission, ensureLocationPermission } from '../native/permissions';
import {
  getFcmTokenWithRetry,
  setupForegroundNotifications,
  subscribeNotificationOpen,
} from '../push/messaging';
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

function looksLikeDownload(url: string): boolean {
  const path = url.split('?')[0].toLowerCase();
  return DOWNLOAD_EXTENSIONS.some((ext) => path.endsWith(ext));
}

type Props = {
  /** Absolute URL this container loads. */
  url: string;
  /** Root portal hosts the main tabs; sub-pages are pushed on top. */
  mode: 'root' | 'sub';
  /** Path to deep-link to once loaded (push-tap routing). Root only. */
  initialNavPath?: string | null;
};

export default function WebViewContainer({ url, mode, initialNavPath }: Props) {
  const webViewRef = useRef<WebView>(null);
  // PlatformChannel over the single react-native-webview channel. `onMessage`
  // is wired to the WebView prop; Web->Native handlers are registered below.
  const bridge = useMemo(() => createNativeChannel(webViewRef), []);
  const router = useRouter();
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);
  const isRoot = mode === 'root';

  // Connect this container to the WebView orchestrator (spec: shared controller).
  // A stable id identifies it in the live stack for the duration of its mount.
  const registry = useWebViewRegistry();
  const [id] = useState(() => `${mode}-${nextWebViewSeq()}`);

  const [currentPath, setCurrentPath] = useState<string>('/');
  const canGoBackRef = useRef(false);
  const lastBackPressRef = useRef(0);
  const pendingNavRef = useRef<string | null>(initialNavPath ?? null);
  const permissionsPrimedRef = useRef(false);
  const cleanupStartedRef = useRef(false);

  // Launch overlay (root only): a branded screen held over the WebView until
  // the web cleanup loop reports back, masking the service-worker/cache purge.
  const [overlayVisible, setOverlayVisible] = useState(isRoot);
  // Lazy useState (not useRef().current) so the Animated.Value is created once
  // without reading a ref during render (react-hooks/refs).
  const [overlayOpacity] = useState(() => new Animated.Value(1));

  // Prime camera (photo upload) + location (campus map) once logged in, so the
  // portal's getUserMedia / geolocation work without a second WebView prompt.
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

  // --- Lifecycle: cache, notifications, deep-link subscription (root only) ---
  useEffect(() => {
    // Sub-pages share the process-wide WebView cache; only the launch screen
    // clears it (login/cookies preserved) and owns notifications + overlay.
    if (!isRoot) return;
    clearWebViewCache(webViewRef);

    const unsubForeground = setupForegroundNotifications();
    const unsubOpen = subscribeNotificationOpen((path) => {
      // If the page is up, navigate immediately; otherwise queue it for onLoad.
      navigateSpa(path);
      pendingNavRef.current = path;
    });
    // Re-post the FCM token whenever the app returns to the foreground, so the
    // web always holds the latest token after a backgrounded refresh (spec §5.A #3).
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
  }, [dismissOverlay, isRoot, navigateSpa, postFcmToken]);

  // --- Orchestrator: register this container + expose its imperative handle --
  useEffect(() => {
    const handle: WebViewHandle = {
      reload: () => webViewRef.current?.reload(),
      reloadClearCache: () => clearCacheAndReload(webViewRef),
      goBackSpa: () => webViewRef.current?.goBack(),
      navigateSpa: (path) => navigateSpa(path),
      refreshFcmToken: () => void postFcmToken(),
    };
    registry.registerWebView({ id, mode, url, path: '/' }, handle);
    return () => registry.unregisterWebView(id);
  }, [id, mode, url, registry, navigateSpa, postFcmToken]);

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
        // Sub-page: the back button pops this native container (spec §3.C.1).
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
  // Register typed handlers on the channel. Payloads are already Zod-validated
  // by `@inu-appcenter/intip-bridge`, so each handler receives a narrowed value.
  useEffect(() => {
    const { channel } = bridge;
    const offs = [
      // Push a new native WebView container onto the stack (spec §3.B/§4).
      // The web only emits this for non-main-tab destinations.
      channel.on('navigateTo', ({ path, url }) => {
        router.push({ pathname: '/webview', params: { url, path } });
      }),
      // Pop the top-most container (spec §3.C). No-op on the root.
      channel.on('goBack', () => {
        if (router.canGoBack()) router.back();
      }),
      channel.on('loginSuccess', () => {
        void postFcmToken();
        primeWebPermissions();
        registry.mergeSession({ loggedIn: true, loginAt: Date.now() });
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
      // Deep-link to the OS settings so the user can grant a denied
      // permission (spec §4.A).
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
  }, [bridge, dismissOverlay, id, postFcmToken, primeWebPermissions, registry, router]);

  // --- External links + Android downloads ------------------------------------
  const onShouldStartLoadWithRequest = useCallback((request: ShouldStartLoadRequest) => {
    const { url: target } = request;
    // Allow sub-frame / resource loads (iOS reports these too).
    if (request.isTopFrame === false) return true;

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

  // Root sits on the main tabs -> no WebView-level swipe-back; sub-pages let the
  // native stack own the swipe so it pops the container (spec §3.C.2 / §6.5).
  const webViewSwipeBack = isRoot && !isMainTabPath(currentPath);

  return (
    // Fill the screen but ignore the bottom inset so content reaches the edge.
    <View style={[styles.fill, { backgroundColor }]}>
      <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
        <WebView
          ref={webViewRef}
          source={{ uri: url }}
          style={[styles.fill, { backgroundColor }]}
          // Identify as the official app so the web enables multi-WebView routing.
          applicationNameForUserAgent={APP_UA_SUFFIX}
          // Cache: never serve from cache; we also clearCache() on mount.
          cacheEnabled={false}
          // Bridge wiring: shims + alert override before content, observers after.
          onMessage={bridge.onMessage}
          injectedJavaScriptBeforeContentLoaded={BRIDGE_SHIM_SCRIPT}
          injectedJavaScript={INJECTED_SCRIPT}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onNavigationStateChange={onNavigationStateChange}
          onLoadEnd={onLoadEnd}
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
      </SafeAreaView>

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
