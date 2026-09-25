import type { MailDomain } from '../contract';
import { fetchJson, IntegrationError } from './integration-fetch';

type ApiDomains = {
  data?: { name: string; status: string; region?: string | null }[];
};

/**
 * Domeny nadawcy u Resend (`GET /domains`) — czy SPF/DKIM dalej są
 * zweryfikowane. Tym samym `RESEND_API_KEY`, którym wysyła poczta.
 *
 * Klucz z prawem tylko do wysyłki (`sending_access`) dostaje tu 401
 * `restricted_api_key`. To nie awaria poczty, więc komunikat mówi wprost,
 * że wysyłka działa, a domen po prostu nie widać.
 */
export async function fetchResendDomains(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ domains: MailDomain[] }> {
  try {
    const { body } = await fetchJson<ApiDomains>(
      'Resend',
      'https://api.resend.com/domains',
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
      },
      fetchImpl,
    );
    return {
      domains: (body.data ?? []).map((d) => ({
        name: d.name,
        status: d.status,
        region: d.region ?? null,
      })),
    };
  } catch (error) {
    if (
      error instanceof IntegrationError &&
      /restricted_api_key/.test(error.message)
    ) {
      throw new IntegrationError(
        'Resend: klucz ma prawo tylko do wysyłki — poczta działa, ale stanu domen nie widać',
      );
    }
    throw error;
  }
}
