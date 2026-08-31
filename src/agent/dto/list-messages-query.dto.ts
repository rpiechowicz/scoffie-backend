import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ListMessagesQueryDto {
  /**
   * Kursor: oddaj wiadomości nowsze niż ta. Klient trzyma id ostatniej,
   * którą pokazał, i dopytuje tylko o przyrost — polling tury i tak wraca
   * co sekundę, a historia rozmowy potrafi urosnąć.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  after?: string;
}
