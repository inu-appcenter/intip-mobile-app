/**
 * Reads the web portal's current JWT pair out of the WebView, for a native
 * shell that would otherwise never be told it.
 *
 * The web only sends `syncTokenInfo` from `setTokenInfo()` — on login and on
 * token refresh. A session the web restores from its own `localStorage` on
 * page load never goes through that, so after a reinstall (or anything else
 * that empties the native store while the WebView's storage survives) the
 * portal is logged in and the shell has no token: every authenticated widget
 * fetch stops before it starts, and the schedule widgets show "로그인하고
 * 시작하기" to a user who is plainly logged in.
 *
 * Fixing that on the web side means a production deploy; this works against
 * the portal as it is deployed today. It depends on the web's storage key
 * (`tokenInfo`, plain JSON — `useUserStore`'s `getInitialToken`), so if that
 * ever changes, the probe quietly reports "no token" and the shell falls back
 * to waiting for the next `syncTokenInfo`.
 */
import type { TokenInfoPayload } from '../../packages/intip-bridge/src/messages';

/** Out-of-band marker, peeled off in `WebViewContainer` before the bridge channel parses the message. */
export const TOKEN_PROBE_MARKER = '__intipTokenProbe';

/**
 * Posts the web's stored token (or null) back to native.
 *
 * Built by plain concatenation with no backslash escapes anywhere — see the
 * injected-script notes: a template literal eats escapes, and a parse error in
 * an injected script fails silently. A `localStorage` that throws (some
 * hardened WebView configurations do) posts nothing, which leaves native as it
 * was.
 */
export const TOKEN_PROBE_SCRIPT =
  '(function(){try{' +
  "var t=window.localStorage.getItem('tokenInfo');" +
  'window.ReactNativeWebView.postMessage(JSON.stringify({' +
  TOKEN_PROBE_MARKER +
  ':t}));' +
  '}catch(e){}})();true;';

function isTokenInfo(value: unknown): value is TokenInfoPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === 'string' &&
    v.accessToken.length > 0 &&
    typeof v.refreshToken === 'string' &&
    typeof v.accessTokenExpiredTime === 'string' &&
    typeof v.refreshTokenExpiredTime === 'string'
  );
}

/**
 * Parses a raw WebView message.
 *
 * - `undefined` — not a probe reply; let the bridge channel have it.
 * - `{ token: null }` — a probe reply saying the web holds no usable token
 *   (logged out, or storage in a shape we don't recognise).
 * - `{ token }` — the web's current pair.
 */
export function parseTokenProbe(raw: string): { token: TokenInfoPayload | null } | undefined {
  if (!raw.includes(TOKEN_PROBE_MARKER)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || !(TOKEN_PROBE_MARKER in data)) return undefined;

  const stored = (data as Record<string, unknown>)[TOKEN_PROBE_MARKER];
  if (typeof stored !== 'string') return { token: null };
  try {
    const parsed: unknown = JSON.parse(stored);
    return { token: isTokenInfo(parsed) ? parsed : null };
  } catch {
    return { token: null };
  }
}

/**
 * What to do with the web's token given what native already holds.
 *
 * - `adopt` — native has nothing, or the web's pair is newer.
 * - `clear` — the web is logged out but native still holds a pair; keeping it
 *   would leave a previous account's classes on the home screen.
 * - `keep` — anything else.
 *
 * "Newer" matters because tokens rotate on both sides. Native refreshes on its
 * own when the app runs headless and tells the web afterwards only if a
 * WebView happens to be listening; blindly overwriting would hand native back
 * the web's older pair, whose refresh token the server has already retired.
 * Expiry times are compared as strings: both come from the same backend in the
 * same `YYYY-MM-DDTHH:mm:ss` naive format, where string order is time order.
 */
export function resolveWebToken(
  web: TokenInfoPayload | null,
  native: TokenInfoPayload | null,
): 'adopt' | 'clear' | 'keep' {
  if (!web) return native ? 'clear' : 'keep';
  if (!native) return 'adopt';
  if (web.accessToken === native.accessToken) return 'keep';
  return web.accessTokenExpiredTime.slice(0, 19) > native.accessTokenExpiredTime.slice(0, 19)
    ? 'adopt'
    : 'keep';
}
