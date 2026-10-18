const { withPodfile } = require("expo/config-plugins");

// Xcode 27 (iOS SDK 27.x) only accepts IPHONEOS_DEPLOYMENT_TARGET >= 15.0.
// Some pods still declare older targets on their own targets — mostly the
// privacy-manifest resource bundles (GoogleUtilities_Privacy, nanopb_Privacy,
// RNPermissionsPrivacyInfo, ...) — and Archive fails with "The iOS deployment
// target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 12.0, but the range of
// supported deployment target versions is 15.0 to 27.1.x".
// Raise any pod target below the app's own minimum (Podfile `platform :ios`,
// 16.4) up to it; targets already at or above it are left alone.
const MIN_TARGET = "16.4";
const ANCHOR = "# @generated withPodsMinDeploymentTarget";

const snippet = `
    ${ANCHOR}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || Gem::Version.new(current) < Gem::Version.new('${MIN_TARGET}')
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_TARGET}'
        end
      end
    end
`;

module.exports = function withPodsMinDeploymentTarget(config) {
  return withPodfile(config, (cfg) => {
    const contents = cfg.modResults.contents;
    if (contents.includes(ANCHOR)) return cfg;

    const hook = "post_install do |installer|";
    if (!contents.includes(hook)) {
      throw new Error(
        "withPodsMinDeploymentTarget: no `post_install do |installer|` in Podfile"
      );
    }
    cfg.modResults.contents = contents.replace(hook, `${hook}${snippet}`);
    return cfg;
  });
};
