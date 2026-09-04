import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { OpsTokenGuard } from '../observability/ops-token.guard';
import { SUBSCRIPTION_PRODUCTS } from '../config/subscription-products';
import {
  purchaseIdentityHashForUser,
  subscriptionScopeId,
} from '../config/purchase-identity';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsReconcileService } from './subscriptions-reconcile.service';

/**
 * Obsługa klienta po stronie operatora — wszystko za `x-ops-token`.
 *
 * PO CO TO ISTNIEJE. Audyt wskazał dwie sytuacje, w których bez tych
 * endpointów zostawało tylko wejście do bazy z ręki:
 *   • „zapłaciłem i nie mam PRO" — trzeba móc zobaczyć, co Apple o tym mówi,
 *     i wymusić uzgodnienie bez czekania na kolejny przebieg;
 *   • „sufit kosztu domu mnie odciął" — płacący klient blokuje się na naszym
 *     bezpieczniku, a bezpiecznik nie miał żadnego przycisku zwalniającego.
 *
 * Nadanie ręczne (`MANUAL`) obsługuje trzeci przypadek: konto recenzenta App
 * Store, rekompensata i rodzina testująca. Nie chodzi przez Apple, więc nie ma
 * `originalTransactionId` i nie jest uzgadniane.
 */

export class GrantManualDto {
  /**
   * Hasz tożsamości obdarowanej osoby (z `GET /ops/billing/subscriptions`).
   * Zamiast niego można podać `userId` — serwer policzy hasz sam.
   */
  @IsOptional()
  @IsString()
  identityHash?: string;

  /** Konto obdarowanej osoby. Wygodniejsze i trudniejsze do pomylenia. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  productId!: string;

  /** Na ile miesięcy; 0 = bezterminowo (konto recenzenta). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  months!: number;

  /**
   * Nadanie na hasz, do którego nie ma dziś żadnego konta. Domyślnie odmawiamy:
   * nadanie na literówkę wygląda w odpowiedzi jak sukces i nie robi NIC, a
   * dowiadujemy się o tym z drugiej reklamacji tego samego klienta.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class RevokeDto {
  /** Po co odebrano dostęp — zostaje w wierszu, żeby dało się to odkręcić. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class LookupQueryDto {
  @IsOptional()
  @IsString()
  originalTransactionId?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}

@Controller('ops/billing')
@UseGuards(OpsTokenGuard)
export class BillingOpsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly reconciler: SubscriptionsReconcileService,
  ) {}

  /** Wyszukanie subskrypcji po transakcji Apple albo po koncie. */
  @Get('subscriptions')
  async lookup(@Query() query: LookupQueryDto) {
    if (query.userId) {
      return { subscriptions: await this.subscriptions.forUser(query.userId) };
    }
    if (!query.originalTransactionId) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj originalTransactionId albo userId.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const row = await this.prisma.subscription.findUnique({
      where: { originalTransactionId: query.originalTransactionId },
    });
    return { subscription: row ?? null };
  }

  /** Wymuszone uzgodnienie z Apple dla jednej subskrypcji. */
  @Post('subscriptions/:id/reconcile')
  async reconcile(@Param('id') id: string) {
    return { reconciled: await this.subscriptions.reconcile(id) };
  }

  /** Cały przebieg od ręki: zaległe zdarzenia + nieświeże subskrypcje. */
  @Post('sweep')
  async sweep() {
    return this.reconciler.sweep();
  }

  /**
   * Odebranie dostępu po zwrocie pieniędzy, gdy powiadomienie nie doszło.
   *
   * Bez tego degradacja po zwrocie była cichym no-opem: operator „coś klikał",
   * a `resolvePlan` dalej widziało ACTIVE z datą w przyszłości.
   */
  @Post('subscriptions/:id/revoke')
  async revoke(@Param('id') id: string, @Body() dto: RevokeDto) {
    const now = new Date();
    const updated = await this.prisma.subscription.updateMany({
      where: { id },
      data: {
        status: 'REVOKED',
        revokedAt: now,
        // BLOKADA JEST TYM, CO ZOSTAJE. `status` i `revokedAt` przepisuje
        // KAŻDE uzgodnienie z Apple i każde zgłoszenie z telefonu — więc samo
        // ich ustawienie znaczyło „dostęp wraca przy najbliższym »Przywróć
        // zakupy«". Tej kolumny nie rusza nic poza operatorem.
        operatorHoldAt: now,
        operatorHoldReason: dto?.reason?.trim() || 'Odebrane przez obsługę.',
      },
    });
    if (updated.count === 0) {
      throw new AppException(
        'NOT_FOUND',
        'Nie znaleziono subskrypcji.',
        HttpStatus.NOT_FOUND,
      );
    }
    return { revoked: true, holdAt: now.toISOString() };
  }

  /**
   * Zdjęcie blokady operatora. Osobny przycisk, bo pomyłka przy odbieraniu
   * dostępu musi dać się cofnąć bez wchodzenia do bazy — a przy okazji
   * uzgadniamy stan z Apple, żeby nie zostawić wiersza z ręcznym REVOKED.
   */
  @Post('subscriptions/:id/unhold')
  async unhold(@Param('id') id: string) {
    const updated = await this.prisma.subscription.updateMany({
      where: { id },
      data: { operatorHoldAt: null, operatorHoldReason: null },
    });
    if (updated.count === 0) {
      throw new AppException(
        'NOT_FOUND',
        'Nie znaleziono subskrypcji.',
        HttpStatus.NOT_FOUND,
      );
    }
    return { held: false, reconciled: await this.subscriptions.reconcile(id) };
  }

  /**
   * Powiadomienia Apple, których nie udało się przetworzyć albo które zamknięto
   * z powodem. Bez tego takie zdarzenie przepadało po cichu: Apple ponawia pięć
   * razy przez trzy doby i przestaje, a w kodzie nie było ani jednego miejsca,
   * w którym dałoby się je zobaczyć.
   */
  @Get('notifications/failed')
  async failedNotifications() {
    const rows = await this.prisma.appleNotification.findMany({
      where: { OR: [{ processedAt: null }, { error: { not: null } }] },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        notificationUuid: true,
        notificationType: true,
        subtype: true,
        originalTransactionId: true,
        environment: true,
        attempts: true,
        error: true,
        receivedAt: true,
        processedAt: true,
      },
    });
    return { notifications: rows };
  }

  /**
   * Nadanie ręczne: konto recenzenta App Store, rekompensata, rodzina
   * testująca. `MANUAL`, więc uzgadnianie z Apple je omija.
   */
  @Post('grant')
  async grant(@Body() dto: GrantManualDto) {
    const product = SUBSCRIPTION_PRODUCTS[dto.productId];
    if (!product) {
      throw new AppException(
        'VALIDATION_ERROR',
        `Nieznany produkt: ${dto.productId}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // KOMU TO NADAJEMY. Wcześniej przyjmowaliśmy dowolny napis: literówka w
    // haszu dawała 201 z identyfikatorem wiersza i nie robiła NIC — bo
    // `resolvePlan` szuka po haszach domowników, a taki wiersz nie pasował do
    // nikogo. Wyglądało to jak udane nadanie, więc recenzent App Store albo
    // klient po reklamacji dalej siedział bez dostępu.
    const identityHash = await this.resolveGrantIdentity(dto);

    const now = new Date();
    const expiresAt =
      dto.months > 0
        ? new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth() + dto.months,
              now.getUTCDate(),
            ),
          )
        : null;
    const created = await this.prisma.subscription.create({
      data: {
        identityHash,
        provider: 'MANUAL',
        productId: dto.productId,
        status: 'ACTIVE',
        expiresAt,
        // Bezterminowe wolno TYLKO tutaj — dla APPLE brak daty znaczy „nie
        // wiemy", czyli martwa.
        neverExpires: dto.months === 0,
        messagesLimitSnapshot: product.messagesPerMonth,
        plansLimitSnapshot: product.plansPerMonth,
        lastVerifiedAt: now,
      },
    });
    return {
      subscriptionId: created.id,
      identityHash,
      expiresAt,
      product: product.name,
    };
  }

  /** `userId` → hasz, albo podany hasz sprawdzony pod kątem „czy do kogoś trafia". */
  private async resolveGrantIdentity(dto: GrantManualDto): Promise<string> {
    if (dto.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: dto.userId },
        select: {
          identityHash: true,
          appleSub: true,
          googleId: true,
          authProvider: true,
        },
      });
      const hash =
        user?.identityHash ??
        (user ? purchaseIdentityHashForUser(user) : null) ??
        null;
      if (!hash) {
        throw new AppException(
          'VALIDATION_ERROR',
          'To konto nie ma tożsamości zakupowej — zaloguj je raz przez Apple albo podaj identityHash z force.',
          HttpStatus.BAD_REQUEST,
        );
      }
      return hash;
    }

    const hash = dto.identityHash?.trim();
    if (!hash) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Podaj userId albo identityHash.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!dto.force) {
      const owner = await this.prisma.user.findFirst({
        where: { identityHash: hash },
        select: { id: true },
      });
      if (!owner) {
        throw new AppException(
          'VALIDATION_ERROR',
          'Żadne konto nie ma tego hasza tożsamości. Sprawdź go albo powtórz z force:true, jeśli nadajesz z wyprzedzeniem.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return hash;
  }

  /**
   * Zwolnienie sufitu kosztu miesięcznego gospodarstwa.
   *
   * Sufit (`AI_HOUSEHOLD_MONTHLY_COST_USD`) jest bezpiecznikiem przed pętlą
   * błędów, a nie limitem sprzedanym klientowi — więc gdy odetnie kogoś, kto
   * mieści się w tym, co kupił, musi istnieć sposób, żeby go zwolnić bez
   * wchodzenia do bazy.
   */
  @Post('households/:id/cost-reset')
  async resetCost(@Param('id') householdId: string) {
    const periodKey = new Date().toISOString().slice(0, 7);
    const result = await this.prisma.aiUsageCounter.updateMany({
      where: { scopeId: householdId, periodKey, kind: 'costMicroUsd' },
      data: { value: 0 },
    });
    return { reset: result.count, periodKey };
  }

  /**
   * Podgląd zużycia w zakresie subskrypcji — do odpowiedzi na „ile mi zostało",
   * gdy klient pyta przez wsparcie, a nie przez aplikację.
   */
  @Get('subscriptions/:id/usage')
  async usage(@Param('id') id: string) {
    const periodKey = new Date().toISOString().slice(0, 7);
    const rows = await this.prisma.aiUsageCounter.findMany({
      where: { scopeId: subscriptionScopeId(id), periodKey },
      select: { kind: true, value: true },
    });
    return { periodKey, counters: rows };
  }
}
