import type { RefreshSession } from '../contract';

/**
 * Sesje osoby = RODZINY refresh tokenów, a nie pojedyncze wiersze.
 *
 * Każda rotacja dokłada wiersz (poprzednik dostaje ROTATED i wskaźnik
 * `replacedByHash` na następcę), więc telefon używany codziennie ma po
 * miesiącu setki wierszy jednej sesji. Panel pokazuje sesję tak, jak widzi ją
 * człowiek: od logowania (korzeń łańcucha) do ostatniego tokenu (głowa), ze
 * stanem głowy — żywa, wylogowana, skasowana po wykryciu kopii (REUSE).
 *
 * Czego tabela nie mówi wprost: ratunek zgubionej rotacji
 * (`recoverLostRotation`) wydaje parę NIEPOWIĄZANĄ z łańcuchem — wygląda jak
 * nowa rodzina, bo nią technicznie jest. Wygasłe wiersze sprząta
 * `refreshAccessToken`, więc korzeń bardzo starej sesji bywa najstarszym
 * zachowanym tokenem, a nie samym logowaniem.
 */

export type RefreshTokenRow = {
  id: string;
  tokenHash: string;
  replacedByHash: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
};

const REASONS = ['ROTATED', 'LOGOUT', 'REUSE', 'RECOVERED'] as const;
type Reason = (typeof REASONS)[number];

const asReason = (value: string | null): Reason | null =>
  (REASONS as readonly string[]).includes(value ?? '')
    ? (value as Reason)
    : null;

export const SESSION_LIMIT = 20;

export function refreshFamilies(
  rows: readonly RefreshTokenRow[],
  now: Date,
  limit: number = SESSION_LIMIT,
): RefreshSession[] {
  const byHash = new Map(rows.map((row) => [row.tokenHash, row]));
  const successors = new Set(
    rows
      .map((row) => row.replacedByHash)
      .filter((hash): hash is string => hash !== null && byHash.has(hash)),
  );
  const families = rows
    .filter((row) => !successors.has(row.tokenHash))
    .map((root) => {
      let head = root;
      const seen = new Set([root.tokenHash]);
      while (head.replacedByHash) {
        const next = byHash.get(head.replacedByHash);
        if (!next || seen.has(next.tokenHash)) break;
        seen.add(next.tokenHash);
        head = next;
      }
      return { root, head };
    })
    // Rodzina, której głowa wygasła, zanim ktoś ją unieważnił, nie jest już
    // sesją — a kontrakt nie ma na „wygasła" osobnego powodu, więc pokazana
    // udawałaby aktywną.
    .filter(({ head }) => head.revokedAt !== null || head.expiresAt > now);

  families.sort(
    (a, b) =>
      b.head.createdAt.getTime() - a.head.createdAt.getTime() ||
      b.root.createdAt.getTime() - a.root.createdAt.getTime(),
  );

  return families.slice(0, limit).map(({ root, head }) => ({
    id: root.id,
    createdAt: root.createdAt.toISOString(),
    expiresAt: head.expiresAt.toISOString(),
    revokedAt: head.revokedAt?.toISOString() ?? null,
    revokedReason: head.revokedAt ? asReason(head.revokedReason) : null,
  }));
}
