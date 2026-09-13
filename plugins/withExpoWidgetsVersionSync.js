/**
 * expo-widgets hardcodes CURRENT_PROJECT_VERSION="1" / MARKETING_VERSION="1.0"
 * for its own widget extension target's Xcode build settings
 * (node_modules/expo-widgets/plugin/build/ios/xcode/addXCConfigurationList.js),
 * completely independent of this app's actual buildNumber/version.
 *
 * Xcode's "Apple Generic" versioning system uses those BUILD SETTINGS to
 * overwrite CFBundleVersion/CFBundleShortVersionString in the *compiled*
 * Info.plist at build time — clobbering the correct values expo-widgets
 * itself already computed and wrote into the source Info.plist (see
 * withWidgetSourceFiles.js's own `config.ios?.buildNumber` read). Confirmed
 * the hard way: `ios/ExpoWidgetsTarget/Info.plist` correctly says
 * CFBundleVersion=26 (matching app.json's ios.buildNumber), but the actually
 * *built* .appex ships CFBundleVersion=1 regardless — exactly the mismatch
 * Xcode's own build warning flags ("must match that of its containing app"),
 * and on iOS 26 that's enough for WidgetKit to silently refuse to list the
 * widget in the Home Screen's "Add Widget" gallery at all (reproduced on
 * iPhone 17 Pro / iOS 26.5 simulator: build succeeds, widget never appears).
 *
 * Must be listed *before* `expo-widgets` in app.json's `plugins` array —
 * counterintuitively. Expo's config-plugin mods compose like middleware:
 * each `withXcodeProject` call wraps the *previously registered* mod as its
 * `nextMod` and runs its own callback FIRST, calling `nextMod` afterward
 * (see `withMod`/`withBaseMod` in @expo/config-plugins). Since the mod
 * actually invoked by the compiler is whichever was registered *last*
 * (outermost wrapper), that plugin's callback runs first chronologically,
 * and every earlier-registered plugin runs progressively later, closest to
 * the base file read/write. So a plugin listed AFTER `expo-widgets` here
 * would run BEFORE it — patching build settings the target doesn't have
 * yet, then having expo-widgets' own target creation (hardcoded
 * CURRENT_PROJECT_VERSION="1"/MARKETING_VERSION="1.0") clobber them right
 * back. Confirmed both ways by inspecting the generated project.pbxproj.
 * Listed *before* `expo-widgets` instead, this plugin's callback runs
 * *after* it creates the target, so our values are the ones left standing.
 *
 * No-ops harmlessly if the target doesn't exist yet (e.g. the dev variant,
 * which excludes expo-widgets entirely — see app.config.js): `xcode`'s
 * `updateBuildProperty` only touches configurations whose target name
 * resolves via `pbxTargetByName`, doing nothing if it doesn't.
 */
const { withXcodeProject } = require("expo/config-plugins");

const WIDGET_TARGET_NAME = "ExpoWidgetsTarget";
const BUILD_CONFIGS = ["Debug", "Release"];

module.exports = function withExpoWidgetsVersionSync(config) {
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    // Same fallback/precedence expo-widgets itself uses when it first writes
    // the (correct, but doomed-to-be-overwritten) source Info.plist.
    const buildNumber = cfg.ios?.buildNumber ?? "1";
    const marketingVersion = cfg.ios?.version ?? cfg.version ?? "1.0";

    for (const buildConfig of BUILD_CONFIGS) {
      proj.updateBuildProperty("CURRENT_PROJECT_VERSION", buildNumber, buildConfig, WIDGET_TARGET_NAME);
      proj.updateBuildProperty(
        "MARKETING_VERSION",
        marketingVersion,
        buildConfig,
        WIDGET_TARGET_NAME,
      );
    }

    return cfg;
  });
};
