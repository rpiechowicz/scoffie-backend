import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PlanPortionDto } from './apply-week-plan.dto';
import { DayOfWeek, MealType } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

/**
 * Dekoratory niżej są od Fazy 0 (krok 2) egzekwowane także na WebSockecie —
 * serwis woła `validateDto(UpsertWeekSlotDto, dto)` na wejściu, więc zły enum
 * albo nie-UUID wraca jako `VALIDATION_ERROR` z listą dozwolonych wartości,
 * a nie jako `PrismaClientValidationError` → 500. Enumy pochodzą wprost z
 * Prismy (jedno źródło prawdy z bazą i z iOS), nie z lokalnych kopii list.
 */
export class UpsertWeekSlotDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @ApiProperty({ enum: MEAL_TYPE_VALUES })
  @IsIn(MEAL_TYPE_VALUES)
  mealType: MealType;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
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
   * Porcje per osoba (Etap 2.2) — zbiór osób = audytorium slotu, każda
   * porcja wielokrotnością 0,05. Podane = źródło prawdy (`plannedServings`
   * liczy serwer). POMINIĘTE = pozycja bez alokacji: zapis ze starszego
   * klienta albo zmiana łącznej liczby porcji stepperem wraca do równego
   * podziału — świadomie, bo stare porcje osób nie pasowałyby już do sumy.
   */
  @ApiPropertyOptional({ type: [PlanPortionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => PlanPortionDto)
  portions?: PlanPortionDto[];

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
   * iOS wysyła to pole wyłącznie wtedy, gdy ma co podmienić (nigdy `""` ani
   * `null`), więc `@IsOptional()` + `@IsUUID()` opisuje dokładnie to, co
   * przychodzi.
   */
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsUUID()
  replaceRecipeId?: string;
}
