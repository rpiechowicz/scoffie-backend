import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  MESSAGE_MAPPING_METADATA,
  MESSAGE_METADATA,
} from '@nestjs/websockets/constants';
import { HouseholdsGateway } from '../households/households.gateway';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { RecipesGateway } from '../recipes/recipes.gateway';
import { UsersGateway } from '../users/users.gateway';
import { WeeklyPlansGateway } from '../weekly-plans/weekly-plans.gateway';
import { WsTelemetryService } from './ws-telemetry.service';

/**
 * Strażnik regresji Fazy 0: KAŻDY handler `@SubscribeMessage` w repo bierze
 * tożsamość z socketu (`actorId`), nigdy z `payload.userId`.
 *
 * Handlery znajdujemy tak, jak Nest sam je znajduje przy starcie
 * (`GatewayMetadataExplorer`): po metadanych `MESSAGE_MAPPING_METADATA` /
 * `MESSAGE_METADATA` na metodach prototypu. Dzięki temu nowy handler wchodzi
 * do tabeli automatycznie — a snapshot nazw zdarzeń niżej wymusza, żeby autor
 * świadomie go tu dopisał (i przy okazji przeszedł testy tożsamości).
 *
 * Serwisy są `Proxy`, którego każda właściwość to `jest.fn()`: nie trzeba
 * wymieniać metod, a każde wywołanie jest zebrane do sprawdzenia.
 */

const GATEWAYS = [
  UsersGateway,
  RecipesGateway,
  NotificationsGateway,
  WeeklyPlansGateway,
  HouseholdsGateway,
] as const;

type GatewayClass = (typeof GATEWAYS)[number];

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
  'recipes:create',
  'recipes:setFavorite',
  // NotificationsGateway
  'notifications:registerDevice',
  // WeeklyPlansGateway
  'weeklyPlans:getByWeek',
  'weeklyPlans:getShoppingList',
  'weeklyPlans:getShoppingListState',
  'weeklyPlans:archiveShoppingList',
  'weeklyPlans:selectShoppingListArchive',
  'weeklyPlans:deleteShoppingListArchive',
  'weeklyPlans:deleteAllShoppingListArchives',
  'weeklyPlans:setShoppingItemChecked',
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
  'households:updateMemberRole',
  'households:removeMember',
  'households:leave',
];
const EXPECTED_HANDLER_COUNT = 39;

/**
 * Handlery, które z założenia nie wołają żadnego serwisu (stub/deprecated).
 * Dla pozostałych test z tokenem wymaga, żeby serwis został wywołany —
 * inaczej „żaden argument nie zawiera 'attacker'" byłoby prawdziwe pusto.
 */
const HANDLERS_WITHOUT_SERVICE = new Set<string>(['weeklyPlans:getSavedPlan']);

type Handler = {
  gateway: GatewayClass;
  gatewayName: string;
  event: string;
  methodName: string;
};

/** Ta sama refleksja, co `GatewayMetadataExplorer.explore` w @nestjs/websockets. */
function discoverHandlers(gateway: GatewayClass): Handler[] {
  const proto = gateway.prototype as unknown as Record<string, unknown>;
  return new MetadataScanner()
    .getAllMethodNames(proto)
    .flatMap((methodName) => {
      const callback = proto[methodName] as object;
      const isMessageMapping = Reflect.getMetadata(
        MESSAGE_MAPPING_METADATA,
        callback,
      ) as unknown;
      if (isMessageMapping === undefined) {
        return [];
      }
      const event = Reflect.getMetadata(MESSAGE_METADATA, callback) as unknown;
      if (typeof event !== 'string') {
        throw new Error(
          `${gateway.name}.${methodName}: @SubscribeMessage bez nazwy zdarzenia (string)`,
        );
      }
      return [{ gateway, gatewayName: gateway.name, event, methodName }];
    });
}

const HANDLERS: Handler[] = GATEWAYS.flatMap(discoverHandlers);

// ---------------------------------------------------------------------------
// Sztuczne serwisy: Proxy, każda właściwość = jest.fn(); wszystkie wywołania
// zbierane w jednym rejestrze na test.
// ---------------------------------------------------------------------------

type CallRecord = { service: string; method: string; args: unknown[] };

/**
 * Wynik, który przechodzi przez każdą ścieżkę „po serwisie" w gatewayach
 * (`result.id`, `result.leftHouseholdIds`, `result.touchedWeekStarts.map`,
 * `preview.addedToInbox`, `result.enabledMealTypes`, …). Serwisy są
 * zamockowane, więc kształt nie musi być prawdziwy — ma tylko nie wywrócić
 * handlera przed broadcastami i wywołaniami serwisów, które chcemy zobaczyć.
 */
const GENERIC_RESULT = Object.freeze({
  id: 'hh-1',
  householdId: 'hh-1',
  name: 'Dom',
  weekStart: '2026-08-24',
  leftHouseholdIds: [] as string[],
  touchedWeeks: [] as Array<{ householdId: string; weekStart: string }>,
  touchedWeekStarts: [] as string[],
  enabledMealTypes: [] as string[],
  mealSlotTimes: {},
  addedToInbox: false,
  changeKind: 'CREATED',
  success: true,
});

const IGNORED_PROPS = new Set<string>([
  'then',
  'catch',
  'finally',
  'constructor',
  'toJSON',
  'asymmetricMatch',
  'nodeType',
  '$$typeof',
  '@@__IMMUTABLE_ITERABLE__@@',
  '@@__IMMUTABLE_RECORD__@@',
]);

function serviceProxy(serviceName: string, calls: CallRecord[]): object {
  const fns = new Map<string, jest.Mock>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || IGNORED_PROPS.has(prop)) {
          return undefined;
        }
        let fn = fns.get(prop);
        if (!fn) {
          fn = jest.fn((...args: unknown[]) => {
            calls.push({ service: serviceName, method: prop, args });
            return Promise.resolve({ ...GENERIC_RESULT });
          });
          fns.set(prop, fn);
        }
        return fn;
      },
      has(_target, prop) {
        return typeof prop === 'string' && !IGNORED_PROPS.has(prop);
      },
    },
  );
}

type Harness = {
  instance: Record<string, (client: unknown, payload: unknown) => unknown>;
  calls: CallRecord[];
  server: {
    emit: jest.Mock;
    to: jest.Mock;
    in: jest.Mock;
    socketsJoin: jest.Mock;
    socketsLeave: jest.Mock;
    disconnectSockets: jest.Mock;
  };
};

/** Zależności konstruktora czytamy z `design:paramtypes` — jak Nest przy DI. */
function constructorDeps(
  gateway: GatewayClass,
): Array<abstract new (...a: never[]) => unknown> {
  const types = Reflect.getMetadata('design:paramtypes', gateway) as unknown;
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error(
      `${gateway.name}: brak design:paramtypes — gateway bez DI?`,
    );
  }
  return types.map((type: unknown, index: number) => {
    if (typeof type !== 'function' || type === Object) {
      throw new Error(
        `${gateway.name}: parametr konstruktora #${index} nie jest klasą — ` +
          'test wymaga rozszerzenia o jawny token DI',
      );
    }
    return type as abstract new (...a: never[]) => unknown;
  });
}

async function buildGateway(gateway: GatewayClass): Promise<Harness> {
  const calls: CallRecord[] = [];
  const providers = constructorDeps(gateway).map((dep) =>
    dep === WsTelemetryService
      ? {
          provide: WsTelemetryService,
          useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() },
        }
      : { provide: dep, useValue: serviceProxy(dep.name, calls) },
  );

  const module = await Test.createTestingModule({
    providers: [gateway, ...providers],
  }).compile();

  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  const socketsJoin = jest.fn();
  const socketsLeave = jest.fn();
  const disconnectSockets = jest.fn();
  const inRoom = jest
    .fn()
    .mockReturnValue({ socketsJoin, socketsLeave, disconnectSockets });

  // `module.get` zwraca klasę gatewaya; tabela woła handlery po nazwie,
  // więc instancja idzie dalej jako mapa metod. Przez `unknown`, bo
  // rzutowanie z konkretnej klasy eslint --fix uznaje za zbędne i usuwa.
  const instance: unknown = module.get(gateway);
  (instance as { server: unknown }).server = {
    emit,
    to,
    in: inRoom,
  };

  return {
    instance: instance as Harness['instance'],
    calls,
    server: {
      emit,
      to,
      in: inRoom,
      socketsJoin,
      socketsLeave,
      disconnectSockets,
    },
  };
}

// ---------------------------------------------------------------------------
// Sockety i payload
// ---------------------------------------------------------------------------

const ATTACKER = 'attacker';
const VICTIM = 'victim';

const anonClient = () => ({ data: {} }) as unknown;
const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as unknown;

/**
 * Jeden payload dla wszystkich handlerów: `userId` podszywający się pod cudze
 * konto plus komplet pól, których używają gatewaye (householdId, weekStart,
 * `data.householdId` w broadcastach itd.). Serwisy są mockami, więc nadmiar
 * pól nikomu nie przeszkadza.
 */
const attackerPayload = () => ({
  userId: ATTACKER,
  id: 'r-1',
  householdId: 'hh-1',
  weekStart: '2026-08-24',
  weekLabel: 'Tydzień 35',
  archiveId: 'arch-1',
  memberUserId: 'member-1',
  filters: {},
  data: {
    householdId: 'hh-1',
    recipeId: 'r-1',
    isFavorite: true,
    productKey: 'p-1',
    isChecked: true,
    dayOfWeek: 'MONDAY',
    mealType: 'DINNER',
    deviceToken: 'device-1',
    token: 'inv-1',
    name: 'Dom',
  },
});

/** Rekurencyjnie: czy gdziekolwiek w wartości siedzi napis zawierający `needle`. */
function containsString(
  value: unknown,
  needle: string,
  seen = new Set<unknown>(),
): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsString(item, needle, seen));
  }
  if (value instanceof Map) {
    return [...value.entries()].some(
      ([k, v]) =>
        containsString(k, needle, seen) || containsString(v, needle, seen),
    );
  }
  if (value instanceof Set) {
    return [...value].some((item) => containsString(item, needle, seen));
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsString(item, needle, seen),
  );
}

/** Wywołania odroczone (`void promise.then(...)`, `setImmediate`) też mają się policzyć. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const serverCalls = (server: Harness['server']): unknown[][] => [
  ...server.emit.mock.calls,
  ...server.to.mock.calls,
  ...server.in.mock.calls,
  ...server.socketsJoin.mock.calls,
  ...server.socketsLeave.mock.calls,
  ...server.disconnectSockets.mock.calls,
];

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
  });

  describe.each(HANDLERS)(
    '$event  [$gatewayName › $methodName]',
    ({ gateway, event, methodName }) => {
      let harness: Harness;

      beforeEach(async () => {
        harness = await buildGateway(gateway);
      });

      const invoke = async (client: unknown) => {
        const handler = harness.instance[methodName];
        expect(typeof handler).toBe('function');
        const ack = await handler.call(
          harness.instance,
          client,
          attackerPayload(),
        );
        await flush();
        return ack as { ok: boolean; code?: string; status?: number };
      };

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
        if (!HANDLERS_WITHOUT_SERVICE.has(event)) {
          expect(usedVictim).toBe(true);
        }
      });
    },
  );
});
