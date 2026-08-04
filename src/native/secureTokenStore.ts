/**
 * Secure on-device storage for the JWT pair mirrored from the web portal
 * (see WebViewContainer's `syncTokenInfo` handler). Lets the native shell
 * call the backend on its own — e.g. registering a rotated FCM token from
 * `onTokenRefresh` — without a live WebView to relay through.
 */
import * as SecureStore from 'expo-secure-store';
import type { TokenInfoPayload } from '../../packages/intip-bridge/src/messages';

export type TokenInfo = TokenInfoPayload;

const STORAGE_KEY = 'intip.tokenInfo';

export async function saveTokenInfo(tokenInfo: TokenInfo): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(tokenInfo));
}

export async function readTokenInfo(): Promise<TokenInfo | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accessToken !== 'string' || typeof parsed?.refreshToken !== 'string') {
      return null;
    }
    return parsed as TokenInfo;
  } catch (err) {
    console.warn('[secureTokenStore] read failed', err);
    return null;
  }
}

export async function clearTokenInfo(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch (err) {
    console.warn('[secureTokenStore] clear failed', err);
  }
}
