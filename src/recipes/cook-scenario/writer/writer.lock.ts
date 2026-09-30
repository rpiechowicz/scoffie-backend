import { open, readFile, stat, unlink } from 'node:fs/promises';

/** Pusta/uszkodzona blokada starsza niż to = porzucona w trakcie zakładania. */
const UNREADABLE_STALE_MS = 60_000;

/**
 * Wyłączna blokada dziennika przebiegu paczek (review Codexa): dwa procesy
 * na jednym dzienniku wysłałyby te same paczki i zapłaciły podwójnie, a każdy
 * pilnowałby budżetu osobno. Blokada to plik tworzony atomowo (`wx` — system
 * gwarantuje, że uda się JEDNEMU procesowi), trzymany do końca przebiegu.
 *
 * Blokada po padniętym procesie: zdjęcie tylko świadomie (`breakStale`)
 * i tylko wtedy, gdy zapisany proces już nie żyje.
 */
export interface LockInfo {
  pid: number;
  startedAt: string;
}

export class LockHeldError extends Error {
  constructor(
    readonly path: string,
    readonly holder: LockInfo | null,
    readonly alive: boolean,
  ) {
    super(
      holder
        ? `dziennik jest zajęty (${path}): proces ${holder.pid} od ${holder.startedAt}${
            alive
              ? ' — nadal działa'
              : ' — nie działa; jeśli na pewno padł, uruchom z --break-lock'
          }`
        : alive
          ? `dziennik jest zajęty (${path}): blokada bez danych — ktoś właśnie ją zakłada`
          : `dziennik jest zajęty (${path}): blokada bez danych, porzucona — jeśli żaden przebieg nie działa, uruchom z --break-lock`,
    );
    this.name = 'LockHeldError';
  }
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = proces istnieje, tylko nie nasz.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function readHolder(path: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Zakłada blokadę; zwraca funkcję zwalniającą. Rzuca `LockHeldError`, gdy
 * blokadę trzyma inny proces (albo martwy, a `breakStale` nie jest ustawione).
 */
export async function acquireLock(
  path: string,
  options: { breakStale?: boolean; isAlive?: (pid: number) => boolean } = {},
): Promise<() => Promise<void>> {
  const isAlive = options.isAlive ?? processAlive;
  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(JSON.stringify(info));
        await handle.close();
      } catch (error) {
        // Blokada bez danych właściciela byłaby nie do zdjęcia — sprzątamy.
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await readHolder(path);
      // Bez danych właściciela (proces padł w trakcie zakładania): świeża =
      // ktoś właśnie ją zakłada; starsza niż minuta = porzucona.
      const alive = holder
        ? isAlive(holder.pid)
        : Date.now() - (await stat(path).catch(() => null))!.mtimeMs <
          UNREADABLE_STALE_MS;
      if (alive || !options.breakStale || attempt > 0) {
        throw new LockHeldError(path, holder, alive);
      }
      // Świadome zdjęcie blokady martwego procesu — i druga próba.
      await unlink(path).catch(() => undefined);
    }
  }
  throw new LockHeldError(path, null, true);
}
