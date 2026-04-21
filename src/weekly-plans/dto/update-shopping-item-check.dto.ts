import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, MinLength } from 'class-validator';

export class UpdateShoppingItemCheckDto {
  @ApiProperty({ example: 'milk::ml' })
  @IsString()
  @MinLength(1)
  productKey: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  isChecked: boolean;
}
