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
 *   planu, „zjedzone"). Klucz `<narzędzie>#<n>`, wiersz W TRANSAKCJI efektu.
 * - `natural` — `check_shopping_items`: kilka zapisów „kupione" w osobnych
 *   transakcjach (po jednej na produkt), więc wiersz dziennika idzie po
 *   wykonaniu. Powtórka po padzie między commitem a dziennikiem ustawia tę
 *   samą wartość jeszcze raz (raport 05, Addendum A1 — świadomie słabsza
 *   gwarancja).
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
  'mark_meal_eaten',
]);
const NATURAL_TOOLS = new Set(['check_shopping_items']);

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

/**
 * Kanoniczny JSON wejścia narzędzia (Addendum A1): klucze obiektów
 * posortowane, kolejność tablic ZACHOWANA, `null` ≠ brak pola, typy bez
 * zmian (`1` ≠ `"1"`). Brak pola i `undefined` to jedno (tak zapisuje je
 * JSONB), `NaN`/`Infinity` — `null` (jak `JSON.stringify`).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? 'null';
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalValue(item),
    );
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = canonicalValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Czy bieżące wywołanie to TA SAMA operacja, co zapisany efekt: to samo
 * narzędzie i kanonicznie równe wejście. Tylko wtedy wolno oddać zapisany
 * wynik jako wynik tego wywołania.
 */
export function isSameOperation(
  stored: Pick<StoredEffect, 'tool' | 'input'>,
  name: string,
  input: Record<string, unknown>,
): boolean {
  return (
    stored.tool === name && canonicalJson(stored.input) === canonicalJson(input)
  );
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
 *
 * KURSOR, nie licznik wywołań (Addendum A1): `n` przesuwa się dopiero po
 * udanym odtworzeniu zapisanego efektu albo po zatwierdzeniu nowego. Wywołanie
 * z innym wejściem niż zapisany efekt `#n` to konflikt odzyskiwania — kursor
 * stoi, więc kolejne wywołanie znowu trafia na `#n` i nie przeskoczy do
 * `#n+1` (drugiego przepisu). Wywołania jednego narzędzia w próbie idą po
 * kolei (`exclusive`), żeby dwa równoległe nie dostały tego samego `#n`.
 */
export class TurnEffects {
  private readonly cursor = new Map<string, number>();
  private readonly lanes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    readonly turnId: string,
    readonly attempt: number,
    /** `null` = tura bez lease (testy jednostkowe, wywołania spoza workera). */
    private readonly leaseToken: string | null,
  ) {}

  /** Klucz NASTĘPNEGO efektu tego narzędzia — bez przesuwania kursora. */
  keyFor(name: string, kind: EffectKind): string {
    if (kind === 'card-db' || kind === 'card-memory') return 'card';
    return `${name}#${(this.cursor.get(name) ?? 0) + 1}`;
  }

  /** Efekt `#n` rozpoznany (odtworzony) albo zatwierdzony — dalej `#n+1`. */
  advance(name: string, kind: EffectKind): void {
    if (kind === 'card-db' || kind === 'card-memory') return;
    this.cursor.set(name, (this.cursor.get(name) ?? 0) + 1);
  }

  /** Wywołania jednego „pasa" (narzędzie albo karta) po kolei. */
  exclusive<T>(lane: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.lanes.set(
      lane,
      next.catch(() => undefined),
    );
    return next;
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
