import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RuntimeSettingsService } from '../src/runtime-settings/runtime-settings.service';

/**
 * `GET /public/app-version` (2.10.2026) — wyłącznik starych buildów.
 *
 * Kontrakt czyta NAJSTARSZY build, więc tu pilnujemy: bez logowania, bez
 * limitu żądań, próg z panelu działa od razu, a zła platforma to 400.
 */
describe('Minimalna wersja aplikacji E2E', () => {
  let app: NestExpressApplication;
  let settings: RuntimeSettingsService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    settings = app.get(RuntimeSettingsService);
  });

  afterAll(async () => {
    await settings
      .clear('APP_MIN_VERSION_IOS')
      .catch(() => undefined /* nie było nadpisania */);
    await app.close();
  });

  const get = (query: string) =>
    request(app.getHttpServer()).get(`/public/app-version?${query}`);

  it('bez progu przepuszcza każdego, bez logowania', async () => {
    await settings
      .clear('APP_MIN_VERSION_IOS')
      .catch(() => undefined /* nie było nadpisania */);
    const res = await get('platform=ios&version=0.1').expect(200);
    expect(res.body).toEqual({
      platform: 'ios',
      minVersion: null,
      updateRequired: false,
      storeUrl: 'https://apps.apple.com/app/id6808608589',
    });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('próg z panelu zatrzymuje starszą wersję od następnego żądania', async () => {
    await settings.set('APP_MIN_VERSION_IOS', '1.1', {
      updatedBy: 'e2e@scoffie.app',
      reason: 'test wyłącznika',
    });
    const old = await get('platform=ios&version=1.0').expect(200);
    expect(old.body).toMatchObject({ minVersion: '1.1', updateRequired: true });
    const fresh = await get('platform=ios&version=1.1.0').expect(200);
    expect(fresh.body.updateRequired).toBe(false);
    const android = await get('platform=android&version=1.0').expect(200);
    expect(android.body.updateRequired).toBe(false);
  });

  it('bez wersji w pytaniu nie blokuje; zła platforma to 400', async () => {
    const res = await get('platform=ios').expect(200);
    expect(res.body.updateRequired).toBe(false);
    const bad = await get('platform=windows&version=1.0').expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
  });

  it('nie ma limitu żądań (cały dom za jednym IP operatora)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 80 }, () => get('platform=ios&version=1.0')),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
  });
});
