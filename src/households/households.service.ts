import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';

@Injectable()
export class HouseholdsService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureMembership(userId: string, householdId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this household');
    }
    return membership;
  }

  async findAll(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { householdId: true },
    });
    const householdIds = memberships.map((m) => m.householdId);
    return this.prisma.household.findMany({
      where: { id: { in: householdIds } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const household = await this.prisma.household.findUnique({ where: { id } });
    if (!household) {
      throw new NotFoundException('Household not found');
    }
    await this.ensureMembership(userId, id);
    return household;
  }

  async create(userId: string, dto: CreateHouseholdDto) {
    const household = await this.prisma.household.create({
      data: {
        name: dto.name,
        createdById: userId,
      },
    });

    await this.prisma.membership.create({
      data: {
        userId,
        householdId: household.id,
        role: 'OWNER',
      },
    });

    return household;
  }

  async createInvitation(
    userId: string,
    householdId: string,
    dto: CreateInvitationDto,
  ) {
    const membership = await this.ensureMembership(userId, householdId);
    if (membership.role !== 'OWNER') {
      throw new ForbiddenException('Only owners can create invitations');
    }

    const token = randomBytes(16).toString('hex');
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : new Date(Date.now() + 7 * 86400000);

    return this.prisma.invitation.create({
      data: {
        token,
        householdId,
        createdById: userId,
        expiresAt,
      },
    });
  }

  async acceptInvitation(userId: string, dto: AcceptInvitationDto) {
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
          userId,
          householdId: invitation.householdId,
        },
      },
      update: {},
      create: {
        userId,
        householdId: invitation.householdId,
        role: 'MEMBER',
      },
    });

    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        redeemedAt: new Date(),
        redeemedById: userId,
      },
    });

    return membership;
  }
}
