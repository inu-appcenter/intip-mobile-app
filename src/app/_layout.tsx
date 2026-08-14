import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider } from 'expo-share-intent';

import WebViewControllerPanel from '../components/WebViewControllerPanel';
import { registerBackgroundHandlers, requestNotificationPermission } from '../push/messaging';
import { checkForUpdate } from '../native/updateCheck';
import { WebViewProvider } from '../webview/WebViewContext';
import { backgroundColorFor } from '../theme';

// Background FCM/notifee handlers must be registered before React renders so
// they survive a background/quit launch.
registerBackgroundHandlers();

export default function RootLayout() {
  const scheme = useColorScheme();
  // Native-stack's own screen background — without this, a pop transition can
  // reveal the bare Android window background (unstyled, reads as black) for
  // a frame before our content paints over it.
  const contentBackgroundColor = backgroundColorFor(scheme);

  useEffect(() => {
    // Ask for notification permission on first launch (alert + badge + sound).
    void requestNotificationPermission();
    // Check for OTA updates (non-blocking; shows a prompt if one is available).
    void checkForUpdate();
  }, []);

  return (
    // GestureHandlerRootView wraps the tree so gesture-handler based components
    // (the dev controller panel) work; native-stack transitions/swipe-back are
    // handled natively by react-native-screens and don't depend on it.
    <GestureHandlerRootView style={{ flex: 1 }}>

      {/* Must wrap everything else (per expo-share-intent's own docs) so the
          native module's deep-link-triggered cold start is caught before any
          other provider mounts. Android only for now — the plugin config
          (app.json) sets `disableIOS`, so this is a no-op on iOS. */}
      <ShareIntentProvider>
        {/* WebViewProvider orchestrates every WebView container (root + pushed
            sub-pages) and backs the debug controller (dev menu + panel). */}
              <WebViewProvider>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: contentBackgroundColor } }}
        >
          {/* Root portal: main tabs live here via SPA routing. Swipe-back is
              disabled so it never conflicts with the bottom tab navigation. */}
          <Stack.Screen name="index" options={{ gestureEnabled: false }} />
            <Stack.Screen
              name="webview"
              options={{
                animation: 'default',
                gestureEnabled: true,

              }}
            />
          </Stack>
          {/* Debug-only GUI controller, rendered above the whole stack. */}
          <WebViewControllerPanel />
        </WebViewProvider>
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}
