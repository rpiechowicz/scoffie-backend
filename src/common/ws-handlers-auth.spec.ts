import { Logger } from '@nestjs/common';
import {
  GATEWAYS,
  HANDLERS,
  Harness,
  anonClient,
  buildGateway,
  containsString,
  invokeHandler,
  serverCalls,
  tokenClient,
} from './ws-handlers.spec-helper';
import {
  HANDLERS_WITHOUT_IDENTITY_ARG,
  HANDLERS_WITHOUT_SERVICE,
  VALID_PAYLOADS,
} from './ws-payload-fixtures.spec-helper';

/**
 * Strażnik regresji Fazy 0: KAŻDY handler `@SubscribeMessage` w repo bierze
 * tożsamość z socketu (`actorId`), nigdy z `payload.userId` — i robi to PRZED
 * walidacją koperty (anonimowy socket dostaje UNAUTHORIZED, nie
 * VALIDATION_ERROR).
 *
 * Harness (refleksja po handlerach, serwisy-Proxy) siedzi w
 * `ws-handlers.spec-helper.ts`, koperty per zdarzenie w
 * `ws-payload-fixtures.spec-helper.ts` — po kroku 2 koperty są walidowane
 * (`@IsUUID()` itd.), więc jeden uniwersalny payload z `hh-1` już nie
 * przechodzi; każde zdarzenie dostaje swoją POPRAWNĄ kopertę z podmienionym
 * `userId` napastnika.
 */

/**
 * Snapshot inline: dokładnie te zdarzenia, w tej liczbie. Nowy handler bez
 * wpisu tutaj wywala test — celowo.
 */
const EXPECTED_EVENTS: readonly string[] = [
  // UsersGateway
  'users:me',
  'users:preferences:get',
  'users:preferences:update',
  'users:profile:update',
  'users:delete',
  'users:onboarding:complete',
  // RecipesGateway
  'recipes:findAll',
  'recipes:findById',
  'ingredients:search',
  'recipes:create',
  'recipes:update',
  'recipes:delete',
  'recipes:setFavorite',
  // NotificationsGateway
  'notifications:registerDevice',
  'notifications:unregisterDevice',
  // WeeklyPlansGateway
  'weeklyPlans:getByWeek',
  'weeklyPlans:getShoppingList',
  'weeklyPlans:getShoppingListState',
  'weeklyPlans:archiveShoppingList',
  'weeklyPlans:selectShoppingListArchive',
  'weeklyPlans:deleteShoppingListArchive',
  'weeklyPlans:deleteAllShoppingListArchives',
  'weeklyPlans:setShoppingItemChecked',
  'weeklyPlans:balance',
  'weeklyPlans:applyWeekPlan',
  'weeklyPlans:upsertWeekSlot',
  'weeklyPlans:removeWeekSlot',
  'weeklyPlans:setMealEaten',
  'weeklyPlans:getSavedPlan',
  'weeklyPlans:clearWeekPlan',
  // HouseholdsGateway
  'households:findAll',
  'households:findById',
  'households:create',
  'households:createInvitation',
  'households:acceptInvitation',
  'households:previewInvitation',
  'households:listPendingInvitations',
  'households:declineInvitation',
  'households:updateName',
  'households:updateMealTypes',
  'households:updateMealTimes',
  'households:listMembers',
  'households:memberPreferences',
  'households:updateMemberRole',
  'households:removeMember',
  'households:leave',
];
const EXPECTED_HANDLER_COUNT = 46;

// ---------------------------------------------------------------------------
// Sockety i payload
// ---------------------------------------------------------------------------

const ATTACKER = 'attacker';
const VICTIM = 'victim';

/**
 * Poprawna koperta zdarzenia + `userId` podszywający się pod cudze konto.
 * `userId` na kopercie to `@IsOptional() @IsString()` (legacy), więc napis
 * `attacker` przechodzi walidację — o to chodzi: handler ma go ZIGNOROWAĆ.
 */
const attackerPayload = (event: string) => {
  const valid = VALID_PAYLOADS[event];
  if (!valid) {
    throw new Error(
      `brak VALID_PAYLOADS['${event}'] w ws-payload-fixtures.spec-helper.ts`,
    );
  }
  return { ...valid, userId: ATTACKER };
};

// ---------------------------------------------------------------------------
// Testy
// ---------------------------------------------------------------------------

describe('WS handlers — tożsamość z socketu (strażnik regresji)', () => {
  beforeEach(() => {
    // `actorId` ostrzega o rozjeździe payload.userId vs token — spodziewany
    // szum w teście z tokenem.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('inwentarz handlerów', () => {
    it(`refleksja po @SubscribeMessage znajduje dokładnie ${EXPECTED_HANDLER_COUNT} handlerów`, () => {
      expect(HANDLERS).toHaveLength(EXPECTED_HANDLER_COUNT);
      expect(EXPECTED_EVENTS).toHaveLength(EXPECTED_HANDLER_COUNT);
    });

    it('lista zdarzeń zgadza się ze snapshotem (nowy handler → dopisz go tutaj)', () => {
      const discovered = HANDLERS.map((h) => h.event).sort();
      expect(discovered).toEqual([...EXPECTED_EVENTS].sort());
      // Nazwy zdarzeń są unikalne w całym serwerze Socket.IO (jeden namespace).
      expect(new Set(discovered).size).toBe(discovered.length);
    });

    it('każdy z 5 gatewayów ma co najmniej jeden handler', () => {
      for (const gateway of GATEWAYS) {
        expect(
          HANDLERS.filter((h) => h.gateway === gateway).map((h) => h.event),
        ).not.toHaveLength(0);
      }
    });

    it('każde zdarzenie ma poprawną kopertę w VALID_PAYLOADS (nowy handler → dopisz fixture)', () => {
      const missing = HANDLERS.map((h) => h.event).filter(
        (event) => !(event in VALID_PAYLOADS),
      );
      expect(missing).toEqual([]);
      const stale = Object.keys(VALID_PAYLOADS).filter(
        (event) => !HANDLERS.some((h) => h.event === event),
      );
      expect(stale).toEqual([]);
    });
  });

  describe.each(HANDLERS)(
    '$event  [$gatewayName › $methodName]',
    ({ gateway, event, methodName }) => {
      let harness: Harness;

      beforeEach(async () => {
        harness = await buildGateway(gateway);
      });

      const invoke = (client: unknown) =>
        invokeHandler(harness, methodName, client, attackerPayload(event));

      it('anonimowy socket → ack UNAUTHORIZED 401, żaden serwis ani serwer nie tknięty', async () => {
        const ack = await invoke(anonClient());

        expect(ack).toMatchObject({
          ok: false,
          code: 'UNAUTHORIZED',
          status: 401,
        });
        expect(harness.calls).toEqual([]);
        expect(serverCalls(harness.server)).toEqual([]);
      });

      it('anonimowy socket ze ZŁĄ kopertą → nadal UNAUTHORIZED (tożsamość przed walidacją)', async () => {
        const ack = await invokeHandler(harness, methodName, anonClient(), {
          userId: ATTACKER,
          id: 'r-1',
          householdId: 'hh-1',
        });

        expect(ack).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
        expect(harness.calls).toEqual([]);
      });

      it(`socket z tokenem '${VICTIM}' + payload.userId '${ATTACKER}' → '${ATTACKER}' nie dociera do żadnego serwisu ani broadcastu`, async () => {
        const ack = await invoke(tokenClient(VICTIM));

        // Handler przeszedł całą ścieżkę (a nie wywrócił się przed serwisem).
        expect(ack).toMatchObject({ ok: true });

        if (!HANDLERS_WITHOUT_SERVICE.has(event)) {
          expect(harness.calls).not.toHaveLength(0);
        }

        const leakedServiceCalls = harness.calls.filter((call) =>
          containsString(call.args, ATTACKER),
        );
        expect(leakedServiceCalls).toEqual([]);

        const leakedServerCalls = serverCalls(harness.server).filter((args) =>
          containsString(args, ATTACKER),
        );
        expect(leakedServerCalls).toEqual([]);

        // Kontrola dodatnia: tożsamość z socketu faktycznie została użyta.
        const usedVictim =
          harness.calls.some((call) => containsString(call.args, VICTIM)) ||
          serverCalls(harness.server).some((args) =>
            containsString(args, VICTIM),
          );
        if (
          !HANDLERS_WITHOUT_SERVICE.has(event) &&
          !HANDLERS_WITHOUT_IDENTITY_ARG.has(event)
        ) {
          expect(usedVictim).toBe(true);
        }
      });
    },
  );
});
