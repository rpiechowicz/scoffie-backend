import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { assertUuid } from '../../common/uuid';
import { validateDto } from '../../common/validate-dto';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateShoppingItemCheckDto } from '../dto/update-shopping-item-check.dto';
import { AddRecipeExtrasDto } from '../dto/add-recipe-extras.dto';
import { RemoveShoppingExtraDto } from '../dto/remove-shopping-extra.dto';
import type {
  ShoppingAccumulator,
  ShoppingListItem,
  ShoppingListStateDto,
  PrismaReadClient,
} from '../types/shopping-types';
import { parseWeekStart, formatWeekStart } from '../utils/week-formatting.util';
import {
  normalizeProductKey,
  toTitleCase,
} from '../utils/text-normalization.util';
import { toShoppingDepartment } from '../utils/department-classifier.util';
import {
  itemSignature,
  buildDisplayShoppingItems,
  mapSnapshotItems,
  roundShoppingAmount,
  toArchiveSnapshot,
  toShoppingUnit,
} from '../utils/shopping-items.util';
import { ensureMembership } from '../utils/auth-checks.util';
import { runSerializable } from '../utils/transaction-runner.util';

/** Etykieta archiwum jest wpisywana ręcznie — górna granica jak dla nazwy gospodarstwa. */
const WEEK_LABEL_MAX_LENGTH = 64;

/**
 * `weekLabel` to skalar z koperty, nie DTO — bramka ręczna, w stylu
 * `assertUuid`, żeby `details` wyglądały jak z class-validator. Bez niej
 * `weekLabel: 42` szedł prosto do kolumny `String` → PrismaClientValidationError
 * → 500, a pusty napis zakładał archiwum bez nazwy.
 */
function assertWeekLabel(weekLabel: unknown): string {
  if (
    typeof weekLabel !== 'string' ||
    weekLabel.trim().length === 0 ||
    weekLabel.length > WEEK_LABEL_MAX_LENGTH
  ) {
    const detail = `weekLabel must be a non-empty string up to ${WEEK_LABEL_MAX_LENGTH} characters`;
    throw new AppException('VALIDATION_ERROR', detail, HttpStatus.BAD_REQUEST, [
      detail,
    ]);
  }
  return weekLabel;
}

function archiveNotFound(): AppException {
  return new AppException(
    'SHOPPING_LIST_ARCHIVE_NOT_FOUND',
    'Nie znaleziono archiwum listy zakupów',
    HttpStatus.NOT_FOUND,
  );
}

/// Owns the per-household shopping list aggregation, snapshotting,
/// archival, and item-check operations. Split out of WeeklyPlansService
/// so the plan-management surface stays focused.
///
/// Snapshot model: every household has a single "current" `ShoppingList`
/// row per week, plus zero or more archived snapshots. Recompute fans
/// out from `rebuildShoppingListSnapshot`, gated by `markShoppingListStale`
/// so we don't do work for weeks the UI isn't looking at.
/** Ile ostatnich archiwów wraca ze stanem listy — starsze tylko w bazie. */
const MAX_ARCHIVES_IN_STATE = 52;

/**
 * Wersja reguł, według których zbudowano migawkę `ShoppingList`.
 *
 * Migawka to pamięć podręczna policzona z planu — po zmianie reguł liczenia
 * (np. 1: jedna jednostka na produkt, `toShoppingUnit`) stare migawki
 * trzymałyby stary kształt aż do pierwszej zmiany planu w danym domu. Starsza
 * wersja = przebudowa przy najbliższym odczycie, jak przy `isStale`, bez
 * masowego `UPDATE` na produkcji. Zmiana reguł = podbicie tej liczby.
 */
export const SHOPPING_LIST_RULES_VERSION = 1;

/** Dopisana pozycja w jednostce listy — patrz `loadExtras`. */
type ShoppingExtraRow = {
  id: string;
  /** Klucz tak, jak leży w bazie (wiersz sprzed 22.09.2026: `cebula::g`). */
  storedKey: string;
  /** Klucz w dzisiejszej jednostce listy — pod nim wiersz się sumuje. */
  productKey: string;
  name: string;
  unit: string;
  department: string;
  amount: number;
  recipeTitle: string;
};

@Injectable()
export class ShoppingListService {
  private readonly logger = new Logger(ShoppingListService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async buildShoppingListBase(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingAccumulator[]> {
    // Day slots are the ONLY source: Plan v2 assigns a recipe straight to a
    // (day, slot), and a slot can hold one dish per household member. The
    // week-long shared pool (`SharedMealPlan`) that preceded it is retired
    // (WP-03) and is never consulted, not even as a fallback.
    const weeklyPlan = await client.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      include: {
        items: {
          // Jawny `select` zamiast `include`, bo skalowanie potrzebuje dwóch
          // zwykłych pól — `plannedServings` z pozycji planu i `servings`
          // z przepisu — a `include` przyjmuje wyłącznie relacje.
          select: {
            plannedServings: true,
            recipe: {
              select: {
                servings: true,
                ingredients: {
                  select: {
                    name: true,
                    amount: true,
                    unit: true,
                    normalizedAmount: true,
                    normalizedUnit: true,
                    department: true,
                    // Masa sztuki — z niej `toShoppingUnit` sprowadza gramy
                    // i sztuki tego samego produktu do jednej jednostki.
                    ingredient: { select: { gramsPerPiece: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Z planu liczy się wyłącznie `PlanItem` (drugie źródło listy to
    // dopisane pozycje, niżej). Wycofana pula tygodniowa
    // (`SharedMealPlan`) podstawiała tu widmową listę tygodniowi, z którego
    // usunięto wszystkie posiłki po jednym — a asystentowi kazałaby liczyć
    // bilans z danych, których nie widać w aplikacji (WP-03).
    //
    // Jedna pozycja to jedno danie, więc podzielony slot wnosi posiłki obu
    // domowników. Waga pozycji jest ułamkiem, a nie krotnością: gotujemy
    // `plannedServings` porcji przepisu napisanego na `recipe.servings`,
    // więc posiłek solo z przepisu na dwie porcje kupuje połowę składników.
    const ingredientSources = (weeklyPlan?.items ?? []).map((item) => ({
      recipe: item.recipe,
      portionFactor:
        Math.max(1, item.plannedServings) / Math.max(1, item.recipe.servings),
    }));

    const aggregated = new Map<string, ShoppingAccumulator>();
    // Składnik bez znormalizowanej ilości to błąd danych (importer i
    // `recipes:create` zawsze ją piszą). Liczymy z surowej ilości, żeby lista
    // nie zgubiła produktu, ale mówimy o tym w logu — cichy fallback dawał
    // „1 łyżeczka" zsumowaną z gramami pod jednym kluczem.
    const missingNormalization = new Set<string>();
    for (const source of ingredientSources) {
      for (const ingredient of source.recipe.ingredients) {
        if (
          ingredient.normalizedAmount == null ||
          ingredient.normalizedUnit == null
        ) {
          missingNormalization.add(ingredient.name);
        }
        // Jedna jednostka na produkt: gramy produktu ze znaną masą sztuki
        // idą na sztuki, zanim powstanie klucz — inaczej „cebula 150 g”
        // i „cebula 1 szt” lądowały w dwóch wierszach.
        const { amount: baseAmount, unit: baseUnit } = toShoppingUnit(
          ingredient.normalizedAmount ?? ingredient.amount,
          ingredient.normalizedUnit ?? ingredient.unit,
          ingredient.ingredient.gramsPerPiece,
        );
        // Nazwa z katalogu jest kanoniczna — na listę idzie dosłownie (tylko
        // z wielką literą), a klucz scala wyłącznie ten sam produkt w tej
        // samej jednostce. Bez regexowego „canonicalizera”, który zamieniał
        // „fasola biała z puszki” w „Sól” i zlewał kawałki kurczaka.
        const displayName = toTitleCase(ingredient.name);
        const productKey = normalizeProductKey(ingredient.name, baseUnit);
        const current = aggregated.get(productKey);
        const amountToAdd = baseAmount * source.portionFactor;
        if (current) {
          current.totalAmount += amountToAdd;
          continue;
        }
        aggregated.set(productKey, {
          productKey,
          name: displayName,
          unit: baseUnit,
          department: toShoppingDepartment(ingredient.department),
          totalAmount: amountToAdd,
        });
      }
    }

    // Drugie źródło: to, co ktoś dopisał ręcznie ze szczegółu przepisu.
    // Ilość jest już przeliczona na porcje przy zapisie, a klucz liczony tak
    // samo jak wyżej — więc „Mleko" z planu i „Mleko" dopisane stają się
    // jedną pozycją z sumą, a nie dwoma wierszami.
    const extras = await this.loadExtras(client, {
      householdId,
      weekStart: weekStartDate,
    });
    for (const extra of extras) {
      const current = aggregated.get(extra.productKey);
      if (current) {
        current.totalAmount += extra.amount;
        continue;
      }
      aggregated.set(extra.productKey, {
        productKey: extra.productKey,
        name: extra.name,
        unit: extra.unit,
        department: extra.department,
        totalAmount: extra.amount,
      });
    }

    if (missingNormalization.size > 0) {
      this.logger.warn(
        `Składniki bez znormalizowanej ilości, lista liczy z surowej: ${Array.from(missingNormalization).join(', ')} (householdId=${householdId}, weekStart=${formatWeekStart(weekStartDate)})`,
      );
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
    const aggregatedItems = await this.buildShoppingListBase(
      householdId,
      weekStartDate,
      tx,
    );

    const shoppingList = await tx.shoppingList.upsert({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      update: {
        isStale: false,
        rulesVersion: SHOPPING_LIST_RULES_VERSION,
        updatedAt: new Date(),
      },
      create: {
        householdId,
        weekStart: weekStartDate,
        isStale: false,
        rulesVersion: SHOPPING_LIST_RULES_VERSION,
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
    const legacyChecks =
      productKeys.length > 0
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
      // Baseline z archiwum jest zapisany po zaokrągleniu
      // (`buildDisplayShoppingItems`), a `item.totalAmount` jeszcze nie —
      // porównanie surowej sumy z zaokrąglonym baseline'em odznaczało
      // pozycję po samym odświeżeniu (0.375 vs 0.38). To samo zaokrąglenie
      // co na liście, także dla sztuk (w górę do połówki).
      const nextAmount = roundShoppingAmount(item.totalAmount, item.unit);
      const hasNewUncheckedDelta = Boolean(
        currentArchiveState?.currentArchiveId &&
        nextAmount > previousAmount + 0.000_001,
      );

      checkedMap.set(
        item.productKey,
        hasNewUncheckedDelta
          ? false
          : (existingCheckedMap.get(item.productKey) ??
              legacyCheckedMap.get(item.productKey) ??
              false),
      );
    }

    const nextItems = buildDisplayShoppingItems(aggregatedItems, checkedMap);

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

    // Jedno zapytanie o stan, jedno `createMany` na nowe pozycje i update
    // tylko tam, gdzie coś się zmieniło — zamiast upsertu na KAŻDĄ pozycję
    // w transakcji (lista na 60 produktów = 60 rund do bazy).
    const existingItems = await tx.shoppingListItem.findMany({
      where: { shoppingListId: shoppingList.id },
      select: {
        productKey: true,
        name: true,
        unit: true,
        department: true,
        totalAmount: true,
        isChecked: true,
      },
    });
    const existingByKey = new Map(
      existingItems.map((item) => [item.productKey, item]),
    );
    const toCreate = nextItems.filter(
      (item) => !existingByKey.has(item.productKey),
    );
    if (toCreate.length > 0) {
      await tx.shoppingListItem.createMany({
        data: toCreate.map((item) => ({
          shoppingListId: shoppingList.id,
          productKey: item.productKey,
          name: item.name,
          unit: item.unit,
          department: item.department,
          totalAmount: item.totalAmount,
          isChecked: item.isChecked,
        })),
      });
    }
    for (const item of nextItems) {
      const current = existingByKey.get(item.productKey);
      if (!current) continue;
      if (
        current.name === item.name &&
        current.unit === item.unit &&
        current.department === item.department &&
        current.totalAmount === item.totalAmount &&
        current.isChecked === item.isChecked
      ) {
        continue;
      }
      await tx.shoppingListItem.update({
        where: {
          shoppingListId_productKey: {
            shoppingListId: shoppingList.id,
            productKey: item.productKey,
          },
        },
        data: {
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
    // `PlanItem` albo dopisane pozycje. Dzięki temu widmowa lista — snapshot zbudowany kiedyś
    // z wycofanej puli, dziś bez pokrycia w planie dnia — sama zeruje się przy
    // pierwszym odczycie: „ma pozycje, nie ma źródła" wymusza przebudowę do
    // pustej listy, bez ręcznego SQL-a.
    const weeklyPlan = await client.weeklyPlan.findUnique({
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
    });

    if ((weeklyPlan?.items.length ?? 0) > 0) {
      return true;
    }
    // Lista z samych dopisanych pozycji też ma źródło — bez tego każdy odczyt
    // takiej listy przebudowywałby ją od nowa jako „widmową".
    const extra = await client.shoppingListExtra.findFirst({
      where: { householdId, weekStart: weekStartDate },
      select: { id: true },
    });
    return extra !== null;
  }

  private async rebuildShoppingListSnapshotWithClient(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<ShoppingListItem[]> {
    if (client === this.prisma) {
      return this.prisma.$transaction((tx) =>
        this.rebuildShoppingListSnapshot(householdId, weekStartDate, tx),
      );
    }

    return this.rebuildShoppingListSnapshot(
      householdId,
      weekStartDate,
      client as Prisma.TransactionClient,
    );
  }

  async markShoppingListStale(
    householdId: string,
    weekStartDate: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.shoppingList.upsert({
      where: {
        householdId_weekStart: {
          householdId,
          weekStart: weekStartDate,
        },
      },
      update: {
        isStale: true,
        updatedAt: new Date(),
      },
      create: {
        householdId,
        weekStart: weekStartDate,
        isStale: true,
      },
      select: { id: true },
    });
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
      if (
        snapshot.isStale ||
        snapshot.rulesVersion < SHOPPING_LIST_RULES_VERSION
      ) {
        return this.rebuildShoppingListSnapshotWithClient(
          householdId,
          weekStartDate,
          client,
        );
      }
      const hasSourceData = await this.hasShoppingSourceData(
        householdId,
        weekStartDate,
        client,
      );
      if (snapshot.items.length === 0 && hasSourceData) {
        return this.rebuildShoppingListSnapshotWithClient(
          householdId,
          weekStartDate,
          client,
        );
      }
      if (snapshot.items.length > 0 && !hasSourceData) {
        return this.rebuildShoppingListSnapshotWithClient(
          householdId,
          weekStartDate,
          client,
        );
      }
      return mapSnapshotItems(snapshot.items);
    }

    return this.rebuildShoppingListSnapshotWithClient(
      householdId,
      weekStartDate,
      client,
    );
  }

  async getShoppingList(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);
    return this.getShoppingListSnapshot(householdId, weekStartDate);
  }

  async getShoppingListState(
    userId: string,
    householdId: string,
    weekStart: string,
  ): Promise<ShoppingListStateDto> {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const [items, archives, currentArchiveStates, currentWeekArchiveState] =
      await Promise.all([
        this.getShoppingListSnapshot(householdId, weekStartDate),
        this.prisma.shoppingListArchive.findMany({
          where: { householdId },
          orderBy: [{ archivedAt: 'desc' }, { revision: 'desc' }],
          // Ekran pokazuje ostatnie tygodnie; dom z dwuletnią historią
          // ładował setki archiwów z tysiącami pozycji przy każdym wejściu.
          take: MAX_ARCHIVES_IN_STATE,
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
    const shouldHideCurrentWeekList =
      currentWeekArchiveState?.currentArchiveId === null;

    const addedFrom = shouldHideCurrentWeekList
      ? new Map<string, string[]>()
      : await this.extrasSourcesByProduct(householdId, weekStartDate);

    return {
      items: shouldHideCurrentWeekList
        ? []
        : items.map((item) => ({
            ...item,
            addedFrom: addedFrom.get(item.productKey) ?? [],
          })),
      archives: archives.map((archive) =>
        toArchiveSnapshot(archive, currentArchiveIds),
      ),
    };
  }

  async archiveShoppingList(
    userId: string,
    householdId: string,
    weekStart: string,
    weekLabelInput: string,
  ) {
    const weekLabel = assertWeekLabel(weekLabelInput);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return runSerializable(this.prisma, async (tx) => {
      const items = await this.getShoppingListSnapshot(
        householdId,
        weekStartDate,
        tx,
      );

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

      const signature = itemSignature(items);
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
    // `archiveId` idzie w `findUnique` po kolumnie `@db.Uuid` — bez bramki
    // śmieć z koperty kończył się P2023 → 500.
    assertUuid(archiveId, 'archiveId');
    await ensureMembership(this.prisma, userId, householdId);

    return runSerializable(this.prisma, async (tx) => {
      const archive = await tx.shoppingListArchive.findUnique({
        where: { id: archiveId },
        select: {
          id: true,
          householdId: true,
          weekStart: true,
        },
      });

      // Cudze archiwum = „nie ma takiego": nie zdradzamy, że id istnieje.
      if (!archive || archive.householdId !== householdId) {
        throw archiveNotFound();
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
        weekStart: formatWeekStart(archive.weekStart),
      };
    });
  }

  async deleteShoppingListArchive(
    userId: string,
    householdId: string,
    archiveId: string,
  ) {
    assertUuid(archiveId, 'archiveId');
    await ensureMembership(this.prisma, userId, householdId);

    return runSerializable(this.prisma, async (tx) => {
      const archive = await tx.shoppingListArchive.findUnique({
        where: { id: archiveId },
        select: {
          id: true,
          householdId: true,
          weekStart: true,
        },
      });

      if (!archive || archive.householdId !== householdId) {
        throw archiveNotFound();
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
        weekStart: formatWeekStart(weekStart),
      };
    });
  }

  async deleteAllShoppingListArchives(
    userId: string,
    householdId: string,
    weekStart: string,
  ) {
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return runSerializable(this.prisma, async (tx) => {
      // Zawężone do TEGO tygodnia: żądanie niesie `weekStart`, klient
      // rozgłasza zmianę dla tego tygodnia, a kasowanie wszystkich tygodni
      // zabierało archiwa, o których nikt na ekranie nie wiedział.
      await tx.shoppingListArchiveState.deleteMany({
        where: { householdId, weekStart: weekStartDate },
      });
      await tx.shoppingListArchive.deleteMany({
        where: { householdId, weekStart: weekStartDate },
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

  /**
   * Przepisy, z których dopisano coś do listy — po `productKey`, tytułami.
   *
   * Tylko do pokazania („dopisane z: Owsianka z bananem") i do decyzji, czy
   * wiersz da się zdjąć z listy. Nie wchodzi do migawki `ShoppingListItem`,
   * bo nie jest stanem listy, tylko opisem jej pochodzenia.
   */
  private async extrasSourcesByProduct(
    householdId: string,
    weekStartDate: Date,
  ): Promise<Map<string, string[]>> {
    const rows = await this.loadExtras(this.prisma, {
      householdId,
      weekStart: weekStartDate,
    });
    const byProduct = new Map<string, string[]>();
    for (const row of rows) {
      const titles = byProduct.get(row.productKey) ?? [];
      if (!titles.includes(row.recipeTitle)) {
        titles.push(row.recipeTitle);
      }
      byProduct.set(row.productKey, titles);
    }
    return byProduct;
  }

  /**
   * Dopisane pozycje tygodnia z kluczem i ilością w jednostce listy.
   *
   * Wiersz zapisany przed ujednoliceniem jednostek (22.09.2026) ma klucz
   * `cebula::g` i ilość w gramach, a plan liczy już cebulę w sztukach —
   * bez przeliczenia wróciłyby dwa wiersze „Cebula (g)” i „Cebula (szt)”.
   * Przeliczamy go przy odczycie tak samo jak plan (`toShoppingUnit`),
   * z masą sztuki z przepisu, z którego go dopisano, zamiast przepisywać
   * tabelę migracją. Wiersze nowsze są już w jednostce listy i przechodzą
   * bez zmian. Kolejność: od najstarszego (`addedFrom` pokazuje ją tak).
   */
  private async loadExtras(
    client: PrismaReadClient,
    where: Prisma.ShoppingListExtraWhereInput,
  ): Promise<ShoppingExtraRow[]> {
    const rows = await client.shoppingListExtra.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        productKey: true,
        name: true,
        unit: true,
        department: true,
        amount: true,
        recipe: {
          select: {
            title: true,
            ingredients: {
              select: {
                name: true,
                ingredient: { select: { gramsPerPiece: true } },
              },
            },
          },
        },
      },
    });
    return rows.map((row) => {
      const separator = row.productKey.lastIndexOf('::');
      const keyName =
        separator >= 0 ? row.productKey.slice(0, separator) : row.productKey;
      const source = row.recipe.ingredients.find(
        (ingredient) => ingredient.name.trim().toLowerCase() === keyName,
      );
      const shopping = toShoppingUnit(
        row.amount,
        row.unit,
        source?.ingredient.gramsPerPiece,
      );
      return {
        id: row.id,
        storedKey: row.productKey,
        productKey:
          shopping.unit === row.unit
            ? row.productKey
            : normalizeProductKey(keyName, shopping.unit),
        name: row.name,
        unit: shopping.unit,
        department: row.department,
        amount: shopping.amount,
        recipeTitle: row.recipe.title,
      };
    });
  }

  /**
   * „Brakuje mi" ze szczegółu przepisu — dopisuje wybrane składniki do listy
   * zakupów tygodnia.
   *
   * Przepis musi być widoczny dla gospodarstwa (katalog albo własny, aktywny)
   * — ta sama bramka, co przy wstawianiu do planu. Ilości liczy serwer
   * z `RecipeIngredient` przeskalowanego na `servings` porcji; ponowne
   * dopisanie tego samego przepisu podmienia ilość, a nie dokłada drugą.
   *
   * Dopisany produkt, który był już odhaczony jako kupiony, wraca na listę
   * jako niekupiony: skoro ktoś mówi, że go brakuje, to trzeba go dokupić.
   */
  async addRecipeExtras(
    userId: string,
    householdId: string,
    weekStart: string,
    input: AddRecipeExtrasDto,
  ): Promise<{ added: number; productKeys: string[] }> {
    const dto = await validateDto(AddRecipeExtrasDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    const recipe = await this.prisma.recipe.findFirst({
      where: {
        id: dto.recipeId,
        isActive: true,
        OR: [{ isCatalog: true }, { householdId }],
      },
      select: {
        id: true,
        servings: true,
        ingredients: {
          where: { id: { in: dto.ingredientIds } },
          select: {
            id: true,
            name: true,
            normalizedAmount: true,
            normalizedUnit: true,
            department: true,
            ingredient: { select: { gramsPerPiece: true } },
          },
        },
      },
    });

    // Cudzy, wycofany i nieistniejący przepis to z punktu widzenia
    // wołającego to samo — tak samo jak w planie.
    if (!recipe) {
      throw new AppException(
        'RECIPE_NOT_FOUND',
        'Nie znaleziono przepisu.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (recipe.ingredients.length !== dto.ingredientIds.length) {
      const detail = 'ingredientIds must belong to the recipe';
      throw new AppException(
        'VALIDATION_ERROR',
        detail,
        HttpStatus.BAD_REQUEST,
        [detail],
      );
    }

    const factor = dto.servings / Math.max(1, recipe.servings);
    const byKey = new Map<string, ShoppingAccumulator>();
    for (const ingredient of recipe.ingredients) {
      // Ta sama jednostka co w planie (`toShoppingUnit`) — inaczej dopisana
      // „cebula” w gramach nie trafiłaby w wiersz „cebula” w sztukach.
      const shopping = toShoppingUnit(
        ingredient.normalizedAmount,
        ingredient.normalizedUnit,
        ingredient.ingredient.gramsPerPiece,
      );
      const productKey = normalizeProductKey(ingredient.name, shopping.unit);
      const amount = shopping.amount * factor;
      const current = byKey.get(productKey);
      if (current) {
        current.totalAmount += amount;
        continue;
      }
      byKey.set(productKey, {
        productKey,
        name: toTitleCase(ingredient.name),
        unit: shopping.unit,
        department: toShoppingDepartment(ingredient.department),
        totalAmount: amount,
      });
    }
    const entries = Array.from(byKey.values());
    const productKeys = entries.map((entry) => entry.productKey);

    // Kolejność blokad jak w reszcie domeny (CLAUDE.md, „Zamek zapisu
    // tygodnia"): `ShoppingListArchiveState` → dopisane → `ShoppingList` →
    // `ShoppingListItem` → `ShoppingItemCheck`. Odwrócona kończy się
    // `40P01`, którego `runSerializable` nie ponawia.
    await runSerializable(this.prisma, async (tx) => {
      // Tydzień z wyczyszczoną historią ma listę schowaną (stan archiwum
      // z `currentArchiveId = null`). Świadome dopisanie znaczy „idę na
      // zakupy" — lista musi się pokazać, inaczej dopisane znikałoby
      // w próżni.
      await tx.shoppingListArchiveState.deleteMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          currentArchiveId: null,
        },
      });

      // Wiersz tego przepisu sprzed ujednolicenia jednostek (`cebula::g`)
      // liczy się dziś pod tym samym kluczem, co nowy zapis (`cebula::szt`).
      // Zostawiony dodałby się do podmienionej ilości — a ponowne dopisanie
      // ma ją podmieniać, nie dublować.
      const superseded = (
        await this.loadExtras(tx, {
          householdId,
          weekStart: weekStartDate,
          recipeId: recipe.id,
        })
      ).filter(
        (extra) =>
          extra.storedKey !== extra.productKey &&
          productKeys.includes(extra.productKey),
      );
      if (superseded.length > 0) {
        await tx.shoppingListExtra.deleteMany({
          where: { id: { in: superseded.map((extra) => extra.id) } },
        });
      }

      for (const entry of entries) {
        await tx.shoppingListExtra.upsert({
          where: {
            householdId_weekStart_recipeId_productKey: {
              householdId,
              weekStart: weekStartDate,
              recipeId: recipe.id,
              productKey: entry.productKey,
            },
          },
          update: {
            name: entry.name,
            unit: entry.unit,
            department: entry.department,
            amount: entry.totalAmount,
          },
          create: {
            householdId,
            weekStart: weekStartDate,
            recipeId: recipe.id,
            productKey: entry.productKey,
            name: entry.name,
            unit: entry.unit,
            department: entry.department,
            amount: entry.totalAmount,
          },
        });
      }

      await this.markShoppingListStale(householdId, weekStartDate, tx);

      // Kupione → do kupienia. Oba zapisy stanu, bo przebudowa migawki
      // czyta i `ShoppingListItem`, i starszy `ShoppingItemCheck`.
      await tx.shoppingListItem.updateMany({
        where: {
          shoppingList: { householdId, weekStart: weekStartDate },
          productKey: { in: productKeys },
        },
        data: { isChecked: false },
      });
      await tx.shoppingItemCheck.updateMany({
        where: {
          householdId,
          weekStart: weekStartDate,
          productKey: { in: productKeys },
        },
        data: { isChecked: false },
      });
    });

    return { added: entries.length, productKeys };
  }

  /**
   * Zdejmuje z listy DOPISANĄ część produktu — ze wszystkich przepisów
   * naraz. Ilość z planu zostaje; wiersz znika tylko wtedy, gdy poza
   * dopisanym nic go nie trzymało.
   */
  async removeShoppingExtra(
    userId: string,
    householdId: string,
    weekStart: string,
    input: RemoveShoppingExtraDto,
  ): Promise<{ removed: number }> {
    const dto = await validateDto(RemoveShoppingExtraDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return this.prisma.$transaction(async (tx) => {
      // Po kluczu w jednostce listy, nie po kluczu z bazy: wiersz „Cebula”
      // w sztukach zbiera też dopisane sprzed ujednolicenia (`cebula::g`),
      // a zdjęcie ma zabrać całą dopisaną część, którą widać na ekranie.
      const ids = (
        await this.loadExtras(tx, { householdId, weekStart: weekStartDate })
      )
        .filter((extra) => extra.productKey === dto.productKey)
        .map((extra) => extra.id);
      const { count } =
        ids.length > 0
          ? await tx.shoppingListExtra.deleteMany({
              where: { id: { in: ids } },
            })
          : { count: 0 };
      if (count === 0) {
        throw new AppException(
          'SHOPPING_ITEM_NOT_FOUND',
          'Nie znaleziono pozycji listy zakupów',
          HttpStatus.NOT_FOUND,
        );
      }
      await this.markShoppingListStale(householdId, weekStartDate, tx);
      return { removed: count };
    });
  }

  async setShoppingItemChecked(
    userId: string,
    householdId: string,
    weekStart: string,
    input: UpdateShoppingItemCheckDto,
  ) {
    // Walidacja na wejściu, PRZED pierwszym zapytaniem — dekoratory DTO nie
    // działają na WS, a `isChecked: "tak"` szło dotąd prosto do Prismy.
    const dto = await validateDto(UpdateShoppingItemCheckDto, input);
    await ensureMembership(this.prisma, userId, householdId);
    const weekStartDate = parseWeekStart(weekStart);

    return this.prisma.$transaction(async (tx) => {
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
        throw new AppException(
          'SHOPPING_ITEM_NOT_FOUND',
          'Nie znaleziono pozycji listy zakupów',
          HttpStatus.NOT_FOUND,
        );
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
}
