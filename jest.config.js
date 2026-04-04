/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  setupFiles: ["<rootDir>/tests/setup.ts"],
  collectCoverageFrom: [
    "lib/**/*.ts",
    "!**/*.d.ts",
  ],
  coverageReporters: ["text", "lcov"],
  testTimeout: 30000,
  maxWorkers: 1,
  globals: {
    "ts-jest": {
      tsconfig: {
        // Override the project tsconfig for tests only
        module: "commonjs",
        moduleResolution: "node",
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: false,
        jsx: "react",
        target: "ES2017",
      },
    },
  },
};
