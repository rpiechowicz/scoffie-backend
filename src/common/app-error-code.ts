export type AppErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PLAN_SLOT_LIMIT_REACHED'
  | 'PLAN_SLOT_VARIANT_LIMIT_REACHED'
  | 'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD'
  | 'PLAN_TOTAL_LIMIT_REACHED'
  | 'SHOPPING_LIST_EMPTY'
  | 'SHOPPING_LIST_NOT_COMPLETED'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_ALREADY_REDEEMED'
  | 'INVITATION_DECLINED'
  // Zaproszony należy już do innego gospodarstwa. To nie jest błąd końcowy,
  // tylko pytanie do użytkownika: przyjęcie zaproszenia znaczy wyjście
  // z obecnego domu, a takiej decyzji nie wolno podjąć za niego.
  | 'INVITATION_REQUIRES_LEAVE'
  // `households:create` przy istniejącym członkostwie. Konto ma jedno
  // gospodarstwo naraz (patrz `acceptInvitation`); drugie po cichu
  // zostawało niewidoczne, bo logowanie wybiera najstarsze.
  | 'HOUSEHOLD_ALREADY_MEMBER'
  | 'CONFLICT'
  // Integracja Cookidoo (Thermomix). AUTH_FAILED leci jako 409, nie 401 —
  // 401 z API znaczy dla iOS „odśwież sesję aplikacji", a tu wygasło hasło
  // do Cookidoo, nie token użytkownika.
  | 'COOKIDOO_NOT_CONNECTED'
  | 'COOKIDOO_AUTH_FAILED'
  | 'COOKIDOO_RECIPE_NOT_LINKED'
  | 'COOKIDOO_RECIPE_NOT_FOUND'
  | 'COOKIDOO_SERVICE_UNAVAILABLE'
  | 'COOKIDOO_SUBSCRIPTION_INACTIVE'
  | 'INTERNAL_ERROR';
