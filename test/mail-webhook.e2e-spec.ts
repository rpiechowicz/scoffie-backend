import { Test, TestingModule } from '@nestjs/testing';
import { ConsoleLogger, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Webhook odrzutów na ŻYWYM stosie HTTP — z tym samym bootstrapem co `main.ts`
 * (`rawBody: true` + `configureApp`). Podpis liczy się z BAJTÓW ciała, więc
 * tylko prawdziwe żądanie przez parser Expressa dowodzi, że `req.rawBody`
 * w ogóle dociera do kontrolera. Test jednostkowy tego nie pokaże: on dostaje
 * bufor z ręki.
 *
 * Powód powstania: 11.09.2026 produkcja odrzucała webhook Resenda z powodem
 * „brak surowego ciała żądania", mimo poprawnej konfiguracji.
 */
/**
 * Sonda: czy `req.rawBody` w ogóle dociera do kontrolera w TEJ aplikacji.
 * Osobno od webhooka, bo webhook odpowiada 204 niezależnie od wyniku —
 * a tu widać wprost, czy parser JSON dostał `verify`.
 */
@Controller('__sonda')
class SondaController {
  @Post()
  @HttpCode(200)
  sonda(@Req() req: RawBodyRequest<Request>) {
    return {
      maRawBody: Buffer.isBuffer(req.rawBody),
      typBody: typeof req.body,
      body: req.body as unknown,
    };
  }
}

const SECRET_BYTES = Buffer.from('e2e-sekret-webhooka-poczty-2026-09-11');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

function sign(id: string, ts: number, body: string): string {
  return createHmac('sha256', SECRET_BYTES)
    .update(`${id}.${ts}.${body}`)
    .digest('base64');
}

function bounce(email: string): string {
  return JSON.stringify({
    type: 'email.bounced',
    created_at: '2026-09-11T08:07:00.000Z',
    data: {
      email_id: 'e2e-msg',
      to: [email],
      from: 'Scoffie <support@scoffie.app>',
      subject: 'x',
      bounce_type: 'Permanent',
    },
  });
}

describe('Webhook poczty E2E', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const poprzednieEnv = { ...process.env };
  const adresy = ['odbity-e2e@example.com', 'podrobiony-e2e@example.com'];

  beforeAll(async () => {
    process.env.MAIL_ENABLED = 'true';
    process.env.MAIL_TRANSPORT = 'stub';
    process.env.MAIL_WEBHOOK_SECRET = SECRET;
    process.env.OPS_ALERT_WEBHOOK_URL = '';

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [SondaController],
    }).compile();
    // DOKŁADNIE jak `main.ts`: bez `rawBody: true` parser nie zostawia bajtów.
    // UWAGA: opcje idą JAKO PIERWSZY argument. `createNestApplication(undefined,
    // opts)` po cichu je gubi — drugi argument liczy się tylko, gdy pierwszy
    // jest adapterem HTTP. Ten test przez pół dnia był przez to fałszywie
    // czerwony.
    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    // Logger testowy Nesta połyka ostrzeżenia — a powód odrzucenia webhooka
    // jest w ostrzeżeniu, więc w tym teście chcemy go widzieć.
    app.useLogger(new ConsoleLogger());
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.mailSuppression.deleteMany({
      where: { email: { in: adresy } },
    });
  });

  afterAll(async () => {
    await prisma.mailSuppression.deleteMany({
      where: { email: { in: adresy } },
    });
    await app.close();
    process.env = { ...poprzednieEnv };
  });

  it('rawBody dociera do kontrolera (pułapka createNestApplication)', async () => {
    const r = await request(app.getHttpServer())
      .post('/__sonda')
      .set('content-type', 'application/json; charset=utf-8')
      .send('{"a":1}')
      .expect(200);
    expect(r.body).toEqual({
      maRawBody: true,
      typBody: 'object',
      body: { a: 1 },
    });
  });

  it('poprawnie podpisany odrzut trafia na listę wykluczeń', async () => {
    const body = bounce(adresy[0]);
    const ts = Math.floor(Date.now() / 1000);

    await request(app.getHttpServer())
      .post('/mail/webhooks/resend')
      // Tak nagłówek wysyła Svix — z charsetem.
      .set('content-type', 'application/json; charset=utf-8')
      .set('svix-id', 'msg_e2e_1')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', `v1,${sign('msg_e2e_1', ts, body)}`)
      .send(body)
      .expect(204);

    const wiersz = await prisma.mailSuppression.findUnique({
      where: { email: adresy[0] },
    });
    expect(wiersz).not.toBeNull();
    expect(wiersz?.reason).toBe('HARD_BOUNCE');
    expect(wiersz?.detail).toBe('Permanent');
  });

  it('zły podpis odbija się o 204 i NIE wyklucza adresu', async () => {
    const body = bounce(adresy[1]);
    const ts = Math.floor(Date.now() / 1000);

    await request(app.getHttpServer())
      .post('/mail/webhooks/resend')
      .set('content-type', 'application/json')
      .set('svix-id', 'msg_e2e_2')
      .set('svix-timestamp', String(ts))
      .set('svix-signature', 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
      .send(body)
      .expect(204);

    const wiersz = await prisma.mailSuppression.findUnique({
      where: { email: adresy[1] },
    });
    expect(wiersz).toBeNull();
  });
});
