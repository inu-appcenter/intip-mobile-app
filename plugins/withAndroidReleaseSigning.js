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
const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');

const RELEASE_SIGNING_CONFIG = `
        release {
            storeFile file(System.getenv("ANDROID_RELEASE_STORE_FILE") ?: "../../intip.jks")
            storePassword System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
            keyAlias System.getenv("ANDROID_RELEASE_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
        }`;

const MINIFY_ANCHOR_REGEXES = [
  /minifyEnabled\s+enableProguardInReleaseBuilds/,
  /minifyEnabled\s+false/,
];

const PROGUARD_FILE_REGEX =
  /proguardFiles getDefaultProguardFile\((['"])proguard-android\.txt\1\), (['"])proguard-rules\.pro\2/;
const OPTIMIZED_PROGUARD_FILE_LINE =
  'proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"';
const PROGUARD_RULES_BLOCK_START = '# @generated withAndroidReleaseSigning begin';
const PROGUARD_RULES_BLOCK_END = '# @generated withAndroidReleaseSigning end';
const PROGUARD_RULES_BLOCK = `${PROGUARD_RULES_BLOCK_START}
# Baseline rules for release stability with R8 enabled.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,Signature,InnerClasses,EnclosingMethod
-keepclassmembers class * {
    native <methods>;
}
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
# Add app-specific reflection/serialization keep rules below when needed.
${PROGUARD_RULES_BLOCK_END}
`;

function applyReleaseBuildGradlePatches(contents) {
  let nextContents = contents;

  if (!nextContents.includes('signingConfigs.release')) {
    if (!nextContents.includes('signingConfigs {')) {
      throw new Error(
        'withAndroidReleaseSigning: no `signingConfigs {` block found in ' +
          'app/build.gradle — the Expo-generated template must have changed.',
      );
    }
    nextContents = nextContents.replace(
      'signingConfigs {',
      `signingConfigs {${RELEASE_SIGNING_CONFIG}`,
    );

    // Anchored on RN's own scaffold comment (stable across Expo versions)
    // rather than surrounding whitespace, so this only ever touches the
    // `release` buildType's signingConfig line, not the `debug` one.
    const signingAnchor = /(\/\/ Caution! In production[\s\S]*?signingConfig )signingConfigs\.debug/;
    if (!signingAnchor.test(nextContents)) {
      throw new Error(
        'withAndroidReleaseSigning: could not find the release buildType\'s ' +
          '`signingConfig signingConfigs.debug` line to replace — the ' +
          'Expo-generated template must have changed.',
      );
    }
    nextContents = nextContents.replace(signingAnchor, '$1signingConfigs.release');
  }

  if (nextContents.includes('minifyEnabled true')) {
    if (!nextContents.includes('shrinkResources true')) {
      nextContents = nextContents.replace(
        'minifyEnabled true',
        'minifyEnabled true\n            shrinkResources true',
      );
    }
  } else {
    const minifyAnchor = MINIFY_ANCHOR_REGEXES.find((regex) => regex.test(nextContents));
    if (!minifyAnchor) {
      throw new Error(
        'withAndroidReleaseSigning: could not find release minifyEnabled line ' +
          'to enforce R8 settings — the Expo-generated template must have changed.',
      );
    }
    nextContents = nextContents.replace(
      minifyAnchor,
      'minifyEnabled true\n            shrinkResources true',
    );
  }

  if (!nextContents.includes(OPTIMIZED_PROGUARD_FILE_LINE)) {
    if (!PROGUARD_FILE_REGEX.test(nextContents)) {
      throw new Error(
        'withAndroidReleaseSigning: could not find release proguardFiles line ' +
          'to enforce optimized defaults — the Expo-generated template must have changed.',
      );
    }
    nextContents = nextContents.replace(PROGUARD_FILE_REGEX, OPTIMIZED_PROGUARD_FILE_LINE);
  }

  return nextContents;
}

function applyProguardRulesPatches(contents) {
  const existing = contents.trimEnd();
  const blockRegex = new RegExp(
    `${PROGUARD_RULES_BLOCK_START}[\\s\\S]*?${PROGUARD_RULES_BLOCK_END}\\n?`,
    'g',
  );
  const withoutGeneratedBlock = existing.replace(blockRegex, '').trimEnd();
  if (!withoutGeneratedBlock) {
    return `${PROGUARD_RULES_BLOCK}\n`;
  }
  return `${withoutGeneratedBlock}\n\n${PROGUARD_RULES_BLOCK}\n`;
}

function withAndroidProguardRules(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const proguardFilePath = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro',
      );
      const existing = fs.existsSync(proguardFilePath)
        ? fs.readFileSync(proguardFilePath, 'utf8')
        : '';
      fs.writeFileSync(proguardFilePath, applyProguardRulesPatches(existing));
      return cfg;
    },
  ]);
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;

    try {
      contents = applyReleaseBuildGradlePatches(contents);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `withAndroidReleaseSigning failed while patching app/build.gradle: ${error.message}`,
        );
      }
      throw error;
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = function withAndroidReleaseBuildHardening(config) {
  return withAndroidProguardRules(withAndroidReleaseSigning(config));
};
module.exports.applyReleaseBuildGradlePatches = applyReleaseBuildGradlePatches;
module.exports.applyProguardRulesPatches = applyProguardRulesPatches;
