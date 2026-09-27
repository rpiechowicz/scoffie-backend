import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Kciuk pod odpowiedzią asystenta na telefonie. */
export const AGENT_MESSAGE_RATINGS = ['UP', 'DOWN'] as const;
export type AgentMessageRating = (typeof AGENT_MESSAGE_RATINGS)[number];
const RATING_VALUES: string[] = [...AGENT_MESSAGE_RATINGS];

/**
 * Szybkie powody podpowiedzi przy kciuku w dół (27.09.2026). To NIE są
 * powody zgłoszenia (`AGENT_REPORT_REASONS`: błąd, zagrożenie, obraza) —
 * podpowiedź mówi „co poprawić”, zgłoszenie „co jest nie tak i wymaga
 * decyzji”. Dlatego żyją osobno i trafiają do osobnego działu panelu.
 */
export const AGENT_FEEDBACK_DOWN_TAGS = [
  /** Odpowiedź za długa, za dużo tekstu. */
  'TOO_LONG',
  /** Asystent odpowiedział na inne pytanie. */
  'NOT_WHAT_I_ASKED',
  /** Dania nietrafione (smak, pora, pomysł). */
  'BAD_DISHES',
  /** Czekanie na odpowiedź za długie. */
  'TOO_SLOW',
  'OTHER',
] as const;

/**
 * Powody przy kciuku W GÓRĘ — „co było dobre” (27.09.2026, analogicznie do
 * podpowiedzi przy kciuku w dół). Lustro powodów w dół, żeby panel
 * zestawiał je parami.
 */
export const AGENT_FEEDBACK_UP_TAGS = [
  /** Zrozumiał, o co chodzi. */
  'UNDERSTOOD',
  /** Trafione dania. */
  'GOOD_DISHES',
  /** Krótko i konkretnie. */
  'CONCISE',
  /** Szybka odpowiedź. */
  'FAST',
] as const;

export const AGENT_FEEDBACK_TAGS = [
  ...AGENT_FEEDBACK_DOWN_TAGS,
  ...AGENT_FEEDBACK_UP_TAGS,
] as const;
export type AgentFeedbackTag = (typeof AGENT_FEEDBACK_TAGS)[number];
const TAG_VALUES: string[] = [...AGENT_FEEDBACK_TAGS];

/** Powody, które pasują do kierunku oceny — reszta z żądania odpada. */
export function feedbackTagsFor(
  rating: AgentMessageRating,
): readonly AgentFeedbackTag[] {
  return rating === 'UP' ? AGENT_FEEDBACK_UP_TAGS : AGENT_FEEDBACK_DOWN_TAGS;
}

export class RateMessageDto {
  /**
   * `null` zdejmuje ocenę (drugie stuknięcie w ten sam kciuk). Pole musi
   * paść jawnie — brak pola to błąd, nie „zdejmij", żeby literówka po
   * stronie klienta nie kasowała ocen po cichu.
   */
  @ApiProperty({ enum: RATING_VALUES, nullable: true })
  @ValidateIf((dto: RateMessageDto) => dto.rating !== null)
  @IsIn(RATING_VALUES)
  rating: AgentMessageRating | null;

  /**
   * Podpowiedź do oceny — powody z listy TEGO kierunku (`feedbackTagsFor`;
   * obce odpadają). Brak pola = podpowiedź bez zmian, chyba że kierunek oceny
   * się zmienił (wtedy znika); pusta lista = bez powodów. Przy `null` pomijane.
   */
  @ApiPropertyOptional({ enum: TAG_VALUES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TAG_VALUES.length)
  @IsIn(TAG_VALUES, { each: true })
  tags?: AgentFeedbackTag[];

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null;
}
