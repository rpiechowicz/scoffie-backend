import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  hasRealPurchaseIdentityPepper,
  purchaseIdentityHashForUser,
} from '../config/purchase-identity';

/**
 * Strażnik pieprza tożsamości zakupowej.
 *
 * PO CO. `PURCHASE_IDENTITY_PEPPER` jest jedynym sekretem w tej aplikacji,
 * którego zmiana jest NIEODWRACALNA i CAŁKOWICIE CICHA. Na nim wisi hasz, po
 * którym rozpoznajemy człowieka po skasowaniu konta — a więc i opłacona
 * subskrypcja, i licznik zużytej darmowej próby. Po zmianie pieprza:
 *
 *   • każdy dostaje świeżą darmową próbę (bo `trial:<hasz>` to inny zakres),
 *   • każda opłacona subskrypcja przestaje pasować do właściciela, więc
 *     płacący klienci tracą PRO — wszyscy naraz i bez jednego błędu w logu.
 *
 * Nic tego nie wykrywało. Aplikacja wstawała normalnie, endpointy odpowiadały
 * 200, a jedynym objawem była fala reklamacji „płacę i nie mam asystenta".
 *
 * JAK TO SPRAWDZAMY BEZ DODATKOWEJ TABELI. Hasz jest funkcją `appleSub` i
 * pieprza, a `appleSub` mamy w bazie. Bierzemy więc kilku użytkowników, którzy
 * mają OBA pola, i przeliczamy ich hasze bieżącym pieprzem. Jeśli ani jeden się
 * nie zgadza, pieprz jest inny niż ten, którym je zapisano.
 *
 * NIE BLOKUJE STARTU. Zablokowany deploy to cała aplikacja w dół, a to jest
 * stan, który i tak trzeba naprawić ręcznie (przywrócić stary pieprz albo
 * przeliczyć hasze migracją — patrz `docs/ROTACJA-SEKRETOW.md`). Ma być
 * GŁOŚNY, nie zabójczy.
 */
@Injectable()
export class PurchaseIdentityGuardService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurchaseIdentityGuardService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.check();
    } catch (error) {
      // Baza może jeszcze wstawać. To jest kontrola, nie warunek startu.
      this.logger.warn(
        `Nie udało się sprawdzić pieprza tożsamości zakupowej: ${String(error)}`,
      );
    }
  }

  /** `true` = hasze w bazie zgadzają się z bieżącym pieprzem (albo nie ma czego sprawdzać). */
  async check(): Promise<boolean> {
    const probes = await this.prisma.user.findMany({
      where: { identityHash: { not: null }, appleSub: { not: null } },
      select: {
        id: true,
        identityHash: true,
        appleSub: true,
        googleId: true,
        authProvider: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });
    if (probes.length === 0) {
      // Pusta baza albo same konta bez logowania zewnętrznego. Nie ma czego
      // porównać — i nie ma czego zepsuć, bo pierwszy hasz dopiero powstanie.
      if (!hasRealPurchaseIdentityPepper()) {
        this.logger.warn(
          'PURCHASE_IDENTITY_PEPPER jest domyślny — ustaw go TERAZ, zanim powstanie pierwszy hasz. Później zmiana odpina wszystkie subskrypcje.',
        );
      }
      return true;
    }

    const matches = probes.filter(
      (user) => purchaseIdentityHashForUser(user) === user.identityHash,
    ).length;
    if (matches > 0) return true;

    const subscriptions = await this.prisma.subscription.count({
      where: { status: { in: ['ACTIVE', 'GRACE'] } },
    });
    this.logger.error(
      `PURCHASE_IDENTITY_PEPPER NIE PASUJE DO BAZY. Żaden z ${probes.length} sprawdzonych haszy nie odtwarza się bieżącym pieprzem. ` +
        `Skutek: ${subscriptions} żywych subskrypcji przestało pasować do właścicieli (płacący tracą PRO), a darmowa próba zaczyna się każdemu od nowa. ` +
        'Przywróć poprzednią wartość albo przelicz hasze — patrz docs/ROTACJA-SEKRETOW.md.',
    );
    return false;
  }
}
