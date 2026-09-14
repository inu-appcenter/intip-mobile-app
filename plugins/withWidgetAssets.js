/**
 * Ships the widgets' own icons to both native projects from one tracked SVG.
 *
 * `/ios` and `/android` are both gitignored prebuild output, so an icon a
 * widget draws cannot simply be committed into either native tree — it has to
 * be generated. This plugin is that generator. For each entry in
 * `WIDGET_ASSETS` it produces, from a single source SVG:
 *
 * - iOS: `ios/<target>/Assets.xcassets/<AssetName>.imageset/` (the SVG
 *   verbatim plus a `Contents.json`), registered on the widget extension
 *   target. Xcode 12+ takes SVG directly in an asset catalog, so there is no
 *   conversion step and no @2x/@3x rasters.
 * - Android: `android/app/src/main/res/drawable/<asset_name>.xml`, a vector
 *   drawable carrying the SVG's own path data.
 *
 * Both sides are then addressed by ONE name from ONE `<Image assetName>` in
 * `src/widgets/*.tsx`: `@expo/ui`'s `ImageView` resolves it against the
 * widget target's asset catalog, and expo-widgets-glance resolves it against
 * the app's `res/drawable` (see that package's `AssetDrawables` — the
 * PascalCase→snake_case conversion below must stay identical to its
 * `toResourceName`). The alternative, `systemName`, is an SF Symbol: iOS-only
 * vocabulary with nothing on Android to resolve it against.
 *
 * Both assets are monochrome templates, tinted at runtime by the `color` prop
 * (iOS: `template-rendering-intent` + `foregroundStyle`; Android:
 * `ColorFilter.tint`), so one file serves every color a widget needs — see
 * `BusArrivalWidget.tsx`'s `busColor`, which stays the single source of truth
 * for the palette on both platforms.
 *
 * Requires `expo prebuild --clean` + a native rebuild. Does not ship via OTA.
 */
const fs = require('fs');
const path = require('path');

const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

/**
 * Must match `targetName` in expo-widgets' own
 * `plugin/src/ios/withIosWidgets.ts`. If that package ever renames the
 * extension target, the assertion in `withIosWidgetAssetCatalog` below is
 * what will catch it.
 */
const IOS_WIDGET_TARGET = 'ExpoWidgetsTarget';

/**
 * Widget icons, by the name `<Image assetName="...">` uses.
 *
 * Sources are tracked in this repo. `busIcon.svg` is inu-portal-web's
 * fontello glyph `icon-bus` (uid `aef20d27…`, codepoint U+E80B) lifted out of
 * that project's `fontello/config.json` — the icon set the web app actually
 * renders with, so the two apps draw the same bus. fontello stores the glyph
 * on a 1000-unit em, already in y-down SVG coordinates (its `config.json`
 * path is the y-flip of the one in `font/fontello.svg`), so it needs no
 * transform — just a `viewBox` of `0 0 1000 1000`.
 *
 * Re-lift it if the web app's icon set changes. There is no shared asset
 * pipeline between the repos and nothing here will notice drift on its own.
 */
const WIDGET_ASSETS = [
  { assetName: 'BusIcon', source: 'assets/widgets/busIcon.svg', androidSizeDp: 24 },
  // Material Icons `refresh` (Apache License 2.0), on its native 24-unit
  // viewBox. The web app's fontello set has no refresh glyph to lift, so this
  // is the one icon here not shared with inu-portal-web.
  { assetName: 'RefreshIcon', source: 'assets/widgets/refreshIcon.svg', androidSizeDp: 24 },
];

/**
 * `BusIcon` → `bus_icon`. Kept character-for-character in step with
 * `AssetDrawables.toResourceName` in expo-widgets-glance's
 * `GlanceTreeRenderer.kt`; if they disagree, Android silently falls back to a
 * placeholder glyph while iOS renders fine.
 */
function toResourceName(assetName) {
  return assetName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
}

/**
 * Pulls the one path out of a single-path, single-color SVG.
 *
 * Deliberately not a general SVG→VectorDrawable converter: that is a real
 * project (groups, transforms, gradients, strokes, clip paths, `style`
 * attributes) and getting it subtly wrong would show up as a quietly
 * malformed icon on one platform only. So this handles exactly the shape a
 * monochrome widget glyph has and throws on anything else, rather than
 * emitting something plausible-looking. iOS is unaffected either way — it
 * consumes the original SVG.
 */
function parseMonochromeSvg(svg, sourcePath) {
  const fail = (why) => {
    throw new Error(
      `withWidgetAssets: ${sourcePath} ${why}. Only a single-path, ` +
        `single-color SVG can be converted to an Android vector drawable ` +
        `here; hand-write the drawable instead if the icon needs more.`
    );
  };

  for (const [token, why] of [
    ['<g', 'contains a group'],
    ['Gradient', 'contains a gradient'],
    ['stroke=', 'has a stroke'],
    ['transform=', 'has a transform'],
    ['clip-path', 'has a clip path'],
  ]) {
    if (svg.includes(token)) fail(why);
  }

  const paths = svg.match(/<path\b[^>]*>/g) ?? [];
  if (paths.length !== 1) fail(`has ${paths.length} <path> elements, expected exactly 1`);

  const d = paths[0].match(/\sd="([^"]+)"/);
  if (!d) fail('has a <path> with no "d" attribute');

  const viewBox = svg.match(/\sviewBox="([\d.\s-]+)"/);
  if (!viewBox) fail('has no viewBox');
  const box = viewBox[1].trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4) fail('has a viewBox that is not 4 numbers');

  return { pathData: d[1], viewportWidth: box[2], viewportHeight: box[3] };
}

/**
 * `androidSizeDp` is the drawable's *intrinsic* size; the viewport stays the
 * SVG's own viewBox. The two are deliberately independent — this glyph's
 * viewBox is a 1000-unit em, and emitting `android:width="1000dp"` from it
 * would declare a 1000dp icon that only looks right because every caller
 * happens to override it with an explicit `frame`. 24dp is the Android icon
 * convention and matches what the iOS side resolves to at its natural size.
 */
function vectorDrawableXml({ pathData, viewportWidth, viewportHeight }, sourcePath, sizeDp) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  GENERATED by plugins/withWidgetAssets.js from ${sourcePath} — do not edit.
  /android is prebuild output; edits here are lost on the next prebuild.

  fillColor is a placeholder. expo-widgets-glance's "ImageView" branch always
  applies a real tint via ColorFilter (from the \`color\` prop), so this value
  never reaches the screen.
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${sizeDp}dp"
    android:height="${sizeDp}dp"
    android:viewportWidth="${viewportWidth}"
    android:viewportHeight="${viewportHeight}">
  <path
      android:fillColor="#FF000000"
      android:pathData="${pathData}" />
</vector>
`;
}

/** `Contents.json` for a vector imageset that keeps its vector data. */
function imagesetContentsJson(filename) {
  return `${JSON.stringify(
    {
      images: [{ filename, idiom: 'universal' }],
      info: { version: 1, author: 'xcode' },
      properties: {
        // Without this, actool rasterizes at build time and the icon stops
        // being resolution independent.
        'preserves-vector-representation': true,
        // What makes `foregroundStyle` (i.e. `Image`'s `color` prop) tint it.
        // A non-template image would render in its own baked-in color.
        'template-rendering-intent': 'template',
      },
    },
    null,
    2
  )}\n`;
}

function withIosWidgetAssetFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const catalogDir = path.join(platformProjectRoot, IOS_WIDGET_TARGET, 'Assets.xcassets');
      fs.mkdirSync(catalogDir, { recursive: true });
      fs.writeFileSync(
        path.join(catalogDir, 'Contents.json'),
        `${JSON.stringify({ info: { version: 1, author: 'xcode' } }, null, 2)}\n`
      );

      for (const { assetName, source } of WIDGET_ASSETS) {
        const filename = path.basename(source);
        const imagesetDir = path.join(catalogDir, `${assetName}.imageset`);
        fs.mkdirSync(imagesetDir, { recursive: true });
        fs.copyFileSync(path.join(projectRoot, source), path.join(imagesetDir, filename));
        fs.writeFileSync(path.join(imagesetDir, 'Contents.json'), imagesetContentsJson(filename));
      }
      return cfg;
    },
  ]);
}

/**
 * Registers the asset catalog on the widget extension target.
 *
 * expo-widgets builds that target with a Sources build phase only — it has no
 * Resources phase and no asset-catalog handling at all — so without this the
 * files written above are on disk but never compiled into the extension
 * bundle, and `Image(assetName:)` finds nothing at runtime. (A widget
 * extension's `Bundle.main` is the extension, not the app, so putting the
 * asset in the app's own catalog would not help.)
 */
function withIosWidgetAssetCatalog(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;

    const targets = project.pbxNativeTargetSection();
    const targetUuid = Object.keys(targets).find(
      (uuid) => !uuid.endsWith('_comment') && targets[uuid].name?.replace(/"/g, '') === IOS_WIDGET_TARGET
    );
    if (!targetUuid) {
      throw new Error(
        `withWidgetAssets: no "${IOS_WIDGET_TARGET}" target in the Xcode project. ` +
          `This plugin must run after expo-widgets (check the plugins order in app.json), ` +
          `and expects expo-widgets' own target name — see its withIosWidgets.ts.`
      );
    }

    if (!project.findPBXGroupKey({ name: IOS_WIDGET_TARGET })) {
      throw new Error(`withWidgetAssets: no "${IOS_WIDGET_TARGET}" PBXGroup in the Xcode project.`);
    }

    const hasResourcesPhase = (targets[targetUuid].buildPhases ?? []).some(
      (phase) => phase.comment === 'Resources'
    );
    if (!hasResourcesPhase) {
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', targetUuid);
    }

    // Idempotent: a second prebuild over an existing project would otherwise
    // add a duplicate file reference, which Xcode reports as a build warning
    // and, for asset catalogs, a duplicated-output error.
    const alreadyAdded = Object.values(project.pbxFileReferenceSection()).some(
      (ref) => typeof ref === 'object' && ref.path?.replace(/"/g, '') === 'Assets.xcassets'
    );
    if (!alreadyAdded) {
      // Expo's helper, not `xcode`'s own `project.addResourceFile`: that one
      // runs every resource path through `correctForResourcesPath`, which
      // dereferences `pbxGroupByName('Resources')` unconditionally and throws
      // on a project that has no group by that name — which the Expo template
      // does not. This helper skips that path and takes a `targetUuid`.
      //
      // `filepath` is relative to the group, not to `ios/`: expo-widgets
      // creates the `ExpoWidgetsTarget` group with a `path` of its own, so
      // passing the full `ExpoWidgetsTarget/Assets.xcassets` here would
      // resolve to that segment twice.
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: 'Assets.xcassets',
        groupName: IOS_WIDGET_TARGET,
        project,
        isBuildFile: true,
        targetUuid,
      });
    }

    return cfg;
  });
}

function withAndroidWidgetAssetDrawables(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const drawableDir = path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable');
      fs.mkdirSync(drawableDir, { recursive: true });

      for (const { assetName, source, androidSizeDp } of WIDGET_ASSETS) {
        const svg = fs.readFileSync(path.join(projectRoot, source), 'utf8');
        const parsed = parseMonochromeSvg(svg, source);
        fs.writeFileSync(
          path.join(drawableDir, `${toResourceName(assetName)}.xml`),
          vectorDrawableXml(parsed, source, androidSizeDp ?? 24)
        );
      }
      return cfg;
    },
  ]);
}

module.exports = function withWidgetAssets(config) {
  return withAndroidWidgetAssetDrawables(
    withIosWidgetAssetCatalog(withIosWidgetAssetFiles(config))
  );
};

// Exported for the unit test in __tests__; not part of the plugin contract.
module.exports.toResourceName = toResourceName;
module.exports.parseMonochromeSvg = parseMonochromeSvg;
module.exports.vectorDrawableXml = vectorDrawableXml;
module.exports.imagesetContentsJson = imagesetContentsJson;
