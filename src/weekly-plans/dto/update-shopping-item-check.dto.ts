import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

/** Walidowane w serwisie przez `validateDto` — patrz `UpsertWeekSlotDto`. */
export class UpdateShoppingItemCheckDto {
  /**
   * Klucz pozycji (`nazwa::jednostka`, patrz `normalizeProductKey`). Górna
   * granica to obrona przed śmieciowym payloadem — prawdziwe klucze mają
   * kilkadziesiąt znaków.
   */
  @ApiProperty({ example: 'milk::ml' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  productKey: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  isChecked: boolean;
}
