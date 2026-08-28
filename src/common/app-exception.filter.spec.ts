import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Body,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsString, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppException } from './app-exception';
import { AppExceptionFilter } from './app-exception.filter';
import { INTERNAL_ERROR_MESSAGE } from './error-contract';

class ProbeDto {
  @IsString()
  @MinLength(3)
  name: string;
}

@Controller('t')
class ProbeController {
  @Get('app')
  app() {
    throw new AppException('NOT_HOUSEHOLD_MEMBER', 'nie należysz', HttpStatus.FORBIDDEN);
  }

  @Get('bare')
  bare() {
    throw new NotFoundException('nie ma');
  }

  @Get('boom')
  boom() {
    throw new Error('select * from secrets');
  }

  @Get('prisma')
  prisma() {
    throw new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
  }

  @Post('validate')
  validate(@Body() dto: ProbeDto) {
    return { ok: dto.name };
  }
}

describe('AppExceptionFilter (HTTP)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('AppException → dokładnie {code, message, requestId}, bez statusCode', async () => {
    const res = await request(app.getHttpServer()).get('/t/app').expect(403);
    expect(res.body).toEqual({
      code: 'NOT_HOUSEHOLD_MEMBER',
      message: 'nie należysz',
      requestId: expect.any(String),
    });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('goły wyjątek Nesta dostaje kod ze statusu', async () => {
    const res = await request(app.getHttpServer()).get('/t/bare').expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: 'nie ma' });
    expect(res.body).not.toHaveProperty('statusCode');
  });

  it('ValidationPipe → VALIDATION_ERROR z details', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/validate')
      .send({ name: 'x', extra: 1 })
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([expect.stringContaining('name')]),
    });
  });

  it('nieobsłużony Error → 500 ze stałym komunikatem', async () => {
    const res = await request(app.getHttpServer()).get('/t/boom').expect(500);
    expect(res.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
      requestId: expect.any(String),
    });
  });

  it('Prisma P2025 → 404 NOT_FOUND', async () => {
    const res = await request(app.getHttpServer()).get('/t/prisma').expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.message).not.toContain('Record');
  });

  it('echo x-request-id z żądania', async () => {
    const res = await request(app.getHttpServer())
      .get('/t/app')
      .set('x-request-id', 'abc-123')
      .expect(403);
    expect(res.body.requestId).toBe('abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});
