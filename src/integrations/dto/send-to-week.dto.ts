import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';

export class SendToWeekDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  recipeId: string;

  // Data liczona po stronie telefonu (lokalna strefa użytkownika) i przesyłana
  // jako goły string — serwer na Railway żyje w UTC i nie wolno mu jej ruszać.
  @ApiProperty({ example: '2026-08-26' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date musi mieć format YYYY-MM-DD',
  })
  date: string;
}
