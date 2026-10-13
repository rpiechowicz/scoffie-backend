import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ShoppingDepartment } from '../types/shopping-department.enum';
import {
  SHOPPING_PRODUCT_INPUT_UNITS,
  SHOPPING_PRODUCT_NAME_MAX,
} from '../utils/shopping-manual.util';

/** Ile produktów naraz przyjmuje jedno „Dodaj do listy”. */
export const ADD_SHOPPING_PRODUCTS_MAX = 50;

/**
 * Jeden produkt z arkusza „Dodaj produkty”: z katalogu (`ingredientId`) albo
 * pod własną nazwą (`name` + `department`). Ilość nieobowiązkowa — bez
 * `amount` i `unit` to „kup to”; z ilością oba pola razem (sprawdza serwis,
 * razem z sufitem per jednostka).
 */
export class ShoppingProductInputDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ingredientId?: string;

  @ApiPropertyOptional({
    example: 'Karma dla kota',
    maxLength: SHOPPING_PRODUCT_NAME_MAX,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(SHOPPING_PRODUCT_NAME_MAX)
  name?: string;

  /** Dział własnej nazwy; produkt z katalogu ma swój. Brak = „Inne”. */
  @ApiPropertyOptional({ enum: Object.values(ShoppingDepartment) })
  @IsOptional()
  @IsIn(Object.values(ShoppingDepartment))
  department?: string;

  @ApiPropertyOptional({ example: 1, minimum: 0.01, maximum: 20000 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 })
  @Min(0.01)
  @Max(20000)
  amount?: number;

  @ApiPropertyOptional({ enum: SHOPPING_PRODUCT_INPUT_UNITS })
  @IsOptional()
  @IsIn(SHOPPING_PRODUCT_INPUT_UNITS)
  unit?: string;
}

/** `weeklyPlans:addShoppingProducts` — walidowane w serwisie przez `validateDto`. */
export class AddShoppingProductsDto {
  @ApiProperty({ type: [ShoppingProductInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ADD_SHOPPING_PRODUCTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => ShoppingProductInputDto)
  items: ShoppingProductInputDto[];
}

/**
 * `weeklyPlans:setShoppingProductAmount` — nowa ilość DOPISANEJ części
 * wiersza `productKey`. Bez `amount` i `unit` = „bez ilości”.
 */
export class SetShoppingProductAmountDto {
  /** Klucz wiersza listy (`nazwa::jednostka`), jak w `UpdateShoppingItemCheckDto`. */
  @ApiProperty({ example: 'mleko::ml' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  productKey: string;

  @ApiPropertyOptional({ example: 1000, minimum: 0.01, maximum: 20000 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 })
  @Min(0.01)
  @Max(20000)
  amount?: number;

  @ApiPropertyOptional({ enum: SHOPPING_PRODUCT_INPUT_UNITS })
  @IsOptional()
  @IsIn(SHOPPING_PRODUCT_INPUT_UNITS)
  unit?: string;
}
