import { CatalogDigest } from './catalog-digest';

/**
 * Prompt systemowy asystenta — trzy bloki, w kolejności podyktowanej przez
 * cache, nie przez czytelność.
 *
 * Cache Anthropica działa na PREFIKSIE: jedna zmieniona litera unieważnia
 * wszystko, co po niej. Dlatego kolejność jest od najbardziej stabilnego do
 * najbardziej zmiennego:
 *
 * 1. **instrukcje** — te same dla wszystkich i dla każdej tury,
 * 2. **digest katalogu** — ten sam dla WSZYSTKICH gospodarstw, zmienia się
 *    tylko przy zmianie katalogu (stąd punkt cache z dłuższym życiem),
 * 3. **kontekst gospodarstwa** — inny dla każdego domu.
 *
 * Gdyby kontekst domu szedł przed digestem, każdy dom miałby własną kopię
 * 8 000 tokenów katalogu w cache zamiast współdzielić jedną (analiza kosztów,
 * §5). Przy kilkudziesięciu gospodarstwach to jest różnica między groszami
 * a złotówkami na turę.
 */
export type SystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
};

export type HouseholdPromptContext = {
  householdName: string;
  /** `YYYY-MM-DD` z telefonu — serwer żyje w UTC i nie ma prawa liczyć „dziś". */
  clientToday: string;
  weekStart: string;
  timeZone: string;
  enabledMealTypes: string[];
  members: unknown;
};

export const AGENT_INSTRUCTIONS = [
  'Jesteś asystentem planowania posiłków w aplikacji Weekly Meals. Mówisz po polsku, zwięźle i konkretnie.',
  '',
  'Twoje zadanie to układać i poprawiać tygodniowy plan posiłków dla gospodarstwa domowego.',
  'Nie jesteś czatem ogólnego przeznaczenia: pytania spoza jedzenia, zakupów i planu grzecznie odsyłasz.',
  '',
  'ZASADY, OD KTÓRYCH NIE MA ODSTĘPSTW:',
  '1. Nie zmyślasz przepisów ani składników. Wszystko, co proponujesz, pochodzi z katalogu poniżej',
  '   albo z narzędzi. Nie ma czegoś w katalogu — powiedz to wprost, nie wymyślaj.',
  '2. Alergeny i diety są twarde. Zanim cokolwiek zaproponujesz, sprawdź gospodarstwo przez',
  '   get_household_context. Danie z alergenem domownika nie jest propozycją do rozważenia.',
  '3. Zanim zapiszesz plan, uruchom apply_week_plan z dry_run=true i popraw wszystkie naruszenia.',
  '   Zapis bez tego kroku to strata tury: przy naruszeniu i tak nic się nie zapisze.',
  '4. Nie liczysz wartości odżywczych samodzielnie — od tego jest get_week_balance. Twoje',
  '   szacunki byłyby zmyśleniem, a użytkownik widzi w aplikacji liczby policzone przez serwer.',
  '5. Dat nie liczysz. Bierzesz je z kontekstu poniżej.',
  '',
  'JAK PRACUJESZ:',
  '- Najpierw sprawdzasz stan (kontekst gospodarstwa, plan, bilans), potem proponujesz.',
  '- Zmiany opisujesz krótko i po ludzku: co wchodzi, co znika, dlaczego.',
  '- Gdy narzędzie zwróci błąd, czytasz kod i poprawiasz się sam. Nie powtarzasz tego samego wywołania.',
  '- Gdy czegoś nie da się zrobić, mówisz to wprost razem z powodem — nie obiecujesz na przyszłość.',
  '- Nie pytasz o zgodę na każdy krok. Pytasz, gdy naprawdę brakuje informacji, której nie ma w narzędziach.',
].join('\n');

/**
 * Buduje bloki systemowe tury.
 *
 * Punkty cache: instrukcje razem z digestem (jeden wspólny prefiks dla całej
 * instalacji, TTL godzina — katalog zmienia się rzadko, a przy kilkudziesięciu
 * użytkownikach trafienie jest niemal pewne), kontekst domu bez punktu — jest
 * krótki i zmienny, więc jego zapis kosztowałby więcej, niż oszczędza.
 */
export function buildSystemPrompt(
  digest: CatalogDigest,
  context: HouseholdPromptContext,
): SystemBlock[] {
  const householdBlock = [
    `GOSPODARSTWO: ${context.householdName}`,
    `DZIŚ: ${context.clientToday} (strefa ${context.timeZone})`,
    `PLANOWANY TYDZIEŃ (poniedziałek): ${context.weekStart}`,
    `POSIŁKI, KTÓRE TEN DOM PLANUJE: ${context.enabledMealTypes.join(', ')}`,
    '',
    'DOMOWNICY (dieta, alergeny, cele) — z get_household_context:',
    JSON.stringify(context.members),
  ].join('\n');

  return [
    { type: 'text', text: AGENT_INSTRUCTIONS },
    {
      type: 'text',
      text: digest.text,
      // Punkt cache PO katalogu: wszystko przed nim jest wspólne dla całej
      // instalacji, więc jeden zapis obsługuje wszystkie gospodarstwa.
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
    { type: 'text', text: householdBlock },
  ];
}
