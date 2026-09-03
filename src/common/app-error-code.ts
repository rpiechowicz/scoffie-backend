/**
 * Kody błędów na drucie — jedna lista dla HTTP i WebSocketu.
 *
 * Klient (i niedługo narzędzia asystenta) decydują po KODZIE: ponowić,
 * przeplanować czy powiedzieć użytkownikowi. Komunikat jest do pokazania,
 * nie do parsowania — iOS przez długi czas dopasowywał angielskie podciągi,
 * bo kodów brakowało; kody niżej zamykają dokładnie te miejsca.
 *
 * Kody generyczne (po statusie HTTP) siedzą w tej samej liście, żeby
 * `wsRespond` i filtr HTTP mogły oddać je bez rzutowania.
 *
 * Lista jest tablicą runtime (nie samym typem), bo schematy narzędzi
 * asystenta i test parytetu z kopiami w iOS (`UserFacingErrorMapper.copyByCode`)
 * muszą ją móc przeczytać. Nowy kod = nowa kopia w iOS; do czasu builda klient
 * pokazuje `message` z serwera, więc komunikaty piszemy po polsku.
 */
export const APP_ERROR_CODES = [
  // ─── generyczne, po statusie ───
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'TOO_MANY_REQUESTS',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  // ─── auth ───
  'APPLE_IDENTITY_INVALID',
  'DEV_LOGIN_DISABLED',
  // ─── gospodarstwo i domownicy ───
  'HOUSEHOLD_NOT_FOUND',
  'NOT_HOUSEHOLD_MEMBER',
  'OWNER_REQUIRED',
  'MEMBER_NOT_FOUND',
  'LAST_OWNER',
  // `households:create` przy istniejącym członkostwie. Konto ma jedno
  // gospodarstwo naraz (patrz `acceptInvitation`); drugie po cichu
  // zostawało niewidoczne, bo logowanie wybiera najstarsze.
  'HOUSEHOLD_ALREADY_MEMBER',
  // ─── zaproszenia ───
  'INVITATION_NOT_FOUND',
  'INVITATION_EXPIRED',
  'INVITATION_ALREADY_REDEEMED',
  'INVITATION_DECLINED',
  // Zaproszony należy już do innego gospodarstwa. Konto obsługuje jedno
  // naraz, więc przyjęcie wymaga jawnej zgody na opuszczenie obecnego
  // (`leaveOtherHouseholds`).
  'INVITATION_REQUIRES_LEAVE',
  // ─── przepisy i składniki ───
  'RECIPE_NOT_FOUND',
  // `recipes:create` ze składnikiem, którego nie ma w katalogu (albo jest
  // nieaktywny); `details` niesie brakujące id — asystent widzi, KTÓRY
  // wymyślił, zamiast gołego 404 bez wskazania.
  'INGREDIENT_NOT_FOUND',
  // ─── plan tygodnia ───
  'PLAN_ITEM_NOT_FOUND',
  'PLAN_SLOT_LIMIT_REACHED',
  'PLAN_SLOT_VARIANT_LIMIT_REACHED',
  'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
  'PLAN_TOTAL_LIMIT_REACHED',
  // Ten sam przepis już stoi w tym slocie (wyścig dwóch telefonów).
  'PLAN_SLOT_DUPLICATE',
  // Danie wstawiane do slotu, do którego się nie nadaje (`suitableMealTypes`).
  // Do Fazy 1 zapis slotu tego nie sprawdzał — asystent mógł wstawić zupę na
  // śniadanie i nikt go nie poprawiał.
  'RECIPE_NOT_SUITABLE_FOR_SLOT',
  // Danie zawiera alergen kogoś, kto ma je zjeść. Twarda odmowa: do Fazy 1
  // pilnował tego wyłącznie prompt, a model nie widzi pełnej listy składników.
  'RECIPE_ALLERGEN_CONFLICT',
  'RECIPE_EXCLUDED_INGREDIENT',
  // Próba edycji albo kasowania przepisu ze WSPÓLNEGO katalogu. Dla asystenta
  // to instrukcja, nie ślepa uliczka: ma zrobić własną kopię w gospodarstwie,
  // a nie ponawiać zapis.
  'RECIPE_NOT_EDITABLE',
  // Przepis stoi w planie tygodnia — kasowanie zostawiłoby dziurę w planie
  // i w liście zakupów.
  'RECIPE_IN_USE',
  // ─── lista zakupów ───
  'SHOPPING_LIST_EMPTY',
  'SHOPPING_LIST_NOT_COMPLETED',
  'SHOPPING_LIST_ARCHIVE_NOT_FOUND',
  'SHOPPING_ITEM_NOT_FOUND',
  // ─── asystent AI (src/agent) ───
  // Nazwy z analizy asystenta (docs/plans/weekly-meals-ai-agent). Klient
  // decyduje po kodzie: DISABLED/BUDGET_PAUSED/UPSTREAM_PAUSED = „spróbuj
  // później", QUOTA_EXCEEDED = karta limitu, TURN_IN_PROGRESS = czekaj na
  // bieżącą turę.
  'AI_DISABLED',
  // Brak ważnej zgody na wysyłanie danych o diecie i alergiach do modelu
  // (art. 9 RODO). 403 — konto jest w porządku, brakuje kliknięcia; klient
  // pokazuje ekran zgody. Egzekwowane tylko przy AI_CONSENT_REQUIRED=true.
  'AI_CONSENT_REQUIRED',
  'AI_QUOTA_EXCEEDED',
  'AI_BUDGET_PAUSED',
  'AI_UPSTREAM_PAUSED',
  'AI_TURN_IN_PROGRESS',
  // Wyczerpany miesięczny limit ZAPISANYCH planów. Jedyny kod z tej rodziny,
  // który wraca do MODELU (jako wynik narzędzia), a nie do klienta — asystent
  // ma o tym powiedzieć zdaniem, zamiast kręcić się w kółko po odmowie zapisu.
  'AI_PLAN_QUOTA_EXCEEDED',
  'AI_CONVERSATION_NOT_FOUND',
  // Propozycja: nie ma jej, jest cudza albo osierocona (tura nie domknęła się).
  'AI_PROPOSAL_NOT_FOUND',
  // Plan zmienił się między propozycją a kliknięciem — zapis byłby cichym
  // nadpisaniem cudzej zmiany, więc go odmawiamy.
  'AI_PROPOSAL_STALE',
  // Minął termin ważności propozycji.
  'AI_PROPOSAL_EXPIRED',
  'AI_TURN_NOT_FOUND',
  'AI_MESSAGE_NOT_FOUND',
  // Powody porażki tury (`AgentTurn.errorCode`), zwracane w GET /agent/turns/:id.
  'AI_TIMEOUT',
  // Tura przerwana przez użytkownika („Stop" w aplikacji). Kwota wraca.
  'AI_CANCELLED',
  'AI_PROVIDER_ERROR',
  // ─── integracja Cookidoo (Thermomix) ───
  // AUTH_FAILED leci jako 409, nie 401 — 401 z API znaczy dla iOS „odśwież
  // sesję aplikacji", a tu wygasło hasło do Cookidoo, nie token użytkownika.
  // Integracja schowana za flagą (COOKIDOO_INTEGRATION_ENABLED=false):
  // 503, bo to stan instalacji, nie konta; `disconnect` działa mimo to.
  'COOKIDOO_DISABLED',
  'COOKIDOO_NOT_CONNECTED',
  'COOKIDOO_AUTH_FAILED',
  'COOKIDOO_RECIPE_NOT_LINKED',
  'COOKIDOO_RECIPE_NOT_FOUND',
  'COOKIDOO_SERVICE_UNAVAILABLE',
  // Vorwerk odpowiedział błędem (502 z mikroserwisu) — inna sytuacja niż
  // „nasz mikroserwis leży", choć dla użytkownika wygląda podobnie.
  'COOKIDOO_UPSTREAM_ERROR',
  /** Vorwerk nie odpowiedział w czasie (504 z usługi) — inna kopia niż „odpowiedziało błędem”. */
  'COOKIDOO_UPSTREAM_TIMEOUT',
  'COOKIDOO_SUBSCRIPTION_INACTIVE',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    typeof value === 'string' &&
    (APP_ERROR_CODES as readonly string[]).includes(value)
  );
}
