import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { ConsentsService } from '../consents/consents.service';
import { PrismaService } from '../prisma/prisma.service';
import { DailyStepsEntryDto } from './dto/sync-health-steps.dto';

// 'YYYY-MM-DD' -> Date o północy UTC. Jawny sufiks 'T00:00:00.000Z', bo goły
// date-string bywał różnie interpretowany. Round-trip przez toISOString łata
// dziurę regexa z DTO: '2026-02-30' V8 po cichu przewija na 2026-03-02 (wiersz
// lądowałby pod inną datą niż wysłana), a '2026-13-01' daje Invalid Date,
// na którym Prisma rzuca 500 zamiast 400.
/** Klient trzyma tygodniowe okno; rok z zapasem wystarcza na każdy wykres. */
const MAX_STEPS_RANGE_DAYS = 400;

const toUtcDate = (raw: string): Date => {
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new AppException('VALIDATION_ERROR', `Nieprawidłowa data: ${raw}`);
  }
  return date;
};

@Injectable()
export class HealthStepsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly consents?: ConsentsService,
  ) {}

  /** Cofnięcie zgody wynika z czynności: wyłączenie synchronizacji kasuje dane. */
  async deleteAll(userId: string): Promise<{ deleted: number }> {
    const result = await this.prisma.dailyStepCount.deleteMany({
      where: { userId },
    });
    if (result.count > 0) {
      await this.consents?.recordSystem(
        userId,
        'HEALTH_DATA',
        'REVOKED',
        'HEALTH_STEPS_CLEARED',
      );
    }
    return { deleted: result.count };
  }

  async syncSteps(userId: string, entries: DailyStepsEntryDto[]) {
    // Pierwsza synchronizacja = wyraźna zgoda na przetwarzanie danych
    // o zdrowiu (art. 9). Zapis tylko, gdy w dzienniku jeszcze jej nie ma.
    if (
      this.consents &&
      !(await this.consents.hasValid(userId, 'HEALTH_DATA'))
    ) {
      await this.consents.recordSystem(
        userId,
        'HEALTH_DATA',
        'GRANTED',
        'HEALTH_STEPS_SYNC',
      );
    }
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
    const fromDate = toUtcDate(from);
    const toDate = toUtcDate(to);
    const spanDays = Math.round(
      (toDate.getTime() - fromDate.getTime()) / 86400000,
    );
    if (spanDays < 0 || spanDays > MAX_STEPS_RANGE_DAYS) {
      throw new AppException(
        'VALIDATION_ERROR',
        `Zakres dat musi mieć od 0 do ${MAX_STEPS_RANGE_DAYS} dni.`,
        HttpStatus.BAD_REQUEST,
        ['from', 'to'],
      );
    }
    const rows = await this.prisma.dailyStepCount.findMany({
      where: { userId, date: { gte: fromDate, lte: toDate } },
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
