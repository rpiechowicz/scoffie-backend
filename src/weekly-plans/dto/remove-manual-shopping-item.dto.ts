import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RemoveManualShoppingItemDto {
  @ApiProperty({ example: 'Woda::ml' })
  @IsString()
  @MinLength(1)
  productKey: string;
}
