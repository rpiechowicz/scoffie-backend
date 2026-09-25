import {
  REFERENCE_USD_PLN,
  netRevenuePln,
} from '../../config/ai-unit-economics';
import type {
  RevenueCountryRow,
  RevenueData,
  RevenueFinanceRow,
  RevenuePeriod,
  RevenueProductRow,
} from '../contract';
import { lastDayOfMonth, salesReportDates } from './apple-reports';
import type { FxBook } from './fx-rates';

/**
 * Ekran „Wypłaty z Apple” — czysta arytmetyka: wiersze z bazy + księga
 * kursów → liczby w PLN. Kwota w walucie wypłaty idzie do PLN po kursie NBP
 * z dnia raportu (ostatnie notowanie ≤ dzień), do USD — przez USD/PLN
 * z tego samego dnia. Waluta spoza tabeli A NBP (np. SAR, TWD) nie wchodzi
 * do sum — ląduje w `unconverted`, żeby panel mógł to powiedzieć.
 */

export const REVENUE_PERIODS = [
  '30',
  '90',
  '365',
] as const satisfies readonly RevenuePeriod[];

export type StoredSale = {
  date: string;
  sku: string;
  title: string;
  productType: string;
  country: string;
  units: number;
  proceeds: number;
  proceedsCurrency: string;
  customerPrice: number;
  customerCurrency: string;
};

export type StoredFinance = {
  month: string;
  currency: string;
  units: number;
  proceeds: number;
};

type Built = Omit<RevenueData, 'state' | 'fx'>;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Dni okresu od najstarszego: `count` dni kończących się wczoraj. */
export function revenueDays(today: string, period: RevenuePeriod): string[] {
  return salesReportDates(today, Number(period)).reverse();
}

export function buildRevenue(input: {
  period: RevenuePeriod;
  /** dziś `YYYY-MM-DD` (UTC, jak synchronizacja) */
  today: string;
  sales: readonly StoredSale[];
  finance: readonly StoredFinance[];
  book: FxBook;
  /** MRR brutto z cennika (`mrrAt`) */
  mrrPln: number;
}): Built {
  const { book } = input;
  const days = revenueDays(input.today, input.period);
  const first = days[0];
  const last = days[days.length - 1];
  const unconverted = new Set<string>();

  /** Kwota → PLN; USD bez notowania — stała cennika; inna waluta bez notowania — `null`. */
  const toPln = (amount: number, currency: string, date: string) => {
    const rate =
      book.toPln(currency, date) ??
      (currency === 'USD' ? REFERENCE_USD_PLN : null);
    return rate === null ? null : amount * rate;
  };

  const byDay = new Map(
    days.map((date) => [date, { units: 0, pln: 0, usd: 0 }]),
  );
  const products = new Map<string, RevenueProductRow>();
  const countries = new Map<string, RevenueCountryRow>();
  let refunds = 0;
  let customerPricePln = 0;

  for (const sale of input.sales) {
    if (sale.date < first || sale.date > last) continue;
    const day = byDay.get(sale.date);
    if (!day) continue;
    const pln = toPln(sale.proceeds, sale.proceedsCurrency, sale.date);
    if (pln === null) unconverted.add(sale.proceedsCurrency);
    const plnValue = pln ?? 0;
    const refund = sale.units < 0 ? -sale.units : 0;

    day.units += sale.units;
    day.pln += plnValue;
    day.usd += plnValue / book.usdPln(sale.date).rate;
    refunds += refund;
    customerPricePln +=
      toPln(sale.customerPrice, sale.customerCurrency, sale.date) ?? 0;

    const product = products.get(sale.sku) ?? {
      sku: sale.sku,
      title: sale.title,
      productType: sale.productType,
      units: 0,
      refunds: 0,
      proceedsPln: 0,
    };
    product.units += sale.units;
    product.refunds += refund;
    product.proceedsPln += plnValue;
    if (!product.title) product.title = sale.title;
    products.set(sale.sku, product);

    const country = countries.get(sale.country) ?? {
      country: sale.country,
      units: 0,
      proceedsPln: 0,
    };
    country.units += sale.units;
    country.proceedsPln += plnValue;
    countries.set(sale.country, country);
  }

  const dayRows = days.map((date) => {
    const day = byDay.get(date) ?? { units: 0, pln: 0, usd: 0 };
    return {
      date,
      units: day.units,
      proceedsPln: round2(day.pln),
      proceedsUsd: round2(day.usd),
    };
  });
  const sum = (
    pick: (d: { pln: number; usd: number; units: number }) => number,
  ) => [...byDay.values()].reduce((total, day) => total + pick(day), 0);
  const proceedsPln = sum((d) => d.pln);

  const finance: RevenueFinanceRow[] = [...input.finance]
    .sort(
      (a, b) =>
        b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency),
    )
    .map((row) => {
      const pln = toPln(row.proceeds, row.currency, lastDayOfMonth(row.month));
      return {
        month: row.month,
        currency: row.currency,
        units: row.units,
        proceeds: round2(row.proceeds),
        proceedsPln: pln === null ? null : round2(pln),
      };
    });

  const byMoney = <T extends { proceedsPln: number; units: number }>(
    a: T,
    b: T,
  ) => b.proceedsPln - a.proceedsPln || b.units - a.units;

  return {
    period: input.period,
    days: dayRows,
    totals: {
      units: sum((d) => d.units),
      refunds,
      proceedsPln: round2(proceedsPln),
      proceedsUsd: round2(sum((d) => d.usd)),
      avgPerDayPln: round2(proceedsPln / days.length),
      customerPricePln: round2(customerPricePln),
    },
    byProduct: [...products.values()]
      .map((row) => ({ ...row, proceedsPln: round2(row.proceedsPln) }))
      .sort(byMoney),
    byCountry: [...countries.values()]
      .map((row) => ({ ...row, proceedsPln: round2(row.proceedsPln) }))
      .sort(byMoney),
    finance,
    estimatedMrrPln: round2(input.mrrPln),
    estimatedNetMrrPln: round2(netRevenuePln(input.mrrPln)),
    unconverted: [...unconverted].sort(),
  };
}
