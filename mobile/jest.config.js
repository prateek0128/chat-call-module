/**
 * Pure-TS tests (ChatStore, VoiceCallEngine, CommsClient, compat, boundaries, UI helpers) plus
 * UI render smoke tests (*.test.tsx) against a hand-written react-native stand-in
 * (__tests__/rn-mock/react-native.js): react-native itself is not installed here.
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  transform: {
    "^.+\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", diagnostics: { warnOnly: false } }],
  },
  moduleNameMapper: {
    "^react-native$": "<rootDir>/__tests__/rn-mock/react-native.js",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
};
