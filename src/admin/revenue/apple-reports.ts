import { addDays } from '../common/warsaw-calendar';
import { IntegrationError } from '../integrations/integration-fetch';

/**
 * Raporty App Store Connect — czyste funkcje: TSV → wiersze, które dni
 * i miesiące pobrać. Pobiera `apple-reports.client.ts`, zapisuje
 * `AppleReportsSyncService`.
 *
 * Sales Summary (SALES/SUMMARY/DAILY): wiersz = produkt × kraj × cena ×
 * powód; `Units` może być ujemne (zwrot), a `Developer Proceeds`
 * i `Customer Price` to kwoty ZA SZTUKĘ — suma wiersza to Units × kwota.
 * Kolumny szukamy po nazwie nagłówka, nie po pozycji: wersje raportu (1_0,
 * 1_1) różnią się liczbą kolumn na końcu.
 */

/** Tyle dni wstecz przy pierwszej synchronizacji (Apple trzyma dzienne raporty rok). */
export const SALES_BACKFILL_DAYS = 365;
/** Codzienne uzupełnianie: Apple potrafi poprawić raport kilka dni później. */
export const SALES_REFRESH_DAYS = 30;
export const FINANCE_BACKFILL_MONTHS = 12;
export const FINANCE_REFRESH_MONTHS = 3;

export type SalesRow = {
  sku: string;
  title: string;
  productType: string;
  country: string;
  units: number;
  /** suma: Units × Developer Proceeds */
  proceeds: number;
  proceedsCurrency: string;
  /** suma: Units × Customer Price */
  customerPrice: number;
  customerCurrency: string;
};

export type FinanceRow = {
  currency: string;
  units: number;
  proceeds: number;
};

/**
 * Zakupy w aplikacji (subskrypcje) — `IA1`, `IA9`, `IAY`, `IAC`, `FI1`
 * i ich odmiany na Maca (`IAY-M`). Pobrania (`1F`, `3F`, `7`…) nie niosą
 * pieniędzy, a zawyżałyby „jednostki”.
 */
export function isInAppPurchase(productType: string): boolean {
  return /^(IA|FI)/.test(productType.trim().toUpperCase());
}

/** Liczba z raportu Apple (`1,234.50`, `-1`, puste = 0). */
export function reportNumber(raw: string | undefined): number {
  const value = Number((raw ?? '').replace(/,/g, '').trim() || '0');
  return Number.isFinite(value) ? value : 0;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

type Table = { header: string[]; rows: string[][] };

function readTsv(tsv: string): Table {
  // BOM na początku pliku (0xFEFF) zjadłby pierwszą nazwę kolumny.
  const lines = (tsv.charCodeAt(0) === 0xfeff ? tsv.slice(1) : tsv)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split('\t').map((cell) => cell.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split('\t'))
    // Powtórzony nagłówek (kolejny blok) i wiersze podsumowań (`Total_Rows`,
    // `Total_Amount`, …) raportu finansowego — nie są danymi.
    .filter(
      (cells) =>
        cells[0]?.trim() !== header[0] &&
        !/^total/i.test(cells[0]?.trim() ?? ''),
    );
  return { header, rows };
}

function columns<K extends string>(
  table: Table,
  names: Record<K, string>,
  report: string,
): Record<K, number> {
  const out = {} as Record<K, number>;
  const missing: string[] = [];
  for (const [key, name] of Object.entries(names) as [K, string][]) {
    const index = table.header.findIndex(
      (cell) => cell.toLowerCase() === name.toLowerCase(),
    );
    if (index < 0) missing.push(name);
    out[key] = index;
  }
  if (missing.length > 0) {
    throw new IntegrationError(
      `App Store Connect: nieznany format raportu ${report} (brak kolumn: ${missing.join(', ')})`,
    );
  }
  return out;
}

/** Sales Summary → wiersze zakupów w aplikacji, zsumowane po kluczu tabeli. */
export function parseSalesSummary(tsv: string): SalesRow[] {
  const table = readTsv(tsv);
  if (table.rows.length === 0) return [];
  const col = columns(
    table,
    {
      sku: 'SKU',
      title: 'Title',
      productType: 'Product Type Identifier',
      units: 'Units',
      proceeds: 'Developer Proceeds',
      customerCurrency: 'Customer Currency',
      country: 'Country Code',
      proceedsCurrency: 'Currency of Proceeds',
      customerPrice: 'Customer Price',
    },
    'Sales Summary',
  );
  const out = new Map<string, SalesRow>();
  for (const cells of table.rows) {
    const cell = (index: number) => (cells[index] ?? '').trim();
    const productType = cell(col.productType);
    if (!isInAppPurchase(productType)) continue;
    const units = reportNumber(cell(col.units));
    const row: SalesRow = {
      sku: cell(col.sku) || '—',
      title: cell(col.title),
      productType,
      country: cell(col.country).toUpperCase() || '—',
      units,
      proceeds: units * reportNumber(cell(col.proceeds)),
      proceedsCurrency: cell(col.proceedsCurrency).toUpperCase(),
      customerPrice: units * reportNumber(cell(col.customerPrice)),
      customerCurrency: cell(col.customerCurrency).toUpperCase(),
    };
    const key = salesKey(row);
    const prev = out.get(key);
    if (prev) {
      prev.units += row.units;
      prev.proceeds += row.proceeds;
      prev.customerPrice += row.customerPrice;
      if (!prev.title) prev.title = row.title;
    } else {
      out.set(key, row);
    }
  }
  return [...out.values()].map((row) => ({
    ...row,
    proceeds: round4(row.proceeds),
    customerPrice: round4(row.customerPrice),
  }));
}

/** Klucz unikalności `AppleSalesDay` (bez daty). */
export const salesKey = (row: SalesRow): string =>
  [
    row.sku,
    row.country,
    row.productType,
    row.proceedsCurrency,
    row.customerCurrency,
  ].join('\u0000');

/** Raport finansowy (FINANCIAL, region ZZ) → suma po walucie wypłaty. */
export function parseFinanceReport(tsv: string): FinanceRow[] {
  const table = readTsv(tsv);
  if (table.rows.length === 0) return [];
  const col = columns(
    table,
    {
      units: 'Quantity',
      proceeds: 'Extended Partner Share',
      currency: 'Partner Share Currency',
    },
    'finansowego',
  );
  const out = new Map<string, FinanceRow>();
  for (const cells of table.rows) {
    const currency = (cells[col.currency] ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    const row = out.get(currency) ?? { currency, units: 0, proceeds: 0 };
    row.units += reportNumber(cells[col.units]);
    row.proceeds += reportNumber(cells[col.proceeds]);
    out.set(currency, row);
  }
  return [...out.values()]
    .map((row) => ({ ...row, proceeds: round4(row.proceeds) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Dni do pobrania, od najnowszego: wczoraj i wstecz. Raport za dziś jeszcze
 * nie istnieje (Apple zamyka dzień z ~dobą opóźnienia; 404 = zero sprzedaży
 * albo „jeszcze nie ma”, oba przypadki uzupełni następny przebieg).
 */
export function salesReportDates(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    addDays(today, -(index + 1)),
  );
}

/**
 * Miesiące fiskalne `YYYY-MM` do pobrania, od najnowszego: poprzedni
 * miesiąc i wstecz (raport za bieżący Apple publikuje po jego zamknięciu).
 */
export function financeMonths(today: string, count: number): string[] {
  const [year, month] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const total = year * 12 + (month - 1) - (index + 1);
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  });
}

/** Ostatni dzień miesiąca `YYYY-MM` — dzień kursu dla raportu finansowego. */
export function lastDayOfMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  const next =
    m === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}
