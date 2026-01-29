import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { PlanItemDto } from './dto/plan-item.dto';
import { WeeklyPlanDto } from './dto/weekly-plan.dto';
import { WeeklyPlansService } from './weekly-plans.service';

@ApiTags('weekly-plans')
@Controller('weekly-plans')
export class WeeklyPlansController {
  constructor(private readonly weeklyPlansService: WeeklyPlansService) {}

  @Get('household/:householdId')
  @ApiOkResponse({ type: [WeeklyPlanDto] })
  listByHousehold(@Param('householdId') householdId: string) {
    return this.weeklyPlansService.listByHousehold(householdId);
  }

  @Get('household/:householdId/one')
  @ApiOkResponse({ type: WeeklyPlanDto })
  getByWeek(
    @Param('householdId') householdId: string,
    @Query('weekStart') weekStart: string,
  ) {
    return this.weeklyPlansService.getByHouseholdAndWeek(householdId, weekStart);
  }

  @Post('household/:householdId')
  @ApiCreatedResponse({ type: WeeklyPlanDto })
  create(@Param('householdId') householdId: string, @Body() dto: CreateWeeklyPlanDto) {
    return this.weeklyPlansService.create(householdId, dto);
  }

  @Post(':weeklyPlanId/items')
  @ApiCreatedResponse({ type: PlanItemDto })
  addItem(@Param('weeklyPlanId') weeklyPlanId: string, @Body() dto: CreatePlanItemDto) {
    return this.weeklyPlansService.addItem(weeklyPlanId, dto);
  }

  @Delete('items/:itemId')
  @ApiOkResponse({ schema: { example: { deleted: true } } })
  async removeItem(@Param('itemId') itemId: string) {
    await this.weeklyPlansService.removeItem(itemId);
    return { deleted: true };
  }
}
