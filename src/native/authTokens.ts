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
import { clearTokenInfo, readTokenInfo, saveTokenInfo, type TokenInfo } from './secureTokenStore';

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

let refreshInFlight: Promise<TokenInfo | null> | null = null;

async function doRefresh(stored: TokenInfo): Promise<TokenInfo | null> {
  if (!stored.refreshToken || isExpired(stored.refreshTokenExpiredTime, new Date())) {
    await clearTokenInfo();
    return null;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/api/members/refresh`, {
      method: 'POST',
      headers: { refresh: stored.refreshToken },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) await clearTokenInfo();
      return null;
    }
    const body = await res.json();
    const newTokenInfo: TokenInfo = body.data;
    await saveTokenInfo(newTokenInfo);
    listener?.(newTokenInfo);
    return newTokenInfo;
  } catch (err) {
    console.warn('[authTokens] self-refresh failed', err);
    return null;
  }
}

/**
 * Returns a currently-valid accessToken, refreshing (and persisting) it
 * first if expired. `null` means no usable session — either never synced
 * from the web login, or the refresh token itself is gone/expired.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const stored = await readTokenInfo();
  if (!stored?.accessToken) return null;
  if (!isExpired(stored.accessTokenExpiredTime, new Date())) return stored.accessToken;

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(stored).finally(() => {
      refreshInFlight = null;
    });
  }
  const refreshed = await refreshInFlight;
  return refreshed?.accessToken ?? null;
}
