/**
 * Pure mapping from a notification's data payload to an in-portal path.
 * Kept dependency-free (only the portal host constant) so it is unit-testable
 * without the Firebase / notifee native modules that `messaging.ts` pulls in.
 */
import { PORTAL_HOST } from '../webview/constants';

/** The raw path/route/link/url field from a notification payload, if any. */
export function extractCandidate(data?: Record<string, unknown>): string | null {
  if (!data) return null;
  const candidate = data.path ?? data.route ?? data.link ?? data.url;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** Map a notification's data payload to a portal path, if any. */
export function extractNavPath(data?: Record<string, unknown>): string | null {
  const candidate = extractCandidate(data);
  if (!candidate) return null;
  if (candidate.startsWith('/')) return candidate;
  try {
    const u = new URL(candidate);
    if (u.host === PORTAL_HOST) return u.pathname + u.search;
  } catch {
    /* not a URL */
  }
  return null;
}
