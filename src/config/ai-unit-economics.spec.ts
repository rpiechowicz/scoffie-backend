import { AGENT_ENV_DEFAULTS } from './agent-env';
import { SUBSCRIPTION_PRODUCTS } from './subscription-products';

/**
 * Strażnik jednostkowej ekonomii asystenta.
 *
 * Trzy liczby w `AGENT_ENV_DEFAULTS` decydują o tym, czy sprzedaż zarabia, czy
 * dopłaca: pula dla gospodarstw BEZ kupionego produktu, sufit kosztu jednego
 * domu na miesiąc i sufit kosztu jednej tury. Każda z nich wygląda jak
 * niewinna stała i każdą da się podnieść jednym znakiem — a skutek widać
 * dopiero na rachunku od Anthropica, miesiąc później.
 *
 * Ten plik zamienia rachunek na asercje. Stawki poniżej są ZMIERZONE, nie
 * założone: benchmark z 7.09.2026 (`benchmark/after-A-przebieg1..3.json`,
 * konfiguracja A = Sonnet/medium, czyli produkcja, ciepły cache).
 */

/** Koszt tury wg typu, USD. Średnia z trzech przebiegów po odchudzeniu. */
const KOSZT_TURY = {
  planTygodnia: 0.2481,
  podmiana: 0.1814,
  rozmowa: 0.0263,
} as const;

/** Najdroższa ZMIERZONA uczciwa tura: podmiana dla jednej osoby, 6 rund. */
const NAJDROZSZA_UCZCIWA_TURA = 0.5944;

/**
 * Zimny cache podnosi rachunek o ~40 % (`cennik-i-limity-2026-09.md` §4).
 * Sufity muszą stać nad wariantem pesymistycznym, bo inaczej odpalają
 * pierwszemu użytkownikowi po deployu — czyli dokładnie wtedy, gdy cache
 * jeszcze nie działa.
 */
const ZIMNY_CACHE = 1.4;

/**
 * Mix tur w miesiącu (`cennik-i-limity-2026-09.md` §4): 20 % plany tygodnia,
 * 20 % podmiany, 60 % rozmowa. To ZAŁOŻENIE, nie pomiar — jedyne w tym
 * pliku. Prawdziwy rozkład pokaże dopiero `AiUsage.apiCalls` z produkcji.
 */
function kosztMiesiaca(wiadomosci: number): number {
  return (
    0.2 * wiadomosci * KOSZT_TURY.planTygodnia +
    0.2 * wiadomosci * KOSZT_TURY.podmiana +
    0.6 * wiadomosci * KOSZT_TURY.rozmowa
  );
}

/** Przychód netto z ceny brutto w PLN: VAT 23 %, Apple 15 %, USD/PLN 3,7224. */
function nettoUsd(pricePln: number): number {
  return (pricePln / 1.23) * 0.85 * (1 / 3.7224);
}

const SOLO = SUBSCRIPTION_PRODUCTS['app.scoffie.pro.solo.monthly'];
const NAJWIEKSZY = Object.values(SUBSCRIPTION_PRODUCTS).sort(
  (a, b) => b.messagesPerMonth - a.messagesPerMonth,
)[0];

describe('jednostkowa ekonomia asystenta', () => {
  describe('pula dla gospodarstw bez kupionego produktu', () => {
    it('nie jest hojniejsza niż najtańszy PŁATNY plan', () => {
      // Dostają ją `AI_TIER_OVERRIDE=PRO`, nadanie operatora i nieznany SKU.
      // Do 7.09.2026 stało tu 200/30, co przy zmierzonych stawkach kosztuje
      // $20,34 miesięcznie — blisko czterokrotność najdroższej subskrypcji,
      // na gospodarstwo, które nie zapłaciło nic.
      expect(AGENT_ENV_DEFAULTS.messagesPerMonth).toBeLessThanOrEqual(
        SOLO.messagesPerMonth,
      );
      expect(AGENT_ENV_DEFAULTS.plansPerMonth).toBeLessThanOrEqual(
        SOLO.plansPerMonth,
      );
    });

    it('mieści się w przychodzie netto z najtańszego planu', () => {
      const koszt = kosztMiesiaca(AGENT_ENV_DEFAULTS.messagesPerMonth);
      expect(koszt).toBeLessThan(nettoUsd(SOLO.pricePln));
    });
  });

  describe('każdy sprzedawany plan zarabia przy PEŁNYM wykorzystaniu', () => {
    it.each(Object.entries(SUBSCRIPTION_PRODUCTS))('%s', (_id, produkt) => {
      // Najbardziej restrykcyjne założenie: subskrybent co miesiąc wyciska
      // limit do zera. Jeśli plan zarabia wtedy, zarabia zawsze.
      const koszt = kosztMiesiaca(produkt.messagesPerMonth);
      const netto = nettoUsd(produkt.pricePln);
      expect(koszt).toBeLessThan(netto);
    });
  });

  describe('sufit kosztu gospodarstwa na miesiąc', () => {
    it('stoi NAD najdroższym legalnym miesiącem, także na zimnym cache', () => {
      // To bezpiecznik na pętlę, nie narzędzie marży. Odpalenie go u kogoś,
      // kto po prostu korzysta z opłaconego limitu, jest awarią produktu —
      // dlatego liczy się najhojniejszy plan w wariancie pesymistycznym.
      const najgorszyUczciwy =
        kosztMiesiaca(NAJWIEKSZY.messagesPerMonth) * ZIMNY_CACHE;
      expect(AGENT_ENV_DEFAULTS.householdMonthlyCostUsd).not.toBeNull();
      expect(AGENT_ENV_DEFAULTS.householdMonthlyCostUsd).toBeGreaterThan(
        najgorszyUczciwy,
      );
    });

    it('…ale nie tak wysoko, żeby przepuścić dwa miesięczne rachunki', () => {
      // Sufit 3× przychodu netto (poprzednie $18) znaczy, że dom w pętli
      // błędów zdąży wydać trzy subskrypcje, zanim cokolwiek go zatrzyma.
      const najgorszyUczciwy =
        kosztMiesiaca(NAJWIEKSZY.messagesPerMonth) * ZIMNY_CACHE;
      expect(AGENT_ENV_DEFAULTS.householdMonthlyCostUsd).toBeLessThan(
        najgorszyUczciwy * 2,
      );
    });
  });

  describe('sufit kosztu jednej tury', () => {
    it('nie ucina najdroższej ZMIERZONEJ uczciwej tury', () => {
      // $0,40 z pierwotnego rachunku (cennik §2) ucinałby realną pracę:
      // powstał, zanim istniał pomiar.
      expect(AGENT_ENV_DEFAULTS.maxTurnCostUsd).not.toBeNull();
      expect(AGENT_ENV_DEFAULTS.maxTurnCostUsd).toBeGreaterThan(
        NAJDROZSZA_UCZCIWA_TURA,
      );
    });

    it('jest niższy niż koszt ucieczki na pełnej pętli narzędzi', () => {
      // Sens tego sufitu to złapanie tury, która kręci się do MAX_TOOL_ROUNDS.
      // Zmierzona ucieczka: ~$1,00. Sufit równy jej niczego nie łapie.
      expect(AGENT_ENV_DEFAULTS.maxTurnCostUsd).toBeLessThan(1);
    });

    it('jedna tura nie może zjeść całego miesięcznego sufitu domu', () => {
      const naTure = AGENT_ENV_DEFAULTS.maxTurnCostUsd as number;
      const naMiesiac = AGENT_ENV_DEFAULTS.householdMonthlyCostUsd as number;
      expect(naTure * 10).toBeLessThan(naMiesiac);
    });
  });

  describe('próg rentowności', () => {
    it('przy realistycznym użyciu 40 % limitu wkład pokrywa koszty stałe z zapasem', () => {
      // Koszty stałe $29,85/mies. (Railway, Apple Developer, domena —
      // potwierdzone 3.09.2026). Przy pełnym rachunku 200/30 wkład z Solo
      // był UJEMNY, więc każdy nowy subskrybent oddalał rentowność.
      const koszt = kosztMiesiaca(SOLO.messagesPerMonth * 0.4);
      const wklad = nettoUsd(SOLO.pricePln) - koszt;
      expect(wklad).toBeGreaterThan(0);
      expect(Math.ceil(29.85 / wklad)).toBeLessThanOrEqual(10);
    });
  });
});
