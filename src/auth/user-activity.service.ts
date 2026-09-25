import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Doba panelu i retencji — Warszawa, jak `src/admin/common/warsaw-calendar.ts`. */
const ACTIVITY_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` doby warszawskiej, w której wypada `instant`. */
export function activityDayKey(instant: Date): string {
  return ACTIVITY_DAY.format(instant);
}

/**
 * Aktywność dzienna osób (`UserActivityDay`, ROADMAPA §5.8): pierwszy
 * uwierzytelniony kontakt osoby z backendem w danej dobie warszawskiej.
 *
 * Wołane z DWÓCH miejsc, w których backend rozpoznaje osobę: `JwtAuthGuard`
 * (każde żądanie REST z tokenem) i handshake socketu (`AuthIoAdapter`).
 *
 * Tanio, bo to ścieżka KAŻDEGO żądania:
 * - zbiór w pamięci „już zapisane dziś" — drugi i kolejny kontakt tej samej
 *   osoby w tej dobie nie dotyka bazy; zbiór czyści się sam, gdy zmieni się
 *   doba (sprawdzane przy wywołaniu, bez timera),
 * - zapis `INSERT … ON CONFLICT DO NOTHING` poza ścieżką odpowiedzi: `record`
 *   nie zwraca obietnicy, żądanie na niego nie czeka, błąd trafia tylko do
 *   logu (i zdejmuje klucz ze zbioru, więc następne żądanie spróbuje znowu).
 *
 * Jedna instancja Railway — zbiór w procesie wystarcza; po restarcie pierwszy
 * kontakt dnia zapisze się jeszcze raz i trafi w `ON CONFLICT`.
 */
@Injectable()
export class UserActivityService {
  private readonly logger = new Logger(UserActivityService.name);
  private day = '';
  private readonly seen = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  record(userId: string, now: Date = new Date()): void {
    const day = activityDayKey(now);
    if (day !== this.day) {
      this.day = day;
      this.seen.clear();
    }
    if (this.seen.has(userId)) return;
    this.seen.add(userId);

    void this.write(userId, day).catch((error: unknown) => {
      // Tylko jeśli doba się nie zmieniła w międzyczasie — inaczej kasowalibyśmy
      // klucz z nowego zbioru.
      if (this.day === day) this.seen.delete(userId);
      this.logger.warn(
        `zapis aktywności nie powiódł się (user ${userId}, ${day}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async write(userId: string, day: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "UserActivityDay" ("userId", "date")
      VALUES (${userId}::uuid, ${day}::date)
      ON CONFLICT DO NOTHING`;
  }
}
