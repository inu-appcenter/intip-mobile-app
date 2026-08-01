/**
 * Module-scope pending-intent queue + recent-id dedupe ring buffer for
 * push-tap routing (spec G4).
 *
 * Why module scope: `notifee.onBackgroundEvent` (and the FCM/notifee "app was
 * launched from a killed state" paths) fire outside the React tree — often
 * before the root WebView container has mounted and subscribed at all. A hook-scoped queue
 * can't receive anything delivered before it exists, so the queue and the
 * live subscriber both have to live here, at import time, kept alive for the
 * whole process lifetime.
 *
 * Why dedupe: the same physical notification tap can resolve through two
 * independent paths at once (e.g. notifee's background PRESS event queues an
 * intent via `deliver`, while RNFirebase's own `getInitialNotification()`
 * *also* reports the app was launched from that same message) — see
 * `docs/push-notification-routing/plan.md` G4. Both paths funnel their
 * candidate id through `isDuplicate` before acting, so only the first one
 * wins.
 */
import type { NavIntent } from './navIntent';

/** How many recent notification ids to remember for dedupe. Plan says 8 is
 * plenty — background/kill-launch races only ever involve one pending tap at
 * a time, this is just headroom for rapid multi-notification launches. */
const DEDUPE_RING_SIZE = 8;

let pending: NavIntent | null = null;
let subscriber: ((intent: NavIntent) => void) | null = null;
const seenIds: string[] = [];

/**
 * Remember `id` and report whether it was already seen. Falsy ids (missing
 * `messageId`/`notification.id`) are never treated as duplicates — with no
 * id to key on we can't tell them apart, so we let them all through rather
 * than risk swallowing a legitimate tap.
 */
export function isDuplicate(id: string | null | undefined): boolean {
  if (!id) return false;
  if (seenIds.includes(id)) return true;
  seenIds.push(id);
  if (seenIds.length > DEDUPE_RING_SIZE) seenIds.shift();
  return false;
}

/**
 * Deliver a resolved nav intent: immediately to the live subscriber if one
 * is mounted (foreground tap, or background tap while the app process is
 * still alive), otherwise queue it for the next `subscribe`/`consumePending`
 * (background/killed tap, resolved once the app is back in front of the
 * user).
 */
export function deliver(intent: NavIntent | null): void {
  if (!intent) return;
  if (subscriber) subscriber(intent);
  else pending = intent;
}

/**
 * Subscribe for live intents. Immediately flushes any already-queued intent
 * through `cb` (a background tap that landed before anyone was listening),
 * then forwards every subsequent `deliver()` call until unsubscribed.
 */
export function subscribe(cb: (intent: NavIntent) => void): () => void {
  subscriber = cb;
  if (pending) {
    const intent = pending;
    pending = null;
    cb(intent);
  }
  return () => {
    if (subscriber === cb) subscriber = null;
  };
}

/**
 * Take (and clear) any queued intent without subscribing. First of
 * `getInitialNavIntent()`'s three sources — covers a background tap that's
 * still sitting in the queue when the host asks for the cold-start intent
 * before (or without) subscribing.
 */
export function consumePending(): NavIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

/** Test-only: reset all module state between test cases. */
export function __resetForTests(): void {
  pending = null;
  subscriber = null;
  seenIds.length = 0;
}
