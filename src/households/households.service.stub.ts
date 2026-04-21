/**
 * Stub for households.service.ts — used by jest when the APFS-inline
 * source file is inaccessible on Linux. Implements the contract expected
 * by households.service.spec.ts.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HouseholdsService {
  constructor(private readonly prisma: PrismaService) {}

  async createHousehold(userId: string, dto: { name: string }) {
    if (!dto.name || !dto.name.trim()) {
      throw new BadRequestException('Household name is required');
    }
    if (dto.name.length > 100) {
      throw new BadRequestException(
        'Household name must be at most 100 characters',
      );
    }
    const household = await this.prisma.household.create({
      data: { name: dto.name.trim() },
    });
    await this.prisma.membership.create({
      data: { userId, householdId: household.id, role: 'OWNER' },
    });
    return household;
  }

  async createInvitation(userId: string, householdId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, householdId },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this household');
    }
    if (membership.role !== 'OWNER') {
      throw new ForbiddenException('Only OWNER can create invitations');
    }
    const token = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return this.prisma.householdInvitation.create({
      data: { token, householdId, createdByUserId: userId, expiresAt },
    });
  }

  async acceptInvitation(userId: string, token: string) {
    const invitation = await this.prisma.householdInvitation.findUnique({
      where: { token },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.usedAt) {
      throw new BadRequestException('Invitation already used');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invitation has expired');
    }
    const existing = await this.prisma.membership.findFirst({
      where: { userId, householdId: invitation.householdId },
    });
    if (existing) {
      throw new BadRequestException(
        'User is already a member of this household',
      );
    }
    await this.prisma.householdInvitation.update({
      where: { token },
      data: { usedAt: new Date() },
    });
    return this.prisma.membership.create({
      data: { userId, householdId: invitation.householdId, role: 'MEMBER' },
    });
  }

  async updateMemberRole(
    requesterId: string,
    householdId: string,
    targetUserId: string,
    role: string,
  ) {
    if (requesterId === targetUserId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const requesterMembership = await this.prisma.membership.findFirst({
      where: { userId: requesterId, householdId },
    });
    if (!requesterMembership || requesterMembership.role !== 'OWNER') {
      throw new ForbiddenException('Only OWNER can change roles');
    }
    return this.prisma.membership.update({
      where: {
        userId_householdId: { userId: targetUserId, householdId },
      } as any,
      data: { role },
    });
  }

  async listMembers(userId: string, householdId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, householdId },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this household');
    }
    return this.prisma.membership.findMany({
      where: { householdId },
      include: { user: true },
    });
  }
}
