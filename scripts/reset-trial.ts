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
 * (albo `trial:user:<id>`, gdy hasz był pusty), rodzaje `messages`
 * i `plans` — patrz `ai-usage-counters.service.ts`. Od 7.10.2026 pula wraca
 * co `AI_TRIAL_RENEW_DAYS` dni, a każdy cykl ma własny okres: `trial`
 * (pierwszy), potem `free:<YYYY-MM-DD>`. Zerujemy WSZYSTKIE cykle — bieżący
 * zależy od kotwicy i od ustawienia w panelu, a zerowanie zamkniętych nic nie
 * daje ani nie psuje. Kotwica cyklu zostaje. Rozmowy, plan i księga użycia
 * zostają nietknięte.
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

  const where = {
    scopeId: { in: scopes },
    kind: { in: ['messages', 'plans'] },
    OR: [{ periodKey: 'trial' }, { periodKey: { startsWith: 'free:' } }],
  };
  const before = await prisma.aiUsageCounter.findMany({ where });
  for (const row of before) {
    console.log(`${row.scopeId} ${row.periodKey} ${row.kind}: ${row.value}`);
  }

  const result = await prisma.aiUsageCounter.updateMany({
    where,
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
