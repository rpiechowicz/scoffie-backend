import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Pamięć jest wspólna dla gospodarstwa, więc odczyt musi powiedzieć, o które
 * gospodarstwo chodzi — użytkownik może należeć do innego niż wczoraj.
 */
export class MemoryQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  householdId: string;
}
