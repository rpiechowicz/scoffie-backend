import { Injectable } from '@nestjs/common';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { SearchIngredientsDto } from './dto/search-ingredients.dto';
import {
  allowedUnitsFor,
  INGREDIENT_SEARCH_DEFAULT_LIMIT,
  rankIngredients,
  SEARCH_CANDIDATE_LIMIT,
  searchStem,
} from './ingredient-search.util';

export type IngredientSearchHit = {
  id: string;
  name: string;
  category: string;
  allergens: string[];
  dietTags: string[];
  /** Bez makro przepis nie przejdzie zapisu — dlatego to jest jawne pole. */
  hasNutrition: boolean;
  /** Masa jednej sztuki; `null` = jednostka `szt` jest dla tego składnika niedostępna. */
  gramsPerPiece: number | null;
  /** Jednostki, które system naprawdę przyjmie — patrz `allowedUnitsFor`. */
  allowedUnits: string[];
};

/**
 * Wyszukiwarka składników katalogu.
 *
 * Powstała, bo `recipes:create` wymaga identyfikatora składnika, a asystent
 * zna wyłącznie nazwy — dotąd nie było ŻADNEJ drogi od „pierś z kurczaka" do
 * właściwego wpisu w katalogu. Efektem był halucynowany identyfikator i błąd
 * zamiast przepisu.
 *
 * Odpowiedź jest celowo szersza niż samo id: alergeny i tagi diet pozwalają
 * odsiać składnik, zanim wejdzie do przepisu, a `hasNutrition` i
 * `allowedUnits` mówią z góry, czy i w jakiej jednostce da się go w ogóle
 * zapisać. Bez tych dwóch pól asystent dowiadywałby się o odmowie dopiero
 * przy zapisie — a katalog ma dziś makro tylko dla jednej trzeciej pozycji.
 */
@Injectable()
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  async search(input: SearchIngredientsDto): Promise<IngredientSearchHit[]> {
    const dto = await validateDto(SearchIngredientsDto, input ?? {});
    const query = dto.query?.trim() ?? '';
    const stem = searchStem(query);
    const limit = dto.limit ?? INGREDIENT_SEARCH_DEFAULT_LIMIT;

    const candidates = await this.prisma.ingredient.findMany({
      where: {
        isActive: true,
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.onlyWithNutrition
          ? { nutritionKcalPer100: { not: null } }
          : {}),
        // Rdzeń, nie pełne zapytanie: „jajka" nie zawiera się w „jajko", więc
        // filtr na całej frazie gubiłby polską odmianę. Ranking i tak liczy
        // się w kodzie, tu chodzi tylko o zawężenie kandydatów.
        ...(stem
          ? {
              OR: [
                { normalizedName: { contains: stem } },
                { aliases: { some: { normalizedAlias: { contains: stem } } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        normalizedName: true,
        category: true,
        allergens: true,
        dietTags: true,
        gramsPerPiece: true,
        nutritionKcalPer100: true,
        aliases: { select: { alias: true } },
      },
      orderBy: { name: 'asc' },
      take: SEARCH_CANDIDATE_LIMIT,
    });

    return rankIngredients(query, candidates)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        allergens: row.allergens,
        dietTags: row.dietTags,
        hasNutrition: row.nutritionKcalPer100 !== null,
        gramsPerPiece: row.gramsPerPiece,
        allowedUnits: allowedUnitsFor(row),
      }));
  }
}
