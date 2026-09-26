import { Injectable } from '@nestjs/common';
import { readAgentEnv } from '../../config/agent-env';
import {
  AgentProvider,
  AgentProviderError,
  AgentProviderRequest,
  AgentProviderResult,
} from './agent-provider';

/** Markery w treści wiadomości — wymuszają błąd w testach, bez mockowania DI. */
export const STUB_UPSTREAM_ERROR_MARKER = '[[upstream-error]]';
export const STUB_ERROR_MARKER = '[[error]]';
/**
 * Wymusza JEDNO wywołanie narzędzia, zanim stub odpowie.
 *
 * Bez tego cała ścieżka postępu tury (`AgentTurn.progress`) była w e2e martwa:
 * stub odpowiadał od razu, więc nikt nigdy nie sprawdził, czy klient dostaje
 * kroki, których obiecuje mu kontrakt. `get_week_plan` na planowanym
 * tygodniu (z bloku gospodarstwa) niczego nie zapisuje.
 */
export const STUB_TOOL_MARKER = '[[tool]]';
/**
 * Wymusza PROPOZYCJĘ tygodnia: `[[propose:<recipeId>:<YYYY-MM-DD>]]`.
 *
 * Identyfikator i tydzień są w markerze, a nie zgadywane z promptu, bo stub
 * ma sprawdzać tor tury, a nie umieć czytać katalogu. Dzięki temu e2e
 * przechodzi całą ścieżkę propozycji — narzędzie, kartę, wiadomość z `kind`
 * i przypięcie `messageId` — bez ani jednego wywołania modelu.
 */
/**
 * Wymusza KOSZT tury: `[[cost:<mikrodolary>]]`. Bez tego stub kosztował
 * zawsze zero, więc e2e nie miało jak sprawdzić, czy wydane pieniądze
 * przeżywają anulowanie, timeout i restart (workstream, Etap 1).
 *
 * Księga widzi wtedy DWA wywołania, jak u prawdziwego dostawcy: wywołanie 0
 * (koszt N) melduje się przed opóźnieniem, wywołanie 1 (tokeny odpowiedzi,
 * koszt 0) po nim. Bez markera jest jedno wywołanie, po opóźnieniu.
 */
export const STUB_COST_PATTERN = /\[\[cost:(\d{1,9})\]\]/;

export const STUB_PROPOSE_PATTERN =
  /\[\[propose:([0-9a-fA-F-]{36}):(\d{4}-\d{2}-\d{2})\]\]/;

/**
 * Kolejne markery `[[propose:…]]` w jednej wiadomości to kolejne dni tego
 * samego tygodnia (MON, TUE, …), zawsze na kolację — tak e2e dostaje
 * propozycję z kilkoma pozycjami (np. „zamień tylko wtorek").
 */
const STUB_PROPOSE_ALL = new RegExp(STUB_PROPOSE_PATTERN.source, 'g');
const STUB_PROPOSE_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/**
 * Wymusza kartę WYBORU: `[[options:<recipeId>,<recipeId>…]]` →
 * `offer_options` z tymi daniami w tej kolejności (kafelki 1, 2, …).
 */
export const STUB_OPTIONS_PATTERN = /\[\[options:([0-9a-fA-F,-]{36,})\]\]/;

/**
 * Wymusza POPRAWKĘ propozycji:
 * `[[revise:<proposalId>:<DZIEŃ>:<PORA>:<recipeId>]]` → `revise_proposal`.
 */
/**
 * Wymusza SERWEROWY PLAN: `[[build:<YYYY-MM-DD>:<DNI po przecinku>]]` →
 * `build_meal_plan` dla tych dni, pór domu i całego domu, bez życzeń.
 */
export const STUB_BUILD_PATTERN = /\[\[build:(\d{4}-\d{2}-\d{2}):([A-Z,]+)\]\]/;

/**
 * Wymusza ZAMIENNIK od planera:
 * `[[replace:<proposalId albo ->:<DZIEŃ>:<PORA>:<DIETA>]]` → `replace_plan_item`
 * z `similar_kcal: true` (`-` = zapisany plan).
 */
export const STUB_REPLACE_PATTERN =
  /\[\[replace:([0-9a-fA-F-]{36}|-):([A-Z]{3}):([A-Z_]+):([A-Z_]+)\]\]/;

/**
 * Wymusza DANIA DO WYBORU z serwera (Etap 3):
 * `[[suggest:<DZIEŃ>:<PORA>:<quick|->]]` → `suggest_meals` na planowanym
 * tygodniu, 3 dania, `quick` = „szybkie" (tag + 25 min).
 */
export const STUB_SUGGEST_PATTERN =
  /\[\[suggest:([A-Z]{3}):([A-Z_]+):(quick|-)\]\]/;

export const STUB_REVISE_PATTERN =
  /\[\[revise:([0-9a-fA-F-]{36}):([A-Z]{3}):([A-Z_]+):([0-9a-fA-F-]{36})\]\]/;

/**
 * Dostawca `stub` (`AI_PROVIDER=stub`) — cały tor tury bez ani jednego
 * wywołania modelu: 202, polling, lease, kwota, bezpiecznik, księga użycia.
 *
 * e2e nie może zależeć od Anthropica (klucza jeszcze nie ma, a płatny
 * dostawca w CI to zły pomysł), a mock w kontenerze DI nie sprawdziłby tego,
 * co naprawdę robi runner. Stub jest więc częścią produkcyjnego kodu,
 * dostępną tylko przy jawnym `AI_PROVIDER=stub`.
 *
 * `AI_STUB_DELAY_MS` rozciąga odpowiedź — tak testuje się 409 na zajętej
 * rozmowie i przerwanie po timeoutcie.
 */
@Injectable()
export class StubAgentProvider implements AgentProvider {
  readonly name = 'stub' as const;

  async run(request: AgentProviderRequest): Promise<AgentProviderResult> {
    const lastUserText =
      [...request.messages].reverse().find((m) => m.role === 'USER')?.text ??
      '';

    // `[[cost:N]]` = pierwsze wywołanie modelu JUŻ się odbyło i kosztowało N,
    // a opóźnienie to dalsza część tury (narzędzie, kolejna runda). Przerwanie
    // w opóźnieniu niesie więc zużycie — dokładnie jak u prawdziwego dostawcy.
    const cost = Number(STUB_COST_PATTERN.exec(lastUserText)?.[1] ?? 0);
    const spent = cost > 0 ? this.usageOf(cost) : undefined;
    let calls = 0;
    if (spent) {
      await this.report(request, calls, spent);
      calls += 1;
    }
    await this.delay(readAgentEnv().stubDelayMs, request.signal, spent);

    if (lastUserText.includes(STUB_UPSTREAM_ERROR_MARKER)) {
      throw new AgentProviderError('stub: symulowany błąd dostawcy', true, 503);
    }
    if (lastUserText.includes(STUB_ERROR_MARKER)) {
      throw new AgentProviderError('stub: symulowany błąd tury', false);
    }

    // Planowany tydzień z bloku gospodarstwa — tak, jak widzi go model.
    const plannedWeek =
      /PLANOWANY TYDZIEŃ \(poniedziałek\): (\d{4}-\d{2}-\d{2})/.exec(
        request.system.map((block) => block.text).join(' '),
      )?.[1] ?? '1970-01-05';

    if (lastUserText.includes(STUB_TOOL_MARKER)) {
      await request.executeTool('get_week_plan', { week_start: plannedWeek });
    }

    const suggest = STUB_SUGGEST_PATTERN.exec(lastUserText);
    if (suggest) {
      const quick = suggest[3] === 'quick';
      await request.executeTool('suggest_meals', {
        week_start: plannedWeek,
        day_of_week: suggest[1],
        meal_type: suggest[2],
        count: 3,
        include_ingredients: [],
        for_user_ids: [],
        diet: 'NONE',
        must_have_tags: [],
        prefer_tags: quick ? ['quick'] : [],
        avoid_ingredients: [],
        max_prep_minutes: quick ? 25 : 0,
      });
    }

    const proposed = [...lastUserText.matchAll(STUB_PROPOSE_ALL)].slice(0, 7);
    if (proposed.length > 0) {
      await request.executeTool('propose_week_plan', {
        week_start: proposed[0][2],
        slots: proposed.map((match, index) => ({
          day_of_week: STUB_PROPOSE_DAYS[index],
          meal_type: 'DINNER',
          recipe: match[1],
        })),
      });
    }

    const options = STUB_OPTIONS_PATTERN.exec(lastUserText);
    if (options) {
      await request.executeTool('offer_options', {
        title: 'Do wyboru',
        slot_label: 'Kolacja · wtorek',
        options: options[1]
          .split(',')
          .filter(Boolean)
          .map((recipe) => ({ recipe })),
      });
    }

    const wishes = {
      must_have_tags: [],
      prefer_tags: [],
      avoid_ingredients: [],
      max_prep_minutes: 0,
    };
    const build = STUB_BUILD_PATTERN.exec(lastUserText);
    if (build) {
      await request.executeTool('build_meal_plan', {
        week_start: build[1],
        days: build[2].split(',').filter(Boolean),
        meal_types: [],
        for_user_ids: [],
        diet: 'NONE',
        ...wishes,
      });
    }

    const replace = STUB_REPLACE_PATTERN.exec(lastUserText);
    if (replace) {
      const weekStart =
        /\d{4}-\d{2}-\d{2}/.exec(lastUserText)?.[0] ?? '1970-01-05';
      await request.executeTool('replace_plan_item', {
        week_start: weekStart,
        day_of_week: replace[2],
        meal_type: replace[3],
        proposal_id: replace[1] === '-' ? '' : replace[1],
        similar_kcal: true,
        diet: replace[4],
        ...wishes,
      });
    }

    const revise = STUB_REVISE_PATTERN.exec(lastUserText);
    if (revise) {
      await request.executeTool('revise_proposal', {
        proposal_id: revise[1],
        day_of_week: revise[2],
        meal_type: revise[3],
        recipe: revise[4],
      });
    }

    const text = `[stub] ${lastUserText}`.slice(0, 4000);
    // Jak prawdziwy dostawca: szkic przed ostatnim słowem, żeby e2e widziało
    // kolumnę `draftText` w ruchu.
    await request.onActivity?.('writing');
    request.onDraft?.(text);
    // Prymitywne, ale niezerowe: e2e sprawdza, że księga użycia i licznik
    // kosztu dostają realne liczby, a nie same zera.
    const answer = {
      inputTokens: lastUserText.length,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: text.length,
      costMicroUsd: 0,
    };
    await this.report(request, calls, answer);
    calls += 1;
    const usage = {
      inputTokens: answer.inputTokens + (spent?.inputTokens ?? 0),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: answer.outputTokens + (spent?.outputTokens ?? 0),
      costMicroUsd: cost,
    };
    return {
      text,
      stopReason: 'end_turn',
      apiCalls: calls,
      usage,
      // Jedna faza: stub nie przekazuje pałeczki.
      phases: [
        {
          model: request.model,
          effort: request.effort,
          apiCalls: calls,
          usage,
        },
      ],
    };
  }

  private async report(
    request: AgentProviderRequest,
    callIndex: number,
    usage: ReturnType<StubAgentProvider['usageOf']>,
  ): Promise<void> {
    await request.onUsage?.({
      callIndex,
      model: request.model,
      effort: request.effort,
      usage,
      stopReason: 'end_turn',
      latencyMs: 0,
    });
  }

  private usageOf(costMicroUsd: number) {
    return {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costMicroUsd,
    };
  }

  private delay(
    ms: number,
    signal: AbortSignal,
    spent?: ReturnType<StubAgentProvider['usageOf']>,
  ): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          new AgentProviderError(
            'stub: tura przerwana',
            true,
            undefined,
            spent,
            spent ? 1 : undefined,
          ),
        );
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
