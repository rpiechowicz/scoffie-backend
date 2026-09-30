import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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
  it('pusta blokada (proces padł w trakcie zakładania): świeża — odmowa, porzucona — --break-lock ją zdejmuje', async () => {
    const path = lockPath();
    writeFileSync(path, '');
    await expect(acquireLock(path, { breakStale: true })).rejects.toMatchObject(
      {
        alive: true,
      },
    );
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(path, old, old);
    await expect(acquireLock(path)).rejects.toThrow('--break-lock');
    const release = await acquireLock(path, { breakStale: true });
    await release();
  });
  // Martwy jest tylko dawny właściciel (pid 4242); „łamacze” to żywe procesy.
  it('dwóch „łamaczy” tej samej porzuconej blokady naraz: przejmuje dokładnie jeden', async () => {
    for (let round = 0; round < 20; round += 1) {
      const path = lockPath();
      writeFileSync(path, JSON.stringify({ pid: 4242, startedAt: 'wczoraj' }));
      const outcomes = await Promise.allSettled(
        [0, 1, 2].map(() =>
          acquireLock(path, {
            breakStale: true,
            isAlive: (pid) => pid !== 4242,
          }),
        ),
      );
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      expect(won).toHaveLength(1);
      await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
    }
  });

  it('zwolnienie usuwa tylko SWOJĄ blokadę', async () => {
    const path = lockPath();
    const release = await acquireLock(path);
    // Ktoś (błędnie) nadpisał blokadę — nasze zwolnienie jej nie ruszy.
    writeFileSync(
      path,
      JSON.stringify({ pid: 1, startedAt: 'x', token: 'cudzy' }),
    );
    await release();
    expect(existsSync(path)).toBe(true);
  });
});
