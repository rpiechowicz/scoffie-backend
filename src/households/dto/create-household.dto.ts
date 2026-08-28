import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Nazwa gospodarstwa. Na WS dekoratory były martwe, więc `name` szło do bazy
 * bez typu i długości (10 000 znaków albo liczba = `PrismaClientValidationError`
 * → 500); od kroku 2 Fazy 0 serwis woła `validateDto` i tu jest jedyna
 * definicja tego, co wolno. Granice (2..64) są te same, co dotąd na HTTP i w
 * Ustawieniach iOS; na WS to jednak ZMIANA zachowania — 1-znakowa nazwa
 * przechodziła, teraz dostaje VALIDATION_ERROR (kreator iOS pilnuje tego od
 * builda Fazy 0).
 */
export class CreateHouseholdDto {
  @ApiProperty({ example: 'Home', minLength: 2, maxLength: 64 })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name: string;
}
