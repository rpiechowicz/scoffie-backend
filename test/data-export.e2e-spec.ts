import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { USER_EXPORT_FORMAT } from '../src/data-export/user-export';

/**
 * Eksport danych osoby (RODO art. 15/20) na żywej bazie.
 *
 * Sprawdza trzy rzeczy, których nie da się dowieść mockiem: że paczka
 * naprawdę wyciąga własne dane osoby ze wszystkich tabel, że NIE wyciąga
 * danych drugiego domownika ani sekretów, i że bez tokenu nie ma nic.
 */
describe('Eksport danych konta (RODO)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@export.local`,
        authProvider: 'DEV',
        weightKg: 70.5,
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('bez tokenu — 401', async () => {
    await request(app.getHttpServer()).get('/me/export').expect(401);
  });

  it('paczka ma własne dane osoby, a nie ma danych domownika ani sekretów', async () => {
    const meId = await createUser('Ja');
    const otherId = await createUser('Domownik');
    const household = await prisma.household.create({
      data: {
        name: 'Dom eksportu',
        createdById: meId,
        memberships: {
          create: [
            { userId: meId, role: 'OWNER' },
            { userId: otherId, role: 'MEMBER' },
          ],
        },
      },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);

    await prisma.userPreference.create({
      data: { userId: meId, allergens: ['peanuts'] },
    });
    await prisma.userPreference.create({
      data: { userId: otherId, allergens: ['milk'] },
    });
    await prisma.consentEvent.create({
      data: {
        userId: meId,
        kind: 'AI_ASSISTANT',
        action: 'GRANTED',
        documentVersion: '2026-09-15',
      },
    });
    await prisma.dailyStepCount.create({
      data: {
        userId: meId,
        date: new Date('2026-09-01T00:00:00.000Z'),
        steps: 8000,
        stepsGoal: 10000,
        source: 'APPLE_HEALTH',
      },
    });
    await prisma.pushDevice.create({
      data: {
        userId: meId,
        deviceToken: `tok-${meId}`,
        platform: 'IOS',
        appBundleId: 'pl.weeklymeals.app',
      },
    });
    await prisma.agentConversation.create({
      data: {
        userId: otherId,
        householdId: household.id,
        messages: {
          create: [{ role: 'USER', text: 'SEKRET DOMOWNIKA' }],
        },
      },
    });
    await prisma.agentConversation.create({
      data: {
        userId: meId,
        householdId: household.id,
        messages: {
          create: [{ role: 'USER', text: 'Co na kolację?' }],
        },
      },
    });

    const token = jwt.sign({ sub: meId });
    const res = await request(app.getHttpServer())
      .get('/me/export')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toContain('attachment');

    const body = res.body as {
      format: string;
      profile: { id: string; weightKg: number };
      preferences: { allergens: string[] };
      consents: { kind: string }[];
      households: { id: string; role: string }[];
      dailySteps: { steps: number }[];
      devices: { platform: string }[];
      assistant: { conversations: { messages: { text: string }[] }[] };
    };
    expect(body.format).toBe(USER_EXPORT_FORMAT);
    expect(body.profile.id).toBe(meId);
    expect(body.profile.weightKg).toBe(70.5);
    expect(body.preferences.allergens).toEqual(['peanuts']);
    expect(body.consents.map((c) => c.kind)).toEqual(['AI_ASSISTANT']);
    expect(body.households).toEqual([
      expect.objectContaining({ id: household.id, role: 'OWNER' }),
    ]);
    expect(body.dailySteps.map((d) => d.steps)).toEqual([8000]);
    expect(body.devices).toEqual([
      expect.objectContaining({ platform: 'IOS' }),
    ]);

    // Rozmowa domownika NIE wchodzi; token urządzenia też nie.
    const raw = JSON.stringify(body);
    expect(raw).toContain('Co na kolację?');
    expect(raw).not.toContain('SEKRET DOMOWNIKA');
    expect(raw).not.toContain(`tok-${meId}`);
    expect(raw).not.toContain('milk');
    expect(raw).not.toContain(otherId);
  });
});
