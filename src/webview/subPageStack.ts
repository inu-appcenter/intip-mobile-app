/**
 * Lookup over the live navigation state: is a given portal URL already open as
 * a pushed sub-page screen (`app/webview.tsx`), and how deep in the stack?
 *
 * Why: a notification tap routes through `handleNavIntent`, which pushes a new
 * `/webview` screen for every non-main-tab destination. Chat notifications for
 * one room arrive as *separate* notifications with separate message ids, so the
 * id ring in `pendingIntent.ts` (which only collapses one physical tap
 * reported through two delivery paths) does not help: tapping n of them stacked
 * n copies of the same chat room. Destination-based lookup is the missing half
 * — if the page is already on the stack, come back to it instead of pushing
 * another instance.
 *
 * Kept as plain functions over a structural subset of React Navigation's state
 * (only `routes` / `index` / nested `state`) so it is unit-testable without a
 * mounted navigator.
 */
import { normalizePath } from './constants';

/** Route name of the pushed sub-page screen (`app/webview.tsx`). */
export const SUB_PAGE_ROUTE = 'webview';

/** Structural subset of React Navigation's route/state we actually read. */
type RouteLike = {
  name?: string;
  params?: object;
  state?: StateLike;
};

type StateLike = {
  /** Index of the focused route; the stack top when the navigator is a stack. */
  index?: number;
  routes?: RouteLike[];
};

/**
 * Comparable identity for a sub-page target: host + `/m`-normalized path +
 * query. Two URLs that differ only by the mobile prefix, a hash, or a trailing
 * `/` are the same destination, and a push notification's URL is built by
 * `portalUrlFor` from a server-supplied path — so it can legitimately differ in
 * those ways from the URL the same page was originally pushed with.
 */
function targetKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value);
    const path = normalizePath(u.pathname).replace(/\/+$/, '');
    return `${u.host}${path || '/'}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * The navigator that holds the sub-page screens — the root stack in this app.
 * Searched for rather than assumed to be `state` itself so an expo-router
 * version that wraps the app's `Stack` in another navigator doesn't silently
 * turn this into "never a duplicate".
 */
function findSubPageStack(state?: StateLike): StateLike | null {
  const routes = state?.routes;
  if (!routes?.length) return null;
  if (routes.some((route) => route?.name === SUB_PAGE_ROUTE)) return state ?? null;
  for (const route of routes) {
    const found = findSubPageStack(route?.state);
    if (found) return found;
  }
  return null;
}

/**
 * How far down the stack `url` is already open as a sub-page:
 *  - `0`    — it *is* the top-most screen (the user is looking at it).
 *  - `n>0`  — `n` screens sit on top of it, so `router.dismiss(n)` returns to it.
 *  - `null` — not open; the caller should push it.
 *
 * The most recently pushed copy wins (searched top-down), so a page opened
 * twice before this check existed still resolves to the nearest one.
 */
export function openSubPageDepth(state: StateLike | undefined, url: string): number | null {
  const target = targetKey(url);
  if (!target) return null;

  const stack = findSubPageStack(state);
  const routes = stack?.routes;
  if (!routes?.length) return null;

  // Screens above the focused index (there are none in a stack, but the state
  // shape doesn't guarantee it) are not "on top" in any meaningful sense.
  const top = Math.min(stack?.index ?? routes.length - 1, routes.length - 1);
  for (let i = top; i >= 0; i--) {
    const route = routes[i];
    if (route?.name !== SUB_PAGE_ROUTE) continue;
    const params = route.params as { url?: unknown } | undefined;
    if (targetKey(params?.url) === target) return top - i;
  }
  return null;
}
