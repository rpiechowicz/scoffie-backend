/**
 * Zeruje pulę PRÓBNĄ asystenta jednej osoby — do testów na produkcji.
 *
 * Skrypt, a nie SQL w notatce, bo SQL trzeba WKLEIĆ, a konsola Railway na
 * telefonie nie przyjmuje wklejania. To ma być jedna krótka linia do
 * przepisania:
 *
 *   pnpm exec tsx scripts/reset-trial.ts rpiechowicz@icloud.com
 *
 * Pula próbna to licznik `AiUsageCounter` o kluczu `trial:<identityHash>`
 * (albo `trial:user:<id>`, gdy hasz był pusty), okres `trial`, rodzaje
 * `messages` i `plans` — patrz `ai-usage-counters.service.ts`. Rozmowy,
 * plan i księga użycia zostają nietknięte. Bez argumentu wypisuje stan,
 * niczego nie zmienia.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error('Użycie: pnpm exec tsx scripts/reset-trial.ts <email>');
    process.exit(2);
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, identityHash: true },
  });
  if (!user) {
    console.error(`Nie ma użytkownika z e-mailem ${email}.`);
    process.exit(1);
  }

  const scopes = [`trial:user:${user.id}`];
  if (user.identityHash) scopes.push(`trial:${user.identityHash}`);

  const before = await prisma.aiUsageCounter.findMany({
    where: { periodKey: 'trial', scopeId: { in: scopes } },
  });
  for (const row of before) {
    console.log(`${row.scopeId} ${row.kind}: ${row.value}`);
  }

  const result = await prisma.aiUsageCounter.updateMany({
    where: { periodKey: 'trial', scopeId: { in: scopes } },
    data: { value: 0 },
  });
  console.log(
    result.count > 0
      ? `Wyzerowano ${result.count} licznik(i) puli próbnej dla ${user.email ?? user.id}.`
      : `Brak liczników puli próbnej dla ${user.email ?? user.id} — nic do zerowania.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
