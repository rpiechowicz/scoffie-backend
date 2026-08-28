import 'reflect-metadata';
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
 * Wspólny harness testów refleksyjnych po WSZYSTKICH handlerach
 * `@SubscribeMessage` (`ws-handlers-auth.spec.ts`, `ws-handlers-validation.spec.ts`).
 *
 * Handlery znajdujemy tak, jak Nest sam je znajduje przy starcie
 * (`GatewayMetadataExplorer`): po metadanych `MESSAGE_MAPPING_METADATA` /
 * `MESSAGE_METADATA` na metodach prototypu. Dzięki temu nowy handler wchodzi
 * do tabel automatycznie — a snapshoty w spec-ach wymuszają, żeby autor
 * świadomie dopisał go do fixture (`ws-payload-fixtures.spec-helper.ts`).
 *
 * Serwisy są `Proxy`, którego każda właściwość to `jest.fn()`: nie trzeba
 * wymieniać metod, a każde wywołanie jest zebrane do sprawdzenia.
 *
 * Plik nie jest suitą (nie kończy się na `.spec.ts`) i nie wchodzi do builda
 * (`tsconfig.build.json` wyklucza `**\/*.spec-helper.ts`).
 */

export const GATEWAYS = [
  UsersGateway,
  RecipesGateway,
  NotificationsGateway,
  WeeklyPlansGateway,
  HouseholdsGateway,
] as const;

export type GatewayClass = (typeof GATEWAYS)[number];

export type Handler = {
  gateway: GatewayClass;
  gatewayName: string;
  event: string;
  methodName: string;
};

/** Ta sama refleksja, co `GatewayMetadataExplorer.explore` w @nestjs/websockets. */
export function discoverHandlers(gateway: GatewayClass): Handler[] {
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

export const HANDLERS: Handler[] = GATEWAYS.flatMap(discoverHandlers);

// ---------------------------------------------------------------------------
// Sztuczne serwisy: Proxy, każda właściwość = jest.fn(); wszystkie wywołania
// zbierane w jednym rejestrze na test.
// ---------------------------------------------------------------------------

export type CallRecord = { service: string; method: string; args: unknown[] };

/** Stałe id w wyniku mocków — prawdziwe UUID, bo `broadcastToHousehold` i spółka dostają je dalej. */
export const GENERIC_HOUSEHOLD_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
export const GENERIC_RECIPE_ID = '7adf5ec0-e3e5-4b28-8bb4-5515c780948c';

/**
 * Wynik, który przechodzi przez każdą ścieżkę „po serwisie" w gatewayach
 * (`result.id`, `result.leftHouseholdIds`, `result.touchedWeekStarts.map`,
 * `preview.addedToInbox`, `result.enabledMealTypes`, `{ recipe, change }`
 * z `recipes:setFavorite`, …). Serwisy są zamockowane, więc kształt nie musi
 * być prawdziwy — ma tylko nie wywrócić handlera przed broadcastami i
 * wywołaniami serwisów, które chcemy zobaczyć.
 */
export const GENERIC_RESULT = Object.freeze({
  id: GENERIC_HOUSEHOLD_ID,
  householdId: GENERIC_HOUSEHOLD_ID,
  name: 'Dom',
  weekStart: '2026-08-31',
  leftHouseholdIds: [] as string[],
  touchedWeeks: [] as Array<{ householdId: string; weekStart: string }>,
  touchedWeekStarts: [] as string[],
  enabledMealTypes: [] as string[],
  mealSlotTimes: {},
  addedToInbox: false,
  changeKind: 'CREATED',
  success: true,
  // `RecipesService.setFavorite` oddaje `{ recipe, change }` — ack to `recipe`,
  // broadcast idzie ze zwalidowanej `change`.
  recipe: { id: GENERIC_RECIPE_ID, householdId: GENERIC_HOUSEHOLD_ID },
  change: {
    recipeId: GENERIC_RECIPE_ID,
    householdId: GENERIC_HOUSEHOLD_ID,
    isFavorite: true,
  },
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

export function serviceProxy(serviceName: string, calls: CallRecord[]): object {
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

export type Harness = {
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

export async function buildGateway(gateway: GatewayClass): Promise<Harness> {
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

  // `module.get` zwraca klasę gatewaya; tabele wołają handlery po nazwie,
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

/**
 * Wywołanie handlera po nazwie metody + `flush`, żeby odroczone efekty
 * (`void promise.then(...)`, `setImmediate`) też się policzyły.
 */
export async function invokeHandler(
  harness: Harness,
  methodName: string,
  client: unknown,
  payload: unknown,
): Promise<WsAck> {
  const handler = harness.instance[methodName];
  if (typeof handler !== 'function') {
    throw new Error(`brak metody ${methodName} na instancji gatewaya`);
  }
  const ack = await handler.call(harness.instance, client, payload);
  await flush();
  return ack as WsAck;
}

export type WsAck = {
  ok: boolean;
  code?: string;
  status?: number;
  details?: string[];
  message?: string;
};

// ---------------------------------------------------------------------------
// Sockety
// ---------------------------------------------------------------------------

export const anonClient = () => ({ data: {} }) as unknown;
export const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as unknown;
export const legacyClient = () => ({ data: { mode: 'legacy' } }) as unknown;

/** Rekurencyjnie: czy gdziekolwiek w wartości siedzi napis zawierający `needle`. */
export function containsString(
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
export const flush = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export const serverCalls = (server: Harness['server']): unknown[][] => [
  ...server.emit.mock.calls,
  ...server.to.mock.calls,
  ...server.in.mock.calls,
  ...server.socketsJoin.mock.calls,
  ...server.socketsLeave.mock.calls,
  ...server.disconnectSockets.mock.calls,
];
