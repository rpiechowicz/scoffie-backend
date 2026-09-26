import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DayOfWeek, MealType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Twardy sufit długości listy — ta sama liczba, co suma limitów planu
 * (7 dni × 6 wariantów × liczba slotów). Dekorator odcina absurdalne wejście,
 * zanim serwis policzy cokolwiek; właściwe limity per slot i per posiłek
 * sprawdza `applyWeekPlan` i raportuje je jako naruszenia, nie wyjątek.
 */
export const APPLY_WEEK_PLAN_MAX_SLOTS = 7 * 6 * 6;

/** Porcja jednej osoby (Etap 2.2): wielokrotność 0,05 porcji przepisu. */
export class PlanPortionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId: string;

  @ApiProperty({ example: 1.25, minimum: 0.1, maximum: 6 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(6)
  servings: number;
}

export class ApplyWeekSlotDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @ApiProperty({ enum: MealType })
  @IsEnum(MealType)
  mealType: MealType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  recipeId: string;

  /** Puste albo pominięte = „Wspólne" (cały dom). */
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsUUID('all', { each: true })
  participantIds?: string[];

  /** Porcje ŁĄCZNE. Pominięte = policz z audytorium (jak w `upsertWeekSlot`). */
  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  plannedServings?: number;

  /**
   * Porcje per osoba (Etap 2.2). Podane = źródło prawdy: zbiór osób musi być
   * audytorium pozycji, a `plannedServings` serwer liczy sam (`ceil(Σ)`).
   * Pominięte albo puste = równy podział, jak dotąd.
   */
  @ApiPropertyOptional({ type: [PlanPortionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => PlanPortionDto)
  portions?: PlanPortionDto[];
}

/**
 * Cały tydzień w jednym wywołaniu — stan DOCELOWY, nie lista poprawek.
 *
 * Po zastosowaniu tydzień zawiera dokładnie te sloty, które przyszły w
 * `slots`: czego nie ma na liście, tego nie ma w planie. Dzięki temu asystent
 * nie musi wiedzieć, co jest teraz w bazie, żeby ułożyć tydzień od nowa — a
 * my nie musimy zgadywać, czy pominięty slot znaczy „usuń", czy „nie ruszaj".
 */
export class ApplyWeekPlanDto {
  @ApiProperty({ type: [ApplyWeekSlotDto] })
  @IsArray()
  @ArrayMaxSize(APPLY_WEEK_PLAN_MAX_SLOTS)
  @ValidateNested({ each: true })
  @Type(() => ApplyWeekSlotDto)
  slots: ApplyWeekSlotDto[];

  /**
   * `true` = policz i sprawdź wszystko, ale NIC nie zapisuj.
   *
   * To jest właściwy tryb dla asystenta: zanim zaproponuje tydzień
   * użytkownikowi, dostaje pełną listę naruszeń (nieznany przepis, danie nie
   * do tego slotu, obcy domownik w audytorium) i może poprawić plan, zamiast
   * zapisać połowę i utknąć.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
