import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

  /**
   * Pory posiłków: mapa slot → minuty od północy. `null` znaczy „gospodarstwo
   * nie ruszało godzin" i klient bierze wtedy swoje domyślne; brak klucza
   * znaczy „ten posiłek nie ma stałej pory".
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
    nullable: true,
    example: { BREAKFAST: 480, LUNCH: 840, DINNER: 1200 },
  })
  mealSlotTimes?: Record<string, number> | null;

  @ApiProperty({ required: false, nullable: true })
  createdById?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
