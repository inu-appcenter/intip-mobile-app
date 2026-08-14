/**
 * Pure URL -> `NavIntent` conversion for deep links (iOS Universal Links /
 * Android App Links).
 *
 * The whole feature is this one translation plus a router hook
 * (`app/+native-intent.ts`): once a portal URL is a `NavIntent`, it goes into
 * the exact same queue a notification tap uses (`push/pendingIntent`), and
 * `WebViewContainer.handleNavIntent` already knows how to land it — root SPA
 * route, native sub-page push, or in-app browser — including the cold-start
 * case where the intent arrives before the WebView exists.
 *
 * Kept dependency-free (constants only) so it is unit-testable without the
 * router or any native module.
 */
import {
  DEEP_LINK_EXCLUDED_PATHS,
  DEEP_LINK_EXCLUDED_PREFIXES,
  DEEP_LINK_HOSTS,
} from '../webview/constants';
import { intentForPortalPath, type NavIntent } from '../push/navIntent';

/** True when `host` is one of the domains this app claims links for. */
function isDeepLinkHost(host: string): boolean {
  return (DEEP_LINK_HOSTS as readonly string[]).includes(host);
}

/** True for the static pages a deep link must hand back to a browser. */
function isExcludedPath(pathname: string): boolean {
  if ((DEEP_LINK_EXCLUDED_PATHS as readonly string[]).includes(pathname)) return true;
  return (DEEP_LINK_EXCLUDED_PREFIXES as readonly string[]).some((prefix) =>
    pathname.startsWith(prefix),
  );
}

/**
 * Convert an incoming deep-link URL into a nav intent, or `null` when the URL
 * is none of our business (custom scheme, dev-client URL, some other host) —
 * `null` means "leave this to the router untouched".
 *
 * Origin normalization: only the *path* survives. Whichever of the two portal
 * hosts the link came in on, the intent is rebuilt against the app's own
 * `ROOT_URL` (that is what `intentForPortalPath` -> `portalUrlFor` does). The
 * root WebView and any pushed sub-page WebView must sit on one origin — they
 * share the login token through that origin's `localStorage`, so a sub-page
 * opened on the *other* host would come up logged out.
 */
export function resolveDeepLink(url: string): NavIntent | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!isDeepLinkHost(parsed.host)) return null;

  // Store-listing / legal pages: open where they were meant to be read rather
  // than swallowing them into the app shell. Reached on Android only (iOS
  // excludes them in the AASA), and the original URL is kept as-is — this one
  // is deliberately *not* normalized onto `ROOT_URL`, since the user tapped a
  // link to that specific host's static page.
  if (isExcludedPath(parsed.pathname)) return { kind: 'external', url };

  return intentForPortalPath(parsed.pathname + parsed.search + parsed.hash);
}
