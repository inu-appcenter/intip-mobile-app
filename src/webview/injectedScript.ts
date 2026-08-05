/**
 * JavaScript injected into the portal.
 *
 * Two injection phases are used:
 *
 *  1. Before content loads (`injectedJavaScriptBeforeContentLoaded`):
 *     - the **bridge shims** that recreate `window.AndroidBridge` (Android) and
 *       `window.webkit.messageHandlers.*` (iOS) so the web's existing
 *       multi-WebView detection + routing works unchanged (spec §2, §4);
 *     - the `window.alert` override.
 *
 *  2. At document end (`injectedJavaScript`):
 *     - the route observer (`routeChange`), login detection (`loginSuccess`),
 *       and the `window.__intipNavigate` deep-link helper.
 *
 * All scripts above are guarded so re-injection is a no-op. Separately,
 * `buildSafeAreaInsetsScript` is re-injected (imperatively, via
 * `webViewRef.current.injectJavaScript`) on every insets change — it's a pure
 * CSS-variable write, so re-running it is always safe.
 */

/**
 * Shared `post()` helper source — reused by every injected script fragment.
 *
 * Emits the `@inu-appcenter/intip-bridge` envelope (`{ event, value, v }`) so
 * that the shell-injected observers (routeChange/jsAlert) and the legacy bridge
 * shim (used by old web versions) all speak the same protocol the native
 * `createNativeChannel` parses. The first arg is kept named `type` for source
 * compatibility but is serialised as `event`.
 */
const POST_HELPER = `
  function post(type, payload) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ event: type, value: payload, v: 1 }));
    } catch (e) {}
  }
`;

/**
 * Bridge shim. The web frontend calls `window.AndroidBridge.navigateTo(...)`
 * (Android) or `window.webkit.messageHandlers.navigateTo.postMessage(...)`
 * (iOS). Under react-native-webview neither object carries the app's methods,
 * so we recreate them here and forward every call to the single postMessage
 * channel parsed by `bridge.ts`.
 *
 * The shim is platform-specific: it must NOT expose `window.AndroidBridge` on
 * iOS (or `window.webkit.messageHandlers.requestAppUpdate` on Android) or the
 * web's environment detection would mis-classify the platform (spec §2.B).
 */
export function buildBridgeShimScript(platform: 'android' | 'ios'): string {
  const androidShim = `
    window.AndroidBridge = {
      navigateTo: function (destination, url) { post('navigateTo', { path: destination, url: url }); },
      goBack: function () { post('goBack'); },
      requestAppUpdate: function () { post('requestAppUpdate'); },
      openAppSettings: function () { post('openAppSettings'); },
      requestPermissionSettings: function () { post('requestPermissionSettings'); },
      logWebDiagnostics: function (payload) { post('logWebDiagnostics', payload == null ? '' : String(payload)); },
      onLaunchWebCleanupFinished: function (payload) { post('onLaunchWebCleanupFinished', payload == null ? '' : String(payload)); }
    };
  `;

  // iOS handlers receive a single `body`. navigateTo's body is a dict
  // ({ path, url }); the rest ignore it. Each must expose a `postMessage`.
  //
  // IMPORTANT (WKWebView quirk): `window.webkit.messageHandlers` is a special
  // native accessor — adding properties to it (`mh.navigateTo = …`) is silently
  // dropped even though it reports `isExtensible: true`. So we cannot extend it.
  // Instead we rebuild `window.webkit` as a plain object whose `messageHandlers`
  // keeps react-native-webview's own `ReactNativeWebView` handler (the single
  // real native channel that `post()` ultimately flows through) and adds the
  // INTIP bridge handlers the web frontend calls.
  const iosShim = `
    var __nativeMH = (window.webkit && window.webkit.messageHandlers) || {};
    function makeHandler(type, transform) {
      return { postMessage: function (body) { post(type, transform ? transform(body) : body); } };
    }
    window.webkit = {
      messageHandlers: {
        ReactNativeWebView: __nativeMH.ReactNativeWebView,
        navigateTo: makeHandler('navigateTo', function (b) {
          b = b || {};
          return { path: typeof b.path === 'string' ? b.path : '', url: typeof b.url === 'string' ? b.url : '' };
        }),
        goBack: makeHandler('goBack'),
        requestAppUpdate: makeHandler('requestAppUpdate'),
        loginSuccess: makeHandler('loginSuccess', function (b) { return b == null ? '' : String(b); }),
        openAppSettings: makeHandler('openAppSettings'),
        requestPermissionSettings: makeHandler('requestPermissionSettings'),
        logWebDiagnostics: makeHandler('logWebDiagnostics', function (b) { return b == null ? '' : String(b); }),
        onLaunchWebCleanupFinished: makeHandler('onLaunchWebCleanupFinished', function (b) { return b == null ? '' : String(b); })
      }
    };
  `;

  return `
(function () {
  if (window.__intipBridgeShimReady) return;
  window.__intipBridgeShimReady = true;
  ${POST_HELPER}
  ${platform === 'android' ? androidShim : iosShim}

  // window.alert -> native dialog (the WebView's own iOS panel is unreliable
  // under react-native-screens; alert() returns no value so bridging is lossless).
  window.alert = function (message) {
    post('jsAlert', message == null ? '' : String(message));
  };
})();
true;
`;
}

/**
 * Document-end script: route observer + login detection + deep-link helper.
 * Reproduces the original `WebViewScripts.routeObserver` + `tokenInfo` login
 * detection. Safe to inject more than once.
 */
export const INJECTED_SCRIPT = `
(function () {
  if (window.__intipBridgeReady) return;
  window.__intipBridgeReady = true;
  ${POST_HELPER}

  function reportRoute() {
    post('routeChange', window.location.pathname);
  }

  // --- route observer -------------------------------------------------------
  var origPush = history.pushState;
  history.pushState = function () {
    var r = origPush.apply(this, arguments);
    reportRoute();
    return r;
  };
  var origReplace = history.replaceState;
  history.replaceState = function () {
    var r = origReplace.apply(this, arguments);
    reportRoute();
    return r;
  };
  window.addEventListener('popstate', reportRoute);

  // --- login detection ------------------------------------------------------
  try {
    if (window.localStorage && localStorage.getItem('tokenInfo')) {
      post('loginSuccess', 'ok');
    }
  } catch (e) {}

  // --- native -> web deep link ----------------------------------------------
  // Best-effort SPA navigation used when a push notification is tapped.
  window.__intipNavigate = function (path) {
    try {
      if (!path || window.location.pathname === path) return;
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (e) {}
  };

  // Report the landing route once so native can set up the back gesture.
  reportRoute();
})();
true;
`;

/**
 * Launch cleanup loop (spec §5.B). Unregisters service workers and clears the
 * CacheStorage, then signals completion through the bridge shim so the native
 * loading overlay can fade out. Injected once after the root page first loads.
 */
export const LAUNCH_CLEANUP_SCRIPT = `
(function() {
  const tasks = [];
  try {
    if ('serviceWorker' in navigator) {
      tasks.push(
        navigator.serviceWorker.getRegistrations()
          .then(function(regs) {
            return Promise.allSettled(regs.map(reg => reg.unregister()));
          })
      );
    }
  } catch (e) {}
  try {
    if ('caches' in window) {
      tasks.push(
        caches.keys().then(names => Promise.allSettled(names.map(name => caches.delete(name))))
      );
    }
  } catch (e) {}
  Promise.allSettled(tasks).then(function() {
    if (window.AndroidBridge && window.AndroidBridge.onLaunchWebCleanupFinished) {
      window.AndroidBridge.onLaunchWebCleanupFinished("done");
    }
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.onLaunchWebCleanupFinished) {
      window.webkit.messageHandlers.onLaunchWebCleanupFinished.postMessage("done");
    }
  });
})();
true;
`;

/**
 * Native safe-area insets (dp), mirrored into the page as CSS custom
 * properties so it can pad itself without relying solely on the WebView
 * engine's own `env(safe-area-inset-*)` support (inconsistent on Android).
 * Every pushed sub-page skips the native top-inset reservation (see
 * `WebViewContainer`), so the page needs this value to pad its own header.
 *
 * Pure property writes, safe to inject repeatedly (initial load + every
 * insets change, e.g. rotation/foldable) with no re-entrancy guard needed.
 */
export function buildSafeAreaInsetsScript(insets: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}): string {
  const vars = JSON.stringify({
    '--native-safe-area-inset-top': `${insets.top}px`,
    '--native-safe-area-inset-bottom': `${insets.bottom}px`,
    '--native-safe-area-inset-left': `${insets.left}px`,
    '--native-safe-area-inset-right': `${insets.right}px`,
  });
  return `
(function () {
  var vars = ${vars};
  function apply() {
    var root = document.documentElement;
    if (!root) return;
    for (var k in vars) root.style.setProperty(k, vars[k]);
  }
  apply();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  }
})();
true;
`;
}

/** Build the call that hands an FCM token to the web context (Native -> Web). */
export function buildReceiveFcmTokenScript(token: string): string {
  const safe = JSON.stringify(token);
  return `window.onReceiveFcmToken && window.onReceiveFcmToken(${safe}); true;`;
}

/** Build the call that deep-links the SPA to a path (push-tap routing). */
export function buildNavigateScript(path: string): string {
  const safe = JSON.stringify(path);
  return `window.__intipNavigate && window.__intipNavigate(${safe}); true;`;
}
