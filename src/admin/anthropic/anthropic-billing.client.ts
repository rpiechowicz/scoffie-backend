import { fetchJson } from '../integrations/integration-fetch';

/**
 * Usage & Cost Admin API Anthropic — zwykły `fetch`, bo SDK tych
 * endpointów nie ma. Klucz Admin API (`sk-ant-admin…`) tylko do odczytu
 * raportów; czytany per żądanie jak pozostałe integracje panelu.
 */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/** Klucz Admin API; pusty = integracja wyłączona. */
export function readAnthropicAdminKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (env.ANTHROPIC_ADMIN_KEY ?? '').trim();
}

export type CostResult = {
  /** centy jako tekst dziesiętny: `"123.45"` = $1,2345 */
  amount: string;
  cost_type: string | null;
  description: string | null;
  model: string | null;
};

export type UsageResult = {
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
  output_tokens: number;
  model?: string | null;
};

export type Bucket<T> = {
  starting_at: string;
  ending_at: string;
  results: T[];
};

type Page<T> = {
  data: Bucket<T>[];
  has_more: boolean;
  next_page: string | null;
};

/** Najwyżej tyle stron — zabezpieczenie przed pętlą przy błędnym kursorze. */
const MAX_PAGES = 12;

async function pages<T>(
  key: string,
  path: string,
  params: [string, string][],
  fetchImpl: typeof fetch,
): Promise<Bucket<T>[]> {
  const buckets: Bucket<T>[] = [];
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const query = new URLSearchParams(params);
    if (page) query.set('page', page);
    const { body } = await fetchJson<Page<T>>(
      'Anthropic',
      `${ANTHROPIC_API_URL}${path}?${query.toString()}`,
      {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'User-Agent': 'ScoffieAdmin/1.0',
        },
      },
      fetchImpl,
    );
    buckets.push(...(body.data ?? []));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return buckets;
}

/** Koszty dobowe (UTC) po opisie — z modelem, rodzajem kosztu i tokenu. */
export function fetchCostReport(
  key: string,
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Bucket<CostResult>[]> {
  return pages<CostResult>(
    key,
    '/v1/organizations/cost_report',
    [
      ['starting_at', from.toISOString()],
      ['ending_at', to.toISOString()],
      ['group_by[]', 'description'],
      ['limit', '31'],
    ],
    fetchImpl,
  );
}

/** Tokeny w kubełkach `1h` albo `1d`; `byModel` — z podziałem na modele. */
export function fetchUsageReport(
  key: string,
  from: Date,
  to: Date,
  width: '1h' | '1d',
  byModel: boolean,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Bucket<UsageResult>[]> {
  return pages<UsageResult>(
    key,
    '/v1/organizations/usage_report/messages',
    [
      ['starting_at', from.toISOString()],
      ['ending_at', to.toISOString()],
      ['bucket_width', width],
      ['limit', width === '1h' ? '168' : '31'],
      ...(byModel ? ([['group_by[]', 'model']] as [string, string][]) : []),
    ],
    fetchImpl,
  );
}
