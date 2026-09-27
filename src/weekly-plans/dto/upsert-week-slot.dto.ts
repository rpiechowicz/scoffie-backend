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
import {
  PORTION_POLICIES,
  type PortionPolicy,
} from '../utils/plan-portions.util';

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
   * porcja wielokrotnością 0,5. Podane = źródło prawdy (`plannedServings`
   * liczy serwer); zastąpienie ISTNIEJĄCEJ alokacji wymaga `expectedRevision`.
   * POMINIĘTE (albo `[]`) nie kasują alokacji, którą pozycja ma (ADR
   * `plan-portions-write-safety`).
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

  /**
   * Token pozycji z odczytu (`items[].revision`) — przy `replaceRecipeId`
   * pozycji ŹRÓDŁOWEJ (wtedy wymaga pary `expectedTargetRevision`).
   * Niezgodny = `PLAN_REVISION_CONFLICT` (chyba że zapis bez zamiany nic by
   * nie zmienił); pominięty = zapis bez weryfikacji (legacy), który nie może
   * zastąpić ani usunąć porcji per osoba (ADR `plan-portions-safe-editing`).
   */
  @ApiPropertyOptional({ example: 7, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;

  /**
   * Jawna intencja wobec porcji per osoba:
   * - `PRESERVE` — zachowaj (przy zmianie audytorium serwer przelicza:
   *   zostający — swoja porcja, nowi — 1,00, usunięci — znikają; przy
   *   zamianie dania porcje przechodzą na nowe danie); bez `portions`;
   * - `REPLACE` — `portions` stają się alokacją (zastąpienie istniejącej
   *   wymaga tokenu);
   * - `RESET` — świadomy powrót do równego podziału (tylko z tokenem, gdy
   *   pozycja ma alokację); bez `portions`.
   * Pominięte = kontrakt legacy: pozycja z alokacją bez `portions` —
   * identyczny zapis albo `PLAN_PORTIONS_CONFLICT`, nigdy cichy reset.
   */
  @ApiPropertyOptional({ enum: PORTION_POLICIES })
  @IsOptional()
  @IsIn(PORTION_POLICIES)
  portionPolicy?: PortionPolicy;

  /**
   * Tylko przy `replaceRecipeId`: token CELU zamiany — `items[].revision`
   * pozycji z przepisem `recipeId`, która już leży w tym slocie, albo `null`,
   * gdy według odczytu klienta takiej pozycji w slocie NIE MA. Podawany razem
   * z `expectedRevision` źródła (jedno bez drugiego = `PLAN_REVISION_REQUIRED`);
   * niezgodny = `PLAN_REVISION_CONFLICT`, nic nie zmienione.
   */
  @ApiPropertyOptional({ example: 9, minimum: 0, nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTargetRevision?: number | null;
}
