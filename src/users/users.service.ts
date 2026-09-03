import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { DietPreferenceValue, Prisma, Sex, UserGoal } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { normalizeAllergenIds } from '../common/allergens';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentsService } from '../consents/consents.service';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { settleHouseholdAfterMemberLeft } from '../households/household-cleanup.util';
import {
  catalogOwnerUserId,
  ensureCatalogOwner,
} from '../common/catalog-owner';
import { onMemberLeft } from '../weekly-plans/utils/plan-roster.util';
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
// Gorne granice makr. Te same liczby stoja w `@Min/@Max` DTO
// (`update-preferences.dto.ts`) i od Fazy 0 to DTO odrzuca wartosci spoza
// zakresu (`validateDto` na wejsciu). Przyciecie zostaje jako druga linia —
// wywolania in-process (narzedzia asystenta) moga kiedys ominac DTO.
const PROTEIN_G_MAX = 400;
const FAT_G_MAX = 300;
const CARBS_G_MAX = 800;

/**
 * `null` zostaje `null` — to sygnal „wroc do liczenia automatem". Liczba jest
 * zaokraglana i przycinana do 0..max, jak `calorieGoal` (suwak nie jest w
 * stanie dac wartosci spoza zakresu, wiec taka liczba to blad, nie intencja).
 * Cokolwiek innego (string, NaN, Infinity — WebSocket przepusci wszystko)
 * jest bledem klienta, nie wartoscia do zapisania.
 */
function clampMacro(
  value: number | null,
  max: number,
  field: 'proteinG' | 'fatG' | 'carbsG',
): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppException(
      'VALIDATION_ERROR',
      `${field} musi byc liczba calkowita 0..${max} albo null`,
      HttpStatus.BAD_REQUEST,
      [field],
    );
  }
  return Math.min(Math.max(Math.round(value), 0), max);
}

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
  constructor(
    private readonly prisma: PrismaService,
    // Opcjonalnie: dziennik zgód (testy jednostkowe budują serwis bez niego).
    @Optional() private readonly consents?: ConsentsService,
  ) {}

  /**
   * Pierwsze podanie danych o zdrowiu (alergeny, sylwetka) = wyraźna zgoda
   * z art. 9 ust. 2 lit. a. Zapis do dziennika tylko raz — dopóki zgoda
   * jest ważna, kolejne edycje nic nie dopisują.
   */
  private async recordHealthConsentOnce(userId: string, source: string) {
    if (!this.consents) return;
    if (await this.consents.hasValid(userId, 'HEALTH_DATA')) return;
    await this.consents.recordSystem(userId, 'HEALTH_DATA', 'GRANTED', source);
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
   *
   * `validateDto` na wejściu: WebSocket nie uruchamia dekoratorów DTO, a
   * narzędzia asystenta wołają tę metodę bezpośrednio — bez tej linii 835 kg
   * albo `sex: 'X'` szłyby do Prismy i wracały jako 500.
   */
  async updateProfile(
    userId: string,
    input: UpdateProfileDto,
  ): Promise<UserProfilePayload> {
    const data = await validateDto(UpdateProfileDto, input);
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

    if (
      data.heightCm != null ||
      data.weightKg != null ||
      data.sex != null ||
      data.yearOfBirth != null
    ) {
      await this.recordHealthConsentOnce(userId, 'PROFILE_BODY_METRICS');
    }

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
      throw new AppException(
        'NOT_FOUND',
        'Nie znaleziono użytkownika.',
        HttpStatus.NOT_FOUND,
      );
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
   * Preferencje wielu użytkowników naraz (unia alergenów domowników przy
   * ocenie przepisu / propozycji planu). Użytkownik bez wiersza NIE jest
   * w mapie — wołający traktuje go jak domyślne preferencje; nie tworzymy
   * wierszy „przy okazji", żeby odczyt nie pisał do bazy.
   */
  async getPreferencesForUsers(
    userIds: readonly string[],
  ): Promise<Map<string, UserPreferencesPayload>> {
    const unique = Array.from(new Set(userIds.filter(Boolean)));
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.userPreference.findMany({
      where: { userId: { in: unique } },
    });
    return new Map(
      rows.map((row) => [row.userId, this.toPreferencesPayload(row)]),
    );
  }

  /**
   * Upsert the preferences row with whatever fields the client sent.
   * Allergens are de-duplicated and lowercased server-side so the storage
   * format matches the iOS enum's raw values regardless of how the client
   * normalises them.
   *
   * `validateDto` na wejściu jest JEDYNYM miejscem, w którym dekoratory DTO
   * faktycznie się uruchamiają dla WebSocketu i wywołań in-process: zły enum
   * (`dietPreference: 'vegan'`), `pushPlanChanges: 'true'`, `calorieGoal:
   * 'abc'` kończą się VALIDATION_ERROR z listą dozwolonych ZANIM cokolwiek
   * dotknie Prismy. Klamry niżej zostają jako druga linia obrony.
   */
  async updatePreferences(
    userId: string,
    input: UpdatePreferencesDto,
  ): Promise<UserPreferencesPayload> {
    const data = await validateDto(UpdatePreferencesDto, input);
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
      // Biala lista z `common/allergens.ts`; nieznane id to VALIDATION_ERROR
      // calego zapisu, nie ciche wyrzucenie — po cichu wyrzucony alergen to
      // uzytkownik, ktory mysli, ze jest chroniony.
      const normalised = normalizeAllergenIds(data.allergens);
      update.allergens = normalised;
      create.allergens = normalised;
      if (normalised.length > 0) {
        await this.recordHealthConsentOnce(userId, 'PREFERENCES_ALLERGENS');
      }
    }

    if (data.excludedIngredientIds !== undefined) {
      // Bez deduplikacji ta sama pieczarka wpisana dwa razy przez asystenta
      // i przez ustawienia dawałaby dwa wiersze w kontekście modelu.
      update.excludedIngredientIds = Array.from(
        new Set(data.excludedIngredientIds),
      );
      create.excludedIngredientIds = update.excludedIngredientIds;
    }

    if (data.maxPrepTimeMinutes !== undefined) {
      update.maxPrepTimeMinutes = data.maxPrepTimeMinutes;
      create.maxPrepTimeMinutes = data.maxPrepTimeMinutes ?? undefined;
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

    // `null` przechodzi nietkniete — to jest sygnal „wroc do liczenia
    // automatem", a nie brak wartosci. Liczby przycinamy jak `calorieGoal`
    // (druga linia za `@Min/@Max` w DTO, patrz `validateDto` wyzej).
    if (data.proteinG !== undefined) {
      const value = clampMacro(data.proteinG, PROTEIN_G_MAX, 'proteinG');
      update.proteinG = value;
      create.proteinG = value;
    }
    if (data.fatG !== undefined) {
      const value = clampMacro(data.fatG, FAT_G_MAX, 'fatG');
      update.fatG = value;
      create.fatG = value;
    }
    if (data.carbsG !== undefined) {
      const value = clampMacro(data.carbsG, CARBS_G_MAX, 'carbsG');
      update.carbsG = value;
      create.carbsG = value;
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
      // Przyciecie dlugosci zostaje obok `@MaxLength(64)` z DTO jako druga
      // linia (wywolania in-process). Najdluzszy realny identyfikator IANA
      // ma ~32 znaki.
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
      throw new AppException(
        'NOT_FOUND',
        'Nie znaleziono użytkownika.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Bot importu to autor całego katalogu, a `Recipe.author` kasuje
    // kaskadą — skasowanie tego konta zabrałoby katalog wszystkim.
    if (userId === catalogOwnerUserId()) {
      throw new AppException(
        'FORBIDDEN',
        'Tego konta nie można usunąć — jest właścicielem wspólnego katalogu.',
        HttpStatus.FORBIDDEN,
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Przepisy autorstwa tej osoby (z aplikacji albo z ręki asystenta w jej
      // turze) NIE giną z kontem: `Recipe.author` to kaskada, a z przepisem
      // poszłyby pozycje planu, uczestnicy i odhaczenia POZOSTAŁYCH
      // domowników. Przepis gospodarstwa jest wspólny — przechodzi na konto
      // bota importu (nie na innego domownika: nie przypisujemy żywej osobie
      // autorstwa, którego nie miała). Idzie PRZED rozliczeniem domów: dom,
      // który zostanie skasowany jako pusty, i tak zabierze swoje przepisy
      // kaskadą po `householdId`, więc przepięcie niczego nie ratuje na siłę.
      const authored = await tx.recipe.count({ where: { authorId: userId } });
      if (authored > 0) {
        const botId = await ensureCatalogOwner(tx);
        await tx.recipe.updateMany({
          where: { authorId: userId },
          data: { authorId: botId },
        });
      }

      // Poświadczenia Cookidoo podane przez TĘ osobę znikają z jej kontem
      // (polityka §12), nawet gdy dom zostaje — reszta domu połączy się
      // własnym hasłem. `connectedBy` jest SetNull, więc kaskada by ich nie
      // ruszyła.
      await tx.cookidooIntegration.deleteMany({
        where: { connectedById: userId },
      });
      // Księga kosztów i notatki domu zostają (rozliczenia, wspólna pamięć),
      // ale bez identyfikatora osoby — po usunięciu konta nie ma kogo do nich
      // przypiąć.
      await tx.aiUsage.updateMany({
        where: { userId },
        data: { userId: null },
      });
      await tx.agentMemory.updateMany({
        where: { createdByUserId: userId },
        data: { createdByUserId: null },
      });

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
        const settlement = await settleHouseholdAfterMemberLeft(
          tx,
          membership.householdId,
        );
        // Kaskada z `tx.user.delete` niżej zabiera wiersze uczestnictwa, ale
        // ROBI TO PÓŹNIEJ i po cichu: item, na którym ta osoba była jedynym
        // uczestnikiem, awansowałby na „Wspólny", a auto-porcje „Wspólnych"
        // zostałyby policzone dla starego składu. Hook musi pójść PRZED
        // usunięciem użytkownika, dopóki wiersze jeszcze istnieją.
        if (settlement.outcome !== 'DELETED') {
          await onMemberLeft(tx, membership.householdId, userId, now);
        }
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
