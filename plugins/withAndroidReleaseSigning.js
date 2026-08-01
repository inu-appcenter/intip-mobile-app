/**
 * Wires up real Android release signing so `expo prebuild` doesn't keep
 * regenerating a `release` buildType that signs with the debug key (Play
 * rejects those uploads outright, and — since this app already has a live
 * Play Store listing — a *different* keystore would register as a separate
 * app, not an update).
 *
 * `android/` is gitignored and rebuilt by `expo prebuild` every time, so
 * hand-editing `android/app/build.gradle` doesn't stick; this plugin is the
 * only way for the release signingConfig to survive a `prebuild --clean` —
 * and, unlike a one-off deploy script, it also runs automatically wherever
 * prebuild itself runs (including inside EAS Build, if this project ever
 * adopts it), with no extra step to remember or wire up separately.
 *
 * No secret ever lives in this file or in git. The keystore itself
 * (`intip.jks`, repo root, gitignored via `*.jks`) and its credentials are
 * read by Gradle from environment variables at *build* time, not by this
 * plugin at *prebuild* time — this file only emits the `System.getenv(...)`
 * Groovy calls as literal text.
 *
 * Required env vars when actually running a release build
 * (`./gradlew bundleRelease` / `expo run:android --variant release`):
 *   - ANDROID_RELEASE_STORE_PASSWORD
 *   - ANDROID_RELEASE_KEY_ALIAS
 *   - ANDROID_RELEASE_KEY_PASSWORD
 * Optional:
 *   - ANDROID_RELEASE_STORE_FILE (defaults to `../../intip.jks`, i.e. repo
 *     root, resolved relative to android/app/build.gradle)
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_SIGNING_CONFIG = `
        release {
            storeFile file(System.getenv("ANDROID_RELEASE_STORE_FILE") ?: "../../intip.jks")
            storePassword System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
            keyAlias System.getenv("ANDROID_RELEASE_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
        }`;

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;

    if (!contents.includes('signingConfigs {')) {
      throw new Error(
        'withAndroidReleaseSigning: no `signingConfigs {` block found in ' +
          'app/build.gradle — the Expo-generated template must have changed.',
      );
    }
    contents = contents.replace(
      'signingConfigs {',
      `signingConfigs {${RELEASE_SIGNING_CONFIG}`,
    );

    // Anchored on RN's own scaffold comment (stable across Expo versions)
    // rather than surrounding whitespace, so this only ever touches the
    // `release` buildType's signingConfig line, not the `debug` one.
    const anchor = /(\/\/ Caution! In production[\s\S]*?signingConfig )signingConfigs\.debug/;
    if (!anchor.test(contents)) {
      throw new Error(
        'withAndroidReleaseSigning: could not find the release buildType\'s ' +
          '`signingConfig signingConfigs.debug` line to replace — the ' +
          'Expo-generated template must have changed.',
      );
    }
    contents = contents.replace(anchor, '$1signingConfigs.release');

    cfg.modResults.contents = contents;
    return cfg;
  });
};
