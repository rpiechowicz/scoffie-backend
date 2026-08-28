/**
 * Kody błędów na drucie — jedna lista dla HTTP i WebSocketu.
 *
 * Klient (i niedługo narzędzia asystenta) decydują po KODZIE: ponowić,
 * przeplanować czy powiedzieć użytkownikowi. Komunikat jest do pokazania,
 * nie do parsowania — iOS przez długi czas dopasowywał angielskie podciągi,
 * bo kodów brakowało; kody niżej zamykają dokładnie te miejsca.
 *
 * Kody generyczne (po statusie HTTP) siedzą w tej samej unii, żeby
 * `wsRespond` i filtr HTTP mogły oddać je bez rzutowania.
 */
export type AppErrorCode =
  // ─── generyczne, po statusie ───
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_ERROR'
  | 'TOO_MANY_REQUESTS'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  // ─── auth ───
  | 'APPLE_IDENTITY_INVALID'
  | 'DEV_LOGIN_DISABLED'
  // ─── gospodarstwo i domownicy ───
  | 'HOUSEHOLD_NOT_FOUND'
  | 'NOT_HOUSEHOLD_MEMBER'
  | 'OWNER_REQUIRED'
  | 'MEMBER_NOT_FOUND'
  | 'LAST_OWNER'
  // `households:create` przy istniejącym członkostwie. Konto ma jedno
  // gospodarstwo naraz (patrz `acceptInvitation`); drugie po cichu
  // zostawało niewidoczne, bo logowanie wybiera najstarsze.
  | 'HOUSEHOLD_ALREADY_MEMBER'
  // ─── zaproszenia ───
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_ALREADY_REDEEMED'
  | 'INVITATION_DECLINED'
  // Zaproszony należy już do innego gospodarstwa. Konto obsługuje jedno
  // naraz, więc przyjęcie wymaga jawnej zgody na opuszczenie obecnego
  // (`leaveOtherHouseholds`).
  | 'INVITATION_REQUIRES_LEAVE'
  // ─── plan tygodnia ───
  | 'RECIPE_NOT_FOUND'
  | 'PLAN_ITEM_NOT_FOUND'
  | 'PLAN_SLOT_LIMIT_REACHED'
  | 'PLAN_SLOT_VARIANT_LIMIT_REACHED'
  | 'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD'
  | 'PLAN_TOTAL_LIMIT_REACHED'
  // Ten sam przepis już stoi w tym slocie (wyścig dwóch telefonów).
  | 'PLAN_SLOT_DUPLICATE'
  // ─── lista zakupów ───
  | 'SHOPPING_LIST_EMPTY'
  | 'SHOPPING_LIST_NOT_COMPLETED'
  // ─── integracja Cookidoo (Thermomix) ───
  // AUTH_FAILED leci jako 409, nie 401 — 401 z API znaczy dla iOS „odśwież
  // sesję aplikacji", a tu wygasło hasło do Cookidoo, nie token użytkownika.
  | 'COOKIDOO_NOT_CONNECTED'
  | 'COOKIDOO_AUTH_FAILED'
  | 'COOKIDOO_RECIPE_NOT_LINKED'
  | 'COOKIDOO_RECIPE_NOT_FOUND'
  | 'COOKIDOO_SERVICE_UNAVAILABLE'
  // Vorwerk odpowiedział błędem (502 z mikroserwisu) — inna sytuacja niż
  // „nasz mikroserwis leży", choć dla użytkownika wygląda podobnie.
  | 'COOKIDOO_UPSTREAM_ERROR'
  | 'COOKIDOO_SUBSCRIPTION_INACTIVE';
