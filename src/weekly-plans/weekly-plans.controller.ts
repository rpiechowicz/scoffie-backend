import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { PlanItemDto } from './dto/plan-item.dto';
import { WeeklyPlanDto } from './dto/weekly-plan.dto';
import { WeeklyPlansService } from './weekly-plans.service';

@ApiTags('weekly-plans')
@Controller('weekly-plans')
@UseGuards(JwtAuthGuard)
export class WeeklyPlansController {
  constructor(private readonly weeklyPlansService: WeeklyPlansService) {}

  @Get('household/:householdId')
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          householdId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          weekStart: '2026-02-02T00:00:00.000Z',
          items: [
            {
              id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
              recipeId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
              dayOfWeek: 'MON',
              mealType: 'DINNER',
              recipe: {
                id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
                title: 'Pasta with tomatoes',
                description: 'Simple pasta with tomato sauce and basil.',
                authorId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
                householdId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
                createdAt: '2026-02-02T00:00:00.000Z',
                updatedAt: '2026-02-02T00:00:00.000Z',
              },
            },
          ],
        },
      ],
    },
  })
  listByHousehold(@Req() req: any, @Param('householdId') householdId: string) {
    return this.weeklyPlansService.listByHousehold(req.user.id, householdId);
  }

  @Get('household/:householdId/one')
  @ApiOkResponse({
    schema: {
      example: {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        householdId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        weekStart: '2026-02-02T00:00:00.000Z',
        items: [
          {
            id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
            recipeId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            recipe: {
              id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
              title: 'Pasta with tomatoes',
              description: 'Simple pasta with tomato sauce and basil.',
              authorId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
              householdId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
              createdAt: '2026-02-02T00:00:00.000Z',
              updatedAt: '2026-02-02T00:00:00.000Z',
            },
          },
        ],
      },
    },
  })
  getByWeek(
    @Req() req: any,
    @Param('householdId') householdId: string,
    @Query('weekStart') weekStart: string,
  ) {
    return this.weeklyPlansService.getByHouseholdAndWeek(req.user.id, householdId, weekStart);
  }

  @Post('household/:householdId')
  @ApiCreatedResponse({ type: WeeklyPlanDto })
  create(
    @Req() req: any,
    @Param('householdId') householdId: string,
    @Body() dto: CreateWeeklyPlanDto,
  ) {
    return this.weeklyPlansService.create(req.user.id, householdId, dto);
  }

  @Post(':weeklyPlanId/items')
  @ApiCreatedResponse({ type: PlanItemDto })
  addItem(
    @Req() req: any,
    @Param('weeklyPlanId') weeklyPlanId: string,
    @Body() dto: CreatePlanItemDto,
  ) {
    return this.weeklyPlansService.addItem(req.user.id, weeklyPlanId, dto);
  }

  @Delete('items/:itemId')
  @ApiOkResponse({ schema: { example: { deleted: true } } })
  async removeItem(@Req() req: any, @Param('itemId') itemId: string) {
    await this.weeklyPlansService.removeItem(req.user.id, itemId);
    return { deleted: true };
  }
}
