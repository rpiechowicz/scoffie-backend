/**
 * Przychód netto z ceny w App Store — JEDNA arytmetyka dla strażnika cennika
 * (`ai-unit-economics.spec.ts`) i rentowności asystenta w panelu
 * administratora (ROADMAPA §5.4: „przenieść do serwisu, nie liczyć drugi raz
 * inaczej”). Liczby jak w `docs/plans/scoffie-ai-agent/cennik-i-limity-2026-09.md`
 * §3 i w `cennik_i_limity_2026_09.py` (`net_usd`).
 *
 * To PRZYBLIŻENIE z cennika: co Apple naprawdę wypłaca (kurs, prowizja po
 * pierwszym roku, zwroty), mówi dopiero raport finansowy App Store Connect
 * (ROADMAPA §5.6).
 */

/** VAT w Polsce — Apple jest sprzedawcą i odprowadza go od ceny brutto. */
export const APPLE_VAT_DIVISOR = 1.23;

/** Część ceny netto, która zostaje po prowizji Apple (Small Business Program, 15 %). */
export const APPLE_PROCEEDS_SHARE = 0.85;

/**
 * Kurs USD→PLN, NBP tabela A z 3.09.2026 — ten sam, na którym policzono
 * cennik. Stała, a nie kurs z dnia: dziennego kursu NBP backend jeszcze nie
 * pobiera (`FxRate`, ROADMAPA §5.6 i §6 — osobna praca).
 */
export const REFERENCE_USD_PLN = 3.7224;

/** Przychód netto w PLN z ceny brutto w PLN: bez VAT i bez prowizji Apple. */
export function netRevenuePln(grossPln: number): number {
  return (grossPln / APPLE_VAT_DIVISOR) * APPLE_PROCEEDS_SHARE;
}

/** To samo w USD — po kursie `usdPln` (domyślnie kurs cennika). */
export function netRevenueUsd(
  grossPln: number,
  usdPln: number = REFERENCE_USD_PLN,
): number {
  return netRevenuePln(grossPln) / usdPln;
}
