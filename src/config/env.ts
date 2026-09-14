import { ROOT_URL } from '../webview/constants';

/**
 * The API each portal web host talks to.
 *
 * This is the pairing that matters, not an environment switch. The shell's own
 * API calls (widget data, FCM registration, token refresh) authenticate with
 * the token the WebView's login synced over, and a token is only valid on the
 * backend that issued it. So the API is decided by which web app the WebView
 * loaded — confirmed from the deployed bundles themselves:
 * `intip.inuappcenter.kr` is built against `portal`, `intip-test.pages.dev`
 * against `portal-dev`.
 *
 * Choosing the two independently (`EXPO_PUBLIC_API_BASE_URL` in `.env`,
 * `ROOT_URL` defaulting to production) is what broke every authenticated
 * widget call: a dev build loaded the production portal, synced a production
 * token, and sent it to `portal-dev`, which answered 401 to all of it.
 */
export const PORTAL_API_BY_WEB_HOST: Readonly<Record<string, string>> = {
  'intip.inuappcenter.kr': 'https://portal.inuappcenter.kr',
  'intip-test.pages.dev': 'https://portal-dev.inuappcenter.kr',
};

const FALLBACK_API = 'https://portal-dev.inuappcenter.kr';

/**
 * The API origin for a given WebView root, without a trailing slash.
 *
 * A known web host always wins over `override`: letting an env var point the
 * shell somewhere its token wasn't issued is the bug this exists to prevent.
 * `override` only applies to hosts not in the table — a local web dev server,
 * say — where there is nothing to derive from.
 */
export function resolveApiBaseUrl(rootUrl: string, override?: string): string {
  let host: string | null = null;
  try {
    host = new URL(rootUrl).host;
  } catch {
    host = null;
  }
  const paired = host ? PORTAL_API_BY_WEB_HOST[host] : undefined;
  return (paired ?? override ?? FALLBACK_API).replace(/\/$/, '');
}

const OVERRIDE = process.env.EXPO_PUBLIC_API_BASE_URL;

/** Backend API origin (no trailing slash), paired with the WebView's `ROOT_URL`. */
export const API_BASE_URL = resolveApiBaseUrl(ROOT_URL, OVERRIDE);

if (__DEV__ && OVERRIDE && OVERRIDE.replace(/\/$/, '') !== API_BASE_URL) {
  console.warn(
    `[env] Ignoring EXPO_PUBLIC_API_BASE_URL=${OVERRIDE}: the WebView loads ${ROOT_URL}, ` +
      `whose tokens are only valid on ${API_BASE_URL}.`,
  );
}
