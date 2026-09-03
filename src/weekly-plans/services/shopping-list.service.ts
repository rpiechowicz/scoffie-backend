import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { assertUuid } from '../../common/uuid';
import { validateDto } from '../../common/validate-dto';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateShoppingItemCheckDto } from '../dto/update-shopping-item-check.dto';
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
  toArchiveSnapshot,
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
                  },
                },
              },
            },
          },
        },
      },
    });

    // `PlanItem` jest JEDYNYM źródłem listy. Wycofana pula tygodniowa
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
        const baseAmount = ingredient.normalizedAmount ?? ingredient.amount;
        const baseUnit = ingredient.normalizedUnit ?? ingredient.unit;
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
        updatedAt: new Date(),
      },
      create: {
        householdId,
        weekStart: weekStartDate,
        isStale: false,
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
      // Baseline z archiwum jest zapisany po zaokrągleniu do 2 miejsc
      // (`buildDisplayShoppingItems`), a `item.totalAmount` jeszcze nie —
      // porównanie surowej sumy z zaokrąglonym baseline'em odznaczało
      // pozycję po samym odświeżeniu (0.375 vs 0.38).
      const nextAmount = Number(item.totalAmount.toFixed(2));
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
    // Tylko `PlanItem`. Dzięki temu widmowa lista — snapshot zbudowany kiedyś
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

    return (weeklyPlan?.items.length ?? 0) > 0;
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
      if (snapshot.isStale) {
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

    return {
      items: shouldHideCurrentWeekList ? [] : items,
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
