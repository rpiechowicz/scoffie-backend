import { Injectable, NotFoundException } from '@nestjs/common';
import { DietPreferenceValue, Prisma, Sex, UserGoal } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { settleHouseholdAfterMemberLeft } from '../households/household-cleanup.util';
import {
  effectiveAvatarColor,
  pickFreeAvatarColor,
} from '../common/avatar-color.util';

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
  // `null` = uzytkownik nie nadpisal makra i klient ma je policzyc sam.
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  // Kanaly powiadomien push. Zyja tutaj, a nie w osobnym module, bo klient
  // synchronizuje je tym samym `users:preferences:update`, ktorym wysyla
  // diete i cel kaloryczny — jeden round-trip zamiast dwoch.
  pushPlanChanges: boolean;
  pushShoppingList: boolean;
  pushHousehold: boolean;
  pushQuietHours: boolean;
  timeZone: string | null;
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
  avatarColor: number | null;
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
      select: { onboardingCompletedAt: true, avatarColor: true },
    });

    if (!existing) {
      throw new NotFoundException('User not found');
    }

    if (existing.onboardingCompletedAt) {
      // Konta sprzed wprowadzenia `avatarColor` skończyły onboarding, zanim
      // kolory istniały — uzupełniamy przydział przy pierwszej okazji,
      // inaczej taki użytkownik na zawsze zostaje na fallbacku z hasza.
      if (existing.avatarColor === null) {
        const user = await this.prisma.user.update({
          where: { id: userId },
          data: { avatarColor: await this.pickAvatarColor(userId) },
        });
        return this.toProfilePayload(user);
      }
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      return this.toProfilePayload(user);
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        onboardingCompletedAt: new Date(),
        avatarColor: await this.pickAvatarColor(userId),
      },
    });

    return this.toProfilePayload(user);
  }

  /**
   * Przydziela indeks gradientu awatara raz, przy kończeniu onboardingu.
   *
   * Kolor mozna by policzyc z hasza adresu e-mail na kliencie i przez chwile
   * tak dzialalo — ale taki przydzial nie widzi reszty gospodarstwa i dwoje
   * domownikow potrafi wylosowac ten sam odcien. A awatary domownikow ogląda
   * sie obok siebie, wiec akurat tam kolizja boli najbardziej.
   *
   * Bierzemy wiec pierwszy kolor nieuzywany przez pozostalych czlonkow
   * gospodarstwa. Konta bez przydzialu liczymy po kolorze, ktorym FAKTYCZNIE
   * swieca na ekranie (fallback z hasza id) — inaczej nowy domownik potrafil
   * dostac indeks identyczny z odcieniem starego konta. Gdy wszystkie sa
   * zajete (gospodarstwo wieksze niz paleta), schodzimy do hasza z id —
   * powtorka jest wtedy nieunikniona, ale nadal deterministyczna.
   */
  private async pickAvatarColor(userId: string): Promise<number> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { householdId: true },
    });

    const householdIds = memberships.map((m) => m.householdId);

    const housemates = householdIds.length
      ? await this.prisma.user.findMany({
          where: {
            id: { not: userId },
            memberships: { some: { householdId: { in: householdIds } } },
          },
          select: { id: true, avatarColor: true },
        })
      : [];

    const taken = new Set(housemates.map(effectiveAvatarColor));

    return pickFreeAvatarColor(taken, userId);
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
    avatarColor: number | null;
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
      avatarColor: user.avatarColor,
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

    // Makra przechodza jak sa, lacznie z `null` — to jest sygnal „wroc do
    // liczenia automatem", a nie brak wartosci.
    if (data.proteinG !== undefined) {
      update.proteinG = data.proteinG;
      create.proteinG = data.proteinG;
    }
    if (data.fatG !== undefined) {
      update.fatG = data.fatG;
      create.fatG = data.fatG;
    }
    if (data.carbsG !== undefined) {
      update.carbsG = data.carbsG;
      create.carbsG = data.carbsG;
    }

    if (data.pushPlanChanges !== undefined) {
      update.pushPlanChanges = data.pushPlanChanges;
      create.pushPlanChanges = data.pushPlanChanges;
    }
    if (data.pushShoppingList !== undefined) {
      update.pushShoppingList = data.pushShoppingList;
      create.pushShoppingList = data.pushShoppingList;
    }
    if (data.pushHousehold !== undefined) {
      update.pushHousehold = data.pushHousehold;
      create.pushHousehold = data.pushHousehold;
    }
    if (data.pushQuietHours !== undefined) {
      update.pushQuietHours = data.pushQuietHours;
      create.pushQuietHours = data.pushQuietHours;
    }
    if (data.timeZone !== undefined) {
      // Pusty string traktujemy jak `null` — klient bez ustawionej strefy nie
      // ma nadpisywac tej, ktora juz w bazie jest, wartoscia bez znaczenia.
      //
      // Przyciecie dlugosci jest tu, a nie tylko w `@MaxLength` na DTO, bo
      // preferencje jada takze WebSocketem, a tamta sciezka nie uruchamia
      // walidacji zagniezdzonego `data` (patrz `weekly-plans.gateway.ts`).
      // Najdluzszy realny identyfikator IANA ma ~32 znaki.
      const normalised = data.timeZone?.trim().slice(0, 64) || null;
      update.timeZone = normalised;
      create.timeZone = normalised;
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
    proteinG: number | null;
    fatG: number | null;
    carbsG: number | null;
    pushPlanChanges: boolean;
    pushShoppingList: boolean;
    pushHousehold: boolean;
    pushQuietHours: boolean;
    timeZone: string | null;
  }): UserPreferencesPayload {
    return {
      dietPreference: row.dietPreference,
      calorieGoal: row.calorieGoal,
      allergens: row.allergens ?? [],
      goal: row.goal,
      activityLevel: row.activityLevel,
      proteinG: row.proteinG,
      fatG: row.fatG,
      carbsG: row.carbsG,
      pushPlanChanges: row.pushPlanChanges,
      pushShoppingList: row.pushShoppingList,
      pushHousehold: row.pushHousehold,
      pushQuietHours: row.pushQuietHours,
      timeZone: row.timeZone,
    };
  }

  /**
   * Trwale usun konto uzytkownika.
   *
   * Kolejnosc ma znaczenie i jest podyktowana tym, co dzieje sie ze
   * wspoldzielonym gospodarstwem:
   *
   * 1. Gospodarstwo, w ktorym uzytkownik jest OSTATNIM czlonkiem, ginie
   *    razem z nim — nie ma komu zostawic planow ani listy zakupow, a
   *    osierocony rekord i tak bylby nieosiagalny.
   * 2. Gospodarstwo z innymi czlonkami zostaje. Jesli odchodzacy jest w nim
   *    jedynym OWNEREM, awansujemy najstarszego stazem czlonka — inaczej
   *    reszta domownikow zostalaby z gospodarstwem, ktorego nikt nie moze
   *    juz administrowac.
   * 3. Dopiero potem kasujemy uzytkownika. Reszta (preferencje, tokeny,
   *    urzadzenia push, uczestnictwa w planach, odhaczone posilki) leci
   *    kaskada z bazy.
   *
   * Calosc w jednej transakcji, zeby nieudany krok nie zostawil konta
   * w polowicznie rozebranym stanie.
   */
  async deleteAccount(userId: string): Promise<{ id: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.$transaction(async (tx) => {
      const memberships = await tx.membership.findMany({
        where: { userId },
        select: { householdId: true, role: true },
      });

      // Kasujemy czlonkostwa jawnie, zanim `settleHouseholdAfterMemberLeft`
      // policzy, kto zostal. Kaskada z usuniecia uzytkownika zrobilaby to
      // dopiero po, wiec kazdy dom wygladalby na wciaz zamieszkany.
      for (const membership of memberships) {
        await tx.membership.delete({
          where: {
            userId_householdId: { userId, householdId: membership.householdId },
          },
        });
        // Ta sama regula co przy wyjsciu z gospodarstwa — jedna definicja
        // zamiast dwoch kopii, ktore juz raz sie rozjechaly (wyjscie nie
        // kasowalo pustych domow, kasowanie konta kasowalo).
        await settleHouseholdAfterMemberLeft(tx, membership.householdId);
      }

      await tx.user.delete({ where: { id: userId } });
    });

    return { id: userId };
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
