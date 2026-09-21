import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Zdjęcie z listy tego, co zostało DOPISANE do produktu (ze wszystkich
 * przepisów naraz). Część z planu zostaje — tej nie da się usunąć inaczej niż
 * zmianą planu. Walidowane w serwisie przez `validateDto`.
 */
export class RemoveShoppingExtraDto {
  /** Klucz pozycji (`nazwa::jednostka`), jak w `UpdateShoppingItemCheckDto`. */
  @ApiProperty({ example: 'mleko::ml' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  productKey: string;
}
