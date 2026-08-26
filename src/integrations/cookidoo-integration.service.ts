import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CookidooServiceClient,
  CookidooSubscriptionInfo,
} from './cookidoo-service.client';

const STATUS_CONNECTED = 'CONNECTED';
const STATUS_AUTH_FAILED = 'AUTH_FAILED';

// Okno idempotencji dla „wyślij na Thermomixa": double-tap i wyścig dwóch
// domowników nie dublują wpisu w Cookidoo. In-memory wystarcza — API to
// jedna instancja (Railway), a skutkiem chybienia jest co najwyżej duplikat
// w „Mój tydzień", który Cookidoo i tak dopuszcza.
const DEBOUNCE_WINDOW_MS = 60_000;

export type CookidooStatusView = {
  connected: boolean;
  login?: string;
  status?: string;
  connectedById?: string | null;
  lastVerifiedAt?: Date | null;
};

@Injectable()
export class CookidooIntegrationService {
  // Fail-fast: bez poprawnego klucza nie wolno przyjąć żadnych poświadczeń.
  private readonly encryptionKey = parseEncryptionKey(
    process.env.COOKIDOO_ENCRYPTION_KEY,
  );
  private readonly recentSends = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cookidooClient: CookidooServiceClient,
  ) {}

  async connect(
    userId: string,
    email: string,
    password: string,
  ): Promise<
    CookidooStatusView & { subscription: CookidooSubscriptionInfo | null }
  > {
    const householdId = await this.resolveHouseholdId(userId);

    // Najpierw walidacja u Vorwerka — błędne dane nie mogą nadpisać
    // działającej integracji (klient rzuca, nic nie zapisujemy).
    const { subscription } = await this.cookidooClient.validateCredentials(
      email,
      password,
    );

    const now = new Date();
    const encrypted = {
      emailEncrypted: encryptSecret(email, this.encryptionKey),
      passwordEncrypted: encryptSecret(password, this.encryptionKey),
      status: STATUS_CONNECTED,
      connectedById: userId,
      lastVerifiedAt: now,
      lastErrorCode: null,
    };
    await this.prisma.cookidooIntegration.upsert({
      where: { householdId },
      create: { householdId, ...encrypted },
      update: encrypted,
    });

    return {
      connected: true,
      login: email,
      status: STATUS_CONNECTED,
      connectedById: userId,
      lastVerifiedAt: now,
      subscription,
    };
  }

  async status(userId: string): Promise<CookidooStatusView> {
    const householdId = await this.resolveHouseholdId(userId);
    const integration = await this.prisma.cookidooIntegration.findUnique({
      where: { householdId },
    });
    if (!integration) {
      return { connected: false };
    }

    let login: string;
    try {
      // Odszyfrowujemy wyłącznie e-mail — hasło nigdy nie opuszcza serwera.
      login = decryptSecret(integration.emailEncrypted, this.encryptionKey);
    } catch {
      // Klucz się zmienił (rotacja/utrata) — stare wpisy są nie do odczytania,
      // więc dla klienta integracji po prostu nie ma; trzeba połączyć ponownie.
      return { connected: false };
    }

    return {
      connected: true,
      login,
      status: integration.status,
      connectedById: integration.connectedById,
      lastVerifiedAt: integration.lastVerifiedAt,
    };
  }

  async disconnect(userId: string): Promise<{ connected: false }> {
    const householdId = await this.resolveHouseholdId(userId);
    await this.prisma.cookidooIntegration.deleteMany({
      where: { householdId },
    });
    return { connected: false };
  }

  async sendToWeek(
    userId: string,
    recipeId: string,
    date: string,
  ): Promise<{ ok: true; date: string; alreadySent: boolean }> {
    const householdId = await this.resolveHouseholdId(userId);

    const integration = await this.prisma.cookidooIntegration.findUnique({
      where: { householdId },
    });
    if (!integration || integration.status !== STATUS_CONNECTED) {
      throw new AppException(
        'COOKIDOO_NOT_CONNECTED',
        integration
          ? 'Połączenie z Cookidoo wymaga ponownego logowania.'
          : 'Gospodarstwo nie ma połączonego konta Cookidoo.',
        HttpStatus.CONFLICT,
      );
    }

    const recipe = await this.prisma.recipe.findUnique({
      where: { id: recipeId },
      select: { sourceProvider: true, sourceRecipeId: true, isActive: true },
    });
    if (
      !recipe ||
      !recipe.isActive ||
      recipe.sourceProvider !== 'cookidoo' ||
      !recipe.sourceRecipeId
    ) {
      throw new AppException(
        'COOKIDOO_RECIPE_NOT_LINKED',
        'Ten przepis nie ma odpowiednika w Cookidoo.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const debounceKey = `${householdId}:${recipeId}:${date}`;
    if (this.wasRecentlySent(debounceKey)) {
      return { ok: true, date, alreadySent: true };
    }

    let email: string;
    let password: string;
    try {
      email = decryptSecret(integration.emailEncrypted, this.encryptionKey);
      password = decryptSecret(
        integration.passwordEncrypted,
        this.encryptionKey,
      );
    } catch {
      throw new AppException(
        'COOKIDOO_NOT_CONNECTED',
        'Połączenie z Cookidoo wymaga ponownego logowania.',
        HttpStatus.CONFLICT,
      );
    }

    try {
      await this.cookidooClient.addToWeek({
        sessionKey: householdId,
        email,
        password,
        recipeId: recipe.sourceRecipeId,
        date,
      });
    } catch (error) {
      if (
        error instanceof AppException &&
        this.exceptionCode(error) === 'COOKIDOO_AUTH_FAILED'
      ) {
        // Hasło do Cookidoo przestało działać — oznaczamy integrację, żeby
        // ustawienia w iOS pokazały „Błąd logowania" bez kolejnych prób.
        await this.prisma.cookidooIntegration.update({
          where: { householdId },
          data: {
            status: STATUS_AUTH_FAILED,
            lastErrorCode: 'COOKIDOO_AUTH_FAILED',
          },
        });
      }
      throw error;
    }

    this.recentSends.set(debounceKey, Date.now());
    await this.prisma.cookidooIntegration.update({
      where: { householdId },
      data: {
        status: STATUS_CONNECTED,
        lastVerifiedAt: new Date(),
        lastErrorCode: null,
      },
    });

    return { ok: true, date, alreadySent: false };
  }

  private wasRecentlySent(key: string): boolean {
    const now = Date.now();
    for (const [entryKey, sentAt] of this.recentSends) {
      if (now - sentAt > DEBOUNCE_WINDOW_MS) {
        this.recentSends.delete(entryKey);
      }
    }
    return this.recentSends.has(key);
  }

  private exceptionCode(error: AppException): string | undefined {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      return (response as { code?: string }).code;
    }
    return undefined;
  }

  // Ta sama reguła co przy logowaniu (auth.service): gospodarstwo użytkownika
  // to jego najstarsze membership. Id bierzemy z JWT, nigdy z payloadu.
  private async resolveHouseholdId(userId: string): Promise<string> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { householdId: true },
    });
    if (!membership) {
      throw new AppException(
        'FORBIDDEN',
        'User is not a member of any household',
        HttpStatus.FORBIDDEN,
      );
    }
    return membership.householdId;
  }
}
