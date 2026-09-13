import { MailWorkerService } from './mail-worker.service';
import { PrismaService } from '../prisma/prisma.service';

// AUDYT 12.09.2026 (P1.12). Zajęcie porcji robiło jeden zbiorczy `updateMany`
// z warunkiem `status: QUEUED`, wyrzucało jego `count`, a potem doczytywało
// wiersze po `status: SENDING` — czyli nie odróżniało wierszy zajętych przez
// TEN przebieg od zajętych przez inny. Drugi przebieg (druga replika na
// Railway) zmieniał zero wierszy, po czym odczytywał te same wiadomości
// i wysyłał je PO RAZ DRUGI. Dziś nie boli, bo instancja jest jedna;
// zaczyna boleć w sekundzie, w której pojawi się druga.

describe('MailWorkerService.claim — jeden wiersz, jeden nadawca', () => {
  /** Baza, w której KTOŚ INNY zdążył już zająć część wierszy. */
  const fakePrisma = (zajeteObok: string[]) => {
    const stan = new Map<string, string>();
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      stan.set(id, zajeteObok.includes(id) ? 'SENDING' : 'QUEUED');
    }
    return {
      stan,
      mailMessage: {
        findMany: jest.fn(
          (args: {
            where: { status?: string; id?: { in: string[] } };
            select?: unknown;
          }) => {
            const ids = args.where.id?.in ?? [...stan.keys()];
            const rows = ids
              .filter((id) => stan.get(id) === args.where.status)
              .map((id) => ({ id, attempts: 0 }));
            return Promise.resolve(rows);
          },
        ),
        updateMany: jest.fn(
          (args: {
            where: { id: string; status: string };
            data: { status: string };
          }) => {
            // Warunkowy UPDATE: podnosi wiersz tylko wtedy, gdy nikt inny go
            // nie zabrał. Dokładnie to robi Postgres.
            if (stan.get(args.where.id) !== args.where.status) {
              return Promise.resolve({ count: 0 });
            }
            stan.set(args.where.id, args.data.status);
            return Promise.resolve({ count: 1 });
          },
        ),
      },
    };
  };

  const build = (prisma: ReturnType<typeof fakePrisma>) =>
    new MailWorkerService(
      prisma as unknown as PrismaService,
      {} as never,
      { notify: jest.fn() } as never,
      { send: jest.fn() } as never,
    );

  /** `claim` jest prywatne — testujemy niezmiennik, nie API. */
  const claim = (worker: MailWorkerService, batch: number) =>
    (
      worker as unknown as {
        claim(size: number): Promise<{ id: string }[]>;
      }
    ).claim(batch);

  it('nie oddaje wierszy, które zajął ktoś inny', async () => {
    const prisma = fakePrisma(['m2', 'm4']);
    const wziete = await claim(build(prisma), 10);

    expect(wziete.map((row) => row.id).sort()).toEqual(['m1', 'm3']);
  });

  it('dwa równoległe przebiegi dzielą porcję rozłącznie', async () => {
    const prisma = fakePrisma([]);
    const worker = build(prisma);

    const [a, b] = await Promise.all([claim(worker, 10), claim(worker, 10)]);
    const idsA = a.map((row) => row.id);
    const idsB = b.map((row) => row.id);

    // Suma pokrywa całą kolejkę, a część wspólna jest pusta — żaden mail nie
    // pójdzie dwa razy.
    expect([...idsA, ...idsB].sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
  });

  it('pusta kolejka nie rusza bazy drugi raz', async () => {
    const prisma = fakePrisma(['m1', 'm2', 'm3', 'm4']);
    const wziete = await claim(build(prisma), 10);

    expect(wziete).toEqual([]);
    // Brak wygranych = brak doczytania; jedno `findMany` na wejściu wystarczy.
    expect(prisma.mailMessage.findMany).toHaveBeenCalledTimes(1);
  });
});
