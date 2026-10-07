import { describe, expect, it } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyReleaseBuildGradlePatches } = require('../withAndroidReleaseSigning') as {
  applyReleaseBuildGradlePatches: (contents: string) => string;
};

const BASE_BUILD_GRADLE = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableProguardInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
    }
}
`;

describe('applyReleaseBuildGradlePatches', () => {
  it('enables signingConfig release, minify, shrinkResources, and optimized proguard defaults', () => {
    const patched = applyReleaseBuildGradlePatches(BASE_BUILD_GRADLE);

    expect(patched).toContain('signingConfigs.release');
    expect(patched).toContain('minifyEnabled true');
    expect(patched).toContain('shrinkResources true');
    expect(patched).toContain(
      'proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"',
    );
    expect(patched).not.toContain('enableProguardInReleaseBuilds');
    expect(patched).not.toContain('proguard-android.txt');
  });

  it('is idempotent when run multiple times', () => {
    const once = applyReleaseBuildGradlePatches(BASE_BUILD_GRADLE);
    const twice = applyReleaseBuildGradlePatches(once);

    expect(twice).toBe(once);
  });
});
