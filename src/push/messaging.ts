/**
 * Firebase Cloud Messaging integration.
 * Swift ref: `fetchFcmToken(for:retry:)`, `postToken(_:)`, APNs registration.
 *
 * Responsibilities:
 *  - Request notification permission (alert + badge + sound) on first launch.
 *  - Register for remote notifications and feed the APNs token to Firebase
 *    (handled automatically by RNFirebase's AppDelegate proxy — we keep the
 *    swizzling default, i.e. FirebaseAppDelegateProxyEnabled is NOT disabled).
 *  - Display foreground messages as banners with badge + sound (via notifee).
 *  - Fetch the FCM token with up to 3 retries (1s backoff) and hand it to the
 *    web context via `window.onReceiveFcmToken(<token>)`.
 *  - Deep-link into the portal when a notification is tapped (push-tap routing).
 */
import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import notifee, {
  AndroidGroupAlertBehavior,
  AndroidImportance,
  EventType,
} from '@notifee/react-native';
import { ensureAndroidPostNotifications } from '../native/permissions';
import { resolveNavIntent, type NavIntent } from './navIntent';
import {
  GROUP_SUMMARY_ID_PREFIX,
  consumePending,
  deliver,
  isDuplicate,
  subscribe,
} from './pendingIntent';
import { registerFcmTokenRotationListener } from './fcmTokenSync';

export type { NavIntent };

const ANDROID_CHANNEL_ID = 'default';
/**
 * Chat channels. The server used to name these in the FCM `notification`
 * block and let the OS render the banner; chat messages are now sent to
 * Android as data-only (the only way our grouping code gets to run while
 * backgrounded), so the channel is picked here instead — from `data.muted` —
 * and both channels have to actually exist on the device.
 */
const CHAT_CHANNEL_ID = 'chat_channel_default';
const CHAT_MUTED_CHANNEL_ID = 'chat_channel_muted';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Create the Android notification channels used for banners. */
async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await notifee.createChannel({
    id: ANDROID_CHANNEL_ID,
    name: '알림',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  });
  await notifee.createChannel({
    id: CHAT_CHANNEL_ID,
    name: '채팅',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  });
  await notifee.createChannel({
    id: CHAT_MUTED_CHANNEL_ID,
    name: '채팅 (무음)',
    // LOW: still lands in the tray, but no sound, vibration or heads-up —
    // what "이 채팅방 알림 끄기" means for a per-room mute.
    importance: AndroidImportance.LOW,
  });
}

/** Ask for notification permission (alert + badge + sound) and register APNs. */
export async function requestNotificationPermission(): Promise<boolean> {
  await ensureAndroidChannels();

  if (Platform.OS === 'android') {
    // Android 13+ (API 33) requires an explicit POST_NOTIFICATIONS grant.
    return ensureAndroidPostNotifications();
  }

  // iOS: request alert + badge + sound, then register for remote notifications.
  const status = await messaging().requestPermission();
  await messaging().registerDeviceForRemoteMessages();
  return (
    status === messaging.AuthorizationStatus.AUTHORIZED ||
    status === messaging.AuthorizationStatus.PROVISIONAL
  );
}

/**
 * Fetch the FCM token, retrying on failure (token may not be ready yet —
 * e.g. APNs token still pending on iOS). Swift ref: `fetchFcmToken(retry:)`.
 */
export async function getFcmTokenWithRetry(retries = 3, delayMs = 1000): Promise<string | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const token = await messaging().getToken();
      if (token) return token;
    } catch (err) {
      console.warn(`[fcm] getToken attempt ${attempt + 1} failed`, err);
    }
    if (attempt < retries - 1) await sleep(delayMs);
  }
  return null;
}

/** The chat room this payload belongs to, or null if it isn't a chat push. */
function chatRoomIdOf(data?: Record<string, unknown>): string | null {
  if (!data || data.type !== 'CHAT') return null;
  const chatRoomId = data.chatRoomId;
  return typeof chatRoomId === 'string' && chatRoomId !== '' ? chatRoomId : null;
}

/** Helper to display a notification with grouping support. */
async function handleDisplayNotification(remoteMessage: any): Promise<void> {
  await ensureAndroidChannels();

  const data = remoteMessage.data as Record<string, unknown> | undefined;
  const chatRoomId = chatRoomIdOf(data);
  // Per-room mute: the server sends chat as data-only on Android, so the
  // quiet-vs-noisy choice it used to make by naming a channel arrives here.
  const muted = data?.muted === 'true';
  const channelId = chatRoomId
    ? muted
      ? CHAT_MUTED_CHANNEL_ID
      : CHAT_CHANNEL_ID
    : ANDROID_CHANNEL_ID;

  const title =
    remoteMessage.notification?.title || data?.chatRoomName || data?.title || '새 메시지';
  const body = remoteMessage.notification?.body || data?.messageText || data?.body || '';

  await notifee.displayNotification({
    // Mirror the FCM messageId as notifee's own id so a later
    // background/foreground PRESS on *this* notification and any
    // independent RNFirebase "opened from notification" report share one
    // dedupe key (see `pendingIntent.ts`) instead of living in two
    // unrelated id spaces.
    id: remoteMessage.messageId || String(Date.now()),
    title,
    body,
    data: remoteMessage.data,
    android: {
      channelId,
      pressAction: { id: 'default' },
      ...(muted ? {} : { sound: 'default' }),
      ...(chatRoomId ? { groupId: chatRoomId } : {}),
    },
    ios: {
      ...(muted ? {} : { sound: 'default' }),
      ...(chatRoomId ? { threadId: chatRoomId } : {}),
    },
  });

  if (Platform.OS === 'android' && chatRoomId) {
    await notifee.displayNotification({
      // Stable per room so the tray keeps exactly one summary, and prefixed so
      // the tap-dedupe ring lets a repeat tap on it through (pendingIntent.ts).
      id: `${GROUP_SUMMARY_ID_PREFIX}${chatRoomId}`,
      title,
      body: '새로운 메시지가 있습니다.',
      // The summary is what the user actually taps once the room's messages
      // collapse, so it needs the same routing payload as its children —
      // without it `resolveNavIntent` gets `undefined` and the tap goes nowhere.
      data: remoteMessage.data,
      android: {
        channelId,
        groupId: chatRoomId,
        groupSummary: true,
        // Children already alert; without this the summary alerts too and one
        // message buzzes twice.
        groupAlertBehavior: AndroidGroupAlertBehavior.CHILDREN,
        pressAction: { id: 'default' },
      },
    });
  }
}

/**
 * Clear every notification still showing for a chat room once one of them is
 * tapped. The children auto-cancel themselves, but the summary we posted by
 * hand does not — left alone it keeps "새로운 메시지가 있습니다." in the tray
 * for a room the user has already opened.
 */
async function clearChatGroup(data?: Record<string, unknown>): Promise<void> {
  const chatRoomId = chatRoomIdOf(data);
  if (!chatRoomId) return;
  try {
    const displayed = await notifee.getDisplayedNotifications();
    const ids = displayed
      .filter((d) => chatRoomIdOf(d.notification.data) === chatRoomId)
      .map((d) => d.id)
      .filter((id): id is string => !!id);
    if (ids.length > 0) await notifee.cancelDisplayedNotifications(ids);
  } catch (err) {
    console.warn('[fcm] failed to clear chat notification group', err);
  }
}

/** Display foreground messages as banners. Returns an unsubscribe function. */
export function setupForegroundNotifications(): () => void {
  return messaging().onMessage(async (remoteMessage) => {
    await handleDisplayNotification(remoteMessage);
  });
}

/**
 * Nav intent from a notification that launched the app from a cold start
 * (tapped while the app was killed), or one that arrived via the background
 * queue before anything was listening (spec G4). Checked in order:
 *  1. `pending` (queued by `registerBackgroundHandlers`'s PRESS handler).
 *  2. FCM's own "app opened from notification" report.
 *  3. notifee's own "app opened from notification" report.
 * Each is consumed/cleared as it's read so a later call doesn't re-deliver
 * the same intent.
 */
export async function getInitialNavIntent(): Promise<NavIntent | null> {
  const queued = consumePending();
  if (queued) return queued;

  const fcm = await messaging().getInitialNotification();
  if (fcm && !isDuplicate(fcm.messageId)) {
    const intent = resolveNavIntent(fcm.data);
    if (intent) return intent;
  }
  const local = await notifee.getInitialNotification();
  if (local && !isDuplicate(local.notification.id)) {
    const intent = resolveNavIntent(local.notification.data);
    if (intent) return intent;
  }
  return null;
}

/**
 * Subscribe to notification taps while the app is running. Also registers as
 * the module-scope pending-queue subscriber (`pendingIntent.subscribe`), so
 * any intent queued by a background tap before this call is flushed through
 * `cb` immediately.
 */
export function subscribeNotificationOpen(cb: (intent: NavIntent) => void): () => void {
  const unsubQueue = subscribe(cb);
  const unsubFcm = messaging().onNotificationOpenedApp((remoteMessage) => {
    if (isDuplicate(remoteMessage.messageId)) return;
    const intent = resolveNavIntent(remoteMessage.data);
    if (intent) deliver(intent);
  });
  const unsubNotifee = notifee.onForegroundEvent(({ type, detail }) => {
    if (type === EventType.PRESS) {
      if (isDuplicate(detail.notification?.id)) return;
      void clearChatGroup(detail.notification?.data);
      const intent = resolveNavIntent(detail.notification?.data);
      if (intent) deliver(intent);
    }
  });
  return () => {
    unsubQueue();
    unsubFcm();
    unsubNotifee();
  };
}

let backgroundRegistered = false;

/**
 * Register background message + event handlers. Must run at module load time
 * (before React renders) so it survives a background/quit launch.
 */
export function registerBackgroundHandlers(): void {
  // This app has no real web target (it's a native WebView shell; app.json's
  // `web.output` is an unused leftover default) — Firebase/notifee are native
  // modules with nothing initialized under `Platform.OS === 'web'`. That
  // matters beyond an actual browser run: `_layout.tsx` calls this at module
  // load, and `expo export`'s static-rendering pass (which `eas update` runs
  // internally to build the OTA bundle) evaluates every route module's
  // top-level code once for a "web" render target, in a Node process with no
  // Firebase app initialized — hitting this unguarded crashed the whole
  // export with "No Firebase App '[DEFAULT]' has been created".
  if (Platform.OS === 'web') return;
  if (backgroundRegistered) return;
  backgroundRegistered = true;

  // Reissued/rotated FCM tokens must reach the backend even with no WebView
  // mounted (background or killed) — see fcmTokenSync.ts.
  registerFcmTokenRotationListener();

  // Data-only messages while backgrounded. The OS renders `notification`
  // payloads itself; nothing extra to do here, but the handler must exist.
  // We manually handle data-only notifications (i.e. remoteMessage.notification is undefined).
  messaging().setBackgroundMessageHandler(async (remoteMessage) => {
    if (!remoteMessage.notification) {
      await handleDisplayNotification(remoteMessage);
    }
  });

  // Taps on notifee-displayed notifications while backgrounded (or after the
  // app was killed — notifee runs this via a headless task either way).
  // Resolve the intent and hand it to the module-scope queue: delivered
  // immediately if `subscribeNotificationOpen` is already mounted, queued
  // otherwise (see `pendingIntent.ts`). Previously a no-op relying on
  // `getInitialNotification()` alone, which only ever resolves for a killed
  // -> cold-start launch, not a plain background tap (spec G4).
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type !== EventType.PRESS) return;
    if (isDuplicate(detail.notification?.id)) return;
    await clearChatGroup(detail.notification?.data);
    deliver(resolveNavIntent(detail.notification?.data));
  });
}
