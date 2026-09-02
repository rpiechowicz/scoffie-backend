/**
 * Eksport danych jednej osoby na wniosek (RODO art. 15/20) — z konsoli.
 *
 *   pnpm rodo:export -- <e-mail albo id użytkownika> [plik.json]
 *
 * Dla wniosku mailowego: osoba nie ma jak podać nam swojego tokenu, więc
 * `GET /me/export` nie wchodzi w grę — ten skrypt składa TĘ SAMĄ paczkę
 * (`src/data-export/user-export.ts`) prosto z bazy. Na Railway:
 *
 *   railway ssh --service Backend -- sh -c 'cd /app && pnpm rodo:export -- adres@example.com /tmp/dane.json'
 *
 * a potem plik zabrać i wysłać osobie zabezpieczonym kanałem. Procedura:
 * docs/rodo-wnioski.md. Skrypt niczego nie zmienia w bazie.
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { buildUserExport } from '../src/data-export/user-export';

const prisma = new PrismaClient();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  // pnpm przekazuje separator `--` dalej do skryptu — odsiewamy go.
  const [who, outPath] = process.argv.slice(2).filter((a) => a !== '--');
  if (!who) {
    console.error('Użycie: pnpm rodo:export -- <e-mail|id> [plik.json]');
    process.exitCode = 2;
    return;
  }

  const matches = UUID_RE.test(who)
    ? await prisma.user.findMany({ where: { id: who }, select: { id: true } })
    : await prisma.user.findMany({
        where: { email: { equals: who, mode: 'insensitive' } },
        select: { id: true },
      });

  if (matches.length === 0) {
    console.error(`Nie ma konta: ${who}`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    // Ten sam e-mail na dwóch kontach (Google i Apple) — wniosek trzeba
    // rozstrzygnąć ręcznie, po id, żeby nie wysłać komuś cudzych danych.
    console.error(
      `Kilka kont z tym e-mailem — podaj id: ${matches.map((m) => m.id).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const bundle = await buildUserExport(prisma, matches[0].id);
  const json = JSON.stringify(bundle, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, { encoding: 'utf8', mode: 0o600 });
    console.error(`Zapisano ${json.length} znaków do ${outPath}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
