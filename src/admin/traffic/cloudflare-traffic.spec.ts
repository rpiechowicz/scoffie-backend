import {
  CLOUDFLARE_GRAPHQL_URL,
  fetchTraffic,
  trafficDates,
} from './cloudflare-traffic.client';
import { AdminTrafficService } from './admin-traffic.service';

const NOW = new Date('2026-09-25T10:00:00Z');
const env = { token: 'cf-token', zoneId: 'zone-1' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const daily = {
  data: {
    viewer: {
      zones: [
        {
          days: [
            {
              dimensions: { date: '2026-09-24' },
              sum: { requests: 700, pageViews: 150 },
              uniq: { uniques: 90 },
            },
            {
              dimensions: { date: '2026-09-25' },
              sum: { requests: 50, pageViews: 10 },
              uniq: { uniques: 7 },
            },
          ],
        },
      ],
    },
  },
};

const adaptive = {
  data: {
    viewer: {
      zones: [
        {
          paths: [
            { count: 2040, dimensions: { clientRequestPath: '/' } },
            { count: 44, dimensions: { clientRequestPath: '/zaproszenie/' } },
          ],
          countries: [{ count: 900, dimensions: { clientCountryName: 'PL' } }],
          invites: [
            { count: 4, dimensions: { date: '2026-09-23' } },
            { count: 1, dimensions: { date: '2026-09-24' } },
          ],
        },
      ],
    },
  },
};

describe('ruch z Cloudflare', () => {
  it('30 dni UTC, dzisiaj na końcu', () => {
    const dates = trafficDates(NOW);
    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe('2026-08-27');
    expect(dates[29]).toBe('2026-09-25');
  });

  it('dni bez dziur, ścieżki, kraje i zaproszenia; token w nagłówku', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(json(calls.length === 1 ? daily : adaptive));
    }) as unknown as typeof fetch;

    const data = await fetchTraffic(env, NOW, fetchImpl);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(CLOUDFLARE_GRAPHQL_URL);
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer cf-token');
    const body = JSON.parse(calls[1].init.body as string) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toMatchObject({
      zone: 'zone-1',
      host: 'scoffie.app',
      invites: ['/zaproszenie', '/zaproszenie/'],
    });
    expect(data.days).toHaveLength(30);
    expect(data.days[28]).toEqual({
      date: '2026-09-24',
      requests: 700,
      visitors: 90,
      pageViews: 150,
    });
    expect(data.days[0]).toMatchObject({ requests: 0, visitors: 0 });
    expect(data.paths).toEqual([
      { name: '/', count: 2040 },
      { name: '/zaproszenie/', count: 44 },
    ]);
    expect(data.countries).toEqual([{ name: 'PL', count: 900 }]);
    expect(data.invites?.total).toBe(5);
    expect(data.invites?.days).toHaveLength(30);
  });

  it('błąd rozbicia (plan, uprawnienia) zostawia wykres, pola null', async () => {
    let n = 0;
    const fetchImpl = (() => {
      n += 1;
      return Promise.resolve(
        n === 1
          ? json(daily)
          : json({
              data: null,
              errors: [{ message: 'not authorized for that account' }],
            }),
      );
    }) as unknown as typeof fetch;
    const data = await fetchTraffic(env, NOW, fetchImpl);
    expect(data.days[29].requests).toBe(50);
    expect(data).toMatchObject({ paths: null, countries: null, invites: null });
  });

  it('błąd dziennych liczb = error integracji, bez tokenu w treści', async () => {
    process.env.ADMIN_CLOUDFLARE_TOKEN = 'cf-secret';
    process.env.ADMIN_CLOUDFLARE_ZONE_ID = 'zone-1';
    try {
      const fetchImpl = (() =>
        Promise.resolve(
          json({ errors: [{ code: 10000 }] }, 403),
        )) as unknown as typeof fetch;
      const state = await new AdminTrafficService().traffic(fetchImpl);
      expect(state.status).toBe('error');
      expect(JSON.stringify(state)).not.toContain('cf-secret');
    } finally {
      delete process.env.ADMIN_CLOUDFLARE_TOKEN;
      delete process.env.ADMIN_CLOUDFLARE_ZONE_ID;
    }
  });

  it('bez zmiennych — off z nazwami', async () => {
    const state = await new AdminTrafficService().traffic();
    expect(state).toEqual({
      status: 'off',
      missing: ['ADMIN_CLOUDFLARE_TOKEN', 'ADMIN_CLOUDFLARE_ZONE_ID'],
    });
  });
});
