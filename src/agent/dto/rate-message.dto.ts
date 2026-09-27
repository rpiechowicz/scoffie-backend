import { ApiProperty } from '@nestjs/swagger';
import { IsIn, ValidateIf } from 'class-validator';

/** Kciuk pod odpowiedzią asystenta na telefonie. */
export const AGENT_MESSAGE_RATINGS = ['UP', 'DOWN'] as const;
export type AgentMessageRating = (typeof AGENT_MESSAGE_RATINGS)[number];
const RATING_VALUES: string[] = [...AGENT_MESSAGE_RATINGS];

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
}
