import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { ensureRecipeForHousehold } from '../weekly-plans/utils/auth-checks.util';
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
import { isCookidooIntegrationEnabled } from './cookidoo-flag';
import { ConsentsService } from '../consents/consents.service';

const STATUS_CONNECTED = 'CONNECTED';
const STATUS_AUTH_FAILED = 'AUTH_FAILED';

// Okno idempotencji dla „wyślij na Thermomixa": double-tap i wyścig dwóch
// domowników nie dublują wpisu w Cookidoo. In-memory wystarcza — API to
// jedna instancja (Railway), a skutkiem chybienia jest co najwyżej duplikat
// w „Mój tydzień", który Cookidoo i tak dopuszcza.
const DEBOUNCE_WINDOW_MS = 60_000;

/**
 * Kropki zamiast znaków e-maila konta Cookidoo (`r•••@g•••.com`) — dla
 * domownika, który nie podłączył konta i nie jest właścicielem domu (audyt
 * 5.09.2026, 2.2.4). Pole zostaje tekstem: `login` w kontrakcie jest stringiem,
 * a klient pokazuje go jako „połączone jako …" — maska mówi „konto jest", ale
 * nie zdradza cudzego adresu.
 */
export function maskCookidooLogin(email: string): string {
  const dots = '•••';
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return dots;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const maskedDomain =
    lastDot > 0
      ? `${domain[0]}${dots}${domain.slice(lastDot)}`
      : `${domain[0]}${dots}`;
  return `${local[0]}${dots}@${maskedDomain}`;
}

type HouseholdMembershipRef = { householdId: string; role: MembershipRole };

export type CookidooStatusView = {
  connected: boolean;
  /**
   * Czy integracja jest w ogóle dostępna (`COOKIDOO_INTEGRATION_ENABLED`).
   * `false` = klient chowa wiersz w Ustawieniach; poświadczenia zostają,
   * `disconnect` nadal działa.
   */
  enabled: boolean;
  /**
   * E-mail konta Cookidoo. Pełny tylko dla osoby, która konto podłączyła,
   * i właściciela domu; pozostali domownicy dostają maskę (`r•••@g•••.com`).
   */
  login?: string;
  status?: string;
  connectedById?: string | null;
  lastVerifiedAt?: Date | null;
  /**
   * Czy pytający może nadpisać albo rozłączyć to połączenie: osoba, która je
   * podłączyła, albo właściciel domu. Tylko przy `connected: true`.
   */
  canManage?: boolean;
};

@Injectable()
export class CookidooIntegrationService {
  /**
   * Klucz czytany LENIWIE, przy pierwszym użyciu, a nie przy budowie DI:
   * wyłączona integracja (`COOKIDOO_INTEGRATION_ENABLED=false`) nie ma
   * prawa wywracać startu całej aplikacji brakiem sekretu, którego nic nie
   * użyje. Przy pierwszym połączeniu brak klucza nadal jest błędem — ten sam
   * `parseEncryptionKey`, tylko później.
   */
  private cachedKey: Buffer | null = null;
  private get encryptionKey(): Buffer {
    this.cachedKey ??= parseEncryptionKey(process.env.COOKIDOO_ENCRYPTION_KEY);
    return this.cachedKey;
  }
  private readonly recentSends = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cookidooClient: CookidooServiceClient,
    // Opcjonalnie: testy jednostkowe budują serwis bez dziennika zgód.
    @Optional() private readonly consents?: ConsentsService,
  ) {}

  async connect(
    userId: string,
    email: string,
    password: string,
  ): Promise<
    CookidooStatusView & { subscription: CookidooSubscriptionInfo | null }
  > {
    this.assertEnabled();
    const membership = await this.resolveMembership(userId);
    const { householdId } = membership;

    // Cudze połączenie nadpisuje tylko jego autor albo właściciel domu —
    // sprawdzone PRZED wysłaniem hasła do Vorwerka, żeby odmowa nie kosztowała
    // logowania na cudzym koncie. Ostateczna bramka jest w samym zapisie
    // (`writeCredentials`), bo między tym odczytem a zapisem ktoś mógł
    // podłączyć dom pierwszy.
    const existing = await this.prisma.cookidooIntegration.findUnique({
      where: { householdId },
      select: { connectedById: true },
    });
    if (existing && !this.canManage(existing, userId, membership)) {
      throw this.notConnectorError();
    }

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
    const replaced = await this.writeCredentials(
      userId,
      householdId,
      encrypted,
    );
    // Właściciel nadpisał cudze połączenie: hasło tamtej osoby zniknęło, więc
    // w dzienniku ma JEJ REVOKED (review 7.10.2026 — zostawało GRANTED).
    if (replaced && replaced !== userId) {
      await this.consents?.recordSystem(
        replaced,
        'COOKIDOO',
        'REVOKED',
        'COOKIDOO_REPLACED',
        householdId,
      );
    }
    // Podanie hasła JEST zgodą na przekazanie go usłudze trzeciej (polityka
    // §3, art. 6 ust. 1 lit. a) — dziennik ma to udowodnić.
    await this.consents?.recordSystem(
      userId,
      'COOKIDOO',
      'GRANTED',
      'COOKIDOO_CONNECT',
      householdId,
    );

    return {
      connected: true,
      enabled: true,
      login: email,
      status: STATUS_CONNECTED,
      connectedById: userId,
      lastVerifiedAt: now,
      canManage: true,
      subscription,
    };
  }

  /**
   * Zapis poświadczeń z bramką „autor albo właściciel" W TRANSAKCJI ZAPISU.
   *
   * Rola z `resolveMembership` jest sprzed walidacji u Vorwerka (sekundy) —
   * w tym czasie pytający mógł zostać zdegradowany albo usunięty z domu
   * (Codex, review 7.10.2026). Dlatego członkostwo i rola są czytane od nowa,
   * z blokadą wiersza (`lockMembership`), i dopiero na nich opiera się zapis.
   *
   * Właściciel nadpisuje zawsze (`upsert`). Domownik: aktualizacja tylko
   * wiersza, który sam podłączył; brak takiego wiersza = pierwsze podłączenie
   * domu (`create`). Gdy w międzyczasie podłączył ktoś inny, `create` trafia
   * w unikalny `householdId` (P2002) i kończy się tą samą odmową, co odczyt
   * wyżej — bez okna, w którym dwa telefony nadpisują się nawzajem.
   *
   * Zwraca `connectedById` nadpisanego wiersza (`null` = nie było wiersza albo
   * autor skasował konto) — do dziennika zgód.
   */
  private async writeCredentials(
    userId: string,
    householdId: string,
    data: Omit<Prisma.CookidooIntegrationUncheckedCreateInput, 'householdId'>,
  ): Promise<string | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockMembership(tx, userId, householdId);
        if (!role) throw this.notConnectorError();
        const previous = await this.lockIntegration(tx, householdId);
        if (role === 'OWNER') {
          await tx.cookidooIntegration.upsert({
            where: { householdId },
            create: { householdId, ...data },
            update: data,
          });
          return previous;
        }
        const own = await tx.cookidooIntegration.updateMany({
          where: { householdId, connectedById: userId },
          data,
        });
        if (own.count > 0) return userId;
        await tx.cookidooIntegration.create({
          data: { householdId, ...data },
        });
        return null;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.notConnectorError();
      }
      throw error;
    }
  }

  /**
   * Rola pytającego w domu, czytana W transakcji z `FOR SHARE` na jego wierszu
   * `Membership`; `null` = już nie jest domownikiem.
   *
   * Blokada szereguje zapis poświadczeń z degradacją (`UPDATE` roli) i
   * usunięciem z domu (`DELETE` członkostwa): albo tamto czeka na nasz commit
   * (i sprzątanie `revokeCookidooCredentialsOf`, które biegnie PO usunięciu
   * członkostwa, widzi już nasz wiersz), albo my czekamy i czytamy stan po
   * nim. `FOR SHARE`, nie `FOR UPDATE`: dwa równoległe zapisy tego samego
   * domownika nie muszą się wykluczać — to robi unikalny `householdId`.
   */
  private async lockMembership(
    tx: Prisma.TransactionClient,
    userId: string,
    householdId: string,
  ): Promise<MembershipRole | null> {
    const rows = await tx.$queryRaw<{ role: MembershipRole }[]>`
      SELECT "role" FROM "Membership"
      WHERE "userId" = ${userId}::uuid AND "householdId" = ${householdId}::uuid
      FOR SHARE`;
    return rows[0]?.role ?? null;
  }

  /**
   * `connectedById` połączenia domu z blokadą `FOR UPDATE` (po `lockMembership`
   * — ta sama kolejność blokad co sprzątanie: członkostwo, potem poświadczenia).
   * Dziennik zgód ma wpisać REVOKED osobie, której hasło TEN zapis usuwa,
   * a nie komuś, kto podłączył się w międzyczasie.
   */
  private async lockIntegration(
    tx: Prisma.TransactionClient,
    householdId: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<{ connectedById: string | null }[]>`
      SELECT "connectedById" FROM "CookidooIntegration"
      WHERE "householdId" = ${householdId}::uuid
      FOR UPDATE`;
    return rows[0]?.connectedById ?? null;
  }

  async status(userId: string): Promise<CookidooStatusView> {
    const enabled = isCookidooIntegrationEnabled();
    const membership = await this.resolveMembership(userId);
    const { householdId } = membership;
    const integration = await this.prisma.cookidooIntegration.findUnique({
      where: { householdId },
    });
    if (!integration) {
      return { connected: false, enabled };
    }

    let login: string;
    try {
      // Odszyfrowujemy wyłącznie e-mail — hasło nigdy nie opuszcza serwera.
      login = decryptSecret(integration.emailEncrypted, this.encryptionKey);
    } catch {
      // Klucz się zmienił (rotacja/utrata) — stare wpisy są nie do odczytania,
      // więc dla klienta integracji po prostu nie ma; trzeba połączyć ponownie.
      return { connected: false, enabled };
    }

    // Wyłączona integracja z zapisanym hasłem: klient chowa łączenie i
    // wysyłkę, ale MUSI pokazać „rozłącz" — inaczej hasło zostaje w bazie
    // bez drogi do usunięcia (audyt 2, 3.09.2026). „Rozłącz" działa dla
    // autora połączenia i właściciela domu — `canManage` mówi klientowi, czy
    // to ten przypadek; pozostali widzą e-mail w masce.
    const canManage = this.canManage(integration, userId, membership);
    return {
      connected: true,
      enabled,
      login: canManage ? login : maskCookidooLogin(login),
      status: integration.status,
      connectedById: integration.connectedById,
      lastVerifiedAt: integration.lastVerifiedAt,
      canManage,
    };
  }

  /**
   * Działa także przy wyłączonej integracji — usunięcie hasła to prawo
   * użytkownika. Kasuje tylko autor połączenia albo właściciel domu: dotąd
   * każdy domownik mógł skasować cudze poświadczenia (audyt 5.09.2026, 2.2.4).
   * Brak połączenia = sukces bez zmian (idempotentnie, jak dotąd).
   */
  async disconnect(
    userId: string,
  ): Promise<{ connected: false; enabled: boolean }> {
    const { householdId } = await this.resolveMembership(userId);
    // Rola czytana od nowa W transakcji, pod blokadą wiersza członkostwa
    // (`lockMembership`) — zdegradowany albo usunięty w międzyczasie nie
    // skasuje cudzych poświadczeń. Warunek w samym DELETE: odczyt „kto
    // podłączył" i kasowanie nie mogą się rozjechać, gdy ktoś równolegle
    // podłącza dom od nowa.
    const removed = await this.prisma.$transaction(async (tx) => {
      const role = await this.lockMembership(tx, userId, householdId);
      if (!role) throw this.notConnectorError();
      const connector = await this.lockIntegration(tx, householdId);
      const result = await tx.cookidooIntegration.deleteMany({
        where:
          role === 'OWNER'
            ? { householdId }
            : { householdId, connectedById: userId },
      });
      if (result.count === 0 && role !== 'OWNER') {
        const foreign = await tx.cookidooIntegration.count({
          where: { householdId },
        });
        if (foreign > 0) throw this.notConnectorError();
      }
      return { count: result.count, connector };
    });
    // REVOKED dla osoby, której hasło zniknęło — także gdy rozłączył je
    // właściciel (review 7.10.2026; dotąd wpis szedł na rozłączającego,
    // a autor zostawał z GRANTED). Autor po skasowanym koncie (`null`): nie
    // ma czyjej zgody odnotować.
    if (removed.count > 0 && removed.connector) {
      await this.consents?.recordSystem(
        removed.connector,
        'COOKIDOO',
        'REVOKED',
        'COOKIDOO_DISCONNECT',
        householdId,
      );
    }
    return { connected: false, enabled: isCookidooIntegrationEnabled() };
  }

  async sendToWeek(
    userId: string,
    recipeId: string,
    date: string,
  ): Promise<{ ok: true; date: string; alreadySent: boolean }> {
    this.assertEnabled();
    const { householdId } = await this.resolveMembership(userId);

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

    // Przepis musi być widoczny dla TEGO domu (katalog albo własny) — bez
    // bramki trasa była wyrocznią istnienia cudzych przepisów.
    await ensureRecipeForHousehold(this.prisma, recipeId, householdId);
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

  private assertEnabled(): void {
    if (isCookidooIntegrationEnabled()) return;
    throw new AppException(
      'COOKIDOO_DISABLED',
      'Integracja z Cookidoo jest tymczasowo wyłączona.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private canManage(
    integration: { connectedById: string | null },
    userId: string,
    membership: HouseholdMembershipRef,
  ): boolean {
    return membership.role === 'OWNER' || integration.connectedById === userId;
  }

  /**
   * Istniejący kod `FORBIDDEN` (403) zamiast nowego: klienci mają już na niego
   * kopię („Nie masz uprawnień do tej akcji."), a nowy kod wymagałby nowego
   * builda iOS. Komunikat mówi, kto może.
   */
  private notConnectorError(): AppException {
    return new AppException(
      'FORBIDDEN',
      'Połączenie z Cookidoo może zmienić albo rozłączyć tylko osoba, która je podłączyła, albo właściciel gospodarstwa.',
      HttpStatus.FORBIDDEN,
    );
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
  // Rola z tego samego wiersza — od niej zależy, kto zarządza połączeniem.
  private async resolveMembership(
    userId: string,
  ): Promise<HouseholdMembershipRef> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { householdId: true, role: true },
    });
    if (!membership) {
      throw new AppException(
        'FORBIDDEN',
        'User is not a member of any household',
        HttpStatus.FORBIDDEN,
      );
    }
    return membership;
  }
}
