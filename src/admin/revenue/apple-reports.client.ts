import { gunzipSync } from 'node:zlib';
import { ascToken } from '../integrations/asc-token';
import { IntegrationError } from '../integrations/integration-fetch';
import type { AscEnv } from '../integrations/integrations-env';

const API = 'https://api.appstoreconnect.apple.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Komunikat dla 401/403: klucz panelu ma dziś rolę Developer (buildy
 * i recenzje), a raporty sprzedaży i finansów wymagają roli Sales, Finance
 * albo Admin.
 */
export const ASC_REPORTS_FORBIDDEN =
  'Klucz ASC bez dostępu do raportów sprzedaży — nadaj rolę Finance albo Sales (App Store Connect → Users and Access → Integrations).';

/** Porażka pobrania raportu — z kodem HTTP (0 = sieć), bez tokenu. */
export class AppleReportError extends IntegrationError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AppleReportError';
  }
}

export type AppleReportRequest =
  | { kind: 'sales'; date: string }
  | { kind: 'finance'; month: string };

export function appleReportUrl(
  vendorNumber: string,
  request: AppleReportRequest,
): string {
  if (request.kind === 'sales') {
    return `${API}/salesReports?${new URLSearchParams({
      'filter[frequency]': 'DAILY',
      'filter[reportType]': 'SALES',
      'filter[reportSubType]': 'SUMMARY',
      'filter[vendorNumber]': vendorNumber,
      'filter[reportDate]': request.date,
      'filter[version]': '1_0',
    })}`;
  }
  return `${API}/financeReports?${new URLSearchParams({
    'filter[regionCode]': 'ZZ',
    'filter[reportType]': 'FINANCIAL',
    'filter[vendorNumber]': vendorNumber,
    'filter[reportDate]': request.month,
  })}`;
}

/**
 * Pobiera raport (gzip TSV) i zwraca tekst. `null` — Apple nie ma raportu
 * za ten okres (404: „There were no sales for the date specified” albo
 * dzień jeszcze nie zamknięty) — to ZERO, nie błąd.
 */
export async function fetchAppleReport(
  env: AscEnv,
  vendorNumber: string,
  request: AppleReportRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  const token = await ascToken(env);
  let res: Response;
  try {
    res = await fetchImpl(appleReportUrl(vendorNumber, request), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/a-gzip, application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppleReportError(
      `App Store Connect nie odpowiada (${error instanceof Error ? error.name : 'sieć'})`,
      0,
    );
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new AppleReportError(
      `App Store Connect: HTTP ${res.status} — ${ASC_REPORTS_FORBIDDEN}`,
      res.status,
    );
  }
  if (!res.ok) {
    const doc = (await res.json().catch(() => null)) as {
      errors?: { title?: string; detail?: string }[];
    } | null;
    const first = doc?.errors?.[0];
    const detail = (first?.detail ?? first?.title ?? '').slice(0, 200).trim();
    throw new AppleReportError(
      `App Store Connect: HTTP ${res.status}${detail ? ` · ${detail}` : ''}`,
      res.status,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return decodeReport(buffer);
}

/** Gzip (normalnie) albo goły tekst (gdyby pośrednik już rozpakował). */
export function decodeReport(buffer: Buffer): string {
  const gzipped =
    buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  try {
    return (gzipped ? gunzipSync(buffer) : buffer).toString('utf8');
  } catch {
    throw new AppleReportError(
      'App Store Connect: uszkodzony plik raportu (gzip)',
      0,
    );
  }
}
