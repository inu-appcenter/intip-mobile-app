/**
 * Native-side JWT expiry/refresh, backed by `secureTokenStore`. Lets the
 * shell call authenticated backend endpoints (FCM token registration) without
 * a live WebView — refreshing the access token itself when it's expired.
 *
 * The refresh endpoint rotates both accessToken and refreshToken on every
 * call (confirmed against the legacy Android client), so a web-side refresh
 * happening in the same narrow window as a native one can make one side's
 * refreshToken stale. That's treated as an acceptable edge case here — no
 * distributed lock, just last-write-wins via `syncTokenInfo`/`tokenInfoUpdated`.
 */
import { API_BASE_URL } from '../config/env';
import { clearTokenInfo, readTokenInfoStrict, saveTokenInfo, type TokenInfo } from './secureTokenStore';

/**
 * Parse a timezone-less "naive" datetime string (e.g.
 * `"2025-01-22T23:25:47.754524713"`) as a device-local `Date`, mirroring the
 * legacy Android client's `LocalDateTime.parse` + `LocalDateTime.now()`
 * comparison. Treating it as UTC (`new Date(str + "Z")`) would compare
 * against the wrong instant on any device not in UTC.
 */
export function parseNaiveLocal(dateTimeStr: string): Date | null {
  const m = dateTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
}

export function isExpired(dateTimeStr: string, now: Date): boolean {
  const expiry = parseNaiveLocal(dateTimeStr);
  return expiry ? now.getTime() >= expiry.getTime() : true;
}

let listener: ((tokenInfo: TokenInfo) => void) | null = null;

/** Subscribe to native-initiated refreshes, to echo the result back to the
 * live WebView(s). No queue — a refresh with nobody subscribed (fully
 * backgrounded/killed) is fine to drop, the web side reconciles via its own
 * 401 flow next time it runs. */
export function onNativeTokenRefresh(cb: (tokenInfo: TokenInfo) => void): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

/**
 * What is known about this device's session.
 *
 * `unknown` is the one that matters: the keychain was locked, or the refresh
 * request never got an answer. It says nothing about whether the user is
 * logged in, so nothing may be torn down on the strength of it.
 */
export type Session =
  | { state: 'valid'; tokenInfo: TokenInfo }
  | { state: 'none' }
  | { state: 'unknown' };

let refreshInFlight: Promise<Session> | null = null;

async function doRefresh(stored: TokenInfo): Promise<Session> {
  if (!stored.refreshToken || isExpired(stored.refreshTokenExpiredTime, new Date())) {
    await clearTokenInfo();
    return { state: 'none' };
  }
  try {
    const res = await fetch(`${API_BASE_URL}/api/members/refresh`, {
      method: 'POST',
      headers: { refresh: stored.refreshToken },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        await clearTokenInfo();
        return { state: 'none' };
      }
      return { state: 'unknown' };
    }
    const body = await res.json();
    const newTokenInfo: TokenInfo = body.data;
    await saveTokenInfo(newTokenInfo);
    listener?.(newTokenInfo);
    return { state: 'valid', tokenInfo: newTokenInfo };
  } catch (err) {
    console.warn('[authTokens] self-refresh failed', err);
    return { state: 'unknown' };
  }
}

/**
 * Resolves the session, refreshing (and persisting) the access token first if
 * it has expired. `none` is only ever a definite answer: nothing stored, the
 * refresh token expired, or the server rejected it.
 */
export async function getSession(): Promise<Session> {
  let stored: TokenInfo | null;
  try {
    stored = await readTokenInfoStrict();
  } catch (err) {
    console.warn('[authTokens] token store unreadable', err);
    return { state: 'unknown' };
  }
  if (!stored?.accessToken) return { state: 'none' };
  if (!isExpired(stored.accessTokenExpiredTime, new Date())) {
    return { state: 'valid', tokenInfo: stored };
  }

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(stored).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Returns a currently-valid accessToken, refreshing (and persisting) it
 * first if expired. `null` means no usable token right now — never synced
 * from the web login, the refresh token gone/expired, or simply unreachable
 * at the moment. Use `getSession` to tell those apart.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session.state === 'valid' ? session.tokenInfo.accessToken : null;
}
