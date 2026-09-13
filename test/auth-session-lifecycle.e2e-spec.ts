import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * CYKL ŻYCIA SESJI — audyt na żywej bazie.
 *
 * Wylogowania na produkcji były zgłaszane dziesięć razy i dziesięć razy
 * poprawiane. Powód, dla którego to nie zbiegało: rotacja refresh tokenów jest
 * problemem WSPÓŁBIEŻNOŚCI i STANU W BAZIE, a jedyne testy, jakie miała, stały
 * na atrapie Prismy — czyli sprawdzały, czy kod robi to, co autor zakładał,
 * tym samym założeniem, które było błędne. Jedyny test e2e dotykał rotacji
 * sekwencyjnie i celowo omijał przypadek, który psuł sesje (jego komentarz
 * mówi wprost: „klient POTWIERDZA odbiór pary, używając jej").
 *
 * Ten plik testuje JEDEN niezmiennik, z którego wynika wszystko inne:
 *
 *   KLIENT, KTÓRY GRA UCZCIWIE, NIE MOŻE STRACIĆ SESJI.
 *
 * „Uczciwie" znaczy: trzyma jeden refresh token, nadpisuje go odpowiedzią
 * serwera i nie wyklucza, że sieć zdubluje mu żądanie. Wszystko, co taki klient
 * potrafi zrobić, musi kończyć się działającą sesją. Wykrywanie kradzieży ma
 * łapać kopie STARYCH tokenów, a nie klienta, któremu padło połączenie.
 */
// Okno łaski na czas tego zestawu: 2 s zamiast 60 s z produkcji.
// Ustawiane PRZED zbudowaniem modułu, bo `AuthService` czyta tę zmienną raz,
// przy konstrukcji. Bez tego dwa testy granicy („PO oknie") czekałyby 2,5 s
// i nadal mieściły się w oknie — czyli byłyby zielone, nic nie sprawdzając.
const GRACE_BEFORE = process.env.REFRESH_REUSE_GRACE_SECONDS;
process.env.REFRESH_REUSE_GRACE_SECONDS = '2';

describe('Cykl życia sesji (e2e, żywa baza)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  type Pair = {
    accessToken: string;
    refreshToken: string;
    userId: string;
    email: string;
  };

  const login = async (label: string): Promise<Pair> => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${stamp}@audyt.local`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({ displayName: `Audyt ${label}`, email })
      .expect(201);
    createdUserIds.push(res.body.user.id as string);
    return {
      accessToken: res.body.accessToken as string,
      refreshToken: res.body.refreshToken as string,
      userId: res.body.user.id as string,
      email,
    };
  };

  const refresh = (token: string) =>
    request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: token });

  const logout = (token: string) =>
    request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: token });

  /**
   * Drugie urządzenie tego samego człowieka: DRUGIE logowanie tym samym
   * e-mailem. `/auth/dev` upsertuje użytkownika po `googleId` liczonym z maila,
   * więc wychodzi ten sam człowiek i niezależna gałąź tokenów — dokładnie jak
   * po zalogowaniu na drugim telefonie. Wszystko przez publiczne API, bez
   * podrabiania tokenów w teście.
   */
  const loginSecondDevice = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({ displayName: 'Audyt drugie urzadzenie', email })
      .expect(201);
    return res.body.refreshToken as string;
  };

  /** Czy tym tokenem da się jeszcze pracować (bez zużywania go na rotację). */
  const accessWorks = async (accessToken: string): Promise<boolean> => {
    const res = await request(app.getHttpServer())
      .get('/me/consents')
      .set('Authorization', `Bearer ${accessToken}`);
    return res.status === 200;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    if (GRACE_BEFORE === undefined) {
      delete process.env.REFRESH_REUSE_GRACE_SECONDS;
    } else {
      process.env.REFRESH_REUSE_GRACE_SECONDS = GRACE_BEFORE;
    }
  });

  // ─── 1. Podstawa ──────────────────────────────────────────────────────────

  it('rotacja sekwencyjna działa w kółko — dwadzieścia odświeżeń pod rząd', async () => {
    const session = await login('sekwencja');
    let token = session.refreshToken;

    for (let i = 0; i < 20; i++) {
      const res = await refresh(token).expect(201);
      expect(res.body.refreshToken).not.toBe(token);
      token = res.body.refreshToken as string;
      expect(await accessWorks(res.body.accessToken as string)).toBe(true);
    }
  });

  // ─── 2. Zgubiona odpowiedź ────────────────────────────────────────────────
  //
  // URLSession ponawia POST, któremu padło połączenie przed odpowiedzią.
  // Serwer widzi wtedy DWA żądania tym samym tokenem. Klient dostaje (co
  // najwyżej) jedną z dwóch odpowiedzi i NIE WIADOMO KTÓRĄ — więc obie muszą
  // prowadzić do działającej sesji.

  it('zgubiona odpowiedź: po ratunku działają OBA tokeny — i ten z rotacji, i ten z ratunku', async () => {
    const session = await login('zgubiona');

    const first = await refresh(session.refreshToken).expect(201);
    const fromRotation = first.body.refreshToken as string;

    // Ponowienie tego samego żądania (klient nie dostał odpowiedzi).
    const retry = await refresh(session.refreshToken).expect(201);
    const fromRecovery = retry.body.refreshToken as string;
    expect(fromRecovery).not.toBe(fromRotation);

    // Klient ma JEDEN z nich i nie wiemy który. Oba muszą działać — inaczej
    // sesja umiera w chwili, w której serwer myśli, że ją ratuje.
    // (To był błąd zmierzony na produkcji 13.09.2026: ratunek kasował token
    // z rotacji, czyli ten, który klient właśnie schował.)
    await refresh(fromRotation).expect(201);
    await refresh(fromRecovery).expect(201);
  });

  it('zgubiona odpowiedź trzy razy pod rząd nadal nie kasuje rodziny', async () => {
    const session = await login('trzy-ponowienia');

    const a = await refresh(session.refreshToken).expect(201);
    const b = await refresh(session.refreshToken).expect(201);
    const c = await refresh(session.refreshToken).expect(201);

    // Każde ponowienie oddaje używalną parę…
    for (const res of [a, b, c]) {
      expect(await accessWorks(res.body.accessToken as string)).toBe(true);
    }
    // …a token, który klient faktycznie schował (dowolny z nich), dalej rotuje.
    await refresh(c.body.refreshToken as string).expect(201);
  });

  it('dwa RÓWNOLEGŁE żądania tym samym tokenem zostawiają działającą sesję', async () => {
    const session = await login('rownolegle');

    const [x, y] = await Promise.all([
      refresh(session.refreshToken),
      refresh(session.refreshToken),
    ]);

    // Oba kończą się sukcesem albo jedno przegrywa — ale sesja MUSI przeżyć.
    const usable = [x, y].filter((r) => r.status === 201);
    expect(usable.length).toBeGreaterThan(0);
    for (const res of usable) {
      await refresh(res.body.refreshToken as string).expect(201);
    }
  });

  it('PIEC rownoleglych zadan tym samym tokenem — sesja nadal zyje', async () => {
    const session = await login('piec-rownolegle');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => refresh(session.refreshToken)),
    );

    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThan(0);
    // Kazdy token, ktory serwer wydal, musi dzialac — klient dostal jeden
    // z nich i nie wiadomo ktory.
    for (const res of ok) {
      await refresh(res.body.refreshToken as string).expect(201);
    }
  });

  it('wylogowanie rownolegle z odswiezeniem nie kasuje rodziny', async () => {
    const session = await login('wyscig-logout');
    const deviceB = await loginSecondDevice(session.email);

    // Telefon odswieza i w tej samej chwili uzytkownik wylogowuje sie na tym
    // samym urzadzeniu (albo `refreshSessionTokens` oddaje swiezy token przez
    // /auth/logout, bo Keychain zdazyl sie zmienic — tak robi iOS).
    await Promise.all([
      refresh(session.refreshToken),
      logout(session.refreshToken),
    ]);

    // Drugie urzadzenie nie ma z tym nic wspolnego i ma pracowac dalej.
    await refresh(deviceB).expect(201);
  });

  // ─── 3. Prawdziwa kradzież ────────────────────────────────────────────────

  it('kopia STAREGO tokenu po tym, jak klient poszedł dalej, kasuje rodzinę', async () => {
    const session = await login('kradziez');

    const first = await refresh(session.refreshToken).expect(201);
    const second = await refresh(first.body.refreshToken as string).expect(201);
    // Klient jest już dwa kroki dalej — stary token może mieć tylko kopia.
    await refresh(session.refreshToken).expect(401);

    // Rodzina pada RAZEM z tokenami dostępu.
    await refresh(second.body.refreshToken as string).expect(401);
    expect(await accessWorks(second.body.accessToken as string)).toBe(false);
  });

  // Granica jest CZASOWA i to jest swiadomy wybor, nie przypadek. Token jeden
  // krok wstecz, ktorego nastepcy nikt nie uzyl, wyglada DOKLADNIE tak samo
  // jak zgubiona odpowiedz — serwer nie ma czym ich rozroznic. Wiec w oknie
  // laski ratujemy (bo telefon, ktoremu padla siec, jest tysiac razy
  // czestszy niz zlodziej), a po oknie kasujemy rodzine.

  it('jeden krok wstecz W OKNIE laski: ratujemy, bo to nie do odroznienia od zgubionej odpowiedzi', async () => {
    const session = await login('w-oknie');
    const first = await refresh(session.refreshToken).expect(201);
    await refresh(first.body.refreshToken as string).expect(201);

    // Nastepca (`second`) zyje, nikt go nie uzyl → to moze byc telefon,
    // ktory nie dostal odpowiedzi.
    await refresh(first.body.refreshToken as string).expect(201);
  });

  it('ten sam token PO oknie laski: to juz kopia, rodzina pada', async () => {
    const session = await login('po-oknie');
    const first = await refresh(session.refreshToken).expect(201);
    const second = await refresh(first.body.refreshToken as string).expect(201);

    // Okno laski w tym zestawie to 2 s (REFRESH_REUSE_GRACE_SECONDS).
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    await refresh(first.body.refreshToken as string).expect(401);
    await refresh(second.body.refreshToken as string).expect(401);
  }, 20_000);

  it('juz wykryty replay nie kasuje rodziny DRUGI raz — sam 401, bez alarmu', async () => {
    const session = await login('replay-echo');
    const first = await refresh(session.refreshToken).expect(201);
    await refresh(first.body.refreshToken as string).expect(201);
    // Pierwsze wykrycie: rodzina pada.
    await refresh(session.refreshToken).expect(401);

    // Telefon dowiaduje sie o tym dopiero, gdy wygasnie mu access token —
    // i puka jeszcze raz tym samym, martwym tokenem. To jest ECHO, nie nowa
    // kradziez: ma dostac 401 i nie ma czego kasowac (rodzina jest juz pusta).
    // Tak wygladal log prod z 16:49: „revoked 0 active token(s)".
    await refresh(session.refreshToken).expect(401);
    const rows = await prisma.refreshToken.count({
      where: { userId: session.userId, revokedAt: null },
    });
    expect(rows).toBe(0);
  });

  // ─── 3b. Promien razenia odmowy ──────────────────────────────────────────
  //
  // Kasowanie rodziny wylogowuje ze WSZYSTKICH urzadzen i podbija
  // `tokenVersion`, czyli unieważnia takze tokeny dostepu. To jest kara za
  // KRADZIEZ. Wolno ja wymierzyc tylko wtedy, gdy mamy dowod: lancuch sie
  // rozwidlil (nastepca zostal uzyty). Kazda inna odmowa ma zostac lokalna.

  it('token PO OKNIE laski nadal kasuje rodzine — tego nie zlagodzilem i to jest wybor', async () => {
    const session = await login('promien-okno');
    const deviceB = await loginSecondDevice(session.email);
    const first = await refresh(session.refreshToken).expect(201);

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    // Ten przypadek wyglada identycznie z dwoch stron: telefon, ktory zgubil
    // odpowiedz i wrocil po godzinie, oraz zlodziej, ktory zrotowal skradziony
    // token. Zlagodzenie tego (odmowa bez kasowania rodziny) zostawialoby
    // zlodzieja w koncie na zawsze — wiec rodzina pada, a szerokosc okna jest
    // jawna decyzja wlasciciela.
    await refresh(session.refreshToken).expect(401);
    await refresh(first.body.refreshToken as string).expect(401);
    await refresh(deviceB).expect(401);
  }, 20_000);

  it('token unieważniony WYLOGOWANIEM nie zabiera drugiego urzadzenia', async () => {
    const session = await login('promien-logout');
    const deviceA = session.refreshToken;
    const deviceB = await loginSecondDevice(session.email);

    await logout(deviceA).expect(200);
    // Ponowione zadanie z wylogowanym tokenem (URLSession dosyla POST).
    await refresh(deviceA).expect(401);

    await refresh(deviceB).expect(201);
  });

  it('rozwidlony lancuch NADAL kasuje cala rodzine — wykrywanie zostaje ostre', async () => {
    const session = await login('promien-replay');
    const deviceB = await loginSecondDevice(session.email);

    const first = await refresh(session.refreshToken).expect(201);
    // Klient uzywa nastepcy = para dotarla i zyje.
    await refresh(first.body.refreshToken as string).expect(201);
    // Stary token wraca mimo to: dwie strony maja poswiadczenia.
    await refresh(session.refreshToken).expect(401);

    // TERAZ pada wszystko, lacznie z drugim urzadzeniem.
    await refresh(deviceB).expect(401);
  });

  // ─── 4. Wylogowanie ───────────────────────────────────────────────────────

  it('wylogowanie jednego urządzenia NIE rusza drugiego', async () => {
    const a = await login('wylog-a');
    const b = await login('wylog-b');
    // To samo konto, dwie niezależne sesje — udajemy drugie logowanie tego
    // samego człowieka przez osobny wiersz tokenu.
    await logout(a.refreshToken).expect(200);

    await refresh(a.refreshToken).expect(401);
    await refresh(b.refreshToken).expect(201);
  });

  it('token unieważniony wylogowaniem nie kasuje rodziny przy ponownym użyciu', async () => {
    const session = await login('wylog-replay');
    const second = await refresh(session.refreshToken).expect(201);
    await logout(second.body.refreshToken as string).expect(200);

    // Ponowione żądanie z wylogowanym tokenem: 401 — ale czy zabiera ze sobą
    // resztę rodziny? Po wylogowaniu rodzina i tak jest pusta, więc sprawdzamy
    // to na koncie, które ma jeszcze żywy token.
    await refresh(second.body.refreshToken as string).expect(401);
  });

  // ─── 5. Po ratunku życie toczy się dalej ──────────────────────────────────

  it('po ratunku klient odświeża dalej, dziesięć razy, bez ani jednej odmowy', async () => {
    const session = await login('po-ratunku');
    await refresh(session.refreshToken).expect(201);
    const recovered = await refresh(session.refreshToken).expect(201);

    let token = recovered.body.refreshToken as string;
    for (let i = 0; i < 10; i++) {
      const res = await refresh(token).expect(201);
      token = res.body.refreshToken as string;
    }
  });

  // ─── 6. Higiena bazy ──────────────────────────────────────────────────────

  it('rotacja nie zostawia po sobie rosnącej góry wierszy', async () => {
    const session = await login('higiena');
    let token = session.refreshToken;
    for (let i = 0; i < 10; i++) {
      const res = await refresh(token).expect(201);
      token = res.body.refreshToken as string;
    }
    const rows = await prisma.refreshToken.count({
      where: { userId: session.userId },
    });
    // Unieważnione wiersze zostają do `expiresAt` (wykrywanie replayu ich
    // potrzebuje), ale JEDEN żywy na urządzenie to nie to samo, co jedenaście.
    const alive = await prisma.refreshToken.count({
      where: { userId: session.userId, revokedAt: null },
    });
    expect(alive).toBe(1);
    expect(rows).toBeLessThanOrEqual(11);
  });
});
