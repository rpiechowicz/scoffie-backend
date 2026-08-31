# C5 — jeden kontrakt błędów (projekt, 28.08.2026)

## Kształt na drucie
- HTTP (status ≥ 400): `{ code, message, details?: string[], requestId }`; nagłówek `x-request-id` zawsze; bez `statusCode`/`error`.
- WS ack `ok:false`: `{ ok:false, error, message (= error), code, status, details?, requestId }` — `error` zostaje (28 miejsc w iOS).

## Decyzje
| Decyzja | Wybór | Dlaczego |
|---|---|---|
| Jeden maper | `mapError(error): MappedError` w `src/common/error-contract.ts`, używany przez filtr HTTP i `wsRespond` | jedna tabela, jeden zestaw testów |
| Typ kodu | jedna unia `AppErrorCode` (kody generyczne w środku); `WireErrorCode = AppErrorCode \| 'HTTP_ERROR'` | bez podatku wyczerpywalności na 32+ miejscach |
| `details` | `AppException.details: string[]` | iOS dekoduje `[String]?`; obiekt położyłby całą kopertę |
| Filtr | `src/common/app-exception.filter.ts`, `APP_FILTER` w `src/common/common.module.ts` (globalny) | działa też w `@nestjs/testing`, bez zmian w `main.ts` |
| ValidationPipe | zostaje `useGlobalPipes` (w `configureApp`), NIE `APP_PIPE` | `APP_PIPE` objąłby gatewaye i `forbidNonWhitelisted` odrzucałby payloady WS |
| Konwertowane rzuty | tekst komunikatu bajt w bajt ten sam | stare iOS dopasowuje podciągi |
| `PLAN_SLOT_DUPLICATE` (409) | dla `weekly-plans.service.ts` „already assigned to that day and meal slot” | generyczny `CONFLICT` nie uniesie kopii o slocie po przejściu na kody |
| „Weekly plan not found” | zostaje goły `NotFoundException` → `NOT_FOUND` | `WeeklyPlanStore.swift:235` liczy na `code == "NOT_FOUND"` dla pustego tygodnia |

## Backend
### `app-error-code.ts` (+16)
`BAD_REQUEST`, `TOO_MANY_REQUESTS`, `SERVICE_UNAVAILABLE`, `NOT_HOUSEHOLD_MEMBER`, `OWNER_REQUIRED`, `HOUSEHOLD_NOT_FOUND`, `HOUSEHOLD_ALREADY_MEMBER`, `MEMBER_NOT_FOUND`, `LAST_OWNER`, `INVITATION_NOT_FOUND`, `APPLE_IDENTITY_INVALID`, `DEV_LOGIN_DISABLED`, `RECIPE_NOT_FOUND`, `PLAN_ITEM_NOT_FOUND`, `PLAN_SLOT_DUPLICATE`, `COOKIDOO_UPSTREAM_ERROR`.

### `error-contract.ts`
```ts
export type WireErrorCode = AppErrorCode | 'HTTP_ERROR';
export type ErrorContract = { code: WireErrorCode; message: string; status: number; details?: string[] };
export type MappedError = { contract: ErrorContract; log: { level: 'warn'|'error'; message: string; stack?: string } | null };
export const INTERNAL_ERROR_MESSAGE = 'Wystąpił błąd serwera. Spróbuj ponownie za chwilę.';
export const STATUS_CODE_MAP: Readonly<Record<number, WireErrorCode>>; // z ws-response + 503
export function mapError(error: unknown): MappedError;
export function toHttpBody(contract, requestId): { code; message; details?; requestId };
```
Gałęzie: 1) `AppException` → własne pola (5xx → `log.error`); 2) inny `HttpException` → tablica `message` + 400 = `VALIDATION_ERROR` z `details`, inaczej `STATUS_CODE_MAP[status] ?? 'HTTP_ERROR'`; 4xx bez logu, 5xx `error`; 3) `Prisma.PrismaClientKnownRequestError`: P2002 → CONFLICT 409 „Taki rekord już istnieje.”, P2025 → NOT_FOUND 404 „Nie znaleziono rekordu.”, P2003 → VALIDATION_ERROR 400 „Nieprawidłowe odwołanie do powiązanego rekordu.”; inne P → INTERNAL_ERROR; `log.warn` z `code`+`meta` (nigdy na drut); 4) obiekt http-errors (`statusCode` 400–599, body-parser) → kod ze statusu, „Nieprawidłowe żądanie.”; 5) reszta (nie-`Error`, `PrismaClientValidationError`) → INTERNAL_ERROR 500, komunikat stały, `log.error` z oryginałem + stack.

### `app-exception.filter.ts`
`@Catch()`; nie-HTTP → `BaseWsExceptionFilter` (siatka); `requestId = req.requestId ?? x-request-id ?? randomUUID()` (guardy odrzucają PRZED interceptorem, więc filtr sam generuje); nagłówek; `res.status().json(toHttpBody)`; log `${method} ${url} ${status} ${code} requestId=…`.

### `ws-response.ts`
`wsRespond(action, meta?: { event? })`; usunąć lokalne `STATUS_CODE_MAP/extractMessage/extractCode`; `requestId = randomUUID()` per błąd; `Logger('WsRespond')`; `setWsErrorObserver(fn | null)` → `RequestMetricsService.recordWsError(code, status)` (`wsErrors: { total, byCode }` w `snapshot()`), podpięte w `ObservabilityModule`. 47 wywołań bez zmian.

### `request-logging.interceptor.ts`
`finalize` czyta `res.statusCode` przed filtrem → błędy liczone jako 200; `tap({ error: e => errorStatus = mapError(e).contract.status })`, użyć `errorStatus ?? res.statusCode`; e2e: po 401 rośnie `statuses['4xx']`.

### Konwersje (tekst bez zmian)
| Miejsce | Kod (status) |
|---|---|
| `apple-identity.service.ts:101,104,118,128,134` | `APPLE_IDENTITY_INVALID` (401) |
| `auth.service.ts:175` | `DEV_LOGIN_DISABLED` (403) |
| `households.service.ts:42` | `HOUSEHOLD_NOT_FOUND` (404) |
| `households.service.ts:52` | `NOT_HOUSEHOLD_MEMBER` (403) |
| `households.service.ts:60,118` | `OWNER_REQUIRED` (403) |
| `households.service.ts:141,466` | `INVITATION_NOT_FOUND` (404) |
| `households.service.ts:593,625` | `MEMBER_NOT_FOUND` (404) |
| `households.service.ts:603,631` | `LAST_OWNER` (400) |
| `households.service.ts create()` | nowy strażnik `HOUSEHOLD_ALREADY_MEMBER` (409) |
| `weekly-plans/utils/auth-checks.util.ts:16` / `:33` | `RECIPE_NOT_FOUND` / `NOT_HOUSEHOLD_MEMBER` |
| `recipes.service.ts:209` / `:621,710` | `NOT_HOUSEHOLD_MEMBER` / `RECIPE_NOT_FOUND` |
| `weekly-plans.service.ts:561` / `:431` | `PLAN_ITEM_NOT_FOUND` / `PLAN_SLOT_DUPLICATE` (409) |
| `cookidoo-service.client.ts` default | `case 'COOKIDOO_UPSTREAM_ERROR'` → 502 „Cookidoo odpowiedziało błędem.” |
Celowo gołe: `jwt-auth.guard.ts`, refresh `auth.service.ts:218`, `weekly-plans.service.ts:162,547`, `shopping-list.service.ts:623,668,789`, `users.service.ts:167,452`, `recipes.service.ts:200,290`.
Spec-i: `apple-identity.service.spec.ts:101-141`, `auth.service.spec.ts:175` → `rejects.toMatchObject({ status, response: { code } })`; `weekly-plans.service.spec.ts:808` → `PLAN_SLOT_DUPLICATE`.

### Testy
`error-contract.spec.ts` (14), `ws-response.spec.ts` (8), `app-exception.filter.spec.ts` (6, mini-kontroler + supertest), e2e (4: refresh 401 body, `/auth/dev {}` VALIDATION_ERROR+details, WS obcy household → NOT_HOUSEHOLD_MEMBER z requestId, metrics `wsErrors.byCode`).

## iOS
- `RecipeProtocols.swift`: `WsEnvelope` + `message`, `requestId`, `details: [String]?` (pobłażliwe `init(from:)`); `RecipeDataError.server(code:message:status:requestId:)`; `serverError(message:)` zostaje dla transportu; `extension WsEnvelope { serverFailure(fallback:) -> RecipeDataError?; requireData(fallback:) throws -> T }`.
- 28 miejsc → `try envelope.requireData(fallback:)`: `WebSocketRecipeTransportClient.swift:37,57,79`; `WebSocketShoppingListTransportClient.swift:61,99,124,146,167,188,209`; `WeeklyPlanStore.swift:203,239(po code==NOT_FOUND),279,305,330,347`; `SessionStore.swift:894,927,972,1007,1043,1081,1094`; `:1332` → `serverFailure`; `:339,1694` → maper; `:262-270` REST Apple → `.server` z `BackendHttpErrorDTO`, usunąć `decodeErrorMessage` (`:296`); `:1929` print + requestId.
- `UserFacingErrorMapper.swift`: `code(from:)`, `copyByCode` (pełna tabela), `message(from:)` = kod najpierw, potem podciągi; `isConnectivityIssue` jako switch: `.server` → false; `.serverError` → podciągi; `.transportNotConfigured`/`IntegrationsAPIError.network`/`URLError` → true.
- `IntegrationsAPIClient.swift`: `backend(code:status:message:)`; `IntegrationsDTOs.swift`: `BackendHttpErrorDTO` + `requestId`, `details`; `CookidooIntegrationStore.swift`: `COOKIDOO_UPSTREAM_ERROR` + `default` → maper.
- Kompatybilność: stary iOS + nowy backend OK (czyta `error/code/status`); nowy iOS + stary backend spada na `error`. Rollback backendu = usunięcie `APP_FILTER`.

## Kolejność (≈1,5–2 dni)
1. kody + `AppException.details` + `error-contract.ts` + spec (2 h); 2. filtr + rejestracja + spec (2 h); 3. `ws-response` + spec + observer + fix interceptora (1,5 h); 4. konwersje + spec-i + strażnik `create` (2 h); 5. Cookidoo upstream + e2e (1 h); 6. iOS koperta/helper/28 miejsc (2 h); 7. iOS maper/integracje (2 h); 8. xcodebuild + ręcznie (1 h).
