import { BadRequestException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from './app-exception';
import { INTERNAL_ERROR_MESSAGE } from './error-contract';
import { setWsErrorObserver, wsRespond } from './ws-response';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('wsRespond', () => {
  afterEach(() => {
    setWsErrorObserver(null);
    jest.restoreAllMocks();
  });

  it('sukces zwraca dane bez zmian', async () => {
    await expect(wsRespond(async () => ({ id: 1 }))).resolves.toEqual({
      ok: true,
      data: { id: 1 },
    });
  });

  it('AppException → kod, message == error, status i requestId', async () => {
    const result = await wsRespond(async () => {
      throw new AppException('NOT_HOUSEHOLD_MEMBER', 'nie należysz', HttpStatus.FORBIDDEN);
    });
    expect(result).toEqual({
      ok: false,
      error: 'nie należysz',
      message: 'nie należysz',
      code: 'NOT_HOUSEHOLD_MEMBER',
      status: 403,
      requestId: expect.stringMatching(UUID),
    });
  });

  it('goły NotFound → NOT_FOUND 404', async () => {
    const result = await wsRespond(async () => {
      throw new NotFoundException('nie ma');
    });
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404, error: 'nie ma' });
  });

  it('ValidationPipe → VALIDATION_ERROR z details', async () => {
    const result = await wsRespond(async () => {
      throw new BadRequestException(['a', 'b']);
    });
    expect(result).toMatchObject({ code: 'VALIDATION_ERROR', details: ['a', 'b'], error: 'a, b' });
  });

  it('Prisma P2002 → CONFLICT bez tekstu Prismy w error', async () => {
    const result = await wsRespond(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`recipeId`)', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });
    expect(result).toMatchObject({ code: 'CONFLICT', status: 409 });
    expect((result as { error: string }).error).not.toContain('recipeId');
  });

  it('zwykły Error → INTERNAL_ERROR, komunikat zamaskowany, requestId w logu', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const result = await wsRespond(async () => {
      throw new Error('prisma boom with sql');
    }, { event: 'weeklyPlans:upsertWeekSlot' });

    expect(result).toMatchObject({ code: 'INTERNAL_ERROR', status: 500, error: INTERNAL_ERROR_MESSAGE });
    const requestId = (result as { requestId: string }).requestId;
    expect(requestId).toMatch(UUID);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`weeklyPlans:upsertWeekSlot 500 INTERNAL_ERROR requestId=${requestId}: prisma boom with sql`),
      expect.any(String),
    );
  });

  it('rzut nie-Error też daje INTERNAL_ERROR', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const result = await wsRespond(async () => {
      throw 'string-throw';
    });
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
  });

  it('obserwator dostaje kod i status tylko przy błędzie', async () => {
    const observer = jest.fn();
    setWsErrorObserver(observer);

    await wsRespond(async () => 'ok');
    expect(observer).not.toHaveBeenCalled();

    await wsRespond(async () => {
      throw new NotFoundException('x');
    });
    expect(observer).toHaveBeenCalledWith('NOT_FOUND', 404);
  });
});
