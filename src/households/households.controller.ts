import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { HouseholdDto } from './dto/household.dto';
import { HouseholdsService } from './households.service';

@ApiTags('households')
@Controller('households')
@UseGuards(JwtAuthGuard)
export class HouseholdsController {
  constructor(private readonly householdsService: HouseholdsService) {}

  @Get()
  @ApiOkResponse({ type: [HouseholdDto] })
  findAll(@Req() req: any) {
    return this.householdsService.findAll(req.user.id);
  }

  @Get(':id')
  @ApiOkResponse({ type: HouseholdDto })
  findById(@Req() req: any, @Param('id') id: string) {
    return this.householdsService.findById(req.user.id, id);
  }

  @Post()
  @ApiCreatedResponse({ type: HouseholdDto })
  create(@Req() req: any, @Body() dto: CreateHouseholdDto) {
    return this.householdsService.create(req.user.id, dto);
  }

  @Post(':id/invitations')
  @ApiCreatedResponse({
    schema: {
      example: {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        token: 'invite-token',
        expiresAt: '2026-12-31T23:59:59.000Z',
      },
    },
  })
  createInvitation(@Req() req: any, @Param('id') householdId: string, @Body() dto: CreateInvitationDto) {
    return this.householdsService.createInvitation(req.user.id, householdId, dto);
  }

  @Post('invitations/accept')
  @ApiCreatedResponse({
    schema: {
      example: {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        userId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        householdId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        role: 'MEMBER',
      },
    },
  })
  acceptInvitation(@Req() req: any, @Body() dto: AcceptInvitationDto) {
    return this.householdsService.acceptInvitation(req.user.id, dto);
  }
}
