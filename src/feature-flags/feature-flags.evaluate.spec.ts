import { randomUUID } from 'crypto';
import {
  evaluateFlag,
  evaluateFlags,
  FEATURE_FLAG_KEY_PATTERN,
  rolloutBucket,
} from './feature-flags.evaluate';

const HOUSEHOLD = '2f1c7f4e-8a55-4c61-9d0b-0c7f6f2d9e11';
const flag = (enabled: boolean, rolloutPercent = 0, key = 'beta.test') => ({
  key,
  enabled,
  rolloutPercent,
});

describe('ocena flag funkcji', () => {
  describe('kolejność: nadpisanie domu > rollout > globalne', () => {
    it('nadpisanie „wyłączona” wygrywa z globalnie włączoną i z rolloutem 100 %', () => {
      expect(evaluateFlag(flag(true, 100), HOUSEHOLD, false)).toEqual({
        value: false,
        source: 'override',
      });
    });

    it('nadpisanie „włączona” wygrywa z globalnie wyłączoną i rolloutem 0', () => {
      expect(evaluateFlag(flag(false, 0), HOUSEHOLD, true)).toEqual({
        value: true,
        source: 'override',
      });
    });

    it('bez nadpisania rollout 100 % włącza, zanim spojrzymy na globalne', () => {
      expect(evaluateFlag(flag(false, 100), HOUSEHOLD, undefined)).toEqual({
        value: true,
        source: 'rollout',
      });
    });

    it('dom poza rolloutem dostaje wartość globalną', () => {
      expect(evaluateFlag(flag(true, 0), HOUSEHOLD, undefined)).toEqual({
        value: true,
        source: 'global',
      });
      expect(evaluateFlag(flag(false, 0), HOUSEHOLD, undefined)).toEqual({
        value: false,
        source: 'off',
      });
    });

    it('bez domu: nadpisania i rollout nie działają, liczy się tylko globalne', () => {
      expect(evaluateFlag(flag(false, 100), null, true).value).toBe(false);
      expect(evaluateFlag(flag(true, 0), null, false).value).toBe(true);
    });
  });

  describe('rollout', () => {
    it('kubełek jest deterministyczny i stabilny (także dla wielkości liter id)', () => {
      const bucket = rolloutBucket('beta.test', HOUSEHOLD);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
      for (let i = 0; i < 5; i += 1) {
        expect(rolloutBucket('beta.test', HOUSEHOLD)).toBe(bucket);
      }
      expect(rolloutBucket('beta.test', HOUSEHOLD.toUpperCase())).toBe(bucket);
    });

    it('znana wartość kubełka nie zmienia się między wersjami', () => {
      // sha256("beta.test:<id>") → pierwsze 4 bajty mod 100. Zmiana algorytmu
      // przetasowałaby wszystkie bety — ma być świadoma.
      expect(rolloutBucket('beta.test', HOUSEHOLD)).toBe(32);
      expect(evaluateFlag(flag(false, 32), HOUSEHOLD, undefined).value).toBe(
        false,
      );
      expect(evaluateFlag(flag(false, 33), HOUSEHOLD, undefined).value).toBe(
        true,
      );
    });

    it('podniesienie odsetka tylko dokłada domy, nikogo nie zabiera', () => {
      const homes: string[] = Array.from({ length: 500 }, () => randomUUID());
      let previous = new Set<string>();
      for (const percent of [0, 5, 10, 25, 50, 75, 100]) {
        const inRollout = new Set(
          homes.filter(
            (id) => evaluateFlag(flag(false, percent), id, undefined).value,
          ),
        );
        for (const id of previous) expect(inRollout.has(id)).toBe(true);
        previous = inRollout;
      }
      expect(previous.size).toBe(500);
    });

    it('odsetek jest mniej więcej taki, jak ustawiony', () => {
      const homes: string[] = Array.from({ length: 4000 }, () => randomUUID());
      const share =
        homes.filter((id) => rolloutBucket('beta.test', id) < 20).length /
        homes.length;
      expect(share).toBeGreaterThan(0.16);
      expect(share).toBeLessThan(0.24);
    });

    it('różne flagi losują różne domy', () => {
      const homes: string[] = Array.from({ length: 400 }, () => randomUUID());
      const a = homes.filter((id) => rolloutBucket('beta.a', id) < 50);
      const b = new Set(homes.filter((id) => rolloutBucket('beta.b', id) < 50));
      const both = a.filter((id) => b.has(id)).length;
      expect(both).toBeLessThan(a.length);
    });
  });

  it('evaluateFlags składa mapę dla domu z nadpisaniami', () => {
    const result = evaluateFlags(
      [
        flag(false, 0, 'z.off'),
        flag(true, 0, 'a.on'),
        flag(false, 0, 'm.beta'),
      ],
      HOUSEHOLD,
      new Map([['m.beta', true]]),
    );
    expect(result).toEqual({ 'a.on': true, 'm.beta': true, 'z.off': false });
    expect(Object.keys(result)).toEqual(['a.on', 'm.beta', 'z.off']);
  });

  it('wzór klucza', () => {
    for (const ok of ['assistant.voice', 'plan_v2', 'shopping-list.beta']) {
      expect(FEATURE_FLAG_KEY_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of [
      'A',
      'Beta',
      '1beta',
      'beta flag',
      'x',
      'a'.repeat(65),
    ]) {
      expect(FEATURE_FLAG_KEY_PATTERN.test(bad)).toBe(false);
    }
  });
});
