import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

export const COOK_FEEDBACK_RATINGS = ['UP', 'DOWN'] as const;
export type CookFeedbackRating = (typeof COOK_FEEDBACK_RATINGS)[number];

/** Najwięcej timerów z „+min” w jednej ocenie — scenariusz ma ich kilka. */
export const COOK_FEEDBACK_MAX_EXTENSIONS = 24;
/** Najwięcej sekund dodanych do jednego timera (2 h — z zapasem). */
export const COOK_FEEDBACK_MAX_EXTENSION_SECONDS = 7200;

/**
 * Ocena gotowania (docs iOS Gotuj §13.3, §13.8). Telefon wysyła ją po
 * stuknięciu kciuka i drugi raz z uwagami z arkusza „Co byś zmienił?” —
 * ten sam `sessionId`, więc drugi zapis poprawia pierwszy (ostatni stan
 * wygrywa, także pusta podpowiedź).
 *
 * Walidowane w serwisie przez `validateDto`.
 */
export class CookFeedbackDto {
  /** Id sesji gotowania z telefonu — klucz idempotencji. */
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  sessionId: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  recipeId: string;

  /** `RecipeCookScenario.version`, na której gotowano. */
  @ApiProperty({ example: 3, minimum: 1 })
  @IsInt()
  @Min(1)
  scenarioVersion: number;

  @ApiProperty({ enum: COOK_FEEDBACK_RATINGS })
  @IsIn(COOK_FEEDBACK_RATINGS)
  rating: CookFeedbackRating;

  /** Powody z pigułek, także podpowiedź sesji („Kotlety +4 min”). */
  @ApiProperty({ type: [String], maxItems: 8 })
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags: string[];

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  /**
   * „+min” z sesji: id timera scenariusza → dodane sekundy. Kształt mapy
   * sprawdza serwis (`parseExtensions`) — dekoratory nie opisują kluczy.
   */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { 't-kotlety': 240 },
  })
  @IsObject()
  extensions: Record<string, number>;

  /** Porcje, na które gotowano. */
  @ApiPropertyOptional({ example: 2, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  servings?: number;
}
