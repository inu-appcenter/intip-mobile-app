/**
 * The backend calls the home screen widgets need, without a WebView.
 *
 * Widgets render from a snapshot the app pushes them (see `../refresh.ts`), so
 * the fetching happens here, in the app process, against the same session the
 * portal WebView is logged in with — `syncTokenInfo` mirrors the JWT pair into
 * `secureTokenStore`, and `getValidAccessToken` refreshes it when it has
 * expired. Nothing here needs a live WebView, which is the whole point: a
 * widget has to be able to update while the user is nowhere near the app.
 *
 * Deliberately `fetch` and not the web app's axios stack. The portal's
 * `tokenInstance` carries interceptors for 401-retry, mock-API switching and
 * redirecting the browser to the login page — none of which mean anything in a
 * background refresh, and the last of which would be actively wrong. The only
 * piece worth sharing is the header convention (`Auth: <accessToken>`, not
 * `Authorization: Bearer`), which this matches deliberately.
 *
 * Also deliberately quiet: every call returns null rather than throwing. A
 * widget refresh runs unattended, often on a flaky network, and a rejected
 * promise there has nobody to catch it — the caller's job is to leave the
 * previous snapshot on screen, not to surface an error the user can't act on.
 */
import { API_BASE_URL } from '../../config/env';
import { getValidAccessToken } from '../../native/authTokens';

/**
 * The portal's envelope. Every endpoint the widgets use wraps its payload in
 * `data`; `check`/`information` carry the server's own success flag and
 * message, which are not useful here beyond "did we get a payload".
 */
type ApiEnvelope<T> = {
  check?: boolean;
  information?: unknown;
  data?: T;
};

/** How long a widget refresh will wait before giving up on a request. */
const REQUEST_TIMEOUT_MS = 10_000;

type FetchOptions = {
  /** Sends the session's access token, refreshing it first if it expired. */
  authenticated?: boolean;
  query?: Record<string, string | number | undefined>;
};

function buildUrl(path: string, query: FetchOptions['query']): string {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * One GET against the portal API, unwrapped to its `data` payload.
 *
 * Returns null for every failure mode there is — no session, a timeout, a
 * non-2xx status, a body that isn't the envelope we expect. Callers can't
 * usefully distinguish them: the response to all of them is the same, which is
 * to keep showing whatever the widget already had.
 */
export async function getJson<T>(path: string, options: FetchOptions = {}): Promise<T | null> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.authenticated) {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      // Not an error: the user simply isn't logged in on this device yet. The
      // widgets have their own `loggedOut` state for exactly this.
      return null;
    }
    headers.Auth = accessToken;
  }

  // AbortSignal.timeout rather than a manual setTimeout race: it cancels the
  // underlying request instead of just ignoring it, which matters when the
  // caller is a background refresh with a hard runtime budget.
  try {
    const response = await fetch(buildUrl(path, options.query), {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[widgets/api] ${path} -> HTTP ${response.status}`);
      return null;
    }
    const body = (await response.json()) as ApiEnvelope<T> | null;
    return body?.data ?? null;
  } catch (err) {
    console.warn(`[widgets/api] ${path} failed`, err);
    return null;
  }
}

/** True when this device has a usable portal session right now. */
export async function hasSession(): Promise<boolean> {
  return (await getValidAccessToken()) !== null;
}
