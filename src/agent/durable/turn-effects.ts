import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentCard } from '../cards/agent-cards';
import { AgentTurnQueue } from './agent-turn-queue.service';

/**
 * Jak narzędzie zachowuje się przy odzyskaniu tury (workstream, Etap 5, §5.7).
 *
 * - `read` — nic nie zapisuje; wykonuje się od nowa bez dziennika.
 * - `card-db` — propozycja w bazie. Klucz `card` (jedna karta na turę), wiersz
 *   dziennika W TRANSAKCJI propozycji.
 * - `card-memory` — karta bez skutków w bazie (wybór, pytanie). Klucz `card`,
 *   wiersz po wykonaniu — nie ma efektu, który mógłby się zdublować, a zapis
 *   pozwala domknąć odzyskaną turę tą samą kartą bez wołania modelu.
 * - `keyed` — efekt wymagający klucza idempotencji (przepis, notatka, zapis
 *   planu). Klucz `<narzędzie>#<n>`, wiersz W TRANSAKCJI efektu.
 * - `natural` — efekt idempotentny z natury: ustawienie wartości („zjedzone",
 *   „kupione"). Klucz `<narzędzie>#<n>`, wiersz po wykonaniu; powtórka po
 *   padzie między commitem a dziennikiem ustawia tę samą wartość jeszcze raz.
 */
export type EffectKind =
  | 'read'
  | 'card-db'
  | 'card-memory'
  | 'keyed'
  | 'natural';

const CARD_DB_TOOLS = new Set([
  'propose_week_plan',
  'propose_day_plan',
  'propose_swap',
  'propose_remove_meal',
  'propose_household_split',
  'revise_proposal',
  'build_meal_plan',
  'replace_plan_item',
]);
const CARD_MEMORY_TOOLS = new Set([
  'ask_clarifying_question',
  'offer_options',
  'suggest_meals',
]);
const KEYED_TOOLS = new Set([
  'create_recipe',
  'update_recipe',
  'remember_note',
]);
const NATURAL_TOOLS = new Set(['mark_meal_eaten', 'check_shopping_items']);

export function effectKind(
  name: string,
  input: Record<string, unknown>,
): EffectKind {
  if (CARD_DB_TOOLS.has(name)) return 'card-db';
  if (CARD_MEMORY_TOOLS.has(name)) return 'card-memory';
  if (KEYED_TOOLS.has(name)) return 'keyed';
  if (name === 'apply_week_plan') {
    return input.dry_run === true ? 'read' : 'keyed';
  }
  if (NATURAL_TOOLS.has(name)) return 'natural';
  return 'read';
}

/** Zapis w dzienniku: wynik narzędzia w kształcie `AgentToolResult`. */
export type StoredEffect = {
  key: string;
  tool: string;
  attempt: number;
  input: Record<string, unknown>;
  result:
    | { ok: true; data: unknown }
    | {
        ok: false;
        error: { code: string; message: string; details?: string[] };
      };
  card: AgentCard | null;
};

/** Efekt o tym kluczu jest już w dzienniku (wyścig albo wcześniejsza próba). */
export class EffectAlreadyCommittedError extends Error {
  constructor(readonly key: string) {
    super(`efekt ${key} jest już w dzienniku tury`);
    this.name = 'EffectAlreadyCommittedError';
  }
}

/** Hak transakcji efektu podawany domenie: fencing + wiersz dziennika. */
export type EffectCommit = (
  tx: Prisma.TransactionClient,
  data: unknown,
) => Promise<void>;

/**
 * Dziennik efektów JEDNEJ próby wykonania tury.
 *
 * Tożsamość wywołania narzędzia jest TRWAŁA i niezależna od modelu: `card`
 * albo `<narzędzie>#<n>`, gdzie `n` to kolejne wywołanie tego narzędzia w tej
 * turze. Model w odzyskanej próbie nie ma tych samych identyfikatorów
 * `tool_use` co w pierwszej (to nowe wywołanie API), więc klucz z nich nie
 * dałby niczego; losowe UUID też nie — powstałoby nowe przy każdej próbie.
 * N-te wywołanie `create_recipe` w turze to ta sama operacja w każdej próbie:
 * po odzyskaniu dostaje zapisany wynik zamiast drugiego przepisu.
 */
export class TurnEffects {
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    readonly turnId: string,
    readonly attempt: number,
    /** `null` = tura bez lease (testy jednostkowe, wywołania spoza workera). */
    private readonly leaseToken: string | null,
  ) {}

  keyFor(name: string, kind: EffectKind): string {
    if (kind === 'card-db' || kind === 'card-memory') return 'card';
    const next = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, next);
    return `${name}#${next}`;
  }

  async load(key: string): Promise<StoredEffect | null> {
    const row = await this.prisma.agentTurnEffect.findUnique({
      where: { turnId_key: { turnId: this.turnId, key } },
    });
    return row ? toStored(row) : null;
  }

  /**
   * Hak do transakcji efektu: fencing (lease nadal nasz) i wiersz dziennika
   * z tym samym commitem co efekt. `ON CONFLICT DO NOTHING` + licznik zamiast
   * łapania P2002 — błąd w środku transakcji Postgresa psułby ją całą.
   */
  commitFor(
    key: string,
    tool: string,
    input: Record<string, unknown>,
  ): EffectCommit {
    return async (tx, data) => {
      if (this.leaseToken) {
        await AgentTurnQueue.fence(tx, this.turnId, this.leaseToken);
      }
      const inserted = await tx.agentTurnEffect.createMany({
        data: [
          {
            turnId: this.turnId,
            key,
            tool,
            attempt: this.attempt,
            input: input as Prisma.InputJsonValue,
            result: { ok: true, data: data ?? null } as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) throw new EffectAlreadyCommittedError(key);
    };
  }

  /**
   * Wiersz PO wykonaniu (karta bez skutków, efekt z natury idempotentny,
   * odmowa narzędzia). Bez transakcji efektu — nie ma czego zdublować.
   * Fencing też jest: worker bez lease nie dopisuje dziennika za kogoś.
   */
  async record(
    key: string,
    tool: string,
    input: Record<string, unknown>,
    result: StoredEffect['result'],
    card: AgentCard | null = null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (this.leaseToken) {
        await AgentTurnQueue.fence(tx, this.turnId, this.leaseToken);
      }
      await tx.agentTurnEffect.createMany({
        data: [
          {
            turnId: this.turnId,
            key,
            tool,
            attempt: this.attempt,
            input: input as Prisma.InputJsonValue,
            result: result as unknown as Prisma.InputJsonValue,
            ...(card ? { card: card as unknown as Prisma.InputJsonValue } : {}),
          },
        ],
        skipDuplicates: true,
      });
    });
  }

  /**
   * Pełny wynik po commicie efektu (w transakcji zapisał się wynik, który
   * domena miała pod ręką). Best effort: bez tego odzyskanie odda wynik
   * z transakcji — krótszy, ale prawdziwy.
   */
  async complete(key: string, data: unknown): Promise<void> {
    await this.prisma.agentTurnEffect.updateMany({
      where: { turnId: this.turnId, key },
      data: {
        result: { ok: true, data: data ?? null } as Prisma.InputJsonValue,
      },
    });
  }
}

export function toStored(row: {
  key: string;
  tool: string;
  attempt: number;
  input: Prisma.JsonValue;
  result: Prisma.JsonValue;
  card: Prisma.JsonValue | null;
}): StoredEffect {
  return {
    key: row.key,
    tool: row.tool,
    attempt: row.attempt,
    input: (row.input ?? {}) as Record<string, unknown>,
    result: row.result as unknown as StoredEffect['result'],
    card: (row.card ?? null) as unknown as AgentCard | null,
  };
}
