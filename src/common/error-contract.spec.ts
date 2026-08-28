import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from './app-exception';
import { INTERNAL_ERROR_MESSAGE, mapError, toHttpBody } from './error-contract';

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Invalid `prisma.x()` invocation', {
    code,
    clientVersion: 'test',
    meta,
  });

describe('mapError', () => {
  it('AppException przechodzi 1:1, bez logu dla 4xx', () => {
    const mapped = mapError(
      new AppException(
        'NOT_HOUSEHOLD_MEMBER',
        'nie należysz',
        HttpStatus.FORBIDDEN,
      ),
    );
    expect(mapped).toEqual({
      contract: {
        code: 'NOT_HOUSEHOLD_MEMBER',
        message: 'nie należysz',
        status: 403,
      },
      log: null,
    });
  });

  it('AppException przekazuje details', () => {
    const mapped = mapError(
      new AppException(
        'VALIDATION_ERROR',
        'zła lista',
        HttpStatus.BAD_REQUEST,
        ['a', 'b'],
      ),
    );
    expect(mapped.contract.details).toEqual(['a', 'b']);
  });

  it('AppException 5xx zostawia komunikat, ale loguje jako error', () => {
    const mapped = mapError(
      new AppException(
        'COOKIDOO_SERVICE_UNAVAILABLE',
        'Cookidoo leży',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );
    expect(mapped.contract).toMatchObject({
      code: 'COOKIDOO_SERVICE_UNAVAILABLE',
      message: 'Cookidoo leży',
      status: 503,
    });
    expect(mapped.log?.level).toBe('error');
  });

  it.each([
    [new UnauthorizedException('x'), 'UNAUTHORIZED', 401, 'x'],
    [new ForbiddenException(), 'FORBIDDEN', 403, 'Forbidden'],
    [new NotFoundException('nie ma'), 'NOT_FOUND', 404, 'nie ma'],
    [new ConflictException('dup'), 'CONFLICT', 409, 'dup'],
    [
      new HttpException('wolniej', HttpStatus.TOO_MANY_REQUESTS),
      'TOO_MANY_REQUESTS',
      429,
      'wolniej',
    ],
    [new BadRequestException('plain'), 'BAD_REQUEST', 400, 'plain'],
    [new HttpException('herbata', 418), 'HTTP_ERROR', 418, 'herbata'],
  ])('goły wyjątek Nesta %p → %s %i', (error, code, status, message) => {
    expect(mapError(error)).toEqual({
      contract: { code, message, status },
      log: null,
    });
  });

  it('ValidationPipe (tablica message) → VALIDATION_ERROR z details', () => {
    const error = new BadRequestException([
      'a must be longer',
      'b is required',
    ]);
    expect(mapError(error).contract).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'a must be longer, b is required',
      status: 400,
      details: ['a must be longer', 'b is required'],
    });
  });

  it('503 z Nesta zostaje 503 z kodem SERVICE_UNAVAILABLE i logiem', () => {
    const mapped = mapError(new ServiceUnavailableException('chwilowo'));
    expect(mapped.contract).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'chwilowo',
      status: 503,
    });
    expect(mapped.log?.level).toBe('error');
  });

  it('InternalServerErrorException maskuje komunikat', () => {
    const mapped = mapError(
      new InternalServerErrorException('select * from users'),
    );
    expect(mapped.contract).toEqual({
      code: 'INTERNAL_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
      status: 500,
    });
    expect(mapped.log).toMatchObject({
      level: 'error',
      message: 'select * from users',
    });
  });

  it.each([
    ['P2002', 'CONFLICT', 409],
    ['P2025', 'NOT_FOUND', 404],
    ['P2003', 'VALIDATION_ERROR', 400],
  ])(
    'Prisma %s → %s %i, tekst Prismy tylko w logu',
    (prismaCode, code, status) => {
      const mapped = mapError(
        prismaError(prismaCode, { target: ['recipeId'] }),
      );
      expect(mapped.contract).toMatchObject({ code, status });
      expect(mapped.contract.message).not.toContain('prisma');
      expect(mapped.log).toMatchObject({
        level: 'warn',
        message: expect.stringContaining(prismaCode),
      });
      expect(mapped.log?.message).toContain('recipeId');
    },
  );

  it('nieznany kod Prismy → INTERNAL_ERROR', () => {
    const mapped = mapError(prismaError('P2034'));
    expect(mapped.contract).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
      message: INTERNAL_ERROR_MESSAGE,
    });
    expect(mapped.log?.level).toBe('error');
  });

  it('zwykły Error → INTERNAL_ERROR z zamaskowanym komunikatem i stackiem w logu', () => {
    const mapped = mapError(new Error('select * from "User" where secret'));
    expect(mapped.contract).toEqual({
      code: 'INTERNAL_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
      status: 500,
    });
    expect(mapped.log).toMatchObject({
      level: 'error',
      message: 'select * from "User" where secret',
      stack: expect.stringContaining('Error'),
    });
  });

  it.each([['string'], [undefined], [null], [42]])(
    'rzut nie-Error (%p) nie wywraca mapera',
    (thrown) => {
      const mapped = mapError(thrown);
      expect(mapped.contract.code).toBe('INTERNAL_ERROR');
      expect(mapped.log?.message).toContain(String(thrown));
    },
  );

  it('obiekt http-errors (body-parser) dostaje kod ze statusu', () => {
    expect(
      mapError({ statusCode: 413, message: 'too large' }).contract,
    ).toEqual({
      code: 'HTTP_ERROR',
      message: 'Nieprawidłowe żądanie.',
      status: 413,
    });
    expect(
      mapError({ statusCode: 400, type: 'entity.parse.failed' }).contract.code,
    ).toBe('BAD_REQUEST');
  });
});

describe('toHttpBody', () => {
  it('składa body bez statusCode i bez pustego details', () => {
    expect(
      toHttpBody(
        { code: 'NOT_FOUND', message: 'nie ma', status: 404 },
        'req-1',
      ),
    ).toEqual({
      code: 'NOT_FOUND',
      message: 'nie ma',
      requestId: 'req-1',
    });
    expect(
      toHttpBody(
        { code: 'VALIDATION_ERROR', message: 'x', status: 400, details: ['x'] },
        'req-2',
      ),
    ).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'x',
      details: ['x'],
      requestId: 'req-2',
    });
  });
});
