/**
 * Pure formatting helpers for the WebView controller surfaces (dev-menu alerts
 * and the in-app panel). No React / native imports so they can be unit-tested.
 */
import type { SessionState, SnapshotEntry, WebViewMode } from './sessionSnapshot';

/** Minimal shape of a live stack entry that the formatters read. */
export type StackEntryLike = {
  mode: WebViewMode;
  url: string;
  path: string;
  canGoBack: boolean;
};

/** Shorten a URL to the portal-relative part where possible, for compact display. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = `${u.pathname}${u.search}`;
    return tail.length > 1 ? tail : u.host;
  } catch {
    return url;
  }
}

/** Truncate long tokens so an FCM token doesn't blow up an alert body. */
export function truncate(value: string, head = 12, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** "Where am I?" — the active (top-most) container's location. */
export function formatWhereAmI(
  active: StackEntryLike | null,
  stackDepth: number,
): string {
  if (!active) return 'No WebView is mounted.';
  return [
    `mode: ${active.mode}`,
    `path: ${active.path || '/'}`,
    `url: ${shortUrl(active.url)}`,
    `SPA back: ${active.canGoBack ? 'yes' : 'no'}`,
    `stack depth: ${stackDepth}`,
  ].join('\n');
}

/** Login/session summary. */
export function formatSession(session: SessionState): string {
  const since =
    session.loginAt != null ? new Date(session.loginAt).toLocaleTimeString() : '—';
  return [
    `logged in: ${session.loggedIn ? 'yes' : 'no'}`,
    `since: ${since}`,
    `fcm token: ${session.fcmToken ? truncate(session.fcmToken) : '—'}`,
  ].join('\n');
}

/** Top-to-bottom render of the native stack (index 0 = root, last = active). */
export function formatStack(entries: readonly StackEntryLike[]): string {
  if (entries.length === 0) return '(empty)';
  return entries
    .map((e, i) => {
      const marker = i === entries.length - 1 ? '▶' : ' ';
      return `${marker} ${i}. [${e.mode}] ${e.path || '/'}  ${shortUrl(e.url)}`;
    })
    .join('\n');
}

/** One-line summary of a saved snapshot's stack, for the load confirmation. */
export function formatSnapshotSummary(
  savedAt: number,
  stack: readonly SnapshotEntry[],
): string {
  const when = savedAt ? new Date(savedAt).toLocaleString() : 'unknown time';
  const lines = stack.map((e, i) => `${i}. [${e.mode}] ${e.path || '/'}`);
  return [`saved: ${when}`, `pages: ${stack.length}`, ...lines].join('\n');
}
