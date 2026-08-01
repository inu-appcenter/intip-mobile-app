/**
 * Sets the Android default FCM notification channel via AndroidManifest
 * meta-data, so background/killed-state notifications (drawn directly by the
 * FCM SDK, not by notifee) use the same channel as the foreground banner
 * channel created in `src/push/messaging.ts` (`notifee.createChannel({ id:
 * 'default', ... })`).
 *
 * Without this, Firebase falls back to an auto-created "Miscellaneous"
 * channel with its own (wrong) importance/sound settings — see
 * docs/push-notification-routing/plan.md, G5.
 *
 * `@react-native-firebase/messaging`'s own config plugin does not expose this
 * option, so it's done here as a local plugin.
 *
 * Manifest-only change: requires `expo prebuild` + a native rebuild. Does not
 * ship via OTA update.
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

/** Must match the notifee channel id in `src/push/messaging.ts`. */
const DEFAULT_NOTIFICATION_CHANNEL_ID = 'default';

const META_DATA_NAME =
  'com.google.firebase.messaging.default_notification_channel_id';

module.exports = function withDefaultNotificationChannel(config) {
  return withAndroidManifest(config, (cfg) => {
    // The manifest merger needs xmlns:tools for tools:replace below.
    cfg.modResults.manifest.$['xmlns:tools'] =
      'http://schemas.android.com/tools';
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      mainApplication,
      META_DATA_NAME,
      DEFAULT_NOTIFICATION_CHANNEL_ID,
    );
    // :react-native-firebase_messaging's library manifest declares the same
    // meta-data with an empty value; without tools:replace the merger fails.
    const item = mainApplication['meta-data'].find(
      (m) => m.$['android:name'] === META_DATA_NAME,
    );
    item.$['tools:replace'] = 'android:value';
    return cfg;
  });
};
