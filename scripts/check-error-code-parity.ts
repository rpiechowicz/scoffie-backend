/**
 * Parytet kodów błędów: każdy kod z `src/common/app-error-code.ts` ma mieć
 * kopię po polsku w iOS (`UserFacingErrorMapper.copyByCode`), a iOS nie ma
 * znać kodów, których serwer już nie wysyła. Obiecany w komentarzu do listy
 * kodów, dotąd nie istniał (audyt 2).
 *
 * Uruchomienie: `pnpm check:error-parity` — repozytorium iOS obok
 * (`../scoffie-ios`) albo `IOS_REPO_PATH=...`. Kod wyjścia 1, gdy
 * serwer ma kod bez kopii w iOS.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ERROR_CODES } from '../src/common/app-error-code';

const iosRepo =
  process.env.IOS_REPO_PATH ?? join(process.cwd(), '..', 'scoffie-ios');
const mapperPath = join(
  iosRepo,
  'Scoffie',
  'Models',
  'Stores',
  'UserFacingErrorMapper.swift',
);

if (!existsSync(mapperPath)) {
  console.error(`[parity] brak pliku iOS: ${mapperPath} (ustaw IOS_REPO_PATH)`);
  process.exit(2);
}

const swift = readFileSync(mapperPath, 'utf8');
const iosCodes = new Set(
  [...swift.matchAll(/^\s*"([A-Z][A-Z0-9_]+)"\s*:\s*"/gm)].map((m) => m[1]),
);
const serverCodes = new Set<string>(APP_ERROR_CODES);

const missingInIos = [...serverCodes].filter((c) => !iosCodes.has(c)).sort();
const unknownInIos = [...iosCodes].filter((c) => !serverCodes.has(c)).sort();

console.log(
  `[parity] serwer: ${serverCodes.size} kodów, iOS: ${iosCodes.size} kopii`,
);
if (missingInIos.length) {
  console.error(
    `[parity] BRAK kopii w iOS (${missingInIos.length}): ${missingInIos.join(', ')}`,
  );
}
if (unknownInIos.length) {
  console.warn(
    `[parity] iOS zna kody, których serwer nie wysyła (${unknownInIos.length}): ${unknownInIos.join(', ')}`,
  );
}
process.exit(missingInIos.length ? 1 : 0);
