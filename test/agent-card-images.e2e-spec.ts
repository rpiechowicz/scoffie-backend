import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { buildUserExport } from '../src/data-export/user-export';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Karty asystenta w HISTORII bez adresów generatora obrazków (review
 * 7.10.2026, audyt 2.2.5) — e2e, żywa baza.
 *
 * Karty sprzed 7.10.2026 mogą trzymać w JSON-ie wiadomości adres pollinations
 * z tytułem i opisem przepisu domu; telefon pobrałby go przy otwarciu
 * rozmowy. Odczyt historii i eksport RODO zamieniają taki `imageUrl` na
 * `null`, zdjęcia katalogu (`img.scoffie.app`) zostają.
 */
const GENERATED =
  'https://image.pollinations.ai/prompt/professional%20food%20photo%2C%20Tajny%20gulasz%20babci?seed=scoffie-1';
const CATALOG_PHOTO = 'https://img.scoffie.app/recipe-images/x.webp';

type Session = { accessToken: string; user: { id: string } };

describe('Karty asystenta w historii bez adresów generatora (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const env = { ...process.env };
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  let session: Session;
  let conversationId: string;

  const auth = () => ({ Authorization: `Bearer ${session.accessToken}` });

  beforeAll(async () => {
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
    process.env.THROTTLE_AUTH_LIMIT = '10000';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Karty ${stamp}`,
        email: `karty-${stamp}@cards.local`,
      })
      .expect(201);
    session = res.body as Session;
    createdUserIds.push(session.user.id);
    await prisma.membership.deleteMany({ where: { userId: session.user.id } });
    const home = await prisma.household.create({
      data: { name: `Karty ${stamp}`, createdById: session.user.id },
    });
    createdHouseholdIds.push(home.id);
    await prisma.membership.create({
      data: { userId: session.user.id, householdId: home.id, role: 'OWNER' },
    });

    conversationId = (
      (
        await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth())
          .send({ householdId: home.id })
          .expect(201)
      ).body as { id: string }
    ).id;

    // Karta zapisana przez starszą wersję: PLAN_DAY z adresem generatora
    // przepisu domu obok zdjęcia z katalogu.
    await prisma.agentMessage.create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        kind: 'PLAN_DAY',
        text: 'Propozycja dnia.',
        card: {
          kind: 'PLAN_DAY',
          v: 1,
          slots: [
            { recipeId: 'r-dom', title: 'Tajny gulasz', imageUrl: GENERATED },
            { recipeId: 'r-kat', title: 'Owsianka', imageUrl: CATALOG_PHOTO },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  });

  const slotImages = (card: unknown) =>
    (card as { slots: { imageUrl: string | null }[] }).slots.map(
      (slot) => slot.imageUrl,
    );

  it('historia rozmowy: adres generatora → null, zdjęcie katalogu zostaje', async () => {
    const res = await request(app.getHttpServer())
      .get(`/agent/conversations/${conversationId}/messages`)
      .set(auth())
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain('pollinations');
    const body = res.body as
      | { messages: { kind: string; card: unknown }[] }
      | { kind: string; card: unknown }[];
    const messages = Array.isArray(body) ? body : body.messages;
    const planDay = messages.find((message) => message.kind === 'PLAN_DAY');
    expect(slotImages(planDay?.card)).toEqual([null, CATALOG_PHOTO]);
  });

  it('eksport RODO: karta w paczce bez adresu generatora', async () => {
    const exported = await buildUserExport(prisma, session.user.id);
    expect(exported).not.toBeNull();
    const text = JSON.stringify(exported?.assistant.conversations);
    expect(text).not.toContain('pollinations');
    expect(text).toContain(CATALOG_PHOTO);
  });
});
