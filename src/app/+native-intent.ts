/**
 * Expo Router's system-path hook: the single entry point every deep link
 * (iOS Universal Link, Android App Link, and the iOS Smart App Banner's
 * `app-argument`) passes through before the router tries to match a route.
 *
 * The app is a WebView shell, so no portal URL corresponds to a native route:
 * `/councilnoticedetail?id=1` is a route in the *web* SPA, not in `app/`. So
 * for our own hosts we never let the router route the URL at all — we convert
 * it to a `NavIntent`, hand it to the same queue notification taps use, and
 * boot at `/` (the root WebView). `WebViewContainer` drains that queue on
 * mount (cold start) or receives it live (app already running), and decides
 * root-SPA vs native sub-page vs in-app browser from there.
 *
 * Anything else — the `intipmobileapp://` custom scheme, dev-client URLs — is
 * returned untouched so normal routing still applies.
 */
import { resolveDeepLink } from '../links/deepLink';
import { deliver } from '../push/pendingIntent';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  // Expo Router's own warning: never throw in here — a crash on this path
  // takes down app launch. `path` is not guaranteed to be a URL or even a
  // path, so every step is defensive and falls back to "not our link".
  let intent = null;
  try {
    intent = resolveDeepLink(path);
  } catch {
    intent = null;
  }
  if (!intent) return path;

  // A running app delivers on the next tick, after the router has acted on the
  // `/` returned below. Delivered immediately, the live subscriber pushed the
  // sub-page first and the router's navigation to `/` then popped it again —
  // a link to a non-main-tab page (a widget's `/home/menu`, or any https link
  // to one) just landed on home. Main-tab links looked fine only because they
  // go to root anyway. On a cold start nothing is subscribed yet: `deliver`
  // queues the intent for the WebView to drain once it mounts, so no wait.
  const send = () => {
    try {
      deliver(intent);
    } catch {
      // A queueing failure must not block launch; the app still opens at root,
      // just without the deep-link destination.
    }
  };
  if (initial) send();
  else setTimeout(send, 0);
  return '/';
}
