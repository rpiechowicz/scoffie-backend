import type { ReportReason, ReportStatus } from '../contract';

/**
 * Czyste przejście z wierszy `AgentReport` / `AgentTurn` / `AiUsage` na
 * kontrakt kolejki zgłoszeń (`AgentReport` w `contract.ts`).
 */

export const REPORT_STATUSES: readonly ReportStatus[] = [
  'NEW',
  'REVIEWED',
  'DISMISSED',
];

const REPORT_REASONS: readonly ReportReason[] = [
  'WRONG',
  'UNSAFE',
  'OFFENSIVE',
  'OTHER',
];

/**
 * Status z kolumny tekstowej. Kolumnę zapisuje wyłącznie panel (walidacja
 * w DTO), ale to tekst, nie enum — wartość spoza kontraktu zostaje w kolejce
 * jako `NEW`, żeby nie zniknęła z oczu, zamiast udawać decyzję.
 */
export function reportStatusOf(value: string): ReportStatus {
  return (REPORT_STATUSES as readonly string[]).includes(value)
    ? (value as ReportStatus)
    : 'NEW';
}

/** Powód z `AGENT_REPORT_REASONS`; nieznany (stary klient) — `OTHER`. */
export function reportReasonOf(value: string): ReportReason {
  return (REPORT_REASONS as readonly string[]).includes(value)
    ? (value as ReportReason)
    : 'OTHER';
}

/**
 * Status tury na karcie zgłoszenia: kontrakt zna tylko `DONE` i `FAILED`.
 * `LIMITED` (globalny budżet uciął turę) i `RUNNING` (tura, której nikt nie
 * domknął) to z punktu widzenia moderacji tura nieudana.
 */
export function reportTurnStatusOf(value: string): 'DONE' | 'FAILED' {
  return value === 'DONE' ? 'DONE' : 'FAILED';
}

/**
 * Model, który NAPISAŁ odpowiedź. Tura ma najwyżej dwie fazy (`agent-route.ts`):
 * CHAT na tańszym modelu (`AgentTurn.model` = model startowy) i — po
 * `start_planning` — PLANNER na mocnym. `AiUsage` ma wiersz na fazę, ale
 * wiersze jednej tury powstają jednym `createMany`, więc ich kolejności nie da
 * się odczytać z `createdAt`. Rozstrzyga reguła trasy: przekazanie pałeczki
 * jest jednokierunkowe, więc model INNY niż startowy to ten, który skończył.
 * Bez modelu startowego (tury sprzed kolumny) — najdroższa faza.
 */
export function answeringModel(
  startModel: string | null,
  phases: readonly { model: string; costMicroUsd: number }[],
): string {
  const byCost = [...phases].sort(
    (a, b) => b.costMicroUsd - a.costMicroUsd || a.model.localeCompare(b.model),
  );
  if (startModel) {
    const handedOff = byCost.find((phase) => phase.model !== startModel);
    return handedOff?.model ?? startModel;
  }
  return byCost[0]?.model ?? '';
}
