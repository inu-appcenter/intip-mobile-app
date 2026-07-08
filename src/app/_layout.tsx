import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import WebViewControllerPanel from '../components/WebViewControllerPanel';
import { registerBackgroundHandlers, requestNotificationPermission } from '../push/messaging';
import WebViewHost from '../webview/WebViewHost';
import { WebViewProvider } from '../webview/WebViewContext';

// Background FCM/notifee handlers must be registered before React renders so
// they survive a background/quit launch.
registerBackgroundHandlers();

export default function RootLayout() {
  useEffect(() => {
    // Ask for notification permission on first launch (alert + badge + sound).
    void requestNotificationPermission();
  }, []);

  return (
    // GestureHandlerRootView must wrap the tree so the custom sub-stack's
    // swipe-back gesture (Gesture.Pan in WebViewHost) receives touches.
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* WebViewProvider orchestrates every WebView instance (root + pushed
          sub-pages) and backs the debug controller (dev menu + panel). */}
      <WebViewProvider>
        <StatusBar style="auto" />
        {/* The only router screen is the launch background; every WebView
            instance (root + custom sub-stack) is owned by <WebViewHost/>, which
            overlays the stack so instances persist across navigations. */}
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" options={{ gestureEnabled: false }} />
        </Stack>
        {/* Persistent WebView layer: root portal + custom animated sub-stack. */}
        <WebViewHost />
        {/* Debug-only GUI controller, rendered above everything. */}
        <WebViewControllerPanel />
      </WebViewProvider>
    </GestureHandlerRootView>
  );
}
