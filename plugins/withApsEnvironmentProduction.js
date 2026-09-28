/**
 * Restores the app target's `aps-environment` entitlement to "production"
 * after expo-widgets clobbers it.
 *
 * expo-widgets (56.0.26) unconditionally writes
 * `aps-environment = "development"` into the app's entitlements — regardless
 * of its own `enablePushNotifications` prop and of app.json's
 * `ios.entitlements` (node_modules/expo-widgets/plugin/build/ios/
 * withPushNotifications.js). The CI release Archive signs manually with the
 * App Store distribution profile, whose entitlements only ever carry
 * `aps-environment = production`, so leaving expo-widgets' value in place
 * makes the entitlements file disagree with the profile and Archive fails.
 * FCM push in the shipped app also needs the production APNs environment.
 *
 * Reads the desired value from app.json's `ios.entitlements` so there is a
 * single source of truth; falls back to "production".
 *
 * Must be listed *before* `expo-widgets` in app.json's `plugins` array, for
 * the same mod-ordering reason documented in withExpoWidgetsVersionSync.js:
 * earlier-registered plugins' mod callbacks run *later*, so this one gets the
 * last word over expo-widgets' entitlement write.
 */
const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withApsEnvironmentProduction(config) {
  const desired = config.ios?.entitlements?.["aps-environment"] ?? "production";
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["aps-environment"] = desired;
    return cfg;
  });
};
