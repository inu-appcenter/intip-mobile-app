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
import notifee, { AndroidImportance, EventType } from '@notifee/react-native';
import { ensureAndroidPostNotifications } from '../native/permissions';
import { resolveNavIntent, type NavIntent } from './navIntent';

export type { NavIntent };

const ANDROID_CHANNEL_ID = 'default';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Create the Android notification channel used for foreground banners. */
async function ensureAndroidChannel(): Promise<string> {
  if (Platform.OS !== 'android') return ANDROID_CHANNEL_ID;
  return notifee.createChannel({
    id: ANDROID_CHANNEL_ID,
    name: '알림',
    importance: AndroidImportance.HIGH,
    sound: 'default',
  });
}

/** Ask for notification permission (alert + badge + sound) and register APNs. */
export async function requestNotificationPermission(): Promise<boolean> {
  await ensureAndroidChannel();

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

/** Display foreground messages as banners. Returns an unsubscribe function. */
export function setupForegroundNotifications(): () => void {
  return messaging().onMessage(async (remoteMessage) => {
    await ensureAndroidChannel();
    await notifee.displayNotification({
      title: remoteMessage.notification?.title,
      body: remoteMessage.notification?.body,
      data: remoteMessage.data,
      android: {
        channelId: ANDROID_CHANNEL_ID,
        pressAction: { id: 'default' },
        sound: 'default',
      },
      ios: { sound: 'default' },
    });
  });
}

/**
 * Nav intent from a notification that launched the app from a cold start
 * (tapped while the app was killed). Checks both FCM-tray and
 * notifee-displayed notifications.
 */
export async function getInitialNavIntent(): Promise<NavIntent | null> {
  const fcm = await messaging().getInitialNotification();
  if (fcm) {
    const intent = resolveNavIntent(fcm.data);
    if (intent) return intent;
  }
  const local = await notifee.getInitialNotification();
  if (local) {
    const intent = resolveNavIntent(local.notification.data);
    if (intent) return intent;
  }
  return null;
}

/** Subscribe to notification taps while the app is running. */
export function subscribeNotificationOpen(cb: (intent: NavIntent) => void): () => void {
  const unsubFcm = messaging().onNotificationOpenedApp((remoteMessage) => {
    const intent = resolveNavIntent(remoteMessage.data);
    if (intent) cb(intent);
  });
  const unsubNotifee = notifee.onForegroundEvent(({ type, detail }) => {
    if (type === EventType.PRESS) {
      const intent = resolveNavIntent(detail.notification?.data);
      if (intent) cb(intent);
    }
  });
  return () => {
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
  if (backgroundRegistered) return;
  backgroundRegistered = true;

  // Data-only messages while backgrounded. The OS renders `notification`
  // payloads itself; nothing extra to do here, but the handler must exist.
  messaging().setBackgroundMessageHandler(async () => {});

  // Taps on notifee notifications while backgrounded are resolved on next
  // launch via getInitialNotification(); the handler just needs to exist.
  notifee.onBackgroundEvent(async () => {});
}
