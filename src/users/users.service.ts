import { Injectable } from '@nestjs/common';
import { DietPreferenceValue, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

const CALORIE_GOAL_MIN = 1200;
const CALORIE_GOAL_MAX = 3500;
const CALORIE_GOAL_DEFAULT = 2000;

export interface UserPreferencesPayload {
  dietPreference: DietPreferenceValue;
  calorieGoal: number;
  allergens: string[];
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
      return {
        dietPreference: existing.dietPreference,
        calorieGoal: existing.calorieGoal,
        allergens: existing.allergens ?? [],
      };
    }

    const created = await this.prisma.userPreference.create({
      data: { userId },
    });

    return {
      dietPreference: created.dietPreference,
      calorieGoal: created.calorieGoal,
      allergens: created.allergens ?? [],
    };
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

    const result = await this.prisma.userPreference.upsert({
      where: { userId },
      update,
      create,
    });

    return {
      dietPreference: result.dietPreference,
      calorieGoal: result.calorieGoal,
      allergens: result.allergens ?? [],
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
  };
}
