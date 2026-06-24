/**
 * Network reachability gate.
 * Swift ref: `ContentView.checkNetwork()` (SystemConfiguration reachability).
 */
import NetInfo from '@react-native-community/netinfo';

/** One-shot connectivity check. True when the device is connected & reachable. */
export async function isConnected(): Promise<boolean> {
  const state = await NetInfo.fetch();
  // `isInternetReachable` can be null before the first probe resolves; in that
  // case fall back to `isConnected` so we don't block a working connection.
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

/** Subscribe to connectivity changes. Returns an unsubscribe function. */
export function subscribeConnectivity(cb: (connected: boolean) => void): () => void {
  return NetInfo.addEventListener((state) => {
    cb(Boolean(state.isConnected && state.isInternetReachable !== false));
  });
}
