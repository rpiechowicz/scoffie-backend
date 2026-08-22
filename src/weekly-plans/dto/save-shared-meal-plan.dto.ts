import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES, isMealType } from '../../common/meal-types';

/**
 * Waliduje `recipeIdsByMealType`: klucze muszą być slotami posiłków,
 * a wartości — tablicami identyfikatorów. Ręcznie, bo `class-validator` nie
 * ma wbudowanej reguły na „słownik enum → tablica stringów".
 */
@ValidatorConstraint({ name: 'RecipeIdsByMealType', async: false })
class RecipeIdsByMealTypeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;

    return Object.entries(value as Record<string, unknown>).every(
      ([key, ids]) =>
        isMealType(key) &&
        Array.isArray(ids) &&
        ids.every((id) => typeof id === 'string'),
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must map meal types (${MEAL_TYPE_VALUES.join(', ')}) to arrays of recipe ids`;
  }
}

export class SaveSharedMealPlanDto {
  /**
   * Pula przepisów na tydzień, slot po slocie. Zastępuje trzy sztywne pola
   * `breakfast/lunch/dinnerRecipeIds` — te zostają wyłącznie po to, żeby
   * starszy klient (bez dodatkowych posiłków) dalej działał po wdrożeniu
   * backendu, i są scalane z tą mapą w `mergeSharedPlanRecipeIds`.
   *
   * Powtórzone id w tablicy = większa liczba porcji tego dania w tygodniu;
   * serwis zwija je do `quantity`.
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    example: {
      BREAKFAST: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
      SECOND_BREAKFAST: [],
    },
  })
  @IsOptional()
  @IsObject()
  @Validate(RecipeIdsByMealTypeConstraint)
  recipeIdsByMealType?: Partial<Record<MealType, string[]>>;

  /** @deprecated Zastąpione przez `recipeIdsByMealType`. */
  @ApiProperty({
    type: [String],
    required: false,
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  breakfastRecipeIds?: string[];

  /** @deprecated Zastąpione przez `recipeIdsByMealType`. */
  @ApiProperty({
    type: [String],
    required: false,
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  lunchRecipeIds?: string[];

  /** @deprecated Zastąpione przez `recipeIdsByMealType`. */
  @ApiProperty({
    type: [String],
    required: false,
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  dinnerRecipeIds?: string[];
}

/**
 * Sprowadza obie formy zapisu do jednej mapy `slot → id przepisów`.
 *
 * Rozstrzygnięcie konfliktu: jeżeli klient przysłał `recipeIdsByMealType`,
 * to ono wygrywa dla slotów, które w nim wymienił — nawet gdy przy okazji
 * wysłał stare pola. Inaczej klient w trakcie migracji potrafiłby nadpisać
 * własny, nowszy zapis starszym.
 *
 * Sloty nieobecne w żadnej z form wracają jako pusta tablica, bo zapis puli
 * jest **pełny**: brak slotu znaczy „nic w nim nie planujemy", nie „zostaw,
 * jak było".
 */
export function mergeSharedPlanRecipeIds(
  dto: SaveSharedMealPlanDto,
): Record<MealType, string[]> {
  const legacy: Partial<Record<MealType, string[]>> = {
    [MealType.BREAKFAST]: dto.breakfastRecipeIds,
    [MealType.LUNCH]: dto.lunchRecipeIds,
    [MealType.DINNER]: dto.dinnerRecipeIds,
  };

  const modern = dto.recipeIdsByMealType ?? {};

  return MEAL_TYPE_VALUES.reduce(
    (acc, key) => {
      const mealType = key as MealType;
      acc[mealType] = modern[mealType] ?? legacy[mealType] ?? [];
      return acc;
    },
    {} as Record<MealType, string[]>,
  );
}
