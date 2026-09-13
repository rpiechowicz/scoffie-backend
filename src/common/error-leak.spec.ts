import { HttpStatus, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from './app-exception';
import { INTERNAL_ERROR_MESSAGE, mapError, toHttpBody } from './error-contract';
import { wsRespond } from './ws-response';

// AUDYT 12.09.2026 (P1.15). Kontrakt błędu jest jedynym miejscem, przez które
// wnętrze serwera może wyciec na drut. Te testy pilnują GÓRNEJ GRANICY: cokolwiek
// niesie rzucony wyjątek — hasło do bazy, token, nazwa kolumny, ścieżka pliku —
// nie ma prawa pojawić się w odpowiedzi dla klienta.
//
// Weryfikacja runtime osobno (13.09.2026): sprawdzone, że Prisma 6 sama nie
// wkłada hasła do `PrismaClientInitializationError` — P1000 oddaje nazwę
// użytkownika, P1001 host i port, P1012 fragment schematu. Hasła nie ma ani
// w `message`, ani w `stack`. To ważne, bo `main.ts` loguje surowy błąd startu
// (`console.error('[bootstrap] start failed:', error)`) prosto do logów Railway.

/** Rzeczy, których klient nie ma prawa zobaczyć, w kształcie, w jakim wyciekają. */
const SEKRETY = [
  'postgresql://scoffie:P4ssw0rd-Prod@example.proxy.rlwy.net:12345/railway',
  'P4ssw0rd-Prod',
  'sk-ant-api03-TAJNY-KLUCZ',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.tajny.podpis',
  '/app/dist/src/weekly-plans/weekly-plans.service.js',
];

const zawieraSekret = (wire: unknown): string[] => {
  const tekst = JSON.stringify(wire);
  return SEKRETY.filter((sekret) => tekst.includes(sekret));
};

describe('kontrakt błędu nie wypuszcza wnętrza serwera (P1.15)', () => {
  const zrodla: ReadonlyArray<[string, () => unknown]> = [
    [
      'goły Error z połączeniem w treści',
      () => new Error(`connect ECONNREFUSED ${SEKRETY[0]}`),
    ],
    [
      'Error ze stackiem po plikach kontenera',
      () => {
        const error = new Error('coś padło');
        error.stack = `Error: coś padło\n    at Object.<anonymous> (${SEKRETY[4]}:120:15)`;
        return error;
      },
    ],
    [
      'InternalServerErrorException z komunikatem dostawcy',
      () =>
        new InternalServerErrorException(
          `Anthropic odrzucił klucz ${SEKRETY[2]}`,
        ),
    ],
    [
      'nieznany kod Prismy',
      () =>
        new Prisma.PrismaClientKnownRequestError(
          `Invalid \`prisma.user.findMany()\` invocation in ${SEKRETY[4]}`,
          { code: 'P9999', clientVersion: '6.0.0', meta: { url: SEKRETY[0] } },
        ),
    ],
    [
      'rzut nie-Error (string z tokenem)',
      () => `refresh token ${SEKRETY[3]} nie pasuje`,
    ],
    [
      'PrismaClientValidationError',
      () =>
        new Prisma.PrismaClientValidationError(
          `Unknown arg \`haslo\` — ${SEKRETY[1]}`,
          { clientVersion: '6.0.0' },
        ),
    ],
  ];

  it.each(zrodla)('HTTP: %s → stały komunikat 500', (_nazwa, zrob) => {
    const { contract } = mapError(zrob());
    const body = toHttpBody(contract, 'req-1');

    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(contract.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(zawieraSekret(body)).toEqual([]);
    // Klucze odpowiedzi są zamkniętą listą — `stack` czy `statusCode` nie
    // dołączą się przypadkiem przy rozszerzaniu kontraktu.
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
  });

  it.each(zrodla)('WS: %s → ta sama koperta, bez wnętrza', async (_n, zrob) => {
    const ack = await wsRespond(
      (): Promise<never> => {
        // Rzut synchroniczny — `wsRespond` woła `await action()` w `try`,
        // więc łapie tak samo jak odrzuconą obietnicę.
        throw zrob();
      },
      { event: 'test:zdarzenie' },
    );

    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('nieosiągalne');
    expect(ack.code).toBe('INTERNAL_ERROR');
    expect(ack.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(ack.error).toBe(INTERNAL_ERROR_MESSAGE);
    expect(zawieraSekret(ack)).toEqual([]);
  });

  it('log serwera dostaje ślad — inaczej nie ma czego szukać po requestId', () => {
    const { log } = mapError(new Error('połączenie odrzucone'));

    expect(log?.level).toBe('error');
    expect(log?.message).toBe('połączenie odrzucone');
    expect(typeof log?.stack).toBe('string');
  });

  it('spodziewane 4xx nie idzie do logu i niesie własny komunikat', () => {
    const { contract, log } = mapError(
      new AppException('NOT_FOUND', 'Nie znaleziono przepisu.', 404),
    );

    expect(log).toBeNull();
    expect(contract.message).toBe('Nie znaleziono przepisu.');
  });

  it('meta Prismy w logu niesie nazwy pól, nie wartości', () => {
    const { log } = mapError(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.0.0',
        meta: { target: ['email'] },
      }),
    );

    expect(log?.message).toBe('Prisma P2002 {"target":["email"]}');
  });
});
