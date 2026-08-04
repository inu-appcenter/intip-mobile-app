/**
 * Registers a rotated FCM token with the backend the moment FCM reissues it
 * (`onTokenRefresh`), independent of any WebView being mounted or foreground —
 * `postFcmToken`'s existing bridge-based path (`WebViewContainer.tsx`) only
 * fires while a WebView is alive and interactive, which a background/killed
 * token rotation never is.
 *
 * `tryRegisterFcmToken` calling `POST /api/tokens` immediately is the primary
 * path. `pendingToken` only exists as a fallback for when that immediate
 * attempt fails (no session yet, or a network/server error) — it's flushed
 * from the existing WebView survival points (`postFcmToken`'s onLoadEnd /
 * loginSuccess / foreground-resume / manual refresh) so a failed background
 * registration still gets one more shot for free.
 */
import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import { API_BASE_URL } from '../config/env';
import { getValidAccessToken } from '../native/authTokens';

function deviceType(): string {
  // Matches inu-portal-web's getFcmDeviceType() convention ('ANDROID'/'IOS').
  return Platform.OS === 'ios' ? 'IOS' : 'ANDROID';
}

async function postFcmTokenToBackend(token: string, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Auth: accessToken },
      body: JSON.stringify({ token, deviceType: deviceType() }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[fcmTokenSync] POST /api/tokens failed', err);
    return false;
  }
}

let pendingToken: string | null = null;

async function tryRegisterFcmToken(token: string): Promise<void> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    // Not logged in via the native shell yet — retried once a session exists.
    pendingToken = token;
    return;
  }
  const ok = await postFcmTokenToBackend(token, accessToken);
  pendingToken = ok ? null : token;
}

let rotationRegistered = false;

/** Registers the `onTokenRefresh` listener once. Call from
 * `registerBackgroundHandlers()` so it's active before React renders. */
export function registerFcmTokenRotationListener(): void {
  if (rotationRegistered) return;
  rotationRegistered = true;
  messaging().onTokenRefresh((token) => {
    void tryRegisterFcmToken(token);
  });
}

/** Retries a previously-failed registration. No-op if the last attempt
 * succeeded (or none has happened yet). */
export function flushPendingFcmToken(): void {
  if (pendingToken) void tryRegisterFcmToken(pendingToken);
}
