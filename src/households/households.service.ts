import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';

@Injectable()
export class HouseholdsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.household.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findById(id: string) {
    const household = await this.prisma.household.findUnique({ where: { id } });
    if (!household) {
      throw new NotFoundException('Household not found');
    }
    return household;
  }

  async create(dto: CreateHouseholdDto) {
    const household = await this.prisma.household.create({
      data: {
        name: dto.name,
        createdById: dto.createdById ?? null,
      },
    });

    if (dto.createdById) {
      await this.prisma.membership.create({
        data: {
          userId: dto.createdById,
          householdId: household.id,
          role: 'OWNER',
        },
      });
    }

    return household;
  }

  async createInvitation(householdId: string, dto: CreateInvitationDto, createdById?: string) {
    const token = randomBytes(16).toString('hex');
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : new Date(Date.now() + 7 * 86400000);

    return this.prisma.invitation.create({
      data: {
        token,
        householdId,
        createdById: createdById ?? null,
        expiresAt,
      },
    });
  }

  async acceptInvitation(dto: AcceptInvitationDto) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.token },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.redeemedAt) {
      throw new BadRequestException('Invitation already redeemed');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invitation expired');
    }

    const membership = await this.prisma.membership.upsert({
      where: {
        userId_householdId: {
          userId: dto.userId,
          householdId: invitation.householdId,
        },
      },
      update: {},
      create: {
        userId: dto.userId,
        householdId: invitation.householdId,
        role: 'MEMBER',
      },
    });

    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        redeemedAt: new Date(),
        redeemedById: dto.userId,
      },
    });

    return membership;
  }
}
