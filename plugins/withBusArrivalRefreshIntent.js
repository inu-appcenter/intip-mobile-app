/**
 * Gives the iOS 인입런 widget a tap-to-refresh that fetches in the widget
 * extension itself, without opening the app.
 *
 * See `plugins/widget-ios/BusArrivalRefresh.swift` for the why. This plugin
 * only installs it:
 *
 * - copies that file into `ios/ExpoWidgetsTarget/` and adds it to the
 *   extension target's Sources phase, and
 * - rewrites the `BusArrivalWidget.swift` expo-widgets generates so its entry
 *   view is the file's `BusArrivalEntryView` (the generated view plus a tap
 *   target over the refresh icon) instead of the bare `WidgetsEntryView`.
 *
 * Must be listed *before* `expo-widgets` in app.json's `plugins`, for the
 * same reason as `withWidgetAssets` and `withExpoWidgetsVersionSync`: mods
 * registered earlier run later, and expo-widgets deletes and regenerates the
 * whole `ExpoWidgetsTarget` directory, so anything written there before it
 * runs is gone.
 *
 * Requires `expo prebuild --clean` + a native rebuild. Does not ship via OTA.
 */
const fs = require('fs');
const path = require('path');

const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

/** Must match `targetName` in expo-widgets' `plugin/src/ios/withIosWidgets.ts`. */
const IOS_WIDGET_TARGET = 'ExpoWidgetsTarget';

const SWIFT_SOURCE = 'plugins/widget-ios/BusArrivalRefresh.swift';
const SWIFT_FILENAME = path.basename(SWIFT_SOURCE);
const WIDGET_SWIFT = 'BusArrivalWidget.swift';

const GENERATED_ENTRY_VIEW = 'WidgetsEntryView(entry: entry)';
const PATCHED_ENTRY_VIEW = 'BusArrivalEntryView(entry: entry)';

/**
 * Swaps the entry view in expo-widgets' generated `BusArrivalWidget.swift`.
 *
 * Throws rather than skipping when the generated code isn't what it expects:
 * an expo-widgets upgrade that changes the template would otherwise ship a
 * widget that silently lost its refresh button.
 */
function patchBusArrivalWidgetSwift(source) {
  if (source.includes(PATCHED_ENTRY_VIEW)) return source;

  const occurrences = source.split(GENERATED_ENTRY_VIEW).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `withBusArrivalRefreshIntent: expected exactly one "${GENERATED_ENTRY_VIEW}" in the ` +
        `generated ${WIDGET_SWIFT}, found ${occurrences}. expo-widgets' widget template ` +
        `has changed — update this plugin to match.`
    );
  }
  return source.replace(GENERATED_ENTRY_VIEW, PATCHED_ENTRY_VIEW);
}

function withBusArrivalSwiftFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const targetDir = path.join(platformProjectRoot, IOS_WIDGET_TARGET);
      const widgetPath = path.join(targetDir, WIDGET_SWIFT);
      if (!fs.existsSync(widgetPath)) {
        throw new Error(
          `withBusArrivalRefreshIntent: ${path.relative(projectRoot, widgetPath)} doesn't exist. ` +
            `This plugin must run after expo-widgets — list it before "expo-widgets" in app.json.`
        );
      }

      fs.copyFileSync(path.join(projectRoot, SWIFT_SOURCE), path.join(targetDir, SWIFT_FILENAME));
      fs.writeFileSync(widgetPath, patchBusArrivalWidgetSwift(fs.readFileSync(widgetPath, 'utf8')));
      return cfg;
    },
  ]);
}

function withBusArrivalSwiftBuildFile(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;

    const targets = project.pbxNativeTargetSection();
    const targetUuid = Object.keys(targets).find(
      (uuid) => !uuid.endsWith('_comment') && targets[uuid].name?.replace(/"/g, '') === IOS_WIDGET_TARGET
    );
    if (!targetUuid) {
      throw new Error(
        `withBusArrivalRefreshIntent: no "${IOS_WIDGET_TARGET}" target in the Xcode project. ` +
          `This plugin must run after expo-widgets — list it before "expo-widgets" in app.json.`
      );
    }

    // Idempotent, like withWidgetAssets: a duplicate reference would compile
    // the file twice and fail on duplicate symbols.
    const alreadyAdded = Object.values(project.pbxFileReferenceSection()).some(
      (ref) => typeof ref === 'object' && ref.path?.replace(/"/g, '') === SWIFT_FILENAME
    );
    if (!alreadyAdded) {
      // Relative to the group: expo-widgets gives the ExpoWidgetsTarget group
      // its own `path` (see withWidgetAssets for the same caveat).
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: SWIFT_FILENAME,
        groupName: IOS_WIDGET_TARGET,
        project,
        targetUuid,
      });
    }
    return cfg;
  });
}

module.exports = function withBusArrivalRefreshIntent(config) {
  return withBusArrivalSwiftBuildFile(withBusArrivalSwiftFiles(config));
};

// Exported for the unit test in __tests__; not part of the plugin contract.
module.exports.patchBusArrivalWidgetSwift = patchBusArrivalWidgetSwift;
