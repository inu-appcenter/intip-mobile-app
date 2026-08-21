import { Stack } from "expo-router";
import { ShareIntentProvider } from "expo-share-intent";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import WebViewControllerPanel from "../components/WebViewControllerPanel";
import { checkForUpdate } from "../native/updateCheck";
import {
  registerBackgroundHandlers,
  requestNotificationPermission,
} from "../push/messaging";
import { backgroundColorFor } from "../theme";
import { WebViewProvider } from "../webview/WebViewContext";
import { refreshTestWidget } from "../widgets/refresh";

// Background FCM/notifee handlers must be registered before React renders so
// they survive a background/quit launch.
registerBackgroundHandlers();

// Hold the system splash until SplashArt has actually drawn its artwork, so it
// hands straight over instead of flashing the bare window background in
// between. SplashArt itself calls `hideAsync` once its images report they are
// on screen. Both calls here must run in global scope, before the first
// render.
void SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 250, fade: true });

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
    // Seed the home screen widget so it has something to draw after install.
    refreshTestWidget();
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
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: contentBackgroundColor },
            }}
          >
            {/* Root portal: main tabs live here via SPA routing. Swipe-back is
              disabled so it never conflicts with the bottom tab navigation. */}
            <Stack.Screen name="index" options={{ gestureEnabled: false }} />
            <Stack.Screen
              name="webview"
              options={{
                animation: "default",
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
