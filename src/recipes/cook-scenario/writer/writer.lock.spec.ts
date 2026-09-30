import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockHeldError } from './writer.lock';

describe('system pisania — wyłączna blokada dziennika', () => {
  const lockPath = () =>
    join(mkdtempSync(join(tmpdir(), 'gotuj-lock-')), 'j.lock');

  it('dwa równoczesne starty: blokadę dostaje dokładnie jeden', async () => {
    const path = lockPath();
    const outcomes = await Promise.allSettled([
      acquireLock(path),
      acquireLock(path),
      acquireLock(path),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect(
      outcomes.filter(
        (o) => o.status === 'rejected' && o.reason instanceof LockHeldError,
      ),
    ).toHaveLength(2);
    // Po zwolnieniu blokada znika i następny przebieg może ruszyć.
    await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
    expect(existsSync(path)).toBe(false);
    const release = await acquireLock(path);
    await release();
  });

  it('blokada żywego procesu nie daje się zdjąć nawet z --break-lock', async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 4242, startedAt: 'wczoraj' }));
    await expect(
      acquireLock(path, { breakStale: true, isAlive: () => true }),
    ).rejects.toMatchObject({ alive: true });
  });

  it('blokada martwego procesu: bez --break-lock odmowa, z nim — przejęcie', async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 4242, startedAt: 'wczoraj' }));
    await expect(acquireLock(path, { isAlive: () => false })).rejects.toThrow(
      '--break-lock',
    );
    const release = await acquireLock(path, {
      breakStale: true,
      isAlive: () => false,
    });
    await release();
    expect(existsSync(path)).toBe(false);
  });
});
