import type { ScenarioJob } from './writer.pipeline';

/**
 * Bramka jakości serii paczek (review Codexa, noc 30.09/1.10): systemowy
 * problem — np. cała kategoria przepisów odrzucana — ma zatrzymać serię,
 * zanim zapłacimy za cały katalog.
 */
export interface GateConfig {
  enabled: boolean;
  /** Najwyższy dopuszczalny udział REJECTED wśród zadań z wynikiem. */
  reject: number;
  /** Najwyższy dopuszczalny wydatek na przepis serii (USD). */
  cost: number;
}

export const DEFAULT_GATE: GateConfig = {
  enabled: true,
  reject: 0.2,
  cost: 0.1,
};

/** Od tylu zadań z wynikiem liczy się udział REJECTED. */
export const GATE_MIN_FINISHED = 30;

/**
 * Bramka serii jest częścią jej TRWAŁEGO stanu (review Codexa, noc 1.10):
 * wznowienie bierze ją z dziennika, inaczej retry po awarii wróciłby do
 * domyślnych progów i po cichu złagodził (albo włączył) zabezpieczenia.
 * Flagi nadpisują POLE PO POLU — samo `--gate-cost` nie rusza zapisanego
 * progu odrzuceń (runda 4). Zmiana przy wznowieniu jest ogłaszana.
 */
export function resolveGateConfig(
  overrides: Partial<GateConfig>,
  fromJournal: GateConfig | undefined,
): { config: GateConfig; changed: string | null } {
  const base = fromJournal ?? DEFAULT_GATE;
  const config: GateConfig = { ...base, ...overrides };
  const changed =
    fromJournal &&
    (config.enabled !== base.enabled ||
      config.reject !== base.reject ||
      config.cost !== base.cost)
      ? `bramka zmieniona przy wznowieniu: ${describeGate(base)} → ${describeGate(config)}`
      : null;
  return { config, changed };
}

export const describeGate = (gate: GateConfig): string =>
  gate.enabled
    ? `odrzucone > ${Math.round(gate.reject * 100)}%, koszt > ${gate.cost} $`
    : 'WYŁĄCZONA';

/**
 * Powód zatrzymania albo `null`. Wydatek WSZYSTKICH zadań (także w toku)
 * na przepis — dolna granica końcowej średniej, więc wolno go sprawdzać od
 * pierwszej rundy (sama średnia zakończonych byłaby zaniżona: tanie kończą
 * się pierwsze). `final` = nic już nie zostało do wydania — wtedy tylko
 * odrzucenia (zła fala nie może skończyć się sukcesem).
 */
export function qualityGate(
  jobs: Pick<ScenarioJob, 'spentMicroUsd' | 'hasResult' | 'outcome'>[],
  gate: GateConfig,
  final = false,
): string | null {
  if (!gate.enabled || !jobs.length) return null;
  const cost =
    jobs.reduce((sum, job) => sum + job.spentMicroUsd, 0) /
    jobs.length /
    1_000_000;
  if (!final && cost > gate.cost) {
    return `wydatek ${cost.toFixed(3)} $ na przepis serii już teraz (próg ${gate.cost} $)`;
  }
  const finished = jobs
    .filter((job) => job.hasResult)
    .map((job) => job.outcome());
  if (finished.length < GATE_MIN_FINISHED) return null;
  const rejected = finished.filter((o) => o.status === 'REJECTED').length;
  if (rejected / finished.length > gate.reject) {
    return `odrzuconych ${rejected} z ${finished.length} (próg ${Math.round(gate.reject * 100)}%)`;
  }
  return null;
}
