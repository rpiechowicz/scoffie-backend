import {
  DEFAULT_GATE,
  qualityGate,
  resolveGateConfig,
  type GateConfig,
} from './writer.gate';
import type { WriteOutcome } from './writer.pipeline';

const job = (status: WriteOutcome['status'] | null, spentUsd: number) => ({
  spentMicroUsd: Math.round(spentUsd * 1_000_000),
  hasResult: status !== null,
  outcome: () => ({ status }) as WriteOutcome,
});

describe('bramka jakości serii', () => {
  it('wznowienie bierze bramkę z dziennika — bez flag nie wraca do domyślnej (review Codexa, noc 1.10)', () => {
    const strict: GateConfig = { enabled: true, reject: 0.1, cost: 0.06 };
    expect(resolveGateConfig(DEFAULT_GATE, false, strict)).toEqual({
      config: strict,
      changed: null,
    });
    const off: GateConfig = { ...DEFAULT_GATE, enabled: false };
    expect(resolveGateConfig(DEFAULT_GATE, false, off).config).toEqual(off);
  });

  it('jawna zmiana przy wznowieniu działa i jest ogłaszana', () => {
    const strict: GateConfig = { enabled: true, reject: 0.1, cost: 0.06 };
    const result = resolveGateConfig(DEFAULT_GATE, true, strict);
    expect(result.config).toEqual(DEFAULT_GATE);
    expect(result.changed).toContain('bramka zmieniona przy wznowieniu');
  });

  it('nowa seria (bez dziennika) — z flag', () => {
    expect(resolveGateConfig(DEFAULT_GATE, false, undefined).config).toEqual(
      DEFAULT_GATE,
    );
  });

  it('koszt: po wydatku wszystkich zadań, także w toku; po ostatniej rundzie nie', () => {
    const jobs = [job(null, 0.12), job(null, 0.12)];
    expect(qualityGate(jobs, DEFAULT_GATE)).toContain('wydatek');
    expect(qualityGate(jobs, DEFAULT_GATE, true)).toBeNull();
  });

  it('odrzucenia: od 30 wyników, także po ostatniej rundzie; wyłączona bramka milczy', () => {
    const jobs = [
      ...Array.from({ length: 23 }, () => job('VALIDATED', 0.04)),
      ...Array.from({ length: 7 }, () => job('REJECTED', 0.04)),
    ];
    expect(qualityGate(jobs, DEFAULT_GATE, true)).toContain(
      'odrzuconych 7 z 30',
    );
    expect(qualityGate(jobs.slice(0, 29), DEFAULT_GATE, true)).toBeNull();
    expect(
      qualityGate(jobs, { ...DEFAULT_GATE, enabled: false }, true),
    ).toBeNull();
  });
});
