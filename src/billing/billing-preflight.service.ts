import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppStoreServerClient } from './app-store-server.client';
import { readBillingEnv } from './billing-env';

export type PreflightStan = 'nieznany' | 'ok' | 'klucz';

export type PreflightWynik = {
  stan: PreflightStan;
  szczegol: string;
  sprawdzoneO: string | null;
};

/**
 * Czy Apple w ogóle nas zna — sprawdzone, a nie założone.
 *
 * PO CO. Do tej pory `purchasesEnabled`, czyli jedyna bramka na przycisk „Kup"
 * w telefonie, wyliczało się z tego, że TRZY ZMIENNE ŚRODOWISKOWE SĄ NIEPUSTE.
 * Nic — ani start serwera, ani `/ops/health`, ani żaden skrypt — nie wykonywało
 * ani jednego żądania do Apple, żeby to sprawdzić. Wystarczyło wkleić klucz
 * App Store Connect API zamiast klucza In-App Purchase (oba są ES256, oba
 * podpiszą nasz token, oba wyglądają identycznie), żeby:
 *
 *   1. paywall pokazał się jako sprawny,
 *   2. pierwszy klient zapłacił 29,99 zł,
 *   3. Apple odpowiedziało 401,
 *   4. klient zobaczył „App Store chwilowo nie odpowiada",
 *   5. i widział to dalej, bo zły klucz nie mija sam.
 *
 * Dowiedzielibyśmy się o tym z reklamacji. Teraz dowiadujemy się z logu przy
 * starcie, zanim ktokolwiek zapłaci.
 *
 * DLACZEGO TYLKO 401/403 GASI SPRZEDAŻ. Odmowa uwierzytelnienia nie mija sama —
 * to zawsze nasz błąd i nie ma powodu przyjmować za nią pieniędzy. Awaria sieci
 * albo pięćsetka u Apple to co innego: mija po kwadransie, a wyłączenie
 * sprzedaży na czas cudzej awarii byłoby gorsze od problemu.
 */
@Injectable()
export class BillingPreflightService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingPreflightService.name);
  private wynik: PreflightWynik = {
    stan: 'nieznany',
    szczegol: 'Jeszcze nie sprawdzano.',
    sprawdzoneO: null,
  };

  constructor(private readonly appStore: AppStoreServerClient) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!readBillingEnv().enabled) {
      this.logger.log(
        'Płatności wyłączone — nie pytam Apple o klucz (i tak nie ma czego sprzedawać).',
      );
      return;
    }
    await this.sprawdz();
  }

  /** Ostatni znany wynik. Czytane przy każdym `GET /billing/subscription`. */
  ostatni(): PreflightWynik {
    return this.wynik;
  }

  /**
   * Czy wolno dziś pokazać przycisk zakupu.
   *
   * `nieznany` przepuszcza świadomie: sprzedaż ma padać na NASZYM błędzie,
   * nie na cudzej awarii ani na tym, że przy starcie nie było sieci.
   */
  wolnoSprzedawac(): boolean {
    return this.wynik.stan !== 'klucz';
  }

  /** Pyta Apple i zapamiętuje odpowiedź. Nigdy nie rzuca. */
  async sprawdz(now: Date = new Date()): Promise<PreflightWynik> {
    try {
      const odpowiedz = await this.appStore.verifyCredentials();
      this.wynik = { ...odpowiedz, sprawdzoneO: now.toISOString() };
    } catch (error) {
      this.wynik = {
        stan: 'nieznany',
        szczegol: `Nie udało się sprawdzić: ${String(error)}`,
        sprawdzoneO: now.toISOString(),
      };
    }

    if (this.wynik.stan === 'klucz') {
      this.logger.error(
        `KLUCZ DO APP STORE NIE DZIAŁA — sprzedaż WYŁĄCZONA, żeby nikt nie zapłacił za dostęp, którego nie umiemy nadać. ${this.wynik.szczegol}`,
      );
    } else if (this.wynik.stan === 'ok') {
      this.logger.log(`Apple przyjmuje nasz klucz. ${this.wynik.szczegol}`);
    } else {
      this.logger.warn(
        `Nie wiadomo, czy klucz do Apple działa — sprzedaż zostaje włączona. ${this.wynik.szczegol}`,
      );
    }
    return this.wynik;
  }
}
