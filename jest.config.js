/**
 * Jest config. The unit tests cover the portal shell's pure logic only
 * (bridge parsing, path normalisation, nav-path extraction, filename
 * derivation), so they need no native modules — a plain ts-jest/node setup
 * via the jest-expo preset is enough.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
