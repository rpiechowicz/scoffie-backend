import { ConflictException, ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { UpdateShoppingItemCheckDto } from './dto/update-shopping-item-check.dto';
import { UpsertWeekSlotDto } from './dto/upsert-week-slot.dto';
import { RemoveWeekSlotDto } from './dto/remove-week-slot.dto';
import { SaveSharedMealPlanDto } from './dto/save-shared-meal-plan.dto';
import { Prisma } from '@prisma/client';

type ShoppingAccumulator = {
  productKey: string;
  name: string;
  unit: string;
  department: string;
  totalAmount: number;
};

type ShoppingListItem = ShoppingAccumulator & {
  isChecked: boolean;
};

type ShoppingListArchiveSnapshot = {
  archiveId: string;
  weekStart: string;
  weekLabel: string;
  revision: number;
  archivedAt: number;
  isCurrentClosed: boolean;
  items: ShoppingListItem[];
};

type ShoppingListStateDto = {
  items: ShoppingListItem[];
  archives: ShoppingListArchiveSnapshot[];
};

type PrismaReadClient = Prisma.TransactionClient | PrismaService;

enum ShoppingDepartment {
  VEGETABLES = 'Warzywa',
  FRUITS = 'Owoce',
  MEAT = 'Mięso',
  FISH = 'Ryby',
  DAIRY = 'Nabiał',
  BAKERY = 'Piekarnia',
  GRAINS = 'Zboża i makarony',
  CANNED = 'Konserwy',
  SPICES = 'Przyprawy i sosy',
  OILS = 'Olej i tłuszcze',
  ALCOHOLS = 'Alkohole',
  BEVERAGES = 'Napoje',
  SNACKS = 'Przekąski i słodycze',
  FROZEN = 'Mrożonki',
  CONFECTIONERY = 'Cukiernia',
  HOUSEHOLD = 'Chemia i gospodarstwo',
  OTHER = 'Inne',
}

@Injectable()
export class WeeklyPlansService {
  constructor(private readonly prisma: PrismaService) {}
  private static readonly MAX_ITEMS_PER_MEAL_TYPE = 7;
  private static readonly MAX_ITEMS_TOTAL = 21;
  private static readonly DEPARTMENT_OTHER = ShoppingDepartment.OTHER;
  private static readonly DEPARTMENT_ORDER: Record<string, number> = {
    [ShoppingDepartment.VEGETABLES]: 1,
    [ShoppingDepartment.FRUITS]: 2,
    [ShoppingDepartment.MEAT]: 3,
    [ShoppingDepartment.FISH]: 4,
    [ShoppingDepartment.DAIRY]: 5,
    [ShoppingDepartment.BAKERY]: 6,
    [ShoppingDepartment.GRAINS]: 7,
    [ShoppingDepartment.CANNED]: 8,
    [ShoppingDepartment.SPICES]: 9,
    [ShoppingDepartment.OILS]: 10,
    [ShoppingDepartment.ALCOHOLS]: 11,
    [ShoppingDepartment.BEVERAGES]: 12,
    [ShoppingDepartment.SNACKS]: 13,
    [ShoppingDepartment.FROZEN]: 14,
    [ShoppingDepartment.CONFECTIONERY]: 15,
    [ShoppingDepartment.HOUSEHOLD]: 16,
    [ShoppingDepartment.OTHER]: 99,
  };
  private static readonly DEPARTMENT_KEYWORD_RULES: Array<{
    department: ShoppingDepartment;
    keywords: string[];
  }> = [
    { department: ShoppingDepartment.VEGETABLES, keywords: ['warzyw', 'veget', 'produce', 'ziemniak', 'cebula', 'czosn', 'marchew', 'seler', 'pomidor', 'papryk', 'ogorek', 'szpinak', 'salata', 'kalafior', 'brokul', 'cukini', 'baklazan', 'burak', 'por', 'jarmuz', 'pietruszk'] },
    { department: ShoppingDepartment.FRUITS, keywords: ['owoc', 'fruit', 'jablk', 'banan', 'cytryn', 'limonk', 'pomarancz', 'gruszk', 'truskawk', 'borowk', 'malin', 'winogron', 'ananas', 'awokado'] },
    { department: ShoppingDepartment.MEAT, keywords: ['mies', 'meat', 'drob', 'poultry', 'kaczk', 'kurczak', 'wolowin', 'wieprz', 'indyk', 'kielbas', 'boczek', 'schab'] },
    { department: ShoppingDepartment.FISH, keywords: ['ryb', 'fish', 'seafood', 'dorsz', 'losos', 'tunczyk', 'krewetk', 'mintaj', 'halibut', 'makrela'] },
    { department: ShoppingDepartment.DAIRY, keywords: ['nabial', 'dairy', 'milk', 'mleko', 'jogurt', 'kefir', 'skyr', 'maslo', 'smietan', 'twarog', 'jajk', 'ser', 'sery', 'sera', 'serek', 'gouda', 'mozzarella', 'mozarella', 'feta', 'parmezan', 'cheddar', 'ricotta', 'brie', 'camembert'] },
    { department: ShoppingDepartment.BAKERY, keywords: ['piekarn', 'bakery', 'bread', 'chleb', 'bulk', 'pieczyw', 'tortill', 'pita', 'bagietk'] },
    { department: ShoppingDepartment.GRAINS, keywords: ['zboz', 'grain', 'pasta', 'rice', 'makaron', 'ryz', 'kasz', 'platki', 'maka', 'owsian', 'soczewic', 'ciecierzyc', 'quinoa', 'komosa', 'fasol'] },
    { department: ShoppingDepartment.CANNED, keywords: ['konserw', 'canned', 'jar', 'sloik', 'puszka', 'oliwk', 'passata', 'bulion', 'mleko kokosowe'] },
    { department: ShoppingDepartment.SPICES, keywords: ['przypraw', 'spice', 'herb', 'sauce', 'sos', 'sol', 'pieprz', 'papryk', 'curry', 'oregano', 'bazyl', 'cynamon', 'musztard', 'majonez', 'ocet', 'ziola', 'kmink', 'jalowiec', 'proszek do pieczenia', 'soda'] },
    { department: ShoppingDepartment.OILS, keywords: ['olej', 'tluszcz', 'oil', 'fat', 'oliwa', 'smalec'] },
    { department: ShoppingDepartment.ALCOHOLS, keywords: ['alkohol', 'wino', 'piwo', 'whisky', 'whiskey', 'wodka', 'rum', 'gin', 'tequila', 'brandy', 'likier', 'prosecco', 'szampan', 'cydr', 'riesling', 'merlot', 'cabernet'] },
    { department: ShoppingDepartment.BEVERAGES, keywords: ['napoj', 'beverage', 'drink', 'woda', 'kawa', 'herbat', 'sok'] },
    { department: ShoppingDepartment.SNACKS, keywords: ['slodycz', 'przekask', 'snack', 'sweet', 'czekolad', 'ciastk', 'chips', 'orzech', 'miod', 'baton'] },
    { department: ShoppingDepartment.FROZEN, keywords: ['mrozon', 'frozen', 'lody'] },
    { department: ShoppingDepartment.CONFECTIONERY, keywords: ['cukiern', 'pastry', 'dessert', 'cake', 'cukier', 'drozdzowk', 'biszkopt'] },
    { department: ShoppingDepartment.HOUSEHOLD, keywords: ['chemia', 'household', 'clean', 'papier', 'plyn', 'proszek do prania', 'worki na smieci', 'reczniki papierowe'] },
  ];
  private static readonly CANONICAL_DEPARTMENT_OVERRIDES: Record<string, ShoppingDepartment> = {
    'kielbasa': ShoppingDepartment.MEAT,
    'kielbasa wedzona': ShoppingDepartment.MEAT,
    'maslo': ShoppingDepartment.DAIRY,
    'smietana kwasna': ShoppingDepartment.DAIRY,
    'jajka': ShoppingDepartment.DAIRY,
    'kapusta kiszona': ShoppingDepartment.VEGETABLES,
    'liscie laurowe': ShoppingDepartment.SPICES,
    'jalowiec': ShoppingDepartment.SPICES,
    'kminek': ShoppingDepartment.SPICES,
    'tymianek': ShoppingDepartment.SPICES,
    'imbir': ShoppingDepartment.SPICES,
    'sok z cytryny': ShoppingDepartment.FRUITS,
    'skorka z cytryny': ShoppingDepartment.FRUITS,
    'riesling': ShoppingDepartment.ALCOHOLS,
    'tluszcz kaczy': ShoppingDepartment.OILS,
    'olej': ShoppingDepartment.OILS,
    'oliwa z oliwek': ShoppingDepartment.OILS,
  };

  private parseWeekStart(weekStart: string): Date {
    const parsed = new Date(weekStart);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppException('VALIDATION_ERROR', 'Invalid weekStart date format', HttpStatus.BAD_REQUEST);
    }
    return parsed;
  }

  private formatWeekStart(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private normalizeProductKey(name: string, unit: string): string {
    return `${name.trim().toLowerCase()}::${unit.trim().toLowerCase()}`;
  }

  private normalizeText(value: string): string {
    const normalized = value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[ł]/g, 'l')
      .replace(/[ą]/g, 'a')
      .replace(/[ć]/g, 'c')
      .replace(/[ę]/g, 'e')
      .replace(/[ń]/g, 'n')
      .replace(/[ó]/g, 'o')
      .replace(/[ś]/g, 's')
      .replace(/[ź]/g, 'z')
      .replace(/[ż]/g, 'z')
      .trim();
    return normalized;
  }

  private itemSignature(items: ShoppingListItem[]): string {
    return items
      .map((item) =>
        [
          item.productKey,
          item.totalAmount.toFixed(6),
          item.unit,
          item.department,
          item.name,
        ].join('|'),
      )
      .sort()
      .join('||');
  }

  private sortShoppingItems(items: ShoppingListItem[]): ShoppingListItem[] {
    return [...items].sort((a, b) => {
      const rankA = WeeklyPlansService.DEPARTMENT_ORDER[a.department] ?? WeeklyPlansService.DEPARTMENT_ORDER.Inne;
      const rankB = WeeklyPlansService.DEPARTMENT_ORDER[b.department] ?? WeeklyPlansService.DEPARTMENT_ORDER.Inne;
      if (rankA !== rankB) return rankA - rankB;
      if (a.department === b.department) {
        return a.name.localeCompare(b.name);
      }
      return a.department.localeCompare(b.department);
    });
  }

  private buildDisplayShoppingItems(
    aggregatedItems: ShoppingAccumulator[],
    checkedMap: Map<string, boolean>,
  ): ShoppingListItem[] {
    if (aggregatedItems.length === 0) {
      return [];
    }

    const normalized = aggregatedItems.map((item) => ({
      ...item,
      totalAmount: Number(item.totalAmount.toFixed(2)),
      isChecked: checkedMap.get(item.productKey) ?? false,
    }));

    const unitsByName = new Map<string, Set<string>>();
    for (const item of normalized) {
      const set = unitsByName.get(item.name) ?? new Set<string>();
      set.add(this.normalizeText(item.unit));
      unitsByName.set(item.name, set);
    }

    return this.sortShoppingItems(
      normalized.map((item) => {
        const units = unitsByName.get(item.name);
        if (units && units.size > 1) {
          return {
            ...item,
            // Avoid visually duplicated product rows when same canonical name has different units.
            name: `${item.name} (${item.unit})`,
          };
        }
        return item;
      }),
    );
  }

  private mapSnapshotItems(
    items: Array<{
      productKey: string;
      name: string;
      unit: string;
      department: string;
      totalAmount: number;
      isChecked: boolean;
    }>,
  ): ShoppingListItem[] {
    return this.sortShoppingItems(
      items.map((item) => ({
        productKey: item.productKey,
        name: item.name,
        unit: item.unit,
        department: item.department,
        totalAmount: Number(item.totalAmount.toFixed(2)),
        isChecked: item.isChecked,
      })),
    );
  }

  private toArchiveSnapshot(
    archive: {
      id: string;
      weekStart: Date;
      weekLabel: string;
      revision: number;
      archivedAt: Date;
      items: Array<{
        productKey: string;
        name: string;
        unit: string;
        department: string;
        totalAmount: number;
        isChecked: boolean;
      }>;
    },
    currentArchiveIds: Set<string>,
  ): ShoppingListArchiveSnapshot {
    return {
      archiveId: archive.id,
      weekStart: this.formatWeekStart(archive.weekStart),
      weekLabel: archive.weekLabel,
      revision: archive.revision,
      archivedAt: archive.archivedAt.getTime(),
      isCurrentClosed: currentArchiveIds.has(archive.id),
      items: this.sortShoppingItems(
        archive.items.map((item) => ({
          productKey: item.productKey,
          name: item.name,
          unit: item.unit,
          department: item.department,
          totalAmount: Number(item.totalAmount.toFixed(2)),
          isChecked: item.isChecked,
        })),
      ),
    };
  }

  private toTitleCase(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  private toPolishDisplayText(value: string): string {
    let output = value.trim().toLowerCase();
    if (!output) return output;

    const phraseReplacements: Array<[string, string]> = [
      ['papryka slodka', 'papryka słodka'],
      ['papryka ostra', 'papryka ostra'],
      ['papryka zolta', 'papryka żółta'],
      ['fasola biala', 'fasola biała'],
      ['wino biale', 'wino białe'],
      ['wino czerwone polslodkie', 'wino czerwone półsłodkie'],
      ['wino czerwone polwytrawne', 'wino czerwone półwytrawne'],
      ['wino biale polslodkie', 'wino białe półsłodkie'],
      ['wino biale polwytrawne', 'wino białe półwytrawne'],
    ];

    for (const [from, to] of phraseReplacements) {
      output = output.replace(new RegExp(`\\b${this.escapeForRegex(from)}\\b`, 'g'), to);
    }

    const tokenReplacements: Array<[string, string]> = [
      ['ogorek', 'ogórek'],
      ['maslo', 'masło'],
      ['salata', 'sałata'],
      ['platki', 'płatki'],
      ['losos', 'łosoś'],
      ['brokul', 'brokuł'],
      ['ryz', 'ryż'],
      ['smietana', 'śmietana'],
      ['smietanka', 'śmietanka'],
      ['sol', 'sól'],
      ['zolta', 'żółta'],
      ['zolty', 'żółty'],
      ['biala', 'biała'],
      ['biale', 'białe'],
      ['bialy', 'biały'],
      ['brazowy', 'brązowy'],
      ['jasminowy', 'jaśminowy'],
      ['zytni', 'żytni'],
      ['zytnie', 'żytnie'],
      ['wloski', 'włoski'],
      ['twarozek', 'twarożek'],
      ['kielbasa', 'kiełbasa'],
      ['lopatka', 'łopatka'],
      ['wolowina', 'wołowina'],
      ['jablko', 'jabłko'],
      ['jablka', 'jabłka'],
      ['polslodkie', 'półsłodkie'],
      ['polwytrawne', 'półwytrawne'],
    ];

    for (const [from, to] of tokenReplacements) {
      output = output.replace(new RegExp(`\\b${this.escapeForRegex(from)}\\b`, 'g'), to);
    }

    return output.replace(/\s+/g, ' ').trim();
  }

  private escapeForRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private keywordMatches(text: string, keyword: string): boolean {
    const escaped = this.escapeForRegex(keyword);
    // treat keywords as stems, e.g. "ser" catches "ser", "sery", "sera", etc.
    const pattern = new RegExp(`\\b${escaped}[a-z]*\\b`, 'i');
    return pattern.test(text);
  }

  private detectDepartmentByKeywords(text: string): ShoppingDepartment | null {
    if (!text) return null;
    for (const rule of WeeklyPlansService.DEPARTMENT_KEYWORD_RULES) {
      if (rule.keywords.some((keyword) => this.keywordMatches(text, keyword))) {
        return rule.department;
      }
    }
    return null;
  }

  private canonicalizeIngredientName(name: string, unit?: string): string {
    let raw = this.normalizeText(name);
    const normalizedUnit = this.normalizeText(unit ?? '');
    if (!raw) return name.trim();

    // Strip parenthetical hints and common qualifiers.
    raw = raw.replace(/\([^)]*\)/g, ' ');
    raw = raw
      .replace(/\b(swieza|swiezy|swieze|suszona|suszony|suszone|mielony|mielona|mielone|surowa|surowy|niesolone|wytrawny|neutralny|koszerna|koszerny|morska|morski|wędzona|wedzona|cierpkie|cala|cały|calkowita|calkowity)\b/g, ' ')
      .replace(/\b(filety|filet|zabki|zabek|lodygi)\b/g, ' ')
      .replace(/\b(w|we)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const exactMap: Record<string, string> = {
      'swieza pietruszka': 'pietruszka',
      'suszone liscie laurowe': 'liście laurowe',
      'liscie laurowe': 'liście laurowe',
      'świeży imbir': 'imbir',
      'swiezy imbir': 'imbir',
      'mielony imbir': 'imbir',
      'swiezy tymianek': 'tymianek',
      'suszony tymianek': 'tymianek',
      'cala kaczka': 'kaczka',
      'stek bavette': 'wołowina bavette',
      'wedzona kielbasa kielbasa lub podobna': 'kiełbasa wędzona',
      'wedzona kielbasa': 'kiełbasa wędzona',
      'tluszcz kaczy': 'tłuszcz kaczy',
      'suszona brazowa soczewica': 'soczewica brązowa',
      'surowa kapusta kiszona': 'kapusta kiszona',
      'jabłka granny smith': 'jabłka',
      'jablka granny smith': 'jabłka',
      'cierpkie jablka granny smith': 'jabłka',
      'ocet jablkowy': 'ocet jabłkowy',
      'ocet jabłkowy': 'ocet jabłkowy',
      'sok jablkowy': 'sok jabłkowy',
      'sok jabłkowy': 'sok jabłkowy',
      'ziemniaki yukon gold': 'ziemniaki',
      'zolta cebula': 'cebula',
      'czarny pieprz': 'pieprz',
      'sól koszerna': 'sól',
      'sol koszerna': 'sól',
      'sól morska': 'sól',
      'sol morska': 'sól',
      'sól morska w platkach': 'sól',
      'sol morska w platkach': 'sól',
      'proszek do pieczenia': 'proszek do pieczenia',
      'soda oczyszczona': 'soda oczyszczona',
      'jagody jalowca': 'jałowiec',
      'nasiona kminku': 'kminek',
      'koncentrat tamaryndowca': 'pasta tamaryndowa',
      'wytrawny riesling': 'riesling',
      'wywar z kurczaka': 'bulion drobiowy',
      'filety dorsza': 'dorsz',
      'filety z dorsza': 'dorsz',
      'sok z cytryny': 'sok z cytryny',
      'sok cytryny': 'sok z cytryny',
      'skorka z cytryny': 'skórka z cytryny',
      'kwaśna śmietana': 'śmietana kwaśna',
      'kwasna smietana': 'śmietana kwaśna',
      'neutralny olej': 'olej',
      'oliwa z oliwek': 'oliwa z oliwek',
      'cała kaczka': 'kaczka',
      'łodygi selera': 'seler naciowy',
      'łodyga selera': 'seler naciowy',
    };

    const mapped = exactMap[raw];
    if (mapped) return this.toTitleCase(mapped);

    if (/\b(kurczak|kurczak[aiemou]{0,2}|kurcz)\b/.test(raw)) return 'Kurczak';
    if (/\b(indyk|indyk[aiemou]{0,2}|indycz)\b/.test(raw)) return 'Indyk';
    if (/kaczk/.test(raw)) return 'Kaczka';
    if (/dorsz/.test(raw)) return 'Dorsz';
    if (/bavette|wołowin|wolowin/.test(raw)) return 'Wołowina bavette';
    if (/kielbas/.test(raw)) return 'Kiełbasa';
    if (/imbir/.test(raw)) {
      if (normalizedUnit === 'szt') return 'Imbir';
      if (normalizedUnit === 'g') return 'Imbir';
      return 'Imbir';
    }
    if (/tymianek/.test(raw)) {
      if (normalizedUnit === 'g') return 'Tymianek';
      return 'Tymianek';
    }
    if (/liscie laurowe/.test(raw)) return 'Liście laurowe';
    if (/kapusta kiszona/.test(raw)) return 'Kapusta kiszona';
    if (/soczewic/.test(raw)) return 'Soczewica brązowa';
    if (/ocet jablk/.test(raw)) return 'Ocet jabłkowy';
    if (/sok jablk/.test(raw)) return 'Sok jabłkowy';
    if (/jablk/.test(raw)) return normalizedUnit === 'ml' ? 'Sok jabłkowy' : 'Jabłko';
    if (/cebul/.test(raw)) return 'Cebula';
    if (/ziemniak/.test(raw)) return 'Ziemniak';
    if (/czosn/.test(raw)) return 'Czosnek';
    if (/marchew/.test(raw)) return 'Marchew';
    if (/seler/.test(raw)) return 'Seler naciowy';
    if (/jajk/.test(raw)) return 'Jajko';
    if (/miod/.test(raw)) return 'Miód';
    if (/cukier puder/.test(raw)) return 'Cukier puder';
    if (/cukier/.test(raw)) return 'Cukier';
    if (/sok z cytryny|sok cytryny/.test(raw)) return 'Sok z cytryny';
    if (/cytryn/.test(raw)) return 'Cytryna';
    if (/kmink/.test(raw)) return 'Kminek';
    if (/jalow/.test(raw)) return 'Jałowiec';
    if (/sol/.test(raw)) return 'Sól';
    if (/pieprz/.test(raw)) return 'Pieprz';

    return this.toTitleCase(this.toPolishDisplayText(raw));
  }

  private mapDepartmentLabel(rawDepartment?: string | null): string {
    const value = this.normalizeText(rawDepartment ?? '');
    if (!value) return WeeklyPlansService.DEPARTMENT_OTHER;
    const detected = this.detectDepartmentByKeywords(value);
    return detected ?? WeeklyPlansService.DEPARTMENT_OTHER;
  }

  private inferDepartmentFromName(name: string): string {
    const value = this.normalizeText(name);
    if (!value) return WeeklyPlansService.DEPARTMENT_OTHER;
    const detected = this.detectDepartmentByKeywords(value);
    return detected ?? WeeklyPlansService.DEPARTMENT_OTHER;
  }

  private resolveDepartment(rawDepartment: string, ingredientName: string): string {
    const override = WeeklyPlansService.CANONICAL_DEPARTMENT_OVERRIDES[
      this.normalizeText(ingredientName)
    ];
    if (override) return override;

    const normalizedName = this.normalizeText(ingredientName);
    if (/\bkielbas[a-z]*\b/.test(normalizedName)) return ShoppingDepartment.MEAT;
    if (/\b(imbir|tymianek|liscie laurowe|jalowiec|kminek)\b/.test(normalizedName)) {
      return ShoppingDepartment.SPICES;
    }

    const mapped = this.mapDepartmentLabel(rawDepartment);
    if (mapped !== WeeklyPlansService.DEPARTMENT_OTHER) return mapped;
    return this.inferDepartmentFromName(ingredientName);
  }

  private async ensureRecipeForHousehold(recipeId: string, householdId: string) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id: recipeId },
      select: { id: true },
    });
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }
    return recipe;
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

  private isSerializableConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    maxRetries = 2,
  ): Promise<T> {
    let attempts = 0;
    while (true) {
      try {
        return await this.prisma.$transaction(
          async (tx) => operation(tx),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (this.isSerializableConflict(error) && attempts < maxRetries) {
          attempts += 1;
          continue;
        }
        throw error;
      }
    }
  }

  async listByHousehold(userId: string, householdId: string) {
    await this.ensureMembership(userId, householdId);
    return this.prisma.weeklyPlan.findMany({
      where: { householdId },
      orderBy: { weekStart: 'desc' },
      include: {
        items: {
          include: {
            recipe: {
              select: {
                id: true,
                title: true,
                description: true,
                mealType: true,
                difficulty: true,
                prepTimeMinutes: true,
                servings: true,
                imageUrl: true,
                nutritionKcal: true,
                nutritionProtein: true,
                nutritionFat: true,
                nutritionCarbs: true,
                nutritionFiber: true,
                nutritionSalt: true,
                isActive: true,
                authorId: true,
                householdId: true,
                ingredients: true,
              },
            },
          },
        },
      },
    });
  }

  async getByHouseholdAndWeek(userId: string, householdId: string, weekStart: string) {
    await this.ensureMembership(userId, householdId);
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: { householdId_weekStart: { householdId, weekStart: new Date(weekStart) } },
      include: {
        items: {
          include: {
            recipe: {
              select: {
                id: true,
                title: true,
                description: true,
                mealType: true,
                difficulty: true,
                prepTimeMinutes: true,
                servings: true,
                imageUrl: true,
                nutritionKcal: true,
                nutritionProtein: true,
                nutritionFat: true,
                nutritionCarbs: true,
                nutritionFiber: true,
                nutritionSalt: true,
                isActive: true,
                authorId: true,
                householdId: true,
                ingredients: true,
              },
            },
          },
        },
      },
    });
    if (!plan) {
      throw new NotFoundException('Weekly plan not found');
    }
    return plan;
  }

  async create(userId: string, householdId: string, dto: CreateWeeklyPlanDto) {
    await this.ensureMembership(userId, householdId);
    return this.prisma.weeklyPlan.create({
      data: {
        householdId,
        weekStart: new Date(dto.weekStart),
      },
    });
  }

  async addItem(userId: string, weeklyPlanId: string, dto: CreatePlanItemDto) {
    const plan = await this.prisma.weeklyPlan.findUnique({
      where: { id: weeklyPlanId },
    });
    if (!plan) {
      throw new NotFoundException('Weekly plan not found');
    }
    await this.ensureMembership(userId, plan.householdId);

    await this.ensureRecipeForHousehold(dto.recipeId, plan.householdId);

    return this.runSerializable(async (tx) => {
      const [existingForMealType, existingTotal, existingSlot] = await Promise.all([
        tx.planItem.count({
          where: {
            weeklyPlanId,
            mealType: dto.mealType,
          },
        }),
        tx.planItem.count({
          where: { weeklyPlanId },
        }),
        tx.planItem.findFirst({
          where: {
            weeklyPlanId,
            dayOfWeek: dto.dayOfWeek,
            mealType: dto.mealType,
          },
        }),
      ]);

      if (existingSlot) {
        throw new ConflictException('This day and meal slot is already assigned in weekly plan');
      }

      if (existingForMealType >= WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE) {
        throw new AppException(
          'PLAN_SLOT_LIMIT_REACHED',
          'Meal type limit reached (max 7 per week)',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (existingTotal >= WeeklyPlansService.MAX_ITEMS_TOTAL) {
        throw new AppException(
          'PLAN_TOTAL_LIMIT_REACHED',
          'Weekly plan total limit reached (max 21 items)',
          HttpStatus.BAD_REQUEST,
        );
      }

      const createdItem = await tx.planItem.create({
        data: {
          weeklyPlanId,
          recipeId: dto.recipeId,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
        },
      });

      await this.rebuildShoppingListSnapshot(plan.householdId, plan.weekStart, tx);

      return createdItem;
    });
  }

  async removeItem(userId: string, itemId: string) {
    const item = await this.prisma.planItem.findUnique({
      where: { id: itemId },
      include: { weeklyPlan: true },
    });
    if (!item) {
      throw new NotFoundException('Plan item not found');
    }
    await this.ensureMembership(userId, item.weeklyPlan.householdId);
    return this.runSerializable(async (tx) => {
      const deletedItem = await tx.planItem.delete({ where: { id: itemId } });
      await this.rebuildShoppingListSnapshot(
        item.weeklyPlan.householdId,
        item.weeklyPlan.weekStart,
        tx,
      );
      return deletedItem;
    });
  }

  private async buildShoppingListBase(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingAccumulator[]> {
    const sharedPlan = await client.sharedMealPlan.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      include: {
        items: {
          include: {
            recipe: {
              include: {
                ingredients: {
                  select: {
                    name: true,
                    amount: true,
                    unit: true,
                    normalizedAmount: true,
                    normalizedUnit: true,
                    department: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    let ingredientSources: Array<{
      recipe: {
        ingredients: Array<{
          name: string;
          amount: number;
          unit: string;
          normalizedAmount: number;
          normalizedUnit: string;
          department: string;
        }>;
      };
      quantity: number;
    }> = [];
    if (sharedPlan && sharedPlan.items.length > 0) {
      ingredientSources = sharedPlan.items.map((item) => ({
        recipe: item.recipe,
        quantity: Math.max(1, item.quantity),
      }));
    } else {
      // Backward compatibility fallback: if shared plan is not yet saved, derive list from calendar slots.
      const weeklyPlan = await client.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        include: {
          items: {
            include: {
              recipe: {
                include: {
                  ingredients: {
                    select: {
                      name: true,
                      amount: true,
                      unit: true,
                      normalizedAmount: true,
                      normalizedUnit: true,
                      department: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      ingredientSources = (weeklyPlan?.items ?? []).map((item) => ({
        recipe: item.recipe,
        quantity: 1,
      }));
    }

    const aggregated = new Map<string, ShoppingAccumulator>();
    for (const source of ingredientSources) {
      for (const ingredient of source.recipe.ingredients) {
        const baseAmount = ingredient.normalizedAmount ?? ingredient.amount;
        const baseUnit = ingredient.normalizedUnit ?? ingredient.unit;
        const canonicalName = this.canonicalizeIngredientName(ingredient.name, baseUnit);
        const productKey = this.normalizeProductKey(canonicalName, baseUnit);
        const current = aggregated.get(productKey);
        const amountToAdd = baseAmount * source.quantity;
        if (current) {
          current.totalAmount += amountToAdd;
          continue;
        }
        aggregated.set(productKey, {
          productKey,
          name: canonicalName,
          unit: baseUnit,
          department: this.resolveDepartment(ingredient.department, canonicalName),
          totalAmount: amountToAdd,
        });
      }
    }

    if (aggregated.size === 0) {
      return [];
    }

    return Array.from(aggregated.values());
  }

  private async rebuildShoppingListSnapshot(
    householdId: string,
    weekStartDate: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ShoppingListItem[]> {
    const aggregatedItems = await this.buildShoppingListBase(householdId, weekStartDate, tx);

    const shoppingList = await tx.shoppingList.upsert({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      update: {
        updatedAt: new Date(),
      },
      create: {
        householdId,
        weekStart: weekStartDate,
      },
      include: {
        items: {
          select: {
            productKey: true,
            isChecked: true,
          },
        },
      },
    });
    const currentArchiveState = await tx.shoppingListArchiveState.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      select: {
        currentArchiveId: true,
        currentArchive: {
          select: {
            items: {
              select: {
                productKey: true,
                totalAmount: true,
              },
            },
          },
        },
      },
    });

    const productKeys = aggregatedItems.map((item) => item.productKey);
    const legacyChecks = productKeys.length > 0
      ? await tx.shoppingItemCheck.findMany({
          where: {
            householdId,
            weekStart: weekStartDate,
            productKey: {
              in: productKeys,
            },
          },
          select: {
            productKey: true,
            isChecked: true,
          },
        })
      : [];

    const existingCheckedMap = new Map(
      shoppingList.items.map((item) => [item.productKey, item.isChecked]),
    );
    const legacyCheckedMap = new Map(
      legacyChecks.map((item) => [item.productKey, item.isChecked]),
    );
    const baselineAmounts = new Map(
      (currentArchiveState?.currentArchive?.items ?? []).map((item) => [
        item.productKey,
        item.totalAmount,
      ]),
    );
    const checkedMap = new Map<string, boolean>();
    for (const item of aggregatedItems) {
      const previousAmount = baselineAmounts.get(item.productKey) ?? 0;
      const hasNewUncheckedDelta = Boolean(
        currentArchiveState?.currentArchiveId
          && item.totalAmount > previousAmount + 0.000_001,
      );

      checkedMap.set(
        item.productKey,
        hasNewUncheckedDelta
          ? false
          : existingCheckedMap.get(item.productKey) ?? legacyCheckedMap.get(item.productKey) ?? false,
      );
    }

    const nextItems = this.buildDisplayShoppingItems(aggregatedItems, checkedMap);

    if (nextItems.length === 0) {
      await tx.shoppingListItem.deleteMany({
        where: { shoppingListId: shoppingList.id },
      });
      await tx.shoppingItemCheck.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });
      return [];
    }

    await tx.shoppingListItem.deleteMany({
      where: {
        shoppingListId: shoppingList.id,
        productKey: {
          notIn: nextItems.map((item) => item.productKey),
        },
      },
    });

    await tx.shoppingItemCheck.deleteMany({
      where: {
        householdId,
        weekStart: weekStartDate,
        productKey: {
          notIn: nextItems.map((item) => item.productKey),
        },
      },
    });

    for (const item of nextItems) {
      await tx.shoppingListItem.upsert({
        where: {
          shoppingListId_productKey: {
            shoppingListId: shoppingList.id,
            productKey: item.productKey,
          },
        },
        update: {
          name: item.name,
          unit: item.unit,
          department: item.department,
          totalAmount: item.totalAmount,
          isChecked: item.isChecked,
        },
        create: {
          shoppingListId: shoppingList.id,
          productKey: item.productKey,
          name: item.name,
          unit: item.unit,
          department: item.department,
          totalAmount: item.totalAmount,
          isChecked: item.isChecked,
        },
      });
    }

    return nextItems;
  }

  private async hasShoppingSourceData(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<boolean> {
    const [sharedPlan, weeklyPlan] = await Promise.all([
      client.sharedMealPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: {
          items: {
            select: { id: true },
            take: 1,
          },
        },
      }),
      client.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: {
          items: {
            select: { id: true },
            take: 1,
          },
        },
      }),
    ]);

    return (sharedPlan?.items.length ?? 0) > 0 || (weeklyPlan?.items.length ?? 0) > 0;
  }

  private async rebuildShoppingListSnapshotWithClient(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingListItem[]> {
    if (client === this.prisma) {
      return this.runSerializable((tx) => this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx));
    }

    return this.rebuildShoppingListSnapshot(
      householdId,
      weekStartDate,
      client as Prisma.TransactionClient,
    );
  }

  private async getShoppingListSnapshot(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingListItem[]> {
    const snapshot = await client.shoppingList.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      include: {
        items: true,
      },
    });

    if (snapshot) {
      const hasSourceData = await this.hasShoppingSourceData(householdId, weekStartDate, client);
      if (snapshot.items.length === 0 && hasSourceData) {
        return this.rebuildShoppingListSnapshotWithClient(householdId, weekStartDate, client);
      }
      if (snapshot.items.length > 0 && !hasSourceData) {
        return this.rebuildShoppingListSnapshotWithClient(householdId, weekStartDate, client);
      }
      return this.mapSnapshotItems(snapshot.items);
    }

    return this.rebuildShoppingListSnapshotWithClient(householdId, weekStartDate, client);
  }

  async getShoppingList(userId: string, householdId: string, weekStart: string) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);
    return this.getShoppingListSnapshot(householdId, weekStartDate);
  }

  async getShoppingListState(
    userId: string,
    householdId: string,
    weekStart: string,
  ): Promise<ShoppingListStateDto> {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    const [items, archives, currentArchiveStates, currentWeekArchiveState] = await Promise.all([
      this.getShoppingListSnapshot(householdId, weekStartDate),
      this.prisma.shoppingListArchive.findMany({
        where: { householdId },
        orderBy: [{ archivedAt: 'desc' }, { revision: 'desc' }],
        include: {
          items: {
            orderBy: [{ department: 'asc' }, { name: 'asc' }],
          },
        },
      }),
      this.prisma.shoppingListArchiveState.findMany({
        where: {
          householdId,
          currentArchiveId: { not: null },
        },
        select: {
          currentArchiveId: true,
        },
      }),
      this.prisma.shoppingListArchiveState.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: {
          currentArchiveId: true,
        },
      }),
    ]);

    const currentArchiveIds = new Set(
      currentArchiveStates
        .map((state) => state.currentArchiveId)
        .filter((value): value is string => Boolean(value)),
    );
    const shouldHideCurrentWeekList = currentWeekArchiveState?.currentArchiveId === null;

    return {
      items: shouldHideCurrentWeekList ? [] : items,
      archives: archives.map((archive) => this.toArchiveSnapshot(archive, currentArchiveIds)),
    };
  }

  async archiveShoppingList(
    userId: string,
    householdId: string,
    weekStart: string,
    weekLabel: string,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    return this.runSerializable(async (tx) => {
      const items = await this.getShoppingListSnapshot(householdId, weekStartDate, tx);

      if (items.length === 0) {
        throw new AppException(
          'SHOPPING_LIST_EMPTY',
          'Shopping list is empty and cannot be archived',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (items.some((item) => !item.isChecked)) {
        throw new AppException(
          'SHOPPING_LIST_NOT_COMPLETED',
          'Shopping list must be fully checked before archiving',
          HttpStatus.BAD_REQUEST,
        );
      }

      const signature = this.itemSignature(items);
      const now = new Date();
      const existingArchive = await tx.shoppingListArchive.findUnique({
        where: {
          householdId_weekStart_signature: {
            householdId,
            weekStart: weekStartDate,
            signature,
          },
        },
        select: {
          id: true,
          revision: true,
        },
      });

      let archiveId: string;
      if (existingArchive) {
        archiveId = existingArchive.id;
        await tx.shoppingListArchive.update({
          where: { id: existingArchive.id },
          data: {
            weekLabel,
            archivedAt: now,
          },
        });
      } else {
        const revisionAggregate = await tx.shoppingListArchive.aggregate({
          where: {
            householdId,
            weekStart: weekStartDate,
          },
          _max: { revision: true },
        });

        const createdArchive = await tx.shoppingListArchive.create({
          data: {
            householdId,
            weekStart: weekStartDate,
            weekLabel,
            revision: (revisionAggregate._max.revision ?? 0) + 1,
            signature,
            archivedAt: now,
            items: {
              create: items.map((item) => ({
                productKey: item.productKey,
                name: item.name,
                unit: item.unit,
                department: item.department,
                totalAmount: item.totalAmount,
                isChecked: item.isChecked,
              })),
            },
          },
          select: { id: true },
        });
        archiveId = createdArchive.id;
      }

      await tx.shoppingListArchiveState.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        update: {
          currentArchiveId: archiveId,
        },
        create: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: archiveId,
        },
      });

      return { archiveId };
    });
  }

  async selectShoppingListArchive(
    userId: string,
    householdId: string,
    archiveId: string,
  ) {
    await this.ensureMembership(userId, householdId);

    return this.runSerializable(async (tx) => {
      const archive = await tx.shoppingListArchive.findUnique({
        where: { id: archiveId },
        select: {
          id: true,
          householdId: true,
          weekStart: true,
        },
      });

      if (!archive || archive.householdId !== householdId) {
        throw new NotFoundException('Shopping list archive not found');
      }

      await tx.shoppingListArchiveState.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: archive.weekStart,
          },
        },
        update: {
          currentArchiveId: archive.id,
        },
        create: {
          householdId,
          weekStart: archive.weekStart,
          currentArchiveId: archive.id,
        },
      });

      return {
        archiveId: archive.id,
        weekStart: this.formatWeekStart(archive.weekStart),
      };
    });
  }

  async deleteShoppingListArchive(
    userId: string,
    householdId: string,
    archiveId: string,
  ) {
    await this.ensureMembership(userId, householdId);

    return this.runSerializable(async (tx) => {
      const archive = await tx.shoppingListArchive.findUnique({
        where: { id: archiveId },
        select: {
          id: true,
          householdId: true,
          weekStart: true,
        },
      });

      if (!archive || archive.householdId !== householdId) {
        throw new NotFoundException('Shopping list archive not found');
      }

      const weekStart = archive.weekStart;

      await tx.shoppingListArchive.delete({
        where: { id: archive.id },
      });

      const replacementArchive = await tx.shoppingListArchive.findFirst({
        where: {
          householdId,
          weekStart,
        },
        orderBy: [{ archivedAt: 'desc' }, { revision: 'desc' }],
        select: { id: true },
      });

      if (replacementArchive) {
        await tx.shoppingListArchiveState.upsert({
          where: {
            householdId_weekStart: {
              householdId,
              weekStart,
            },
          },
          update: {
            currentArchiveId: replacementArchive.id,
          },
          create: {
            householdId,
            weekStart,
            currentArchiveId: replacementArchive.id,
          },
        });
      } else {
        await tx.shoppingListArchiveState.upsert({
          where: {
            householdId_weekStart: {
              householdId,
              weekStart,
            },
          },
          update: {
            currentArchiveId: null,
          },
          create: {
            householdId,
            weekStart,
            currentArchiveId: null,
          },
        });
      }

      return {
        archiveId,
        weekStart: this.formatWeekStart(weekStart),
      };
    });
  }

  async deleteAllShoppingListArchives(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    return this.runSerializable(async (tx) => {
      await tx.shoppingListArchiveState.deleteMany({
        where: { householdId },
      });
      await tx.shoppingListArchive.deleteMany({
        where: { householdId },
      });
      await tx.shoppingListArchiveState.create({
        data: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      return { success: true };
    });
  }

  async setShoppingItemChecked(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: UpdateShoppingItemCheckDto,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    return this.runSerializable(async (tx) => {
      await this.getShoppingListSnapshot(householdId, weekStartDate, tx);

      const snapshot = await tx.shoppingList.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: {
          id: true,
          items: {
            where: {
              productKey: dto.productKey,
            },
            select: {
              productKey: true,
            },
          },
        },
      });

      if (!snapshot || snapshot.items.length === 0) {
        throw new NotFoundException('Shopping item not found for this household and week');
      }

      await tx.shoppingListItem.update({
        where: {
          shoppingListId_productKey: {
            shoppingListId: snapshot.id,
            productKey: dto.productKey,
          },
        },
        data: {
          isChecked: dto.isChecked,
        },
      });

      return tx.shoppingItemCheck.upsert({
        where: {
          householdId_weekStart_productKey: {
            householdId,
            weekStart: weekStartDate,
            productKey: dto.productKey,
          },
        },
        update: {
          isChecked: dto.isChecked,
        },
        create: {
          householdId,
          weekStart: weekStartDate,
          productKey: dto.productKey,
          isChecked: dto.isChecked,
        },
      });
    });
  }

  async upsertWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: UpsertWeekSlotDto,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);
    await this.ensureRecipeForHousehold(dto.recipeId, householdId);

    return this.runSerializable(async (tx) => {
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      const weeklyPlan = await tx.weeklyPlan.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        update: {},
        create: {
          householdId,
          weekStart: weekStartDate,
        },
        select: { id: true },
      });

      const existingSlot = await tx.planItem.findFirst({
        where: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
        },
      });

      if (existingSlot) {
        const updatedItem = await tx.planItem.update({
          where: { id: existingSlot.id },
          data: { recipeId: dto.recipeId },
        });
        await this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx);
        return updatedItem;
      }

      const [existingForMealType, existingTotal] = await Promise.all([
        tx.planItem.count({
          where: {
            weeklyPlanId: weeklyPlan.id,
            mealType: dto.mealType,
          },
        }),
        tx.planItem.count({
          where: { weeklyPlanId: weeklyPlan.id },
        }),
      ]);

      if (existingForMealType >= WeeklyPlansService.MAX_ITEMS_PER_MEAL_TYPE) {
        throw new AppException(
          'PLAN_SLOT_LIMIT_REACHED',
          'Meal type limit reached (max 7 per week)',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (existingTotal >= WeeklyPlansService.MAX_ITEMS_TOTAL) {
        throw new AppException(
          'PLAN_TOTAL_LIMIT_REACHED',
          'Weekly plan total limit reached (max 21 items)',
          HttpStatus.BAD_REQUEST,
        );
      }

      const createdItem = await tx.planItem.create({
        data: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
          recipeId: dto.recipeId,
        },
      });

      await this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx);

      return createdItem;
    });
  }

  async removeWeekSlot(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: RemoveWeekSlotDto,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    return this.runSerializable(async (tx) => {
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      const weeklyPlan = await tx.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: { id: true },
      });

      if (!weeklyPlan) {
        return null;
      }

      const existingSlot = await tx.planItem.findFirst({
        where: {
          weeklyPlanId: weeklyPlan.id,
          dayOfWeek: dto.dayOfWeek,
          mealType: dto.mealType,
        },
        select: { id: true },
      });

      if (!existingSlot) {
        return null;
      }

      const deletedItem = await tx.planItem.delete({
        where: { id: existingSlot.id },
      });

      await this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx);

      return deletedItem;
    });
  }

  async clearWeekPlan(userId: string, householdId: string, weekStart: string) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    await this.runSerializable(async (tx) => {
      const weeklyPlan = await tx.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: { id: true },
      });

      const sharedPlan = await tx.sharedMealPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: { id: true },
      });

      if (weeklyPlan) {
        await tx.planItem.deleteMany({
          where: { weeklyPlanId: weeklyPlan.id },
        });
      }

      if (sharedPlan) {
        await tx.sharedMealPlanItem.deleteMany({
          where: { sharedMealPlanId: sharedPlan.id },
        });
        await tx.sharedMealPlan.delete({
          where: { id: sharedPlan.id },
        });
      }

      await tx.shoppingItemCheck.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });

      await tx.shoppingList.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });

      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });

      await tx.shoppingListArchive.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
        },
      });
    });

    return { success: true };
  }

  async getUserDisplayName(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    return user?.displayName ?? null;
  }

  async getSharedMealPlan(userId: string, householdId: string, weekStart: string) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    const plan = await this.prisma.sharedMealPlan.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      include: {
        items: {
          include: {
            recipe: {
              select: {
                id: true,
                title: true,
                description: true,
                mealType: true,
                difficulty: true,
                prepTimeMinutes: true,
                servings: true,
                imageUrl: true,
                nutritionKcal: true,
                nutritionProtein: true,
                nutritionFat: true,
                nutritionCarbs: true,
                nutritionFiber: true,
                nutritionSalt: true,
                isActive: true,
                authorId: true,
                householdId: true,
                ingredients: true,
                sourceInstructions: true,
              },
            },
          },
          orderBy: [{ mealType: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!plan) {
      return {
        weekStart,
        items: [],
      };
    }

    return {
      weekStart,
      items: plan.items.map((item) => ({
        mealType: item.mealType,
        quantity: item.quantity,
        recipe: item.recipe,
      })),
    };
  }

  async saveSharedMealPlan(
    userId: string,
    householdId: string,
    weekStart: string,
    dto: SaveSharedMealPlanDto,
  ) {
    await this.ensureMembership(userId, householdId);
    const weekStartDate = this.parseWeekStart(weekStart);

    const breakfast = dto.breakfastRecipeIds ?? [];
    const lunch = dto.lunchRecipeIds ?? [];
    const dinner = dto.dinnerRecipeIds ?? [];

    const allIds = [...breakfast, ...lunch, ...dinner];
    const uniqueIds = Array.from(new Set(allIds));

    const countByRecipe = (ids: string[]) =>
      ids.reduce<Map<string, number>>((map, id) => {
        map.set(id, (map.get(id) ?? 0) + 1);
        return map;
      }, new Map<string, number>());

    const breakfastCounts = countByRecipe(breakfast);
    const lunchCounts = countByRecipe(lunch);
    const dinnerCounts = countByRecipe(dinner);
    const breakfastAllowed = Array.from(breakfastCounts.keys());
    const lunchAllowed = Array.from(lunchCounts.keys());
    const dinnerAllowed = Array.from(dinnerCounts.keys());

    await this.runSerializable(async (tx) => {
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      if (uniqueIds.length > 0) {
        const recipes = await tx.recipe.findMany({
          where: {
            id: { in: uniqueIds },
          },
          select: { id: true },
        });

        if (recipes.length !== uniqueIds.length) {
          throw new NotFoundException('One or more recipes from shared plan do not exist');
        }
      }

      const sharedPlan = await tx.sharedMealPlan.upsert({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        update: {},
        create: {
          householdId,
          weekStart: weekStartDate,
        },
        select: { id: true },
      });

      const rows = [
        ...Array.from(breakfastCounts.entries()).map(([recipeId, quantity]) => ({
          sharedMealPlanId: sharedPlan.id,
          recipeId,
          mealType: 'BREAKFAST' as const,
          quantity,
        })),
        ...Array.from(lunchCounts.entries()).map(([recipeId, quantity]) => ({
          sharedMealPlanId: sharedPlan.id,
          recipeId,
          mealType: 'LUNCH' as const,
          quantity,
        })),
        ...Array.from(dinnerCounts.entries()).map(([recipeId, quantity]) => ({
          sharedMealPlanId: sharedPlan.id,
          recipeId,
          mealType: 'DINNER' as const,
          quantity,
        })),
      ].filter((row) => row.quantity > 0);

      await tx.sharedMealPlanItem.deleteMany({
        where: {
          sharedMealPlanId: sharedPlan.id,
        },
      });

      if (rows.length > 0) {
        await tx.sharedMealPlanItem.createMany({
          data: rows,
        });
      }

      const weeklyPlan = await tx.weeklyPlan.findUnique({
        where: {
          householdId_weekStart: {
            householdId,
            weekStart: weekStartDate,
          },
        },
        select: { id: true },
      });

      if (!weeklyPlan) {
        await this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx);
        return;
      }

      const pruneByMealType = async (
        mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER',
        allowedRecipeIds: string[],
      ) => {
        if (allowedRecipeIds.length === 0) {
          await tx.planItem.deleteMany({
            where: {
              weeklyPlanId: weeklyPlan.id,
              mealType,
            },
          });
          return;
        }

        await tx.planItem.deleteMany({
          where: {
            weeklyPlanId: weeklyPlan.id,
            mealType,
            recipeId: { notIn: allowedRecipeIds },
          },
        });
      };

      await Promise.all([
        pruneByMealType('BREAKFAST', breakfastAllowed),
        pruneByMealType('LUNCH', lunchAllowed),
        pruneByMealType('DINNER', dinnerAllowed),
      ]);

      await this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx);
    });

    return this.getSharedMealPlan(userId, householdId, weekStart);
  }
}
