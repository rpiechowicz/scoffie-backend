import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { UpdateHouseholdDto } from './dto/update-household.dto';
import { UpdateHouseholdMealTypesDto } from './dto/update-meal-types.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { normalizeEnabledMealTypes } from '../common/meal-types';

@Injectable()
export class HouseholdsService {
  constructor(private readonly prisma: PrismaService) {}

  private invitationStatusFrom(invitation: {
    expiresAt: Date;
    redeemedAt: Date | null;
  }) {
    if (invitation.redeemedAt) return 'REDEEMED' as const;
    if (invitation.expiresAt.getTime() < Date.now()) return 'EXPIRED' as const;
    return 'PENDING' as const;
  }

  private async getHouseholdOrThrow(householdId: string) {
    const household = await this.prisma.household.findUnique({
      where: { id: householdId },
    });
    if (!household) {
      throw new NotFoundException('Household not found');
    }
    return household;
  }

  private async ensureMembership(userId: string, householdId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this household');
    }
    return membership;
  }

  private async ensureOwner(userId: string, householdId: string) {
    const membership = await this.ensureMembership(userId, householdId);
    if (membership.role !== 'OWNER') {
      throw new ForbiddenException('Only owners can manage household members');
    }
    return membership;
  }

  private async countOwners(householdId: string) {
    return this.prisma.membership.count({
      where: {
        householdId,
        role: 'OWNER',
      },
    });
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
    const household = await this.getHouseholdOrThrow(id);
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
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + 7 * 86400000);

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
      throw new AppException(
        'INVITATION_ALREADY_REDEEMED',
        'Invitation already redeemed',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new AppException(
        'INVITATION_EXPIRED',
        'Invitation expired',
        HttpStatus.BAD_REQUEST,
      );
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

  async previewInvitation(userId: string, dto: AcceptInvitationDto) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.token },
      include: {
        household: {
          select: {
            id: true,
            name: true,
          },
        },
        createdBy: {
          select: {
            displayName: true,
          },
        },
      },
    });

    if (!invitation) {
      return {
        token: dto.token,
        status: 'NOT_FOUND',
        household: null,
        invitedByDisplayName: null,
        expiresAt: null,
      };
    }

    const existingMembership = await this.prisma.membership.findUnique({
      where: {
        userId_householdId: {
          userId,
          householdId: invitation.householdId,
        },
      },
    });

    const baseStatus = this.invitationStatusFrom(invitation);
    const status = existingMembership ? 'ALREADY_MEMBER' : baseStatus;

    return {
      token: invitation.token,
      status,
      household: invitation.household,
      invitedByDisplayName: invitation.createdBy?.displayName ?? null,
      expiresAt: invitation.expiresAt,
    };
  }

  async updateName(
    userId: string,
    householdId: string,
    dto: UpdateHouseholdDto,
  ) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureOwner(userId, householdId);
    return this.prisma.household.update({
      where: { id: householdId },
      data: { name: dto.name },
    });
  }

  /**
   * Ustawia sloty posiłków, które gospodarstwo planuje.
   *
   * Świadomie `ensureMembership`, a nie `ensureOwner` jak przy zmianie nazwy:
   * to, czy w domu jada się podwieczorek, nie jest decyzją administracyjną —
   * a wymóg właściciela oznaczałby, że współlokator nie może dołożyć sobie
   * drugiego śniadania.
   *
   * Wyłączenie slotu **nie kasuje** zaplanowanych w nim posiłków. Ukrycie to
   * nie to samo co usunięcie: ktoś może wyłączyć podwieczorek na tydzień
   * urlopu i wrócić do swojego planu. Klient dodatkowo pokazuje wyłączony
   * slot, dopóki coś w nim stoi, więc dane nigdy nie znikają z oczu po cichu.
   */
  async updateMealTypes(
    userId: string,
    householdId: string,
    dto: UpdateHouseholdMealTypesDto,
  ) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureMembership(userId, householdId);

    const enabledMealTypes = normalizeEnabledMealTypes(dto.mealTypes);

    return this.prisma.household.update({
      where: { id: householdId },
      data: { enabledMealTypes },
    });
  }

  async listMembers(userId: string, householdId: string) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureMembership(userId, householdId);
    return this.prisma.membership.findMany({
      where: { householdId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            avatarUrl: true,
            // Kolor awatara jedzie razem z domownikiem, zeby ta sama osoba
            // wygladala tak samo w Ustawieniach i w Planie. Bez tego klient
            // kolorowal awatary domownikow po pozycji na liscie i jeden
            // uzytkownik mial dwa rozne kolory na dwoch ekranach.
            avatarColor: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  async updateMemberRole(
    userId: string,
    householdId: string,
    memberUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureOwner(userId, householdId);

    const targetMembership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId: memberUserId, householdId } },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found in this household');
    }

    if (targetMembership.role === dto.role) {
      return targetMembership;
    }

    if (targetMembership.role === 'OWNER' && dto.role !== 'OWNER') {
      const ownerCount = await this.countOwners(householdId);
      if (ownerCount <= 1) {
        throw new BadRequestException('Household must have at least one owner');
      }
    }

    return this.prisma.membership.update({
      where: { userId_householdId: { userId: memberUserId, householdId } },
      data: { role: dto.role },
    });
  }

  async removeMember(
    userId: string,
    householdId: string,
    memberUserId: string,
  ) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureOwner(userId, householdId);

    const targetMembership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId: memberUserId, householdId } },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found in this household');
    }

    if (targetMembership.role === 'OWNER') {
      const ownerCount = await this.countOwners(householdId);
      if (ownerCount <= 1) {
        throw new BadRequestException(
          'Cannot remove the last owner from household',
        );
      }
    }

    return this.prisma.membership.delete({
      where: { userId_householdId: { userId: memberUserId, householdId } },
    });
  }

  async leave(userId: string, householdId: string) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureMembership(userId, householdId);

    await this.prisma.membership.delete({
      where: { userId_householdId: { userId, householdId } },
    });

    return { success: true };
  }

  async getUserDisplayName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    return user?.displayName ?? 'Domownik';
  }
}
