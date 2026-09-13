// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * Keep Metro out of the widget renderer submodule's own `node_modules`.
 *
 * `packages/expo-widgets-glance` is a git submodule of a standalone OSS
 * package (see AGENTS.md), and it has to run `npm install` in its own
 * directory — that's how its config plugin gets built (`npm run
 * widgets-glance:build`). That install brings its dev dependencies with it,
 * including a second copy of `react` and `react-native`.
 *
 * Node's resolution then finds *that* copy first for any bare import inside
 * the package, and Metro happily bundles both. For stateless modules nothing
 * visible happens, which is why this went unnoticed for a while. For anything
 * holding state it breaks outright: the package's `registerGlanceRefreshTask`
 * registered its headless task on the submodule's `AppRegistry`, while React
 * Native started the app through the app's own — and the app died at launch
 * with `"main" has not been registered`, pointing at a file path under
 * `packages/expo-widgets-glance/node_modules/react-native/`.
 *
 * Nothing under there is ever meant to be bundled: only the package's own
 * `index.ts` is imported, and everything it needs resolves upward to this
 * app's dependencies. Blocking the directory makes that the only possibility
 * rather than the lucky default.
 */
config.resolver.blockList = [
  ...[config.resolver.blockList ?? []].flat(),
  /[/\\]packages[/\\]expo-widgets-glance[/\\]node_modules[/\\].*/,
];

module.exports = config;
