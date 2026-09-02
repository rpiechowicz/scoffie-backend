import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Ciało zatwierdzenia propozycji — do 3.09.2026 puste.
 *
 * `force` = „Zapisz mimo to" z karty STALE: plan zmienił się od propozycji,
 * użytkownik to widzi i mimo to chce ją zapisać. Serwer pomija wtedy
 * porównanie z odciskiem tygodnia, ale NIE pomija walidacji (alergeny,
 * wykluczenia, nieznane przepisy) — ona biegnie zawsze, jak przy każdym
 * zapisie. Bez `force` propozycja nieaktualna odmawia jak dotąd.
 */
export class ApplyProposalDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
