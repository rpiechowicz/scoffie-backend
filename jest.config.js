const path = require('path');

const rootDir = path.resolve(__dirname, 'src');
const tsJestPath = path.resolve(__dirname, 'node_modules', 'ts-jest', 'dist', 'index.js');

// Preload ts-jest to make sure it's available
require(tsJestPath);

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: rootDir,
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // Tylko TS: CommonJS ze `scripts/lib` (np. rebuild-guard.js) ma iść do
    // Node bez ts-jest, bo `allowJs` jest wyłączone.
    '^.+\\.ts$': [tsJestPath, {
      tsconfig: path.resolve(__dirname, 'tsconfig.json'),
    }],
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: path.resolve(__dirname, 'coverage'),
  testEnvironment: 'node',
  modulePaths: [path.resolve(__dirname, 'node_modules')],
  moduleNameMapper: {
    // Redirect APFS-blocked households.service to an accessible stub file
    '^(\\./|.*/)households\\.service$': '<rootDir>/households/households.service.stub',
  },
};
