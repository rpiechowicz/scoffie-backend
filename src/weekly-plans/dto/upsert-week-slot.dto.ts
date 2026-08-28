import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

const dayOfWeek = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const mealType = MEAL_TYPE_VALUES;

export class UpsertWeekSlotDto {
  @ApiProperty({ enum: dayOfWeek })
  @IsIn(dayOfWeek)
  dayOfWeek: (typeof dayOfWeek)[number];

  @ApiProperty({ enum: mealType })
  @IsIn(mealType)
  mealType: MealType;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  recipeId: string;

  /**
   * Household members this meal is for. Omitted or empty means "everyone" —
   * the app renders that as „Wspólne". Listing a subset is what makes a slot
   * a split ("Ania eats a salad, Marek a schnitzel").
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      'Household member user ids this meal is for. Empty or omitted = everyone.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsUUID(undefined, { each: true })
  participantIds?: string[];

  /**
   * Ile porcji gotujemy. Pominięte = policz z audytorium
   * (`participantIds.length`, a dla „Wspólne" liczba domowników).
   * Starszy klient nie zna tego pola i dzięki temu dostaje policzoną wartość
   * zamiast twardej jedynki.
   */
  @ApiPropertyOptional({ example: 2, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  plannedServings?: number;

  /**
   * Przepis, który ma zniknąć ze slotu w TEJ SAMEJ transakcji, w której wchodzi
   * `recipeId`. Tak wygląda „zmień danie": klient nie woła już
   * `removeWeekSlot` + `upsertWeekSlot`, między którymi slot stał pusty, a
   * drugi domownik dostawał dwa powiadomienia zamiast jednego.
   *
   * Równe `recipeId` znaczy „bez podmiany" — arkusz edycji wysyła edytowany
   * przepis także wtedy, gdy użytkownik ruszył tylko audytorium albo porcje.
   * Pominięte `participantIds` przy podmianie przejmuje audytorium starego
   * dania (po odsianiu byłych domowników); pominięte `plannedServings`
   * zachowuje ręcznie wybraną liczbę porcji, a auto przelicza na nowo.
   *
   * Dekoratory nie odpalają się na ścieżce WS (patrz `plannedServings`),
   * więc formatu pilnuje `parseReplaceRecipeId` w serwisie.
   */
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsUUID()
  replaceRecipeId?: string;
}
