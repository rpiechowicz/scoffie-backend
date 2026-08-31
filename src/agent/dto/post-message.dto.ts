import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import {
  IsCalendarDate,
  IsIanaTimeZone,
  IsMondayDate,
} from './agent-date.validators';

export const AGENT_MESSAGE_MAX_LENGTH = 2000;

export class PostMessageDto {
  /**
   * Identyfikator nadany przez klienta — klucz idempotencji. Ponowione
   * żądanie (utracona odpowiedź, powrót z tła) oddaje TĘ SAMĄ turę zamiast
   * płacić drugi raz za ten sam prompt.
   */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientMessageId: string;

  @ApiProperty({ maxLength: AGENT_MESSAGE_MAX_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_MESSAGE_MAX_LENGTH)
  text: string;

  /** Poniedziałek tygodnia, o którym rozmawiamy — liczony na telefonie. */
  @ApiProperty({ example: '2026-08-31' })
  @IsMondayDate()
  weekStart: string;

  /** „Dziś" w strefie użytkownika; serwer na Railway żyje w UTC. */
  @ApiProperty({ example: '2026-09-02' })
  @IsCalendarDate()
  clientToday: string;

  @ApiProperty({ example: 'Europe/Warsaw' })
  @IsIanaTimeZone()
  timeZone: string;
}
