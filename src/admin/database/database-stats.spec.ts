import {
  rowsEstimate,
  SLOW_QUERY_TEXT_MAX,
  toNumber,
  toSlowQuery,
  trimQueryText,
} from './database-stats';

describe('statystyki bazy', () => {
  it('liczby z bigint, tekstu i Decimal', () => {
    expect(toNumber(10n)).toBe(10);
    expect(toNumber('8192')).toBe(8192);
    expect(toNumber({ toString: () => '1.5' })).toBe(1.5);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('nie')).toBe(0);
  });

  it('reltuples -1 przed ANALYZE to 0', () => {
    expect(rowsEstimate(-1)).toBe(0);
    expect(rowsEstimate(1234.6)).toBe(1235);
  });

  it('tekst zapytania zwinięty i przycięty do 200 znaków', () => {
    expect(trimQueryText('SELECT  *\n FROM "User"\tWHERE id = $1')).toBe(
      'SELECT * FROM "User" WHERE id = $1',
    );
    const long = trimQueryText(`SELECT ${'a, '.repeat(200)}b`);
    expect(long).toHaveLength(SLOW_QUERY_TEXT_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('wiersz pg_stat_statements', () => {
    expect(
      toSlowQuery({
        query: 'SELECT $1',
        calls: 3n,
        meanMs: 12.345,
        totalMs: '37.04',
      }),
    ).toEqual({ query: 'SELECT $1', calls: 3, meanMs: 12.3, totalMs: 37 });
  });
});
