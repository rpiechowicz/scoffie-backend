import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CookFeedbackData,
  CookFeedbackExtension,
  CookFeedbackItem,
  FeedbackPeriod,
  FeedbackRating,
} from '../contract';
import { readOnlyQuery } from '../read-only-query';

/** Lista pokazuje najnowsze oceny z okresu; sumy liczą wszystkie. */
export const COOK_FEEDBACK_ITEMS_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wiersz oceny z okresu — wejście czystej funkcji `summarizeCookFeedback`. */
export interface CookFeedbackRow {
  recipeId: string;
  scenarioVersion: number;
  rating: string;
  tags: string[];
  comment: string | null;
  extensions: unknown;
  updatedAt: Date;
}

/** Nazwa timera i tytuł jego kroku w danej wersji scenariusza. */
export type TimerNames = Map<string, { label: string; stepTitle: string }>;

/**
 * Oceny gotowania w trybie Gotuj — zakładka „Gotuj” w dziale „Oceny” panelu.
 *
 * Najważniejszy sygnał to „+min”: kilka sesji, w których ludzie dokładali
 * czas do tego samego timera, znaczy, że scenariusz ma za krótki czas
 * (docs iOS Gotuj §13.3). Nazwy timerów i kroków bierzemy z treści TEJ
 * wersji scenariusza, na której gotowano — nowsza wersja mogła je zmienić.
 */
@Injectable()
export class AdminCookFeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  overview(
    period: FeedbackPeriod,
    now = new Date(),
  ): Promise<CookFeedbackData> {
    const days = Number(period);
    const since = startOfUtcDay(new Date(now.getTime() - (days - 1) * DAY_MS));

    return readOnlyQuery(this.prisma, async (tx) => {
      const [rows, latest] = await Promise.all([
        tx.cookFeedback.findMany({
          where: { updatedAt: { gte: since } },
          select: {
            recipeId: true,
            scenarioVersion: true,
            rating: true,
            tags: true,
            comment: true,
            extensions: true,
            updatedAt: true,
          },
        }),
        tx.cookFeedback.findMany({
          where: { updatedAt: { gte: since } },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: COOK_FEEDBACK_ITEMS_LIMIT,
          select: {
            id: true,
            userId: true,
            recipeId: true,
            scenarioVersion: true,
            rating: true,
            tags: true,
            comment: true,
            extensions: true,
            servings: true,
            updatedAt: true,
          },
        }),
      ]);

      const recipeIds = [...new Set(rows.map((row) => row.recipeId))];
      const recipes =
        recipeIds.length > 0
          ? await tx.recipe.findMany({
              where: { id: { in: recipeIds } },
              select: { id: true, title: true },
            })
          : [];
      const titles = new Map(recipes.map((r) => [r.id, r.title]));

      // Treść tylko tych wersji, przy których ktoś dodał czas.
      const versionKeys = new Map<
        string,
        { recipeId: string; version: number }
      >();
      for (const row of rows) {
        if (Object.keys(extensionsOf(row.extensions)).length === 0) continue;
        versionKeys.set(scenarioKey(row.recipeId, row.scenarioVersion), {
          recipeId: row.recipeId,
          version: row.scenarioVersion,
        });
      }
      const scenarios =
        versionKeys.size > 0
          ? await tx.recipeCookScenario.findMany({
              where: { OR: [...versionKeys.values()] },
              select: { recipeId: true, version: true, content: true },
            })
          : [];
      const names = new Map<string, TimerNames>(
        scenarios.map((s) => [
          scenarioKey(s.recipeId, s.version),
          timerNamesOf(s.content),
        ]),
      );

      const userIds = [...new Set(latest.map((row) => row.userId))];
      const users =
        userIds.length > 0
          ? await tx.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, displayName: true },
            })
          : [];
      const userNames = new Map(users.map((u) => [u.id, u.displayName]));

      const items = latest.map((row): CookFeedbackItem => ({
        id: row.id,
        userId: row.userId,
        userName: userNames.get(row.userId) ?? '',
        recipeId: row.recipeId,
        recipeTitle: titles.get(row.recipeId) ?? '',
        scenarioVersion: row.scenarioVersion,
        rating: ratingOf(row.rating),
        tags: row.tags,
        comment: row.comment,
        extensions: namedExtensions(
          row.extensions,
          names.get(scenarioKey(row.recipeId, row.scenarioVersion)),
        ),
        servings: row.servings,
        ratedAt: row.updatedAt.toISOString(),
      }));

      return {
        period,
        ...summarizeCookFeedback(rows, since, days, titles, names),
        items,
      };
    });
  }
}

/** Sumy, dzień po dniu, powody, przepisy i timery — czysta funkcja wierszy okresu. */
export function summarizeCookFeedback(
  rows: readonly CookFeedbackRow[],
  since: Date,
  days: number,
  titles: ReadonlyMap<string, string>,
  names: ReadonlyMap<string, TimerNames>,
): Omit<CookFeedbackData, 'period' | 'items'> {
  const daily = Array.from({ length: days }, (_, index) => ({
    date: dayKey(new Date(since.getTime() + index * DAY_MS)),
    up: 0,
    down: 0,
  }));
  const dayIndex = new Map(daily.map((day, index) => [day.date, index]));
  const totals = { up: 0, down: 0, withNote: 0, withExtensions: 0 };
  const tagCounts = new Map<string, number>();
  const recipes = new Map<
    string,
    { up: number; down: number; withExtensions: number }
  >();
  const timers = new Map<
    string,
    {
      recipeId: string;
      scenarioVersion: number;
      timerId: string;
      sessions: number;
      seconds: number;
    }
  >();

  for (const row of rows) {
    const bucket = ratingOf(row.rating) === 'UP' ? 'up' : 'down';
    totals[bucket] += 1;
    const index = dayIndex.get(dayKey(row.updatedAt));
    if (index !== undefined) daily[index][bucket] += 1;
    if (row.tags.length > 0 || row.comment) totals.withNote += 1;
    for (const tag of row.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    const recipe = recipes.get(row.recipeId) ?? {
      up: 0,
      down: 0,
      withExtensions: 0,
    };
    recipe[bucket] += 1;
    const extensions = Object.entries(extensionsOf(row.extensions));
    if (extensions.length > 0) {
      totals.withExtensions += 1;
      recipe.withExtensions += 1;
    }
    recipes.set(row.recipeId, recipe);

    for (const [timerId, seconds] of extensions) {
      const key = `${scenarioKey(row.recipeId, row.scenarioVersion)}:${timerId}`;
      const timer = timers.get(key) ?? {
        recipeId: row.recipeId,
        scenarioVersion: row.scenarioVersion,
        timerId,
        sessions: 0,
        seconds: 0,
      };
      timer.sessions += 1;
      timer.seconds += seconds;
      timers.set(key, timer);
    }
  }

  return {
    totals,
    daily,
    byTag: [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    byRecipe: [...recipes.entries()]
      .map(([recipeId, count]) => ({
        recipeId,
        recipeTitle: titles.get(recipeId) ?? '',
        ...count,
      }))
      .sort(
        (a, b) =>
          b.down - a.down ||
          b.withExtensions - a.withExtensions ||
          b.up + b.down - (a.up + a.down) ||
          a.recipeTitle.localeCompare(b.recipeTitle),
      ),
    timers: [...timers.values()]
      .map((timer) => {
        const named = names
          .get(scenarioKey(timer.recipeId, timer.scenarioVersion))
          ?.get(timer.timerId);
        return {
          recipeId: timer.recipeId,
          recipeTitle: titles.get(timer.recipeId) ?? '',
          scenarioVersion: timer.scenarioVersion,
          timerId: timer.timerId,
          timerLabel: named?.label ?? null,
          stepTitle: named?.stepTitle ?? null,
          sessions: timer.sessions,
          averageSeconds: Math.round(timer.seconds / timer.sessions),
        };
      })
      .sort(
        (a, b) =>
          b.sessions - a.sessions ||
          b.averageSeconds - a.averageSeconds ||
          a.recipeTitle.localeCompare(b.recipeTitle),
      ),
  };
}

/**
 * Timery z treści scenariusza (`steps[].timer`). Treść czytamy luźno — panel
 * ma pokazać ocenę także przy wersji, której kształt się zmienił.
 */
export function timerNamesOf(content: unknown): TimerNames {
  const names: TimerNames = new Map();
  const steps = (content as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return names;
  for (const step of steps as unknown[]) {
    if (step === null || typeof step !== 'object') continue;
    const { title, timer } = step as { title?: unknown; timer?: unknown };
    if (timer === null || typeof timer !== 'object') continue;
    const { id, label } = timer as { id?: unknown; label?: unknown };
    if (typeof id !== 'string') continue;
    names.set(id, {
      label: typeof label === 'string' ? label : id,
      stepTitle: typeof title === 'string' ? title : '',
    });
  }
  return names;
}

function namedExtensions(
  value: unknown,
  names: TimerNames | undefined,
): CookFeedbackExtension[] {
  return Object.entries(extensionsOf(value)).map(([timerId, seconds]) => {
    const named = names?.get(timerId);
    return {
      timerId,
      timerLabel: named?.label ?? null,
      stepTitle: named?.stepTitle ?? null,
      seconds,
    };
  });
}

/** Mapę zapisuje `parseExtensions`; tu tylko obrona przed ręcznym SQL-em. */
function extensionsOf(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, seconds] of Object.entries(value)) {
    if (typeof seconds === 'number' && seconds > 0) result[key] = seconds;
  }
  return result;
}

function scenarioKey(recipeId: string, version: number): string {
  return `${recipeId}@${version}`;
}

function ratingOf(value: string): FeedbackRating {
  return value === 'UP' ? 'UP' : 'DOWN';
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
