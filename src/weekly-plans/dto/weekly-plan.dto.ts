import { ApiProperty } from '@nestjs/swagger';
import { PlanItemDto } from './plan-item.dto';

/**
 * Odpowiedź `weeklyPlans:getByWeek`. Tydzień bez ani jednego posiłku też ma
 * ten kształt (z pustym `items`) — od Fazy 0 odczyt zakłada pusty wiersz
 * zamiast odpowiadać 404, patrz `WeeklyPlansService.getByHouseholdAndWeek`.
 */
export class WeeklyPlanDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  householdId: string;

  /**
   * Poniedziałek tygodnia jako `YYYY-MM-DD` — ten sam format, który klient
   * wysyła w kopercie i który niosą broadcasty `weeklyPlans:weekChanged`.
   * Dawniej szedł tu pełny ISO datetime z Prismy, więc jeden tydzień miał
   * dwie reprezentacje na drucie.
   */
  @ApiProperty({
    example: '2026-08-31',
    description: 'Poniedziałek, YYYY-MM-DD',
  })
  weekStart: string;

  @ApiProperty({ type: [PlanItemDto] })
  items: PlanItemDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
