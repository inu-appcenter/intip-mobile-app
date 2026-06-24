import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import WebViewControllerPanel from '../components/WebViewControllerPanel';
import { registerBackgroundHandlers, requestNotificationPermission } from '../push/messaging';
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
    // WebViewProvider orchestrates every WebView container (root + pushed
    // sub-pages) and backs the debug controller (dev menu + panel).
    <WebViewProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        {/* Root portal: main tabs live here via SPA routing. Swipe-back is
            disabled so it never conflicts with the bottom tab navigation. */}
        <Stack.Screen name="index" options={{ gestureEnabled: false }} />
        {/* Sub-pages pushed by `navigateTo`: slide in from the right and allow
            the native swipe-back gesture to pop the container (spec §3.C). */}
        <Stack.Screen
          name="webview"
          options={{
            animation: 'slide_from_right',
            gestureEnabled: true,
            fullScreenGestureEnabled: true,
          }}
        />
      </Stack>
      {/* Debug-only GUI controller, rendered above the whole stack. */}
      <WebViewControllerPanel />
    </WebViewProvider>
  );
}
