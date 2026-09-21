/**
 * Regression guard for the stale Android group summary: dismissing a room's
 * last message must take the hand-posted `summary:<roomId>` notification with
 * it, or the tray keeps showing "새로운 메시지가 있습니다." for a room with
 * nothing left in it.
 */
import { beforeEach, expect, it, jest } from '@jest/globals';
import { GROUP_SUMMARY_ID_PREFIX } from '../pendingIntent';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const mockDisplayed: { id: string; notification: { data?: Record<string, unknown> } }[] = [];
const mockCancel = jest.fn(async () => {});
const mockDisplay = jest.fn(async (_n: unknown) => {});
const mockOnBackgroundEvent = jest.fn();

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(async () => {}),
    displayNotification: mockDisplay,
    getDisplayedNotifications: jest.fn(async () => mockDisplayed),
    cancelDisplayedNotifications: mockCancel,
    onBackgroundEvent: (cb: unknown) => mockOnBackgroundEvent(cb),
    onForegroundEvent: jest.fn(() => () => {}),
    getInitialNotification: jest.fn(async () => null),
  },
  AndroidGroupAlertBehavior: { CHILDREN: 1 },
  AndroidImportance: { HIGH: 4, LOW: 2 },
  EventType: { PRESS: 1, DISMISSED: 0 },
}));

jest.mock('@react-native-firebase/messaging', () => {
  const api = { setBackgroundMessageHandler: jest.fn(), onTokenRefresh: jest.fn() };
  const messaging = () => api;
  messaging.AuthorizationStatus = { AUTHORIZED: 1, PROVISIONAL: 2 };
  return { __esModule: true, default: messaging };
});

jest.mock('../fcmTokenSync', () => ({ registerFcmTokenRotationListener: jest.fn() }));
jest.mock('../../native/permissions', () => ({ ensureAndroidPostNotifications: jest.fn() }));

const ROOM = '42';
const data = { type: 'CHAT', chatRoomId: ROOM };
const summaryId = `${GROUP_SUMMARY_ID_PREFIX}${ROOM}`;

/** The registered background handler, invoked with a DISMISSED event. */
async function dismiss(): Promise<void> {
  // require, not import: the module registers its handlers at import time and
  // each case needs a fresh registration after `jest.resetModules()`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registerBackgroundHandlers } = require('../messaging') as typeof import('../messaging');
  registerBackgroundHandlers();
  const handler = mockOnBackgroundEvent.mock.calls[0][0] as (event: unknown) => Promise<void>;
  await handler({ type: 0, detail: { notification: { id: 'msg-1', data } } });
}

beforeEach(() => {
  jest.resetModules();
  mockDisplayed.length = 0;
  mockCancel.mockClear();
  mockDisplay.mockClear();
  mockOnBackgroundEvent.mockClear();
});

it('cancels the leftover summary once the last child is dismissed', async () => {
  mockDisplayed.push({ id: summaryId, notification: { data } });
  await dismiss();
  expect(mockCancel).toHaveBeenCalledWith([summaryId]);
});

it('keeps the summary while other messages in the room are still showing', async () => {
  mockDisplayed.push({ id: summaryId, notification: { data } }, { id: 'msg-2', notification: { data } });
  await dismiss();
  expect(mockCancel).not.toHaveBeenCalled();
});

/** Deliver a data-only chat push through the background message handler. */
async function receive(messageId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registerBackgroundHandlers } = require('../messaging') as typeof import('../messaging');
  registerBackgroundHandlers();
  const messagingMock = jest.requireMock('@react-native-firebase/messaging') as {
    default: () => { setBackgroundMessageHandler: { mock: { calls: [(m: unknown) => Promise<void>][] } } };
  };
  const handler = messagingMock.default().setBackgroundMessageHandler.mock.calls[0][0];
  await handler({ messageId, data });
}

/** Ids passed to displayNotification, in call order. */
const displayedIds = () =>
  mockDisplay.mock.calls.map(([n]) => (n as { id: string }).id);

it("posts no summary for a room's first message", async () => {
  await receive('msg-1');
  expect(displayedIds()).toEqual(['msg-1']);
});

it('posts the summary once a second message needs collapsing', async () => {
  mockDisplayed.push({ id: 'msg-1', notification: { data } });
  await receive('msg-2');
  expect(displayedIds()).toEqual(['msg-2', summaryId]);
});

it('sweeps a summary left over from an earlier build', async () => {
  mockDisplayed.push({ id: summaryId, notification: { data } });
  await receive('msg-9');
  expect(mockCancel).toHaveBeenCalledWith([summaryId]);
});
