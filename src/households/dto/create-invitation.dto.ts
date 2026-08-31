import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/**
 * iOS wysyła `data: {}` (stare buildy — wcale), więc każde pole jest
 * opcjonalne. `expiresAt` musi być ISO 8601: serwis robi `new Date(expiresAt)`
 * i bez tej bramki `Invalid Date` lądowało w Prismie jako 500.
 */
export class CreateInvitationDto {
  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.000Z' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
