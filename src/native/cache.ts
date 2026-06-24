/**
 * WebView cache helpers.
 * Swift ref: `clearCacheAndLoad(...)`.
 *
 * Only the memory + disk *cache* is ever wiped — never localStorage or cookies,
 * so the login (`tokenInfo`) survives an in-place update.
 * `WebView.clearCache(true)` clears disk + memory cache without touching
 * web storage, which is exactly the behaviour we want.
 */
import type { RefObject } from 'react';
import type WebView from 'react-native-webview';

/** Clear the WebView's memory + disk cache (login preserved). */
export function clearWebViewCache(ref: RefObject<WebView | null>): void {
  ref.current?.clearCache?.(true);
}

/** On-demand "화면 업데이트": clear cache then reload, keeping login. */
export function clearCacheAndReload(ref: RefObject<WebView | null>): void {
  ref.current?.clearCache?.(true);
  ref.current?.reload?.();
}
