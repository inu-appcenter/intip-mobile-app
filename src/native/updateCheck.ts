/**
 * EAS Update (OTA) availability check and install prompt.
 * Runs once per app launch; informs the user if a new version is available
 * and offers to download + reload.
 */
import * as Updates from "expo-updates";
import { Platform } from "react-native";

import { nativeAlert } from "../../modules/intip-native-dialog";

let checkStarted = false;

/**
 * Check for a new OTA update and prompt the user to install if one is available.
 * Safe to call multiple times; the check only runs once per app launch.
 */
export async function checkForUpdate(): Promise<void> {
  // Skip on web (this app has no real web target, and firebase/notifee are
  // native-only anyway — web would fail to initialize).
  if (Platform.OS === "web") return;

  if (checkStarted) return;
  checkStarted = true;

  // Embedded builds (direct from App Store/Play Store, not EAS Update) have no
  // updates URL and can't check.
  if (__DEV__) return;

  try {
    const update = await Updates.checkForUpdateAsync();
    if (update.isAvailable === false) return;

    // New version found. Prompt the user to download + reload.
    nativeAlert(
      "새 버전 업데이트",
      "새 버전이 있습니다. 지금 업데이트 하시겠어요?",
      [
        {
          text: "나중에",
          style: "cancel",
        },
        {
          text: "업데이트",
          onPress: async () => {
            try {
              await Updates.fetchUpdateAsync();
              // Reload to activate the new update.
              await Updates.reloadAsync();
            } catch (err) {
              console.error("[update] fetch/reload failed", err);
              nativeAlert(
                "업데이트 실패",
                "새 버전을 받을 수 없습니다. 나중에 다시 시도해주세요.",
              );
            }
          },
        },
      ],
    );
  } catch (err) {
    console.warn("[update] check failed", err);
    // Silently ignore check failures — OTA is an optimization, not critical.
  }
}
