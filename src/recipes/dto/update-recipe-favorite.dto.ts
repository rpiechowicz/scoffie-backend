import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString } from 'class-validator';

export class UpdateRecipeFavoriteDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  recipeId: string;

  @ApiProperty({ example: '7adf5ec0-e3e5-4b28-8bb4-5515c780948c' })
  @IsString()
  householdId: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  isFavorite: boolean;
}
