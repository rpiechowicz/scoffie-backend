import { Injectable, NotFoundException } from '@nestjs/common';
import { DietPreferenceValue, Prisma, Sex, UserGoal } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

const CALORIE_GOAL_MIN = 1200;
const CALORIE_GOAL_MAX = 3500;
const CALORIE_GOAL_DEFAULT = 2000;
const ACTIVITY_LEVEL_MIN = 1;
const ACTIVITY_LEVEL_MAX = 4;
const ACTIVITY_LEVEL_DEFAULT = 2;

export interface UserPreferencesPayload {
  dietPreference: DietPreferenceValue;
  calorieGoal: number;
  allergens: string[];
  goal: UserGoal;
  activityLevel: number;
}

export interface UserProfilePayload {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  yearOfBirth: number | null;
  heightCm: number | null;
  weightKg: number | null;
  sex: Sex | null;
  onboardingCompletedAt: Date | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  create(data: CreateUserDto) {
    return this.prisma.user.create({ data });
  }

  getMe(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            household: true,
          },
        },
      },
    });
  }

  /**
   * Update the supplied profile fields (displayName, yearOfBirth, height,
   * weight). Used by the welcome flow's Profile step and Settings. Omitted
   * fields are left intact.
   */
  async updateProfile(
    userId: string,
    data: UpdateProfileDto,
  ): Promise<UserProfilePayload> {
    const update: Prisma.UserUpdateInput = {};

    if (data.displayName !== undefined) {
      const trimmed = data.displayName.trim();
      if (trimmed.length > 0) {
        update.displayName = trimmed;
      }
    }
    if (data.yearOfBirth !== undefined) {
      update.yearOfBirth = data.yearOfBirth;
    }
    if (data.heightCm !== undefined) {
      update.heightCm = data.heightCm;
    }
    if (data.weightKg !== undefined) {
      update.weightKg = data.weightKg;
    }
    if (data.sex !== undefined) {
      update.sex = data.sex;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: update,
    });

    return this.toProfilePayload(user);
  }

  /**
   * Mark the welcome flow as complete. Idempotent — re-running keeps the
   * original timestamp so we don't accidentally re-trigger first-login UI
   * if the iOS client retries on a flaky network.
   */
  async completeOnboarding(userId: string): Promise<UserProfilePayload> {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { onboardingCompletedAt: true },
    });

    if (!existing) {
      throw new NotFoundException('User not found');
    }

    if (existing.onboardingCompletedAt) {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      return this.toProfilePayload(user);
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { onboardingCompletedAt: new Date() },
    });

    return this.toProfilePayload(user);
  }

  private toProfilePayload(user: {
    id: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    yearOfBirth: number | null;
    heightCm: number | null;
    weightKg: number | null;
    sex: Sex | null;
    onboardingCompletedAt: Date | null;
  }): UserProfilePayload {
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      yearOfBirth: user.yearOfBirth,
      heightCm: user.heightCm,
      weightKg: user.weightKg,
      sex: user.sex,
      onboardingCompletedAt: user.onboardingCompletedAt,
    };
  }

  /**
   * Fetch the user's diet / kcal / allergens row, lazily creating a default
   * one if the row hasn't been initialised yet. Returning a fresh default
   * (instead of null) keeps the iOS client logic simple — every call comes
   * back with a usable preferences object.
   */
  async getPreferences(userId: string): Promise<UserPreferencesPayload> {
    const existing = await this.prisma.userPreference.findUnique({
      where: { userId },
    });

    if (existing) {
      return this.toPreferencesPayload(existing);
    }

    const created = await this.prisma.userPreference.create({
      data: { userId },
    });

    return this.toPreferencesPayload(created);
  }

  /**
   * Upsert the preferences row with whatever fields the client sent.
   * Allergens are de-duplicated and lowercased server-side so the storage
   * format matches the iOS enum's raw values regardless of how the client
   * normalises them.
   */
  async updatePreferences(
    userId: string,
    data: UpdatePreferencesDto,
  ): Promise<UserPreferencesPayload> {
    const update: Prisma.UserPreferenceUpdateInput = {};
    const create: Prisma.UserPreferenceCreateInput = {
      user: { connect: { id: userId } },
    };

    if (data.dietPreference !== undefined) {
      update.dietPreference = data.dietPreference;
      create.dietPreference = data.dietPreference;
    }

    if (data.calorieGoal !== undefined) {
      const clamped = Math.min(
        Math.max(data.calorieGoal, CALORIE_GOAL_MIN),
        CALORIE_GOAL_MAX,
      );
      update.calorieGoal = clamped;
      create.calorieGoal = clamped;
    }

    if (data.allergens !== undefined) {
      const normalised = Array.from(
        new Set(
          data.allergens.map((a) => a.trim().toLowerCase()).filter(Boolean),
        ),
      ).sort();
      update.allergens = normalised;
      create.allergens = normalised;
    }

    if (data.goal !== undefined) {
      update.goal = data.goal;
      create.goal = data.goal;
    }

    if (data.activityLevel !== undefined) {
      const clamped = Math.min(
        Math.max(data.activityLevel, ACTIVITY_LEVEL_MIN),
        ACTIVITY_LEVEL_MAX,
      );
      update.activityLevel = clamped;
      create.activityLevel = clamped;
    }

    const result = await this.prisma.userPreference.upsert({
      where: { userId },
      update,
      create,
    });

    return this.toPreferencesPayload(result);
  }

  private toPreferencesPayload(row: {
    dietPreference: DietPreferenceValue;
    calorieGoal: number;
    allergens: string[] | null;
    goal: UserGoal;
    activityLevel: number;
  }): UserPreferencesPayload {
    return {
      dietPreference: row.dietPreference,
      calorieGoal: row.calorieGoal,
      allergens: row.allergens ?? [],
      goal: row.goal,
      activityLevel: row.activityLevel,
    };
  }

  /**
   * Internal helper that exposes the bounds + default in one place — the
   * gateway / front-end can read these without reaching into private
   * constants.
   */
  static readonly preferencesDefaults = {
    calorieGoalMin: CALORIE_GOAL_MIN,
    calorieGoalMax: CALORIE_GOAL_MAX,
    calorieGoalDefault: CALORIE_GOAL_DEFAULT,
    activityLevelMin: ACTIVITY_LEVEL_MIN,
    activityLevelMax: ACTIVITY_LEVEL_MAX,
    activityLevelDefault: ACTIVITY_LEVEL_DEFAULT,
  };
}
