/**
 * Maps a notification's data payload to what the app should do about it: route
 * inside the portal, or hand off to a browser. Kept dependency-free (same
 * reasoning as `navPath.ts`) so it is unit-testable without Firebase/notifee.
 */
import { PUSH_EXTERNAL_HOSTS } from '../webview/constants';
import { extractCandidate, extractNavPath } from './navPath';

export type NavIntent =
  | { kind: 'path'; path: string }
  | { kind: 'external'; url: string };

/** True when `host` is (or is a subdomain of) one of the allow-listed domains. */
function isAllowedExternalHost(host: string): boolean {
  return (PUSH_EXTERNAL_HOSTS as readonly string[]).some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/** Map a notification's data payload to a nav intent, if any. */
export function resolveNavIntent(data?: Record<string, unknown>): NavIntent | null {
  const path = extractNavPath(data);
  if (path) return { kind: 'path', path };

  const candidate = extractCandidate(data);
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (/^https?:$/.test(u.protocol) && isAllowedExternalHost(u.host)) {
      return { kind: 'external', url: candidate };
    }
  } catch {
    /* not a URL */
  }
  return null;
}
