import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
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

  /**
   * Co ten build potrafi narysować — dziś wyłącznie `cards.v1`.
   *
   * Serwer pyta o UMIEJĘTNOŚĆ, a nie o numer wersji, bo z numeru i tak
   * musiałby ją wywnioskować, a lista rośnie razem z klientem. Brak pola
   * znaczy „nic ponad tekst": stary build dostaje dotychczasowe zachowanie
   * i nie zobaczy tury, która kończy się przyciskiem, którego nie ma.
   */
  @ApiPropertyOptional({ example: ['cards.v1'], type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  clientCapabilities?: string[];
}

/**
 * Poprawienie własnego pytania.
 *
 * To NIE jest edycja tekstu w miejscu: poprawka uruchamia nową turę, a to,
 * co było po poprawianej wiadomości, znika z rozmowy. Inaczej użytkownik
 * zostawałby z odpowiedzią na pytanie, którego już nie zadał — a model
 * w kolejnej turze widziałby je dalej.
 */
export class EditMessageDto extends PostMessageDto {
  /** Wiadomość do poprawienia — musi być WŁASNA i z tej rozmowy. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId: string;
}
