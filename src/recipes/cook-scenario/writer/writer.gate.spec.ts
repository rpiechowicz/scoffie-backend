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
  const strict: GateConfig = { enabled: true, reject: 0.1, cost: 0.06 };

  it('wznowienie bierze bramkę z dziennika — bez flag nie wraca do domyślnej (review Codexa, noc 1.10)', () => {
    expect(resolveGateConfig({}, strict)).toEqual({
      config: strict,
      changed: null,
    });
    const off: GateConfig = { ...DEFAULT_GATE, enabled: false };
    expect(resolveGateConfig({}, off).config).toEqual(off);
  });

  it('flagi nadpisują pole po polu — samo --gate-cost nie rusza progu odrzuceń (runda 4)', () => {
    expect(resolveGateConfig({ cost: 0.08 }, strict).config).toEqual({
      ...strict,
      cost: 0.08,
    });
    expect(resolveGateConfig({ reject: 0.15 }, strict).config).toEqual({
      ...strict,
      reject: 0.15,
    });
    const off = resolveGateConfig({ enabled: false }, strict);
    expect(off.config).toEqual({ ...strict, enabled: false });
    expect(off.changed).toContain('bramka zmieniona przy wznowieniu');
  });

  it('nowa seria (bez dziennika) — domyślna z flagami, bez ogłoszenia zmiany', () => {
    expect(resolveGateConfig({ cost: 0.08 }, undefined)).toEqual({
      config: { ...DEFAULT_GATE, cost: 0.08 },
      changed: null,
    });
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
