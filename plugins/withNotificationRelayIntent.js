/**
 * Installs `plugins/notification-relay-ios/RelayNotificationIntent.swift` — the
 * App Intent that an iOS 27 Shortcuts "when I get a notification" automation
 * calls with the notification's title/body — into the main app target.
 *
 * Why not inside `modules/intip-notification-relay/ios/`: App Intents metadata
 * is extracted only for the target that compiles the intent's source. The
 * module pod is linked as a static framework (`useFrameworks: static`), so an
 * intent there builds fine but never shows up in Shortcuts. Same reasoning as
 * `withBusArrivalRefreshIntent`, which does this for the widget target.
 *
 * - copies the file into `ios/<ProjectName>/`, and
 * - adds it to the application target's Sources phase (idempotent).
 *
 * Requires `expo prebuild --clean` + a native rebuild. Does not ship via OTA.
 * See docs/notification-relay/plan.md.
 */
const fs = require('fs');
const path = require('path');

const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const SWIFT_SOURCE = 'plugins/notification-relay-ios/RelayNotificationIntent.swift';
const SWIFT_FILENAME = path.basename(SWIFT_SOURCE);

function withRelayIntentSwiftFile(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectRoot } = cfg.modRequest;
      const sourceRoot = IOSConfig.Paths.getSourceRoot(projectRoot);
      fs.copyFileSync(path.join(projectRoot, SWIFT_SOURCE), path.join(sourceRoot, SWIFT_FILENAME));
      return cfg;
    },
  ]);
}

function withRelayIntentBuildFile(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);

    // A duplicate reference would compile the file twice and fail on duplicate symbols.
    const alreadyAdded = Object.values(project.pbxFileReferenceSection()).some(
      (ref) => typeof ref === 'object' && path.basename(ref.path?.replace(/"/g, '') ?? '') === SWIFT_FILENAME
    );
    if (!alreadyAdded) {
      // The app group in Expo's template has no `path`, so files are referenced as
      // `<ProjectName>/File.swift`. No targetUuid → the application target.
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: `${projectName}/${SWIFT_FILENAME}`,
        groupName: projectName,
        project,
      });
    }
    return cfg;
  });
}

module.exports = function withNotificationRelayIntent(config) {
  return withRelayIntentBuildFile(withRelayIntentSwiftFile(config));
};
