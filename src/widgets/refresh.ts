import { Platform } from "react-native";

import TestWidget from "./TestWidget";

/**
 * Pushes a snapshot into the home screen widget.
 *
 * A widget renders whatever the last timeline entry held; with no entry it sits
 * on the placeholder the system draws at install time. `updateSnapshot` writes a
 * single entry dated now, which is all the countdown needs — the timer text
 * ticks on the WidgetKit side from there.
 *
 * expo-widgets is iOS-only. The Android build resolves to a no-op stub rather
 * than throwing, so the guard is about not doing pointless work, not safety.
 */
export function refreshTestWidget() {
  if (Platform.OS !== "ios") {
    return;
  }

  const now = Date.now();
  TestWidget.updateSnapshot({
    label: "테스트 카운트다운",
    targetAt: now + 60 * 60 * 1000,
    updatedAt: now,
  });
}
