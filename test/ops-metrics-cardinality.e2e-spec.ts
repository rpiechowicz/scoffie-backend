import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Kardynalność metryk HTTP (noc 26/27.09, N7).
 *
 * Klucz trasy w `RequestMetricsService` to SZABLON trasy (`req.route.path`),
 * a mapa tras nie ma sufitu. Gdyby 404 skanerów (`/wp-admin/…`) albo
 * identyfikatory z adresów trafiały do kluczy, pamięć procesu i `/ops/metrics`
 * rosłyby bez końca. Strażnik: ani ścieżka nieistniejąca, ani id z adresu
 * nie stają się kluczem.
 */
describe('Metryki HTTP — kardynalność (N7)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app
      .get(PrismaService)
      .user.deleteMany({ where: { email: { startsWith: 'metrics-' } } });
    await app.close();
  });

  it('404 skanerów i id z adresu nie tworzą nowych kluczy tras', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    for (let i = 0; i < 30; i += 1) {
      await request(app.getHttpServer()).get(`/wp-admin/skan-${i}.php`);
    }
    // Żądanie, które PRZECHODZI przez interceptor (zalogowane, trasa z `:id`)
    // — inaczej test niczego by nie mierzył (404 i 401 go omijają).
    const session = (
      await request(app.getHttpServer())
        .post('/auth/dev')
        .send({
          displayName: 'Metryki',
          email: `metrics-${Date.now()}@ops.local`,
        })
        .expect(201)
    ).body as { accessToken: string; user: { id: string } };
    await request(app.getHttpServer())
      .get(`/agent/conversations/${id}`)
      .set('Authorization', `Bearer ${session.accessToken}`);
    const res = await request(app.getHttpServer())
      .get('/ops/metrics')
      .set('x-ops-token', 'ci-ops-token')
      .set('Authorization', 'Bearer ci-ops-token');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('GET /agent/conversations/:id');
    expect(body).not.toContain('skan-');
    expect(body).not.toContain(id);
  });
});
