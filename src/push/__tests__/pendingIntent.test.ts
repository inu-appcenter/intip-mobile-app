import { describe, it, expect, beforeEach } from '@jest/globals';
import { consumePending, deliver, isDuplicate, subscribe, __resetForTests } from '../pendingIntent';
import type { NavIntent } from '../navIntent';

const intentA: NavIntent = { kind: 'spa', path: '/home' };
const intentB: NavIntent = { kind: 'push', path: '/chat/789', url: 'https://portal.example/chat/789' };

beforeEach(() => {
  __resetForTests();
});

describe('deliver / subscribe / consumePending (queue)', () => {
  it('queues when there is no subscriber, and consumePending drains it exactly once', () => {
    deliver(intentA);
    expect(consumePending()).toEqual(intentA);
    expect(consumePending()).toBeNull();
  });

  it('ignores a null intent (nothing to resolve) without queuing anything', () => {
    deliver(null);
    expect(consumePending()).toBeNull();
  });

  it('delivers straight to a live subscriber instead of queuing', () => {
    const received: NavIntent[] = [];
    subscribe((intent) => received.push(intent));

    deliver(intentA);

    expect(received).toEqual([intentA]);
    // Went straight to the callback, never sat in the queue.
    expect(consumePending()).toBeNull();
  });

  it('subscribing flushes an already-queued intent immediately, before anything new arrives', () => {
    // Simulates a background-tap PRESS event that fires before WebViewHost
    // has mounted/subscribed: deliver() queues, subscribe() later flushes.
    deliver(intentA);

    const received: NavIntent[] = [];
    subscribe((intent) => received.push(intent));

    expect(received).toEqual([intentA]);
    expect(consumePending()).toBeNull();
  });

  it('does not flush anything on subscribe when the queue is empty', () => {
    const received: NavIntent[] = [];
    subscribe((intent) => received.push(intent));
    expect(received).toEqual([]);
  });

  it('after unsubscribing, deliver goes back to queuing instead of calling the old callback', () => {
    const received: NavIntent[] = [];
    const unsubscribe = subscribe((intent) => received.push(intent));
    unsubscribe();

    deliver(intentB);

    expect(received).toEqual([]);
    expect(consumePending()).toEqual(intentB);
  });

  it('a second subscriber replaces the first (only the latest subscriber receives deliveries)', () => {
    const first: NavIntent[] = [];
    const second: NavIntent[] = [];
    subscribe((intent) => first.push(intent));
    subscribe((intent) => second.push(intent));

    deliver(intentA);

    expect(first).toEqual([]);
    expect(second).toEqual([intentA]);
  });
});

describe('isDuplicate (dedupe ring buffer)', () => {
  it('is not a duplicate the first time an id is seen, but is on every subsequent check', () => {
    expect(isDuplicate('msg-1')).toBe(false);
    expect(isDuplicate('msg-1')).toBe(true);
    expect(isDuplicate('msg-1')).toBe(true);
  });

  it('tracks distinct ids independently', () => {
    expect(isDuplicate('msg-1')).toBe(false);
    expect(isDuplicate('msg-2')).toBe(false);
    expect(isDuplicate('msg-1')).toBe(true);
    expect(isDuplicate('msg-2')).toBe(true);
  });

  it('never flags falsy ids (missing messageId/notification.id) as duplicates', () => {
    expect(isDuplicate(undefined)).toBe(false);
    expect(isDuplicate(undefined)).toBe(false);
    expect(isDuplicate(null)).toBe(false);
    expect(isDuplicate('')).toBe(false);
  });

  it('remembers only the most recent 8 ids, evicting the oldest (ring buffer)', () => {
    for (let i = 1; i <= 8; i++) {
      expect(isDuplicate(`msg-${i}`)).toBe(false);
    }
    // All 8 are still remembered.
    for (let i = 1; i <= 8; i++) {
      expect(isDuplicate(`msg-${i}`)).toBe(true);
    }

    // A 9th id evicts the oldest (msg-1).
    expect(isDuplicate('msg-9')).toBe(false);
    expect(isDuplicate('msg-1')).toBe(false); // evicted -> treated as new again
  });
});

describe('cross-path dedupe scenario (G4)', () => {
  it('a background PRESS event marks an id seen; a later duplicate check for the same id (from getInitialNotification) is suppressed', () => {
    // registerBackgroundHandlers's onBackgroundEvent path: resolves + delivers.
    expect(isDuplicate('shared-id')).toBe(false);
    deliver(intentA);

    // subscribeNotificationOpen flushes the queue on mount.
    const received: NavIntent[] = [];
    subscribe((intent) => received.push(intent));
    expect(received).toEqual([intentA]);

    // getInitialNavIntent() independently asks messaging().getInitialNotification()
    // for the same underlying tap; its id was already marked seen above, so the
    // caller knows to skip resolving/acting on it again.
    expect(isDuplicate('shared-id')).toBe(true);
  });
});
