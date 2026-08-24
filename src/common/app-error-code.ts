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
  | 'CONFLICT'
  | 'INTERNAL_ERROR';
