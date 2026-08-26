import { Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { DailyStepsEntryDto } from './dto/sync-health-steps.dto';

// 'YYYY-MM-DD' -> Date o północy UTC. Jawny sufiks 'T00:00:00.000Z', bo goły
// date-string bywał różnie interpretowany. Round-trip przez toISOString łata
// dziurę regexa z DTO: '2026-02-30' V8 po cichu przewija na 2026-03-02 (wiersz
// lądowałby pod inną datą niż wysłana), a '2026-13-01' daje Invalid Date,
// na którym Prisma rzuca 500 zamiast 400.
const toUtcDate = (raw: string): Date => {
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new AppException('VALIDATION_ERROR', `Nieprawidłowa data: ${raw}`);
  }
  return date;
};

@Injectable()
export class HealthStepsService {
  constructor(private readonly prisma: PrismaService) {}

  async syncSteps(userId: string, entries: DailyStepsEntryDto[]) {
    // Deduplikacja po dacie (ostatni wygrywa) — zdublowany dzień w batchu
    // wywaliłby transakcję na kluczu głównym, a taki batch potrafi powstać
    // po stronie telefonu przy zmianie strefy czasowej.
    const byDate = new Map(entries.map((entry) => [entry.date, entry]));
    await this.prisma.$transaction(
      [...byDate.values()].map((entry) => {
        const date = toUtcDate(entry.date);
        return this.prisma.dailyStepCount.upsert({
          where: { userId_date: { userId, date } },
          create: {
            userId,
            date,
            steps: entry.steps,
            stepsGoal: entry.stepsGoal,
            source: entry.source,
          },
          // `stepsGoal` tylko przy create — to zrzut celu z dnia pierwszego
          // zapisu. Telefon stempluje CAŁE kroczące okno bieżącym celem, więc
          // aktualizowanie go tutaj nadpisywałoby historię: zmiana celu w
          // piątek „poprawiałaby" wstecz cele z poniedziałku–czwartku.
          update: { steps: entry.steps, source: entry.source },
        });
      }),
    );
    return { ok: true, synced: byDate.size };
  }

  async getSteps(userId: string, from: string, to: string) {
    const rows = await this.prisma.dailyStepCount.findMany({
      where: { userId, date: { gte: toUtcDate(from), lte: toUtcDate(to) } },
      orderBy: { date: 'asc' },
    });
    return {
      entries: rows.map((row) => ({
        // @db.Date wraca jako Date o północy UTC — ucinamy do 'YYYY-MM-DD',
        // żeby klient dostał dokładnie ten string, który wysłał.
        date: row.date.toISOString().slice(0, 10),
        steps: row.steps,
        stepsGoal: row.stepsGoal,
        source: row.source,
      })),
    };
  }
}
