/**
 * A single INTIP WebView instance — the reusable "content unit" of the native
 * multi-WebView stack. Unlike the old `WebViewContainer`, this component is
 * **router-free**: it owns only the WebView + the JS<->Native bridge, and it
 * lives inside the persistent {@link WebViewHost} rather than on an expo-router
 * screen. That persistence is what lets the warm pool reuse an instance across
 * navigations without re-booting its JS context (a WKWebView cannot be
 * reparented across screen trees).
 *
 * Navigation is delegated to the host through callbacks: the web's `navigateTo`
 * becomes {@link Props.onNavigateTo} (host pushes a sub-instance) and `goBack`
 * becomes {@link Props.onGoBack} (host pops). The root instance additionally
 * owns the launch overlay, cache purge, notifications and FCM lifecycle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  Linking,
  Platform,
  StyleSheet,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, { type WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { createNativeChannel } from '@inu-appcenter/intip-bridge/native';
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
  /** Absolute URL this instance loads. */
  url: string;
  /** Root portal hosts the main tabs; sub-pages are pushed on top. */
  mode: 'root' | 'sub';
  /** Path to deep-link to once loaded (push-tap routing). Root only. */
  initialNavPath?: string | null;
  /** Web asked to push a new sub-page — the host owns the custom stack. */
  onNavigateTo: (url: string, path: string) => void;
  /** Web asked to go back — the host pops the top sub-page (no-op on root). */
  onGoBack: () => void;
  /**
   * Web asked to return to a home-tab path (`/home`, `/m/home`). The host
   * collapses the whole sub-stack back to root and drives root there — see
   * `targetPath` below, which is what actually performs that SPA move.
   */
  onGoHome: (path: string) => void;
  /** The WebContent process died (iOS jetsam / Android render-process gone). Only
   * meaningful while `active === false` (parked warm slot) — see the handler below. */
  onContentProcessTerminated?: () => void;
  /**
   * PILOT (temp, Android only): Android WebView renders via SurfaceView by
   * default, a separate OS-compositor surface that doesn't reliably respect
   * an ancestor's transform animation — confirmed as the source of the
   * reveal-slide flicker (reproduced even revealing already-fully-loaded
   * content). Forcing 'software' (TextureView-based) rendering for the
   * animation's duration fixes it, but is too slow to leave on permanently
   * — this prop scopes it to exactly the slide.
   */
  androidSoftwareRenderDuringSlide?: boolean;
  /**
   * Tier 3 warm pool: `false` while parked (suspended, hidden from the
   * controller stack), `true` once revealed/promoted. `undefined` (root and
   * plain cold sub-pages) means "not pool-managed" — no `setActive` is ever
   * sent and the instance registers with the controller immediately, as in M1.
   */
  active?: boolean;
  /**
   * SPA-route this (already-booted) instance to `path` whenever the value
   * changes (queued if the instance hasn't finished its first `routeChange`
   * yet, flushed once it does). Two independent callers drive this:
   *  - Tier 3 warm pool: pre-navigate a parked warm slot ahead of adoption
   *    (latest prewarm intent overrides an earlier one).
   *  - `goHome`: drive the always-loaded root instance to a home path after
   *    the sub-stack collapses (see `WebViewHost.goHome`).
   */
  targetPath?: string;
  /** Web sent a `prewarm` touchstart intent. Only wired for the root instance. */
  onPrewarm?: (url: string, path: string) => void;
  /** SPA route changed. Used by the host to detect "shell interactive" (root only). */
  onRouteChange?: (path: string) => void;
};

export default function WebViewInstance({
  url,
  mode,
  initialNavPath,
  onNavigateTo,
  onGoBack,
  onGoHome,
  onContentProcessTerminated,
  active,
  targetPath,
  onPrewarm,
  onRouteChange,
  androidSoftwareRenderDuringSlide,
}: Props) {
  const webViewRef = useRef<WebView>(null);
  // PlatformChannel over the single react-native-webview channel. `onMessage`
  // is wired to the WebView prop; Web->Native handlers are registered below.
  // The channel only stores the ref and reads `.current` later (in post/reload),
  // never during render — so the react-hooks/refs warning is a false positive.
  // eslint-disable-next-line react-hooks/refs
  const bridge = useMemo(() => createNativeChannel(webViewRef), []);
  const scheme = useColorScheme();
  const backgroundColor = backgroundColorFor(scheme);
  const isRoot = mode === 'root';
  // Stable for the instance's lifetime — `url` never changes after mount, so
  // this can't flip mid-session. Deriving it from a live-changing SPA route
  // instead would flip which tree branch renders (SafeAreaView-wrapped or
  // not) and remount the WebView, losing its JS context (same class of bug
  // as the warm-pool reconciliation issue in WebViewHost).
  const edgeToEdge = useMemo(() => {
    if (isRoot) return true;
    try {
      return isEdgeToEdgePath(new URL(url).pathname);
    } catch {
      return false;
    }
  }, [isRoot, url]);

  // Connect this instance to the WebView orchestrator (spec: shared controller).
  // A stable id identifies it in the live stack for the duration of its mount.
  const registry = useWebViewRegistry();
  const [id] = useState(() => `${mode}-${nextWebViewSeq()}`);

  const [currentPath, setCurrentPath] = useState<string>('/');
  const pendingNavRef = useRef<string | null>(initialNavPath ?? null);
  const permissionsPrimedRef = useRef(false);
  const cleanupStartedRef = useRef(false);
  // Tier 3 warm pool: independent of the root-only `pendingNavRef`/deep-link
  // queue above, so promoting a warm slot can never interfere with root's
  // push-notification flow. Flushed once, same as pendingNavRef, in onLoadEnd.
  const hasLoadedRef = useRef(false);
  const pendingTargetRef = useRef<string | undefined>(targetPath);

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

  // Tier 3 warm pool: suspend(false)/resume(true) the parked instance. Only
  // fires for pool-managed instances (`active` explicitly boolean) — root and
  // plain cold sub-pages leave `active` undefined and never touch this, so a
  // normal push never triggers a wasted suspend/resume + reveal-revalidate.
  useEffect(() => {
    if (active === undefined) return;
    bridge.channel.send('setActive', active);
  }, [active, bridge]);

  // Tier 3 warm pool: SPA-navigate an already-booted instance to `targetPath`,
  // once the SPA has reported its own first route (or queue it if it hasn't —
  // flushed on the first `routeChange` below). Re-fires on change so a later
  // prewarm intent overrides an earlier one still in flight.
  useEffect(() => {
    if (targetPath === undefined) return;
    if (hasLoadedRef.current) navigateSpa(targetPath);
    else pendingTargetRef.current = targetPath;
  }, [targetPath, navigateSpa]);

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

  // --- Orchestrator: register this instance + expose its imperative handle ---
  useEffect(() => {
    // Tier 3 warm pool: a parked slot (`active === false`) stays out of the
    // controller stack until adopted, so the dev panel only ever shows real
    // navigation entries. Once promoted, `active` flips to `true` and this
    // effect re-runs (same component instance, no remount) and registers.
    if (active === false) return;
    const handle: WebViewHandle = {
      reload: () => webViewRef.current?.reload(),
      reloadClearCache: () => clearCacheAndReload(webViewRef),
      goBackSpa: () => webViewRef.current?.goBack(),
      navigateSpa: (path) => navigateSpa(path),
      refreshFcmToken: () => void postFcmToken(),
    };
    registry.registerWebView({ id, mode, url, path: '/' }, handle);
    return () => registry.unregisterWebView(id);
  }, [id, mode, url, registry, navigateSpa, postFcmToken, active]);

  // --- Bridge: Web -> Native -------------------------------------------------
  // Register typed handlers on the channel. Payloads are already Zod-validated
  // by `@inu-appcenter/intip-bridge`, so each handler receives a narrowed value.
  useEffect(() => {
    const { channel } = bridge;
    const offs = [
      // Push a new sub-page — the host owns the custom stack (spec §3.B/§4).
      // The web only emits this for non-main-tab destinations.
      channel.on('navigateTo', ({ path, url: target }) => {
        onNavigateTo(target, path);
      }),
      // Pop the top-most sub-page (spec §3.C). No-op on the root.
      channel.on('goBack', () => {
        onGoBack();
      }),
      // Return to a home-tab path — collapse the stack to root and drive
      // root there, regardless of which instance (root or a sub-page) sent it.
      channel.on('goHome', ({ path }) => {
        onGoHome(path);
      }),
      channel.on('loginSuccess', () => {
        void postFcmToken();
        primeWebPermissions();
        registry.mergeSession({ loggedIn: true, loginAt: Date.now() });
      }),
      channel.on('routeChange', (path) => {
        setCurrentPath(path || '/');
        registry.updateWebView(id, { path: path || '/' });
        onRouteChange?.(path || '/');
        // Tier 3 warm pool: flush a queued prewarm target on the SPA's FIRST
        // reported route, not on document-load (onLoadEnd) — the web app's
        // own boot-time redirect (e.g. "/" -> "/home") can otherwise race
        // with and silently overwrite an externally-triggered `navigate()`
        // sent too early, before the router/history listeners have settled.
        if (!hasLoadedRef.current) {
          hasLoadedRef.current = true;
          if (pendingTargetRef.current) {
            navigateSpa(pendingTargetRef.current);
            pendingTargetRef.current = undefined;
          }
        }
      }),
      // Tier 3 warm pool: link touchstart intent. Only meaningful when the
      // host wires `onPrewarm` (root only) — inert (no-op) for sub-pages.
      channel.on('prewarm', ({ path, url: target }) => {
        onPrewarm?.(target, path);
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
  }, [
    bridge,
    dismissOverlay,
    id,
    navigateSpa,
    onGoBack,
    onGoHome,
    onNavigateTo,
    onPrewarm,
    onRouteChange,
    postFcmToken,
    primeWebPermissions,
    registry,
  ]);

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
  // gone). A parked warm instance can't self-heal usefully (nothing is being
  // shown) — bubble up so the pool manager marks it dead and adopt-on-navigateTo
  // cold-falls-back. A visible instance (root, cold sub, or promoted) reloads
  // itself in place.
  const onContentProcessDied = useCallback(() => {
    if (active === false) onContentProcessTerminated?.();
    else webViewRef.current?.reload();
  }, [active, onContentProcessTerminated]);

  // Root sits on the main tabs -> no WebView-level swipe-back; sub-pages let the
  // host's custom stack own the swipe so it pops the instance (spec §3.C.2 / §6.5).
  const webViewSwipeBack = isRoot && !isMainTabPath(currentPath);

  const webView = (
    <WebView
      ref={webViewRef}
      source={{ uri: url }}
      style={[styles.fill, { backgroundColor }]}
      androidLayerType={
        Platform.OS === 'android' && androidSoftwareRenderDuringSlide ? 'software' : undefined
      }
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
    // Fill the host layer but ignore the bottom inset so content reaches the edge.
    <View style={[styles.fill, { backgroundColor }]}>
      {edgeToEdge ? (
        // Root (and sub-pages whose page has been migrated, see
        // `isEdgeToEdgePath`) go fully edge-to-edge (top/left/right too) —
        // the web owns those insets via env(safe-area-inset-*) CSS, matching
        // how it already owns the bottom inset everywhere. Everything else
        // keeps the native reservation below until migrated the same way.
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
