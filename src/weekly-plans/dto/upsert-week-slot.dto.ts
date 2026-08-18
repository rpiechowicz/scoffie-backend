import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

const dayOfWeek = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const mealType = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;

export class UpsertWeekSlotDto {
  @ApiProperty({ enum: dayOfWeek })
  @IsIn(dayOfWeek)
  dayOfWeek: (typeof dayOfWeek)[number];

  @ApiProperty({ enum: mealType })
  @IsIn(mealType)
  mealType: (typeof mealType)[number];

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  recipeId: string;

  /**
   * Household members this meal is for. Omitted or empty means "everyone" —
   * the app renders that as „Wspólne". Listing a subset is what makes a slot
   * a split ("Ania eats a salad, Marek a schnitzel").
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      'Household member user ids this meal is for. Empty or omitted = everyone.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsUUID(undefined, { each: true })
  participantIds?: string[];
}
