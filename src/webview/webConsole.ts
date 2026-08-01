/**
 * Dev-only relay of the web's `console.*` output to the native (Metro) log.
 *
 * Safari/Chrome remote inspection of the WebView is flaky (attach timing,
 * suspended content processes), so in dev builds we patch the web context's
 * console and forward every call over `ReactNativeWebView.postMessage`.
 *
 * The relay deliberately does NOT ride the `@inu-appcenter/intip-bridge`
 * PlatformChannel: it is a dev tool, not part of the native<->web contract,
 * and adding it there would force a cross-repo schema bump. Instead messages
 * carry their own marker key and are intercepted (and swallowed) in
 * `WebViewContainer`'s `onMessage` before the channel sees them.
 */

/** Top-level key marking a relayed console message. Not a bridge event. */
export const WEB_CONSOLE_MARKER = '__intipConsole';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];

/**
 * Injected before content loads (dev only) so boot-time logs are captured.
 * Patches console methods (still calling the originals, so remote inspectors
 * keep working when they do attach) and reports uncaught errors / rejections.
 */
export const WEB_CONSOLE_SCRIPT = `
(function () {
  if (window.__intipConsoleRelayReady) return;
  window.__intipConsoleRelayReady = true;

  function toText(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return String(arg.stack || arg);
    try {
      var seen = [];
      return JSON.stringify(arg, function (k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.indexOf(v) !== -1) return '[Circular]';
          seen.push(v);
        }
        return typeof v === 'function' ? String(v) : v;
      });
    } catch (e) {
      try { return String(arg); } catch (e2) { return '[unserializable]'; }
    }
  }

  function relay(level, args) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        '${WEB_CONSOLE_MARKER}': { level: level, parts: Array.prototype.map.call(args, toText) }
      }));
    } catch (e) {}
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level] && console[level].bind(console);
    console[level] = function () {
      relay(level, arguments);
      if (orig) orig.apply(null, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    relay('error', ['[uncaught] ' + (e.message || e) +
      (e.filename ? ' @' + e.filename + ':' + e.lineno : '')]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    relay('error', ['[unhandledrejection]', toText(e && e.reason)]);
  });
})();
true;
`;

/* eslint-disable no-console */
const NATIVE_LOGGERS: Record<Level, (...args: unknown[]) => void> = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
/* eslint-enable no-console */

/**
 * If `raw` is a relayed console message, log it natively (prefixed with the
 * instance's `tag` so interleaved multi-WebView output stays readable) and
 * return true — the caller must then NOT forward it to the bridge channel.
 */
export function relayWebConsoleMessage(raw: string, tag: string): boolean {
  if (!raw.includes(WEB_CONSOLE_MARKER)) return false;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof data !== 'object' || data === null) return false;
  const entry = (data as Record<string, unknown>)[WEB_CONSOLE_MARKER];
  if (typeof entry !== 'object' || entry === null) return false;
  const { level, parts } = entry as { level?: unknown; parts?: unknown };
  const logger =
    NATIVE_LOGGERS[(LEVELS as readonly string[]).includes(level as string) ? (level as Level) : 'log'];
  logger(`[web ${tag}]`, ...formatParts(Array.isArray(parts) ? parts : []));
  return true;
}

/**
 * Apply console printf-style substitution (`%s`/`%d`/`%i`/`%f`/`%o`/`%O`/`%j`;
 * `%c` styling is dropped) when the first part is a format string, the way
 * DevTools would — React logs warnings in that form. Extra args stay appended.
 */
function formatParts(parts: unknown[]): unknown[] {
  const [first, ...rest] = parts;
  if (typeof first !== 'string' || !/%[sdifoOjc%]/.test(first)) return parts;
  let i = 0;
  const text = first.replace(/%([sdifoOjc%])/g, (match, spec: string) => {
    if (spec === '%') return '%';
    if (i >= rest.length) return match;
    const arg = rest[i++];
    if (spec === 'c') return ''; // CSS styling — meaningless in a terminal
    if (spec === 'd' || spec === 'i') return String(parseInt(String(arg), 10));
    if (spec === 'f') return String(parseFloat(String(arg)));
    return typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg);
  });
  return [text, ...rest.slice(i)];
}
