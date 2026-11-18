const { withPodfile } = require("expo/config-plugins");

// Xcode 27: expo-modules-jsi's "[CP-User] Build ExpoModulesJSI xcframework"
// phase runs a nested `xcodebuild -quiet`, which prints a bogus
//   error: the following command failed with exit code 0 but produced no further output
// for a SwiftCompile job that actually succeeded. The outer build sees an
// `error:` line in the script output and fails the archive ("Command
// PhaseScriptExecution emitted errors but did not return a nonzero exit code").
// Upstream fixed its trigger only in 58.x (expo/expo#50482, #50587); 56.x/57.x
// still hits it. Drop exactly that line; pipefail keeps the script's exit
// status, so real compile errors still fail the build.
// Remove once expo-modules-jsi ships a fix for SDK 57 (or after upgrading to 58).
const ANCHOR = "# @generated withJsiXcframeworkPhaseFix";
const BOGUS_LINE =
  "error: the following command failed with exit code 0 but produced no further output";

const snippet = `
    ${ANCHOR}
    installer.pods_project.targets.each do |target|
      next unless target.name == 'ExpoModulesJSI'
      target.shell_script_build_phases.each do |phase|
        next unless phase.name.to_s.include?('Build ExpoModulesJSI xcframework')
        next if phase.shell_script.include?('pipefail')
        phase.shell_script = "set -o pipefail\\n#{phase.shell_script.strip} 2>&1 | sed '/^${BOGUS_LINE}$/d'\\n"
      end
    end
`;

module.exports = function withJsiXcframeworkPhaseFix(config) {
  return withPodfile(config, (cfg) => {
    const contents = cfg.modResults.contents;
    if (contents.includes(ANCHOR)) return cfg;

    const hook = "post_install do |installer|";
    if (!contents.includes(hook)) {
      throw new Error(
        "withJsiXcframeworkPhaseFix: no `post_install do |installer|` in Podfile"
      );
    }
    cfg.modResults.contents = contents.replace(hook, `${hook}${snippet}`);
    return cfg;
  });
};
