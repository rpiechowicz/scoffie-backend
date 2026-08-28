import { Logger } from '@nestjs/common';
import {
  HANDLERS,
  Harness,
  buildGateway,
  invokeHandler,
  serverCalls,
  tokenClient,
} from './ws-handlers.spec-helper';
import {
  HANDLERS_WITHOUT_INPUT,
  HANDLERS_WITHOUT_SERVICE,
  INVALID_PAYLOADS,
  InvalidCase,
  USER,
  VALID_PAYLOADS,
} from './ws-payload-fixtures.spec-helper';

/**
 * Strażnik regresji Fazy 0 (krok 2): KAŻDY handler `@SubscribeMessage`
 * waliduje kopertę PRZED wywołaniem serwisu — zła koperta to ack
 * `{ ok:false, code:'VALIDATION_ERROR', status:400, details:[…] }`, żaden
 * serwis ani broadcast nie jest tknięty, a `payload === undefined` / napis
 * zamiast obiektu NIGDY nie kończy się INTERNAL_ERROR (dawniej: `TypeError`
 * na `payload.data.dayOfWeek` → 500).
 *
 * Serwisy są mockami, więc tabela sprawdza wyłącznie kopertę
 * (`ws-payload-fixtures.spec-helper.ts` → `INVALID_PAYLOADS`); zawartość
 * `data`/`filters` sprawdzają spec-i serwisów i `test/ws-validation.e2e-spec.ts`.
 */

const flatCases: Array<{
  event: string;
  gatewayName: string;
  methodName: string;
  gateway: (typeof HANDLERS)[number]['gateway'];
  name: string;
  invalid: InvalidCase;
}> = HANDLERS.flatMap((handler) =>
  (INVALID_PAYLOADS[handler.event] ?? []).map((invalid) => ({
    ...handler,
    name: invalid.name,
    invalid,
  })),
);

describe('WS handlers — walidacja koperty (strażnik regresji)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // `wsRespond` loguje 500 przez `logger.error` — gdyby się pojawił, test
    // i tak pada na `code`, a log tylko zaciemnia wynik.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('inwentarz fixture', () => {
    it('każde zdarzenie ma wpis w VALID_PAYLOADS (nowy handler → dopisz fixture)', () => {
      const missing = HANDLERS.map((h) => h.event).filter(
        (event) => !(event in VALID_PAYLOADS),
      );
      expect(missing).toEqual([]);
    });

    it('każde zdarzenie z wejściem ma ≥1 wpis w INVALID_PAYLOADS, a bez wejścia — żadnego', () => {
      const missing = HANDLERS.map((h) => h.event).filter(
        (event) =>
          !HANDLERS_WITHOUT_INPUT.has(event) &&
          (INVALID_PAYLOADS[event] ?? []).length === 0,
      );
      expect(missing).toEqual([]);

      const contradictory = [...HANDLERS_WITHOUT_INPUT].filter(
        (event) => (INVALID_PAYLOADS[event] ?? []).length > 0,
      );
      expect(contradictory).toEqual([]);
    });

    it('fixture nie zna zdarzeń, których nie ma w gatewayach (usunięty handler → usuń wpis)', () => {
      const known = new Set(HANDLERS.map((h) => h.event));
      const stale = [
        ...Object.keys(INVALID_PAYLOADS),
        ...HANDLERS_WITHOUT_INPUT,
        ...HANDLERS_WITHOUT_SERVICE,
      ].filter((event) => !known.has(event));
      expect(stale).toEqual([]);
    });
  });

  describe.each(flatCases)(
    '$event — $name  [$gatewayName › $methodName]',
    ({ gateway, methodName, invalid }) => {
      let harness: Harness;

      beforeEach(async () => {
        harness = await buildGateway(gateway);
      });

      it('socket z tokenem → ack VALIDATION_ERROR 400 z details, serwis i serwer nietknięte', async () => {
        const ack = await invokeHandler(
          harness,
          methodName,
          tokenClient(USER),
          invalid.payload,
        );

        expect(ack).toMatchObject({
          ok: false,
          code: 'VALIDATION_ERROR',
          status: 400,
        });
        expect(Array.isArray(ack.details)).toBe(true);
        expect(ack.details).not.toHaveLength(0);
        if (invalid.detail) {
          expect(ack.details).toEqual(
            expect.arrayContaining([expect.stringContaining(invalid.detail)]),
          );
        }
        expect(harness.calls).toEqual([]);
        expect(serverCalls(harness.server)).toEqual([]);
      });
    },
  );

  describe.each(HANDLERS)(
    '$event  [$gatewayName › $methodName]',
    ({ gateway, event, methodName }) => {
      let harness: Harness;

      beforeEach(async () => {
        harness = await buildGateway(gateway);
      });

      it('poprawna koperta → ok:true (fixture VALID_PAYLOADS faktycznie przechodzi)', async () => {
        const ack = await invokeHandler(
          harness,
          methodName,
          tokenClient(USER),
          VALID_PAYLOADS[event],
        );
        expect(ack).toMatchObject({ ok: true });
        if (!HANDLERS_WITHOUT_SERVICE.has(event)) {
          expect(harness.calls).not.toHaveLength(0);
        }
      });

      it.each([
        ['undefined', undefined],
        ["napis 'string'", 'string'],
      ])(
        'payload %s → nigdy INTERNAL_ERROR (VALIDATION_ERROR albo ok:true dla handlera bez wejścia)',
        async (_label, payload) => {
          const ack = await invokeHandler(
            harness,
            methodName,
            tokenClient(USER),
            payload,
          );

          expect(ack.code).not.toBe('INTERNAL_ERROR');
          if (ack.ok) {
            // Bez wejścia (users:me, households:findAll, …) albo koperta z
            // samymi polami opcjonalnymi (recipes:findAll) — handler ma
            // przeżyć brak payloadu, nie rzucać TypeError.
            expect(ack.ok).toBe(true);
          } else {
            expect(ack).toMatchObject({
              code: 'VALIDATION_ERROR',
              status: 400,
              details: expect.any(Array),
            });
            expect(harness.calls).toEqual([]);
          }
        },
      );
    },
  );
});
