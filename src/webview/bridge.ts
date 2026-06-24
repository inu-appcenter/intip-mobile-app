/**
 * JS <-> Native bridge protocol.
 *
 * The web frontend already speaks the native multi-WebView protocol through
 * `window.AndroidBridge.*` (Android) and `window.webkit.messageHandlers.*`
 * (iOS). This Expo shell exposes shims (see `injectedScript.ts`) that forward
 * every one of those calls through react-native-webview's single channel:
 *   window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload })).
 *
 * The message names below match the native handler names exactly so the web
 * app needs no changes:
 *   navigateTo · goBack · requestAppUpdate · loginSuccess ·
 *   openAppSettings · requestPermissionSettings · logWebDiagnostics ·
 *   onLaunchWebCleanupFinished
 *
 * `routeChange` and `jsAlert` are extra channels this shell injects itself
 * (route observer + native `window.alert`), not part of the web→native API.
 */

export type NavigateToPayload = { path: string; url: string };

export type BridgeMessage =
  | { type: 'loginSuccess'; payload?: string }
  | { type: 'routeChange'; payload: string }
  | { type: 'requestAppUpdate'; payload?: unknown }
  // `window.alert` is bridged to a native dialog (see injectedScript) because
  // the WebView's own iOS alert panel is unreliable under react-native-screens.
  | { type: 'jsAlert'; payload: string }
  // Multi-WebView stack: push a new native WebView container for `url`.
  | { type: 'navigateTo'; payload: NavigateToPayload }
  // Pop the top-most native WebView container.
  | { type: 'goBack'; payload?: unknown }
  // Open the OS app-settings screen (deep-linked permission recovery).
  | { type: 'openAppSettings'; payload?: unknown }
  | { type: 'requestPermissionSettings'; payload?: unknown }
  // Diagnostics relayed from the web for native-side logging.
  | { type: 'logWebDiagnostics'; payload: string }
  // Launch cleanup loop finished -> the shell can dismiss the loading overlay.
  | { type: 'onLaunchWebCleanupFinished'; payload?: string };

export type BridgeMessageType = BridgeMessage['type'];

const KNOWN_TYPES: readonly BridgeMessageType[] = [
  'loginSuccess',
  'routeChange',
  'requestAppUpdate',
  'jsAlert',
  'navigateTo',
  'goBack',
  'openAppSettings',
  'requestPermissionSettings',
  'logWebDiagnostics',
  'onLaunchWebCleanupFinished',
];

const STRING_PAYLOAD_TYPES: readonly BridgeMessageType[] = [
  'routeChange',
  'jsAlert',
  'logWebDiagnostics',
];

/**
 * Parse a raw `onMessage` string into a typed bridge message.
 * Returns `null` for anything that isn't a recognised bridge message so that
 * unrelated postMessage traffic from the web app is ignored safely.
 */
export function parseBridgeMessage(raw: string): BridgeMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof data !== 'object' || data === null) return null;
  const { type, payload } = data as { type?: unknown; payload?: unknown };

  if (typeof type !== 'string') return null;
  if (!KNOWN_TYPES.includes(type as BridgeMessageType)) return null;

  if (type === 'navigateTo') {
    if (typeof payload !== 'object' || payload === null) return null;
    const { path, url } = payload as { path?: unknown; url?: unknown };
    if (typeof url !== 'string' || url.length === 0) return null;
    return { type, payload: { path: typeof path === 'string' ? path : '', url } };
  }

  if (STRING_PAYLOAD_TYPES.includes(type as BridgeMessageType)) {
    return { type, payload: typeof payload === 'string' ? payload : '' } as BridgeMessage;
  }

  return { type, payload } as BridgeMessage;
}
