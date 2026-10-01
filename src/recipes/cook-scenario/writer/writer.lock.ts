import { randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';

/**
 * Wyłączna blokada dziennika przebiegu paczek (review Codexa): dwa procesy
 * na jednym dzienniku wysłałyby te same paczki i zapłaciły podwójnie, a każdy
 * pilnowałby budżetu osobno. Blokada to plik tworzony atomowo (`wx` — system
 * gwarantuje, że uda się JEDNEMU procesowi), trzymany do końca przebiegu,
 * ze znacznikiem właściciela (`token`).
 *
 * Blokada po padniętym procesie: zdjęcie tylko świadomie (`breakStale`)
 * i tylko wtedy, gdy zapisany proces już nie żyje. Przejęcie idzie pod
 * wyłączną blokadą „łamacza” (łamie jeden naraz), a zwolnienie usuwa
 * blokadę tylko ze SWOIM znacznikiem — kilku „łamaczy” naraz nie zostawi
 * dwóch właścicieli.
 */
export interface LockInfo {
  pid: number;
  startedAt: string;
  token?: string;
}

/** Pusta/uszkodzona blokada starsza niż to = porzucona w trakcie zakładania. */
const UNREADABLE_STALE_MS = 60_000;

/**
 * Blokada „łamacza” — `null`, gdy łamie już ktoś inny. Porzucona (łamacz
 * padł) starsza niż minuta zostaje usunięta — łamanie trwa milisekundy.
 */
async function acquireBreaker(
  path: string,
): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      await handle.close();
      return () => unlink(path).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age =
        Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? 0);
      if (age < UNREADABLE_STALE_MS || attempt > 0) return null;
      await unlink(path).catch(() => undefined);
    }
  }
  return null;
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

async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

const parse = (raw: string | null): LockInfo | null => {
  try {
    return raw ? (JSON.parse(raw) as LockInfo) : null;
  } catch {
    return null;
  }
};

/**
 * Zakłada blokadę; zwraca funkcję zwalniającą. Rzuca `LockHeldError`, gdy
 * blokadę trzyma inny proces (albo martwy, a `breakStale` nie jest ustawione).
 */
export async function acquireLock(
  path: string,
  options: { breakStale?: boolean; isAlive?: (pid: number) => boolean } = {},
): Promise<() => Promise<void>> {
  const isAlive = options.isAlive ?? processAlive;
  const token = randomUUID();
  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  };
  let broke = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
        // Usuwamy tylko SWOJĄ blokadę.
        if (parse(await readRaw(path))?.token === token) {
          await unlink(path).catch(() => undefined);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raw = await readRaw(path);
      const holder = parse(raw);
      // Bez danych właściciela (proces padł w trakcie zakładania): świeża =
      // ktoś właśnie ją zakłada; starsza niż minuta = porzucona.
      const alive = holder
        ? isAlive(holder.pid)
        : Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? 0) <
          UNREADABLE_STALE_MS;
      if (alive || !options.breakStale || broke) {
        throw new LockHeldError(path, holder, alive);
      }
      // Przejęcie pod WYŁĄCZNĄ blokadą „łamacza” (`.break`, też `wx`): łamie
      // naraz tylko jeden proces. Pod nią sprawdzamy, że to wciąż ta sama
      // porzucona blokada — jej właściciel nie żyje, a zwykły proces cudzej
      // nie usuwa, więc nikt jej w tym oknie nie podmieni — i dopiero ją
      // usuwamy. Własną zakładamy zwykłym `wx` (może nas ktoś wyprzedzić —
      // wtedy on jest właścicielem, nie dwóch naraz).
      const releaseBreaker = await acquireBreaker(`${path}.break`);
      if (!releaseBreaker) throw new LockHeldError(path, holder, true);
      try {
        if ((await readRaw(path)) === raw) {
          await unlink(path).catch(() => undefined);
        }
      } finally {
        await releaseBreaker();
      }
      broke = true;
    }
  }
  throw new LockHeldError(path, null, true);
}
