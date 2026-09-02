import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class UsageQueryDto {
  /** Kwoty liczą się per gospodarstwo — tak jak liczniki `AiUsageCounter`. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  householdId: string;
}
