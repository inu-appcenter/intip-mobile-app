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
 * All scripts are guarded so re-injection is a no-op.
 */

/** Shared `post()` helper source — reused by every injected script fragment. */
const POST_HELPER = `
  function post(type, payload) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, payload: payload }));
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
  const iosShim = `
    window.webkit = window.webkit || {};
    window.webkit.messageHandlers = window.webkit.messageHandlers || {};
    var mh = window.webkit.messageHandlers;
    function makeHandler(type, transform) {
      return { postMessage: function (body) { post(type, transform ? transform(body) : body); } };
    }
    mh.navigateTo = makeHandler('navigateTo', function (b) {
      b = b || {};
      return { path: typeof b.path === 'string' ? b.path : '', url: typeof b.url === 'string' ? b.url : '' };
    });
    mh.goBack = makeHandler('goBack');
    mh.requestAppUpdate = makeHandler('requestAppUpdate');
    mh.loginSuccess = makeHandler('loginSuccess', function (b) { return b == null ? '' : String(b); });
    mh.openAppSettings = makeHandler('openAppSettings');
    mh.requestPermissionSettings = makeHandler('requestPermissionSettings');
    mh.logWebDiagnostics = makeHandler('logWebDiagnostics', function (b) { return b == null ? '' : String(b); });
    mh.onLaunchWebCleanupFinished = makeHandler('onLaunchWebCleanupFinished', function (b) { return b == null ? '' : String(b); });
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
