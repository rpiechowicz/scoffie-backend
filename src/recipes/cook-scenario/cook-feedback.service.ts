import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { assertUuid } from '../../common/uuid';
import { validateDto } from '../../common/validate-dto';
import { PrismaService } from '../../prisma/prisma.service';
import { RecipesService } from '../recipes.service';
import {
  COOK_FEEDBACK_MAX_EXTENSION_SECONDS,
  COOK_FEEDBACK_MAX_EXTENSIONS,
  CookFeedbackDto,
  type CookFeedbackRating,
} from './cook-feedback.dto';

export interface CookFeedbackSaved {
  sessionId: string;
  rating: CookFeedbackRating;
  updatedAt: string;
}

/**
 * Oceny gotowania w trybie Gotuj (`recipes:cookFeedback`). Jedna na osobę
 * i sesję: kciuk zapisuje się od razu, uwagi z arkusza poprawiają ten sam
 * wiersz. Panel czyta je w dziale „Oceny” (`AdminCookFeedbackService`).
 */
@Injectable()
export class CookFeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipes: RecipesService,
  ) {}

  async save(
    userId: string,
    householdId: string,
    input: CookFeedbackDto,
  ): Promise<CookFeedbackSaved> {
    const dto = await validateDto(CookFeedbackDto, input);
    assertUuid(householdId, 'householdId');
    // Członkostwo PRZED odczytem przepisu — jak `findPublished`.
    await this.recipes.ensureMembership(userId, householdId);
    const recipe = await this.prisma.recipe.findFirst({
      where: {
        id: dto.recipeId,
        OR: [{ isCatalog: true }, { householdId }],
      },
      select: { id: true },
    });
    if (!recipe) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        'Nie znaleziono przepisu.',
        HttpStatus.NOT_FOUND,
      );
    }
    const extensions = parseExtensions(dto.extensions);
    const tags = [
      ...new Set(dto.tags.map((tag) => tag.trim()).filter(Boolean)),
    ];
    const comment = dto.comment?.trim() || null;
    const fields = {
      recipeId: dto.recipeId,
      scenarioVersion: dto.scenarioVersion,
      rating: dto.rating,
      tags,
      comment,
      extensions,
      servings: dto.servings ?? null,
    };
    const row = await this.prisma.cookFeedback.upsert({
      where: { userId_sessionId: { userId, sessionId: dto.sessionId } },
      update: fields,
      create: { userId, sessionId: dto.sessionId, ...fields },
      select: { sessionId: true, rating: true, updatedAt: true },
    });
    return {
      sessionId: row.sessionId,
      rating: row.rating === 'UP' ? 'UP' : 'DOWN',
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Mapa „+min”: klucz = id timera (niepusty, do 64 znaków), wartość = sekundy
 * 1..7200. Zera wypadają; cokolwiek innego = `VALIDATION_ERROR` — telefon
 * wysyła tylko to, co sam policzył, więc zły kształt to błąd klienta.
 */
export function parseExtensions(value: unknown): Record<string, number> {
  const invalid = (message: string) =>
    new AppException('VALIDATION_ERROR', message, HttpStatus.BAD_REQUEST);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('extensions must be an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > COOK_FEEDBACK_MAX_EXTENSIONS) {
    throw invalid(
      `extensions must have at most ${COOK_FEEDBACK_MAX_EXTENSIONS} timers`,
    );
  }
  const result: Record<string, number> = {};
  for (const [timerId, seconds] of entries) {
    if (timerId.length === 0 || timerId.length > 64) {
      throw invalid('extensions keys must be timer ids (1–64 characters)');
    }
    if (
      typeof seconds !== 'number' ||
      !Number.isInteger(seconds) ||
      seconds < 0 ||
      seconds > COOK_FEEDBACK_MAX_EXTENSION_SECONDS
    ) {
      throw invalid(
        `extensions values must be whole seconds (0–${COOK_FEEDBACK_MAX_EXTENSION_SECONDS})`,
      );
    }
    if (seconds > 0) result[timerId] = seconds;
  }
  return result;
}
