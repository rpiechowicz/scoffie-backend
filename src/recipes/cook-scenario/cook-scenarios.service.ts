import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { assertUuid } from '../../common/uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { RecipesService } from '../recipes.service';
import { recipeContentHash } from './cook-scenario.hash';
import type { CookScenarioResponse } from './cook-scenario.types';
import { parseCookScenarioContent } from './cook-scenario.validate';

/**
 * Odczyt scenariusza trybu Gotuj dla telefonu (`recipes:cookScenario`).
 *
 * Telefon pyta tylko wtedy, gdy przepis w katalogu niesie
 * `cookScenarioVersion` (albo wersja się zmieniła), i trzyma odpowiedź
 * u siebie — tryb Gotuj działa potem offline. Zapisem zajmuje się
 * `publishCookScenario` (loader wzorców, później system pisania i panel).
 */
@Injectable()
export class CookScenariosService {
  private readonly logger = new Logger(CookScenariosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipes: RecipesService,
  ) {}

  async findPublished(
    userIdentifier: string,
    recipeId: string,
    householdId: string,
  ): Promise<CookScenarioResponse> {
    assertUuid(recipeId, 'recipeId');
    assertUuid(householdId, 'householdId');
    // Członkostwo PRZED odczytem przepisu — ta sama kolejność co `findById`
    // (audyt 21.09.2026): inaczej odpowiedź zdradzałaby istnienie cudzego
    // przepisu.
    await this.recipes.ensureMembership(userIdentifier, householdId);
    const recipe = await this.prisma.recipe.findFirst({
      where: {
        id: recipeId,
        isActive: true,
        OR: [{ isCatalog: true }, { householdId }],
      },
      select: {
        id: true,
        title: true,
        servings: true,
        sourceInstructions: true,
        cookScenarioVersion: true,
        ingredients: {
          select: { ingredientId: true, amount: true, unit: true },
        },
      },
    });
    if (!recipe) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        'Nie znaleziono przepisu.',
        HttpStatus.NOT_FOUND,
      );
    }
    const none: CookScenarioResponse = { recipeId, scenario: null };
    if (recipe.cookScenarioVersion === null) return none;

    const row = await this.prisma.recipeCookScenario.findFirst({
      where: { recipeId, status: 'PUBLISHED' },
      select: {
        version: true,
        rulesVersion: true,
        recipeContentHash: true,
        content: true,
      },
    });
    if (!row) return none;

    // Przepis zmienił się po napisaniu scenariusza (edycja w panelu, import):
    // ilości albo kroki mogą już nie pasować, więc lepiej bez trybu Gotuj niż
    // z błędnymi ilościami. Oznaczenie STALE i ponowne pisanie zrobi system
    // pisania (Etap E3) — tu tylko nie wydajemy nieaktualnej treści.
    if (row.recipeContentHash !== recipeContentHash(recipe)) {
      this.logger.warn(
        `scenariusz Gotuj nieaktualny: recipeId=${recipeId} v${row.version}`,
      );
      return none;
    }
    const parsed = parseCookScenarioContent(row.content);
    if (!parsed.content) {
      this.logger.error(
        `scenariusz Gotuj z niepoprawną treścią: recipeId=${recipeId} v${row.version} (${parsed.errors.length} błędów)`,
      );
      return none;
    }
    return {
      recipeId,
      scenario: {
        version: row.version,
        rulesVersion: row.rulesVersion,
        content: parsed.content,
      },
    };
  }
}
