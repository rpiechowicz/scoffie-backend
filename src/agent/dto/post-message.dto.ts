import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  IsCalendarDate,
  IsIanaTimeZone,
  IsMondayDate,
} from './agent-date.validators';

export const AGENT_MESSAGE_MAX_LENGTH = 2000;

/** Typy obrazów, które umie przeczytać model — i tylko one. */
export const AGENT_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/**
 * Sufit na zdjęcie w base64 (~2 MB po zdekodowaniu).
 *
 * Telefon i tak przeskalowuje zdjęcie przed wysyłką; ten limit jest po to,
 * żeby błąd po stronie klienta nie zamienił się w megabajty w pamięci serwera
 * i w rachunku za tokeny.
 */
export const AGENT_IMAGE_MAX_BASE64_LENGTH = 2_800_000;

/**
 * Zdjęcie do JEDNEJ tury — nigdzie nie zapisywane.
 *
 * Idzie prosto do modelu i znika razem z turą. To jest decyzja, nie
 * uproszczenie: zdjęcie wnętrza lodówki albo kuchni mówi o domu więcej niż
 * cała reszta rozmowy, a jedyne, co naprawdę musimy z niego zachować, to
 * odpowiedź asystenta. Cena jest uczciwa i widoczna: w kolejnej turze model
 * już go nie widzi, więc pyta zamiast zgadywać.
 */
export class PostMessageImageDto {
  @ApiProperty({ enum: AGENT_IMAGE_MEDIA_TYPES })
  @IsIn(AGENT_IMAGE_MEDIA_TYPES as unknown as string[])
  mediaType: string;

  @ApiProperty({ description: 'Zawartość w base64, bez prefiksu data:.' })
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_IMAGE_MAX_BASE64_LENGTH)
  data: string;
}

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
  /**
   * Zdjęcie dołączone do TEJ wiadomości.
   *
   * Serwer go nie zapisuje — patrz `PostMessageImageDto`. W historii zostaje
   * sama wiadomość z rodzajem `PHOTO`, żeby po powrocie do rozmowy było
   * widać, że pytanie miało załącznik, którego już nie ma.
   */
  @ApiPropertyOptional({ type: PostMessageImageDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PostMessageImageDto)
  image?: PostMessageImageDto;

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
