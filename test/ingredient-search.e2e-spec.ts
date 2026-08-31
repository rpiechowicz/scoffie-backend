import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Wyszukiwarka składników na PRAWDZIWYM katalogu (403 polskie nazwy).
 *
 * Testy jednostkowe sprawdzają ranking na wymyślonych przykładach; dopiero
 * tutaj widać, czy odmiana i rdzeń działają na tym, co naprawdę leży w bazie.
 * To jest jedyny sposób, żeby stwierdzić, czy asystent w ogóle znajdzie
 * składnik, którego szuka — bez tego `recipes:create` wymaga identyfikatora,
 * którego nie ma skąd wziąć.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

type Hit = {
  id: string;
  name: string;
  category: string;
  hasNutrition: boolean;
  gramsPerPiece: number | null;
  allowedUnits: string[];
  allergens: string[];
  dietTags: string[];
};

describe('ingredients:search E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let socket: Socket;
  const createdUserIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  const ack = <T>(event: string, payload: unknown): Promise<WsEnvelope<T>> =>
    new Promise((resolve, reject) => {
      socket
        .timeout(9000)
        .emit(event, payload, (err: Error | null, response: WsEnvelope<T>) => {
          if (err) reject(err);
          else resolve(response);
        });
    });

  const search = async (filters: Record<string, unknown>): Promise<Hit[]> => {
    const response = await ack<Hit[]>('ingredients:search', { filters });
    if (!response.ok) throw new Error(`szukanie padło: ${response.code}`);
    return response.data;
  };

  const names = (hits: Hit[]) => hits.map((hit) => hit.name.toLowerCase());

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const stamp = `${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Szukacz ${stamp}`,
        email: `szukacz-${stamp}@ingredients.local`,
      })
      .expect(201);
    const session = res.body as { accessToken: string; user: { id: string } };
    createdUserIds.push(session.user.id);

    socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: session.accessToken },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    for (const client of sockets.splice(0)) client.disconnect();
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('znajduje po nazwie w mianowniku', async () => {
    const hits = await search({ query: 'kurczak' });
    expect(hits.length).toBeGreaterThan(0);
    expect(names(hits).some((name) => name.includes('kurcz'))).toBe(true);
  });

  it('znajduje po ODMIANIE — asystent nie pisze w mianowniku', async () => {
    // „jajka" nie zawiera się w „jajko"; bez rdzenia i rankingu to by przepadło.
    const hits = await search({ query: 'jajka' });
    expect(names(hits)).toContain('jajko');
  });

  it('odmiana trafia w składnik, a nie w danie, które go zawiera', async () => {
    const hits = await search({ query: 'jajka', limit: 3 });
    expect(hits[0].name.toLowerCase()).toBe('jajko');
  });

  it('działa dla wielosłownego zapytania', async () => {
    const hits = await search({ query: 'pierś z kurczaka' });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('każdy wynik niesie identyfikator, którego wymaga zapis przepisu', async () => {
    const hits = await search({ query: 'cebula', limit: 1 });
    expect(hits[0].id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('filtr „tylko z makrami" naprawdę odsiewa — dwie trzecie katalogu ich nie ma', async () => {
    const hits = await search({ query: 'ser', onlyWithNutrition: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.hasNutrition)).toBe(true);
  });

  it('szanuje limit', async () => {
    const hits = await search({ query: 'a', limit: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it('zapytanie bez trafień oddaje pustą listę, nie błąd', async () => {
    expect(await search({ query: 'xyzqwerty' })).toEqual([]);
  });

  it('przeglądanie po kategorii bez zapytania', async () => {
    const hits = await search({ category: 'Ryby', limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.category === 'Ryby')).toBe(true);
  });

  describe('dozwolone jednostki', () => {
    it('przyprawa dostaje łyżeczkę i szczyptę', async () => {
      const hits = await search({ category: 'Przyprawy i sosy', limit: 50 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].allowedUnits).toEqual(
        expect.arrayContaining(['łyżeczka', 'szczypta']),
      );
    });

    it('warzywo NIE dostaje łyżki — przeliczenie i tak by ją odrzuciło', async () => {
      const hits = await search({ category: 'Warzywa', limit: 50 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => !hit.allowedUnits.includes('łyżka'))).toBe(
        true,
      );
    });

    it('sztuki tylko tam, gdzie znamy masę sztuki', async () => {
      const hits = await search({ query: 'jajko', limit: 5 });
      const jajko = hits.find((hit) => hit.name.toLowerCase() === 'jajko');
      expect(jajko?.gramsPerPiece).not.toBeNull();
      expect(jajko?.allowedUnits).toContain('szt');
    });
  });
});
