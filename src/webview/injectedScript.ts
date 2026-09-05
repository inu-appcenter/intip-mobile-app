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
 *       a lazy geolocation-permission priming ping (`GEO_REQUEST_MARKER`), and
 *       the `window.__intipNavigate` deep-link helper.
 *
 * All scripts above are guarded so re-injection is a no-op. Separately,
 * `buildSafeAreaInsetsScript` is re-injected (imperatively, via
 * `webViewRef.current.injectJavaScript`) on every insets change — it's a pure
 * CSS-variable write, so re-running it is always safe.
 */

/**
 * Out-of-band marker for a lazy location-permission-priming ping. Deliberately
 * NOT an `@inu-appcenter/intip-bridge` event (see `webConsole.ts`'s
 * `WEB_CONSOLE_MARKER` for the same reasoning): it's a native-only signal, so
 * adding it to the bridge contract would force a cross-repo schema bump for
 * something the web side never needs to know about. Intercepted (and
 * swallowed) in `WebViewContainer`'s `onMessage` before the channel sees it.
 */
export const GEO_REQUEST_MARKER = '__intipGeoRequested';

/**
 * True when `raw` is the geolocation-priming ping posted by the patch
 * installed in `INJECTED_SCRIPT` below.
 */
export function isGeoPermissionRequest(raw: string): boolean {
  if (!raw.includes(GEO_REQUEST_MARKER)) return false;
  try {
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null && GEO_REQUEST_MARKER in data;
  } catch {
    return false;
  }
}

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
  // adds the INTIP bridge handlers the web frontend calls.
  //
  // The rebuild MUST keep the original `messageHandlers` reachable, hence
  // `Object.create(__nativeMH)`: own properties are the INTIP handlers, and any
  // other lookup falls through to the real native accessor.
  //
  // react-native-webview registers TWO native handlers, not one:
  // `ReactNativeWebView` (postMessage) and `ReactNativeHistoryShim`. The latter
  // is used by RNW's own document-start user script, which patches
  // history.pushState/replaceState and does
  //   window.webkit.messageHandlers.ReactNativeHistoryShim.postMessage(type)
  // on every history operation (that is how RNW detects SPA navigation and fires
  // onLoadingFinish). A plain object that copied only `ReactNativeWebView` hid it,
  // so every SPA navigation threw a TypeError inside RNW's injected script —
  // reported by WebKit as a bare "Script error." with no file/stack (injected code
  // has no script origin), and RNW's SPA navigation callback silently stopped
  // firing. Keep the prototype link so both handlers stay reachable.
  const iosShim = `
    var __nativeMH = (window.webkit && window.webkit.messageHandlers) || {};
    function makeHandler(type, transform) {
      return { postMessage: function (body) { post(type, transform ? transform(body) : body); } };
    }
    window.webkit = {
      messageHandlers: Object.assign(Object.create(__nativeMH), {
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
      })
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

  // --- lazy location-permission priming --------------------------------------
  // iOS WKWebView's geolocation runs on the app's own CoreLocation
  // authorization and won't prompt for it itself (unlike camera/mic, which
  // both WKWebView and Android WebView prompt for on demand — see
  // native/permissions.ts). Rather than ask for location up front on every
  // login, ping native the moment a page actually calls the geolocation API,
  // so the OS permission dialog only ever appears on a page that genuinely
  // needs it.
  try {
    if (navigator.geolocation) {
      var origGetCurrentPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      var origWatchPosition = navigator.geolocation.watchPosition.bind(navigator.geolocation);
      var notifyGeoRequested = function () {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ '${GEO_REQUEST_MARKER}': true }));
        } catch (e) {}
      };
      navigator.geolocation.getCurrentPosition = function () {
        notifyGeoRequested();
        return origGetCurrentPosition.apply(navigator.geolocation, arguments);
      };
      navigator.geolocation.watchPosition = function () {
        notifyGeoRequested();
        return origWatchPosition.apply(navigator.geolocation, arguments);
      };
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
 * In-page half of the back-gesture guard (issue #25).
 *
 * A back swipe starts inside a narrow band at the screen edge, and the page
 * keeps receiving those touches until the system decides the swipe really is a
 * back gesture. If the finger lingers there for the long-press timeout (~500ms
 * — i.e. any slightly slow swipe) the WebView starts a text selection / image
 * drag *mid back gesture*: the selection handles and the context menu pop up
 * and the content smears under the transition.
 *
 * The native edge guard in `WebViewContainer` cannot do this on its own, and
 * measurement on device (One UI, Android 16) says why: `ACTION_DOWN` reaches the
 * WebView before any native guard can rule on the touch, and cancelling the RN
 * touch stream afterwards does not reach Chromium's own gesture detector — the
 * guard activated 346ms in and the engine still fired its long-press haptic
 * 250ms later. The system's own `ACTION_CANCEL` is no help either; it was
 * measured arriving 3-16s after the touch began.
 *
 * What does work is telling the engine, at touch-down, to drop its default
 * handling for this touch. So for any touch that begins in the edge band:
 *
 *  - `touchstart` is `preventDefault`ed, which drops the engine's long-press
 *    selection and the OS haptic that rides along with it. The listener must be
 *    registered `{ passive: false }` — document-level touchstart is passive by
 *    default in Chromium and a passive listener's `preventDefault` is ignored;
 *  - the events a page starts an interaction from (`touchstart`, `pointerdown`,
 *    `mousedown`) are swallowed in the capture phase, so the page's own handler
 *    never runs. React binds its listeners to the root container, not
 *    `document`, so capturing here always wins the race. This is what stops a
 *    back swipe being read as the start of a drag or a long press, with no
 *    state left for the page to unwind afterwards;
 *  - a stylesheet (toggled by a class on `<html>`) kills `user-select`,
 *    `-webkit-touch-callout` and `-webkit-user-drag` everywhere, which is what
 *    the engine consults when the long-press timer fires;
 *  - `contextmenu` is swallowed while the guard is engaged, covering the
 *    link/image menu that does not go through selection.
 *
 * `preventDefault` also suppresses the synthesised `click`, which would kill
 * plain taps in the band, so a touch that never travels is replayed as a click
 * on `touchend`. Scrolling that starts in the band was measured to still work.
 * Editable targets are exempt throughout, so a text field at the edge keeps its
 * caret handles. Everything is released on `touchend`/`touchcancel`, with a
 * timer as a backstop in case the WebView eats the end event.
 *
 * Nothing outside the band changes: a long press there still selects text and
 * still vibrates, which is the control the fix was verified against.
 */
export function buildEdgeLongPressGuardScript(
  leftPx: number,
  rightPx: number,
): string {
  return `
(function () {
  if (window.__intipEdgeGuardReady) return;
  window.__intipEdgeGuardReady = true;

  // Backstop only: a committed back gesture can swallow touchend.
  var RELEASE_FALLBACK_MS = 2000;
  var CLASS = '__intip-edge-guard';

  try {
    var style = document.createElement('style');
    style.textContent =
      'html.' + CLASS + ', html.' + CLASS + ' * {' +
      '-webkit-user-select: none !important;' +
      'user-select: none !important;' +
      '-webkit-touch-callout: none !important;' +
      '-webkit-user-drag: none !important;' +
      '}';
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}

  var engaged = false;
  var releaseTimer = null;

  function isEditable(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
    }
    return false;
  }

  function engage() {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    engaged = true;
    try { document.documentElement.classList.add(CLASS); } catch (e) {}
    releaseTimer = setTimeout(release, RELEASE_FALLBACK_MS);
  }

  function release() {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    if (!engaged) return;
    engaged = false;
    try { document.documentElement.classList.remove(CLASS); } catch (e) {}
  }

  function inBand(clientX) {
    var width = window.innerWidth || document.documentElement.clientWidth || 0;
    return clientX <= handle.left || clientX >= width - handle.right;
  }

  // x of the point this event starts an interaction at, or null when the event
  // is not a single-finger start (a second finger is never a back gesture).
  function startX(e) {
    if (e.type === 'touchstart') {
      if (!e.touches || e.touches.length !== 1) return null;
      return e.touches[0].clientX;
    }
    return typeof e.clientX === 'number' ? e.clientX : null;
  }

  function isGuarded(e) {
    var x = startX(e);
    return x !== null && inBand(x) && !isEditable(e.target);
  }

  // Runtime handle so a dev build can A/B the fix without rebuilding: setting
  // window.__intipEdgeGuard.blocking = false (or .preventDefault = false)
  // restores the pre-fix behaviour from the next touch on.
  var handle = {
    blocking: true,
    preventDefault: true,
    // Live, because the band is not a constant: it changes with navigation
    // mode and with Samsung's gesture-sensitivity slider. Pushed by
    // buildEdgeGuardBandScript.
    left: ${leftPx},
    right: ${rightPx}
  };
  try { window.__intipEdgeGuard = handle; } catch (e) {}

  // Layer 1: the page never learns the touch happened. stopPropagation (not
  // stopImmediatePropagation) so the engage listener below still runs.
  function blockGestureStart(e) {
    if (!handle.blocking || !isGuarded(e)) return;
    e.stopPropagation();
    // Drops the engine's own default handling for this touch — the long-press
    // selection and the OS haptic with it. Cancelling the RN touch stream
    // demonstrably does not.
    if (handle.preventDefault && e.cancelable) e.preventDefault();
    // preventDefault also suppresses the synthesised click, so a plain tap in
    // the band would stop working. Remember it and replay it on touchend if
    // the finger never travelled: a tap is not a back gesture.
    if (e.type === 'touchstart') {
      var t0 = e.touches[0];
      pendingTap = { target: e.target, x: t0.clientX, y: t0.clientY, at: Date.now() };
    }
  }

  var pendingTap = null;
  var TAP_SLOP_PX = 10;
  var TAP_MAX_MS = 500;

  function dropTap() { pendingTap = null; }

  function maybeReplayTap(e) {
    var p = pendingTap;
    pendingTap = null;
    if (!p) return;
    if (Date.now() - p.at > TAP_MAX_MS) return;
    var t = e.changedTouches && e.changedTouches[0];
    if (t && (Math.abs(t.clientX - p.x) > TAP_SLOP_PX || Math.abs(t.clientY - p.y) > TAP_SLOP_PX)) return;
    try { if (p.target && p.target.click) p.target.click(); } catch (e4) {}
  }

  document.addEventListener('touchmove', function (e) {
    var p = pendingTap;
    if (!p) return;
    var t = e.touches && e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - p.x) > TAP_SLOP_PX || Math.abs(t.clientY - p.y) > TAP_SLOP_PX) dropTap();
  }, true);

  // passive:false — document-level touchstart is passive by default in
  // Chromium, and a passive listener's preventDefault() is ignored.
  document.addEventListener('touchstart', blockGestureStart, { capture: true, passive: false });
  document.addEventListener('pointerdown', blockGestureStart, true);
  document.addEventListener('mousedown', blockGestureStart, true);

  // Layer 2: suppress what the engine consults for the rest of the touch.
  document.addEventListener('touchstart', function (e) {
    if (engaged) return;
    if (isGuarded(e)) engage();
  }, true);

  document.addEventListener('touchend', function (e) { maybeReplayTap(e); release(); }, true);
  document.addEventListener('touchcancel', function () { dropTap(); release(); }, true);

  document.addEventListener('contextmenu', function (e) {
    if (engaged) e.preventDefault();
  }, true);
})();
true;
`;
}

/**
 * Dev-only instrumentation for the edge guard. Never injected in a release
 * build (see `documentEndScript` in `WebViewContainer`).
 *
 * The whole back-gesture investigation kept stalling on one unanswered
 * question: when a back swipe makes the device buzz, did the *page* ask for
 * that (`navigator.vibrate`, a deliberate drag-start haptic) or did the
 * *engine* (a ~500ms long press, whose haptic is emitted below JS where no
 * injected script can reach it)? The two have completely different fixes, and
 * nothing in the app could tell them apart.
 *
 * Pairing this with `adb logcat -s VibratorManagerService:V` answers it:
 * a vibration the OS logs but this never sees came from the engine.
 *
 * It also records the geometry every guess so far has been built on — where
 * the touch actually landed relative to the viewport edge, and how long the
 * page held the touch before it was cancelled. That is what says whether
 * the band actually in force matches what this device really reserves.
 */
export function buildEdgeGuardDiagnosticsScript(): string {
  return `
(function () {
  try { console.log('[edge-diag] boot'); } catch (e0) {}
  if (window.__intipEdgeDiagReady) return;
  window.__intipEdgeDiagReady = true;
 try {
  var TAG = '[edge-diag]';
  var startedAt = 0;
  var pending = null;

  // Read off the guard's live handle so the log never disagrees with the band
  // actually in force (it changes with navigation mode / sensitivity).
  function bandLeft() { try { return window.__intipEdgeGuard.left; } catch (e) { return -1; } }
  function bandRight() { try { return window.__intipEdgeGuard.right; } catch (e) { return -1; } }

  function describe(node) {
    if (!node || node.nodeType !== 1) return String(node);
    var out = node.tagName.toLowerCase();
    if (node.id) out += '#' + node.id;
    var cls = typeof node.className === 'string' ? node.className : '';
    if (cls) out += '.' + cls.trim().split(/\\s+/).slice(0, 3).join('.');
    if (node.getAttribute) {
      var day = node.getAttribute('data-day');
      if (day !== null) out += '[day=' + day + ',hour=' + node.getAttribute('data-hour') + ']';
    }
    return out;
  }

  // 1. Who asks for vibration. Silence here + a vibration in logcat == engine.
  try {
    var origVibrate = navigator.vibrate && navigator.vibrate.bind(navigator);
    if (origVibrate) {
      navigator.vibrate = function (pattern) {
        var stack = '';
        try { stack = new Error().stack || '(no stack)'; } catch (e) {}
        console.log(TAG, 'navigator.vibrate(' + JSON.stringify(pattern) + ')\\n' + stack);
        return origVibrate(pattern);
      };
    } else {
      console.log(TAG, 'navigator.vibrate unavailable — any buzz is engine-side');
    }
  } catch (e) {}

  // 2. Where each touch landed, and whether the guard claimed it.
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches.length === 1 ? e.touches[0] : null;
    if (!t) return;
    var w = window.innerWidth || document.documentElement.clientWidth || 0;
    var fromLeft = Math.round(t.clientX);
    var fromRight = Math.round(w - t.clientX);
    var inBand = fromLeft <= bandLeft() || fromRight <= bandRight();
    var blocking = true;
    try { blocking = !!(window.__intipEdgeGuard && window.__intipEdgeGuard.blocking); } catch (e2) {}
    startedAt = Date.now();
    pending = inBand;
    console.log(
      TAG, 'touchstart',
      'fromLeft=' + fromLeft, 'fromRight=' + fromRight,
      'viewport=' + w, 'screen=' + ((window.screen && window.screen.width) || '?'),
      'dpr=' + (window.devicePixelRatio || 1),
      'band=' + bandLeft() + '/' + bandRight(), 'inBand=' + inBand, 'blocking=' + blocking,
      'target=' + describe(e.target), 'path=' + location.pathname
    );
  }, true);

  // 3. How it ended. The gap before a cancel is the window the engine's
  //    ~500ms long press fires in — if it is longer than that, the native
  //    guard is arriving too late (or not at all).
  function logEnd(e) {
    if (pending === null) return;
    console.log(TAG, e.type, 'after=' + (Date.now() - startedAt) + 'ms', 'inBand=' + pending);
    pending = null;
  }
  document.addEventListener('click', function (e) {
    console.log(TAG, 'click x=' + Math.round(e.clientX) + ' target=' + describe(e.target));
  }, true);
  document.addEventListener('touchend', logEnd, true);
  document.addEventListener('touchcancel', logEnd, true);

  console.log(TAG, 'ready band=' + bandLeft() + '/' + bandRight() + ' viewport=' + (window.innerWidth || 0));
 } catch (err) {
  try { console.log('[edge-diag] THREW', (err && (err.stack || err.message)) || String(err)); } catch (e9) {}
 }
})();
true;
`;
}

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

/**
 * Pushes a new gesture band into a guard that is already running.
 *
 * The band is not fixed for the life of a page: the user can switch navigation
 * mode or move Samsung's gesture-sensitivity slider while the app sits in the
 * background. `buildEdgeLongPressGuardScript` bakes in whatever was known at
 * injection time and then reads `window.__intipEdgeGuard` on every touch, so
 * this only has to overwrite two numbers. Safe to run before the guard exists
 * (it does nothing) and safe to run repeatedly.
 */
export function buildEdgeGuardBandScript(
  leftPx: number,
  rightPx: number,
): string {
  return `
(function () {
  try {
    var g = window.__intipEdgeGuard;
    if (!g) return;
    g.left = ${leftPx};
    g.right = ${rightPx};
  } catch (e) {}
})();
true;
`;
}
