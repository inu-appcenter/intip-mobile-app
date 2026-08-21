const { withProjectBuildGradle } = require("expo/config-plugins");

const WORK_MANAGER_VERSION = "2.8.0";
const ANCHOR = "// @generated withWorkManagerVersionAlign";

/**
 * androidx.glance:glance-appwidget (expo-widgets) pulls androidx.work:work-runtime-ktx:2.7.1
 * while other deps pull androidx.work:work-runtime:2.8.0. Since WorkManager 2.7 the -ktx
 * extensions were folded into the main artifact, so mixing the two versions produces
 * "Duplicate class androidx.work.OneTimeWorkRequestKt" at :app:checkDebugDuplicateClasses.
 * Aligning every androidx.work artifact on one version removes the overlap.
 */
const snippet = `
${ANCHOR}
allprojects {
  configurations.all {
    resolutionStrategy.eachDependency { details ->
      if (details.requested.group == 'androidx.work') {
        details.useVersion '${WORK_MANAGER_VERSION}'
        details.because 'align androidx.work artifacts; -ktx was merged into work-runtime in 2.7'
      }
    }
  }
}
`;

module.exports = function withWorkManagerVersionAlign(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error(
        "withWorkManagerVersionAlign only supports the groovy build.gradle"
      );
    }
    if (!cfg.modResults.contents.includes(ANCHOR)) {
      cfg.modResults.contents += snippet;
    }
    return cfg;
  });
};
