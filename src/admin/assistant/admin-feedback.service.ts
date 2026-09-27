import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AgentFeedbackData,
  AgentFeedbackItem,
  FeedbackPeriod,
  FeedbackRating,
  FeedbackTag,
} from '../contract';
import { readOnlyQuery } from '../read-only-query';

/** Lista pokazuje najnowsze oceny z okresu; sumy liczą wszystkie. */
export const FEEDBACK_ITEMS_LIMIT = 200;

export const FEEDBACK_PERIODS: readonly FeedbackPeriod[] = ['7', '30', '90'];

const FEEDBACK_TAGS: readonly FeedbackTag[] = [
  'TOO_LONG',
  'NOT_WHAT_I_ASKED',
  'BAD_DISHES',
  'TOO_SLOW',
  'OTHER',
];

const DAY_MS = 24 * 60 * 60 * 1000;

type FeedbackRow = {
  rating: string;
  tags: string[];
  comment: string | null;
  messageKind: string;
  updatedAt: Date;
};

/**
 * Oceny odpowiedzi asystenta (27.09.2026) — dział „Oceny” obok „Zgłoszeń”.
 *
 * Osobno od zgłoszeń, bo to inna sprawa: zgłoszenie czeka na decyzję
 * moderatora, ocena jest sygnałem jakości. Tu nie ma statusów — sumy, dzień po
 * dniu, rodzaje odpowiedzi, powody podpowiedzi i lista najnowszych.
 *
 * Treść: WYŁĄCZNIE migawka wysłana razem z podpowiedzią (jak przy
 * zgłoszeniu, ROADMAPA §1.4). Gołe kciuki mają tylko rodzaj odpowiedzi,
 * z tury — tylko metadane (model, czas).
 *
 * Oceny odchodzą razem z wiadomością (retencja rozmów 90 dni, „usuń moje
 * rozmowy”), więc okres 90 dni to najdalej, ile da się wstecz zobaczyć.
 */
@Injectable()
export class AdminFeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  overview(
    period: FeedbackPeriod,
    now = new Date(),
  ): Promise<AgentFeedbackData> {
    const days = Number(period);
    const since = startOfUtcDay(new Date(now.getTime() - (days - 1) * DAY_MS));

    return readOnlyQuery(this.prisma, async (tx) => {
      const [rows, latest] = await Promise.all([
        tx.agentMessageFeedback.findMany({
          where: { updatedAt: { gte: since } },
          select: {
            rating: true,
            tags: true,
            comment: true,
            messageKind: true,
            updatedAt: true,
          },
        }),
        tx.agentMessageFeedback.findMany({
          where: { updatedAt: { gte: since } },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: FEEDBACK_ITEMS_LIMIT,
          select: {
            id: true,
            userId: true,
            rating: true,
            tags: true,
            comment: true,
            messageText: true,
            messageKind: true,
            updatedAt: true,
            turnId: true,
          },
        }),
      ]);

      const turnIds = [
        ...new Set(
          latest
            .map((row) => row.turnId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const userIds = [...new Set(latest.map((row) => row.userId))];
      const users =
        userIds.length > 0
          ? await tx.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, displayName: true },
            })
          : [];
      const namesById = new Map(
        users.map((user) => [user.id, user.displayName]),
      );
      const turns =
        turnIds.length > 0
          ? await tx.agentTurn.findMany({
              where: { id: { in: turnIds } },
              select: { id: true, model: true, durationMs: true },
            })
          : [];
      const turnsById = new Map(turns.map((turn) => [turn.id, turn]));

      const items = latest.map((row): AgentFeedbackItem => {
        const turn = row.turnId ? turnsById.get(row.turnId) : undefined;
        return {
          id: row.id,
          userId: row.userId,
          userName: namesById.get(row.userId) ?? '',
          rating: ratingOf(row.rating),
          tags: tagsOf(row.tags),
          comment: row.comment,
          messageText: row.messageText,
          messageKind: row.messageKind,
          ratedAt: row.updatedAt.toISOString(),
          turn: turn
            ? { model: turn.model ?? '', durationMs: turn.durationMs ?? null }
            : null,
        };
      });

      return { period, ...summarize(rows, since, days), items };
    });
  }
}

/** Sumy, dzień po dniu i rozkłady — czysta funkcja wierszy okresu. */
export function summarize(
  rows: readonly FeedbackRow[],
  since: Date,
  days: number,
): Omit<AgentFeedbackData, 'period' | 'items'> {
  const daily = Array.from({ length: days }, (_, index) => ({
    date: dayKey(new Date(since.getTime() + index * DAY_MS)),
    up: 0,
    down: 0,
  }));
  const dayIndex = new Map(daily.map((day, index) => [day.date, index]));
  const kinds = new Map<string, { up: number; down: number }>();
  const tagCounts = new Map<FeedbackTag, number>();
  const totals = { up: 0, down: 0, withNote: 0 };

  for (const row of rows) {
    const rating = ratingOf(row.rating);
    const bucket = rating === 'UP' ? 'up' : 'down';
    totals[bucket] += 1;
    const index = dayIndex.get(dayKey(row.updatedAt));
    if (index !== undefined) daily[index][bucket] += 1;

    const kind = kinds.get(row.messageKind) ?? { up: 0, down: 0 };
    kind[bucket] += 1;
    kinds.set(row.messageKind, kind);

    if (rating === 'DOWN') {
      const tags = tagsOf(row.tags);
      if (tags.length > 0 || row.comment) totals.withNote += 1;
      for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  return {
    totals,
    daily,
    byKind: [...kinds.entries()]
      .map(([kind, count]) => ({ kind, ...count }))
      .sort(
        (a, b) =>
          b.up + b.down - (a.up + a.down) || a.kind.localeCompare(b.kind),
      ),
    byTag: [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

function ratingOf(value: string): FeedbackRating {
  return value === 'UP' ? 'UP' : 'DOWN';
}

/** Powody spoza kontraktu (stary albo przyszły klient) wypadają z listy. */
function tagsOf(values: readonly string[]): FeedbackTag[] {
  return values.filter((value): value is FeedbackTag =>
    (FEEDBACK_TAGS as readonly string[]).includes(value),
  );
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
