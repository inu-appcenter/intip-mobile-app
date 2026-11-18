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

/**
 * Readable whenever the device has been unlocked once since boot, not only
 * while it is unlocked right now (the SecureStore default).
 *
 * The token is read in the background far more often than in the foreground:
 * iOS launches the app for a Live Activity push-to-start before every class,
 * and that launch refreshes the widgets. With the default, each of those reads
 * failed on a locked phone — indistinguishable from "no token" — and the
 * schedule widgets were overwritten with their logged-out state.
 */
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function saveTokenInfo(tokenInfo: TokenInfo): Promise<void> {
  // Deleted first because iOS keeps an existing item's accessibility when its
  // value is overwritten: without this, a token first saved under the old
  // default would stay locked-phone-unreadable forever.
  await SecureStore.deleteItemAsync(STORAGE_KEY, STORE_OPTIONS);
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(tokenInfo), STORE_OPTIONS);
}

/**
 * The stored pair, or null when there is none. Throws when the store itself
 * can't be read (a locked keychain) — for callers that must not mistake
 * "couldn't look" for "logged out".
 */
export async function readTokenInfoStrict(): Promise<TokenInfo | null> {
  const raw = await SecureStore.getItemAsync(STORAGE_KEY, STORE_OPTIONS);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = parsed as Partial<TokenInfo> | null;
  if (typeof candidate?.accessToken !== 'string' || typeof candidate?.refreshToken !== 'string') {
    return null;
  }
  return candidate as TokenInfo;
}

export async function readTokenInfo(): Promise<TokenInfo | null> {
  try {
    return await readTokenInfoStrict();
  } catch (err) {
    console.warn('[secureTokenStore] read failed', err);
    return null;
  }
}

export async function clearTokenInfo(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY, STORE_OPTIONS);
  } catch (err) {
    console.warn('[secureTokenStore] clear failed', err);
  }
}
