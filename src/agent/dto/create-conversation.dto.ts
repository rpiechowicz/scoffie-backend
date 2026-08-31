import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateConversationDto {
  // Rozmowa jest przypięta do gospodarstwa, bo tam mieszkają plan tygodnia,
  // przepisy i lista zakupów — i tam liczy się kwota (`AiUsageCounter`
  // scope = householdId).
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  householdId: string;
}
