import { AgentCallTiming } from './providers/agent-provider';

/**
 * Jedna linia logu z rozbiciem czasu tury — do `grep agent-timing` w logach
 * Railwaya i do porównań przed/po zmianie.
 *
 * Same liczby i nazwy narzędzi, bez treści: w logach asystenta nie ma
 * wiadomości użytkownika (patrz CLAUDE.md). Format `klucz=wartość`, żeby dało
 * się go rozebrać jednym `awk`, bez parsera.
 *
 * `prep` to czas od startu tury do pierwszego żądania (historia + prompt) —
 * tego w benchmarku nie widać, bo benchmark składa prompt poza pomiarem.
 */
export function formatTurnTiming(
  turnId: string,
  totalMs: number,
  prepMs: number,
  timings: readonly AgentCallTiming[],
): string {
  const calls = timings.map((timing, index) =>
    [
      `c${index + 1}=${timing.model}`,
      `total=${timing.totalMs}`,
      `first=${timing.firstBlockMs ?? '-'}`,
      `think=${timing.thinkingMs}`,
      `tool_in=${timing.toolInputMs}`,
      `text=${timing.textMs}`,
      `out=${timing.outputTokens}`,
      `run=${timing.toolsRunMs ?? '-'}`,
      `tools=${timing.tools.join('+') || '-'}`,
    ].join(','),
  );
  return [
    'agent-timing',
    `turn=${turnId}`,
    `total=${totalMs}`,
    `prep=${prepMs}`,
    `calls=${timings.length}`,
    ...calls,
  ].join(' ');
}
