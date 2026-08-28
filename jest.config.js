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
  // Bez `moduleNameMapper`. Dawniej `households.service` był podmieniany na
  // stub o innym API (plik bywał wypchnięty do iCloud jako „dataless" i
  // czytał się jako EIO) — 15 zielonych testów nie dotykało produkcyjnego
  // kodu. Folder repa ma teraz „Keep Downloaded"; gdy `docker cp`/jest trafi
  // na EIO, materializować pliki (`cat > /dev/null`), nie wracać do stubu.
};
