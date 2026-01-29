import { ApiProperty } from '@nestjs/swagger';

export class WeeklyPlanDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  householdId: string;

  @ApiProperty()
  weekStart: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
