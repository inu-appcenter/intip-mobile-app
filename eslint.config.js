// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // packages/intip-bridge is a git submodule (own repo/tooling); the app only
    // compiles its source, it doesn't lint it here.
    ignores: ["dist/*", "packages/**"],
  }
]);
