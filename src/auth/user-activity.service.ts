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

/** „Ostatnio w aplikacji” (`User.lastSeenAt`) zapisujemy najwyżej raz na tyle na osobę. */
export const LAST_SEEN_EVERY_MS = 5 * 60_000;
/** Powyżej tylu wpisów mapa `lastSeen` wyrzuca te, których okno już minęło. */
const LAST_SEEN_PRUNE_AT = 5_000;

/**
 * Aktywność osób: dzienna (`UserActivityDay`, ROADMAPA §5.8) — pierwszy
 * uwierzytelniony kontakt osoby z backendem w danej dobie warszawskiej — i
 * chwila ostatniej obecności w aplikacji (`User.lastSeenAt`), którą panel
 * pokazuje zamiast `lastLoginAt` (to zmienia się tylko przy pełnym
 * logowaniu; aplikacja potem po cichu odnawia sesję).
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
 * - `lastSeenAt` tak samo poza ścieżką odpowiedzi, najwyżej raz na 5 minut
 *   na osobę (mapa w procesie), surowym `UPDATE` — bez ruszania `updatedAt`
 *   i bez cofania wartości, gdyby zapisy przyszły w złej kolejności.
 *
 * Jedna instancja Railway — zbiór w procesie wystarcza; po restarcie pierwszy
 * kontakt dnia zapisze się jeszcze raz i trafi w `ON CONFLICT`.
 */
@Injectable()
export class UserActivityService {
  private readonly logger = new Logger(UserActivityService.name);
  private day = '';
  private readonly seen = new Set<string>();
  /** userId → chwila ostatniego zapisu `lastSeenAt` (ms). */
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  record(userId: string, now: Date = new Date()): void {
    this.touchLastSeen(userId, now);
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

  private touchLastSeen(userId: string, now: Date): void {
    const at = now.getTime();
    const last = this.lastSeen.get(userId);
    if (last !== undefined && at - last < LAST_SEEN_EVERY_MS) return;
    if (this.lastSeen.size >= LAST_SEEN_PRUNE_AT) {
      for (const [id, t] of this.lastSeen) {
        if (at - t >= LAST_SEEN_EVERY_MS) this.lastSeen.delete(id);
      }
    }
    this.lastSeen.set(userId, at);

    void this.writeLastSeen(userId, now).catch((error: unknown) => {
      // Tylko nasz wpis — nowszy zapis tej osoby mógł go już zastąpić.
      if (this.lastSeen.get(userId) === at) this.lastSeen.delete(userId);
      this.logger.warn(
        `zapis lastSeenAt nie powiódł się (user ${userId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async writeLastSeen(userId: string, now: Date): Promise<void> {
    const instant = now.toISOString();
    await this.prisma.$executeRaw`
      UPDATE "User"
      SET "lastSeenAt" = (${instant}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ${userId}::uuid
        AND ("lastSeenAt" IS NULL
             OR "lastSeenAt" < (${instant}::timestamptz AT TIME ZONE 'UTC'))`;
  }

  private async write(userId: string, day: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "UserActivityDay" ("userId", "date")
      VALUES (${userId}::uuid, ${day}::date)
      ON CONFLICT DO NOTHING`;
  }
}
