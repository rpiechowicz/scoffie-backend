import {
  describeDatabasePool,
  readDatabasePoolSettings,
  serializableTransactionOptions,
} from './database-config';

/** Pula i timeouty bazy — jawnie, bez zgadywania (workstream, Etap 4D). */
describe('database-config', () => {
  it('bez parametrów w DATABASE_URL: domyślne Prismy (2 × CPU + 1, 10 s, 5 s)', () => {
    const settings = readDatabasePoolSettings(
      'postgresql://u:p@host:5432/db?schema=public',
      4,
    );
    expect(settings).toMatchObject({
      connectionLimit: null,
      poolTimeoutSeconds: null,
      connectTimeoutSeconds: null,
      defaults: {
        connectionLimit: 9,
        poolTimeoutSeconds: 10,
        connectTimeoutSeconds: 5,
      },
      invalid: [],
    });
    expect(describeDatabasePool(settings)).toBe(
      'connection_limit=domyślne(9), pool_timeout=domyślne(10 s), connect_timeout=domyślne(5 s)',
    );
  });

  it('parametry z adresu; linia logu bez hosta i hasła', () => {
    const settings = readDatabasePoolSettings(
      'postgresql://user:tajne@db.internal:5432/app?connection_limit=7&pool_timeout=20&connect_timeout=3',
      2,
    );
    const line = describeDatabasePool(settings);
    expect(line).toBe(
      'connection_limit=7, pool_timeout=20 s, connect_timeout=3 s',
    );
    expect(line).not.toContain('tajne');
    expect(line).not.toContain('db.internal');
  });

  it('niepoprawna wartość jest zgłaszana, nie zgadywana', () => {
    const settings = readDatabasePoolSettings(
      'postgresql://u:p@h/db?connection_limit=dużo',
      2,
    );
    expect(settings.invalid).toEqual(['connection_limit']);
    expect(describeDatabasePool(settings)).toContain(
      'NIEPOPRAWNE: connection_limit',
    );
  });

  it('timeout transakcji SERIALIZABLE tylko z env; puste = domyślne Prismy', () => {
    expect(serializableTransactionOptions({})).toEqual({});
    expect(
      serializableTransactionOptions({
        DB_SERIALIZABLE_TIMEOUT_MS: '15000',
        DB_SERIALIZABLE_MAX_WAIT_MS: '4000',
      }),
    ).toEqual({ timeout: 15000, maxWait: 4000 });
    expect(
      serializableTransactionOptions({ DB_SERIALIZABLE_TIMEOUT_MS: 'abc' }),
    ).toEqual({});
  });
});
