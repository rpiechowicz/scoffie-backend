/**
 * Usunięcie konta na wniosek (RODO art. 17) — z konsoli.
 *
 *   pnpm accounts:delete -- <e-mail albo id użytkownika>          # tylko pokazuje
 *   pnpm accounts:delete -- <e-mail albo id użytkownika> --yes    # kasuje
 *
 * Idzie przez `UsersService.deleteAccount`, czyli DOKŁADNIE tą samą drogą,
 * co przycisk „Usuń konto" w aplikacji: przepisy z katalogu przechodzą na
 * bota importu, gospodarstwo zostaje pozostałym domownikom, wspólne plany
 * nie znikają, bot importu jest nie do skasowania. Surowy `DELETE` w bazie
 * nie zna tych reguł. Procedura: docs/rodo-wnioski.md.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  // pnpm przekazuje separator `--` dalej do skryptu — odsiewamy go.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const confirmed = args.includes('--yes');
  const who = args.find((a) => !a.startsWith('--'));
  if (!who) {
    console.error('Użycie: pnpm accounts:delete -- <e-mail|id> [--yes]');
    process.exitCode = 2;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const matches = await prisma.user.findMany({
      where: UUID_RE.test(who)
        ? { id: who }
        : { email: { equals: who, mode: 'insensitive' } },
      select: {
        id: true,
        displayName: true,
        email: true,
        authProvider: true,
        createdAt: true,
        _count: { select: { memberships: true, recipes: true } },
      },
    });

    if (matches.length === 0) {
      console.error(`Nie ma konta: ${who}`);
      process.exitCode = 1;
      return;
    }
    if (matches.length > 1) {
      console.error(
        `Kilka kont z tym e-mailem — podaj id: ${matches.map((m) => m.id).join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }

    const [user] = matches;
    console.error(
      `Konto ${user.id} — ${user.displayName} <${user.email ?? 'bez e-maila'}>, ` +
        `${user.authProvider}, założone ${user.createdAt.toISOString()}, ` +
        `gospodarstw: ${user._count.memberships}, przepisów: ${user._count.recipes}`,
    );
    if (!confirmed) {
      console.error('Nic nie skasowano. Dopisz --yes, żeby usunąć.');
      return;
    }

    await app.get(UsersService).deleteAccount(user.id);
    console.error(`Usunięto konto ${user.id}.`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
