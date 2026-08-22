import { ApiProperty } from '@nestjs/swagger';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';

export class HouseholdDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  /**
   * Sloty posiłków, które to gospodarstwo planuje. Zawsze zawiera
   * śniadanie / obiad / kolację i jest posortowana porą dnia.
   */
  @ApiProperty({
    enum: MEAL_TYPE_VALUES,
    isArray: true,
    example: ['BREAKFAST', 'LUNCH', 'DINNER'],
  })
  enabledMealTypes: string[];

  @ApiProperty({ required: false, nullable: true })
  createdById?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
