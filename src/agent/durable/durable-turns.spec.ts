import { TURN_TIMEOUT_GRACE_MS } from '../../config/agent-env';
import { TURN_ORPHAN_AFTER_MS, turnCloseVerdict } from '../agent-turn-liveness';
import { usageCallKey } from '../agent-usage-ledger.service';
import { effectKind, TurnEffects } from './turn-effects';
import { parseTurnExecution, readTurnLeaseConfig } from './turn-lease-config';

const NOW = Date.parse('2026-09-27T10:00:00Z');
const OPTIONS = {
  turnTimeoutMs: 240_000,
  maxAttempts: 3,
  inProcess: false,
  now: NOW,
};

const row = (
  overrides: Partial<Parameters<typeof turnCloseVerdict>[0]> = {},
) => ({
  startedAt: new Date(NOW - 30_000),
  updatedAt: new Date(NOW - 90_000),
  deadlineAt: new Date(NOW + 210_000),
  attempt: 1,
  leaseExpiresAt: new Date(NOW - 1_000),
  cancelRequestedAt: null,
  ...overrides,
});

describe('trwałe tury (Etap 5) — reguły czyste', () => {
  describe('turnCloseVerdict', () => {
    it('wygasły lease PRZED terminem = do przejęcia, nie porażka (§5.5, §5.11)', () => {
      expect(turnCloseVerdict(row(), OPTIONS)).toBeNull();
      // Ani cisza od 90 s — stara reguła „minuta bez znaku życia" nie dotyczy.
      expect(
        turnCloseVerdict(row({ leaseExpiresAt: null, attempt: 0 }), OPTIONS),
      ).toBeNull();
    });

    it('po terminie CAŁEJ tury = AI_TIMEOUT, także z żywym lease', () => {
      const late = row({
        deadlineAt: new Date(NOW - TURN_TIMEOUT_GRACE_MS),
        leaseExpiresAt: new Date(NOW + 20_000),
      });
      expect(turnCloseVerdict(late, OPTIONS)).toMatchObject({
        errorCode: 'AI_TIMEOUT',
        detail: 'AI_TURN_DEADLINE',
      });
    });

    it('termin z `deadlineAt`, nie ze `startedAt` — kolejna próba go nie przesuwa', () => {
      // Tura wystartowała 10 min temu, ale termin wciąż przed nami: żyje.
      const oldStart = row({ startedAt: new Date(NOW - 600_000) });
      expect(turnCloseVerdict(oldStart, OPTIONS)).toBeNull();
    });

    it('wyczerpane próby bez żywego lease = AI_PROVIDER_ERROR z dokładnym powodem', () => {
      expect(turnCloseVerdict(row({ attempt: 3 }), OPTIONS)).toMatchObject({
        errorCode: 'AI_PROVIDER_ERROR',
        detail: 'AI_TURN_ATTEMPTS_EXHAUSTED',
      });
      // Ostatnia próba w biegu — żyje.
      expect(
        turnCloseVerdict(
          row({ attempt: 3, leaseExpiresAt: new Date(NOW + 5_000) }),
          OPTIONS,
        ),
      ).toBeNull();
    });

    it('trwały „Stop" bez żywego lease = AI_CANCELLED; z żywym czeka na workera', () => {
      const stopped = row({ cancelRequestedAt: new Date(NOW - 500) });
      expect(turnCloseVerdict(stopped, OPTIONS)).toMatchObject({
        errorCode: 'AI_CANCELLED',
      });
      expect(
        turnCloseVerdict(
          { ...stopped, leaseExpiresAt: new Date(NOW + 5_000) },
          OPTIONS,
        ),
      ).toBeNull();
    });

    it('tura sprzed Etapu 5 (bez `deadlineAt`): stara reguła znaku życia', () => {
      const legacy = row({
        deadlineAt: null,
        leaseExpiresAt: null,
        attempt: 0,
        updatedAt: new Date(NOW - TURN_ORPHAN_AFTER_MS),
      });
      expect(turnCloseVerdict(legacy, OPTIONS)).toMatchObject({
        errorCode: 'AI_PROVIDER_ERROR',
        detail: 'AI_TURN_LEGACY_ORPHAN',
      });
      expect(
        turnCloseVerdict(legacy, { ...OPTIONS, inProcess: true }),
      ).toBeNull();
    });
  });

  describe('usageCallKey (§5.8)', () => {
    it('próba 1 w starym kształcie; kolejne niosą numer próby', () => {
      expect(usageCallKey('t', 0)).toBe('turn:t:0');
      expect(usageCallKey('t', 2, 1)).toBe('turn:t:2');
      expect(usageCallKey('t', 0, 2)).toBe('turn:t:a2:0');
      // To samo wywołanie tej samej próby = ten sam klucz (ponowiony zapis).
      expect(usageCallKey('t', 1, 3)).toBe(usageCallKey('t', 1, 3));
      // To samo `callIndex` w innej próbie = INNE, realne wywołanie.
      expect(usageCallKey('t', 0, 2)).not.toBe(usageCallKey('t', 0, 1));
    });
  });

  describe('dziennik efektów — klasyfikacja i klucze (§5.7)', () => {
    it('inwentarz narzędzi zapisujących', () => {
      expect(effectKind('build_meal_plan', {})).toBe('card-db');
      expect(effectKind('propose_swap', {})).toBe('card-db');
      expect(effectKind('revise_proposal', {})).toBe('card-db');
      expect(effectKind('suggest_meals', {})).toBe('card-memory');
      expect(effectKind('offer_options', {})).toBe('card-memory');
      expect(effectKind('create_recipe', {})).toBe('keyed');
      expect(effectKind('remember_note', {})).toBe('keyed');
      expect(effectKind('apply_week_plan', { dry_run: false })).toBe('keyed');
      expect(effectKind('apply_week_plan', { dry_run: true })).toBe('read');
      expect(effectKind('mark_meal_eaten', {})).toBe('natural');
      expect(effectKind('check_shopping_items', {})).toBe('natural');
      expect(effectKind('find_recipes', {})).toBe('read');
      expect(effectKind('get_week_plan', {})).toBe('read');
    });

    it('klucz = „card" albo n-te wywołanie narzędzia w turze — deterministyczny w każdej próbie', () => {
      const keys = (effects: TurnEffects) => [
        effects.keyFor('create_recipe', 'keyed'),
        effects.keyFor('remember_note', 'keyed'),
        effects.keyFor('create_recipe', 'keyed'),
        effects.keyFor('suggest_meals', 'card-memory'),
        effects.keyFor('build_meal_plan', 'card-db'),
      ];
      const first = keys(new TurnEffects({} as never, 't', 1, 'a'));
      const second = keys(new TurnEffects({} as never, 't', 2, 'b'));
      expect(first).toEqual([
        'create_recipe#1',
        'remember_note#1',
        'create_recipe#2',
        'card',
        'card',
      ]);
      expect(second).toEqual(first);
    });
  });

  describe('konfiguracja i wejście tury', () => {
    it('domyślne i granice env', () => {
      expect(readTurnLeaseConfig({})).toEqual({
        leaseMs: 30_000,
        renewMs: 10_000,
        maxAttempts: 3,
        workerEnabled: true,
        pollMs: 3_000,
        concurrency: 16,
      });
      const custom = readTurnLeaseConfig({
        AI_TURN_LEASE_MS: '9000',
        AI_TURN_MAX_ATTEMPTS: '99',
        AI_TURN_WORKER: 'off',
      });
      expect(custom).toMatchObject({
        leaseMs: 9_000,
        renewMs: 3_000,
        // Śmieci = domyślne, nie zgadnięta liczba.
        maxAttempts: 3,
        workerEnabled: false,
      });
    });

    it('wejście tury z bazy: pełne albo `null` (tura nieodzyskiwalna)', () => {
      expect(
        parseTurnExecution({
          dates: {
            weekStart: '2026-09-28',
            clientToday: '2026-09-27',
            timeZone: 'Europe/Warsaw',
          },
          proposalMode: true,
        }),
      ).toMatchObject({ proposalMode: true });
      expect(parseTurnExecution(null)).toBeNull();
      expect(parseTurnExecution({ dates: {}, proposalMode: true })).toBeNull();
    });
  });
});
