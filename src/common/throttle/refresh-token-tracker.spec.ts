import { createHash } from 'crypto';
import { refreshTokenTracker } from './refresh-token-tracker';

describe('refreshTokenTracker', () => {
  const TOKEN = 'a'.repeat(64);

  it('klucz to hasz przedstawionego tokenu — sesja, nie adres', async () => {
    const tracker = await refreshTokenTracker({
      ip: '100.64.0.1',
      body: { refreshToken: TOKEN },
    });
    expect(tracker).toBe(
      `refresh:${createHash('sha256').update(TOKEN).digest('hex').slice(0, 32)}`,
    );
    // Surowy token nie trafia do magazynu throttlera.
    expect(tracker).not.toContain(TOKEN);
  });

  it('dwie sesje za jednym NAT-em mają dwa różne klucze', async () => {
    const [first, second] = await Promise.all([
      refreshTokenTracker({ ip: '100.64.0.1', body: { refreshToken: TOKEN } }),
      refreshTokenTracker({
        ip: '100.64.0.1',
        body: { refreshToken: 'b'.repeat(64) },
      }),
    ]);
    expect(first).not.toBe(second);
  });

  it.each([
    ['bez ciała', {}],
    ['token nie-tekstowy', { body: { refreshToken: 42 } }],
    ['pusty token', { body: { refreshToken: '   ' } }],
  ])('%s: liczy się po IP', async (_label, extra) => {
    await expect(
      refreshTokenTracker({ ip: '100.64.0.1', ...extra }),
    ).resolves.toBe('ip:100.64.0.1');
  });
});
