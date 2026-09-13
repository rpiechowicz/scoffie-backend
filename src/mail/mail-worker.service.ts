import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { MailMessage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OpsAlertService } from '../observability/ops-alert.service';
import { mapWithConcurrency } from '../common/concurrency.util';
import { readMailEnv } from './mail-env';
import { nextAttemptAt } from './mail-backoff';
import { isAppleRelay, normalizeEmail } from './mail-eligibility';
import { MAIL_CLIENT } from './providers/mail-client';
// `import type` — patrz TS1272: interfejs w sygnaturze konstruktora z `@Inject`.
import type { MailClient, OutgoingMail } from './providers/mail-client';
import { MailRenderer } from './mail-renderer';
import { isMailTemplateId } from './mail-template';

/** Ile wiadomości leci do dostawcy równolegle. Tyle samo, co przy pushach. */
const SEND_CONCURRENCY = 4;

/**
 * Wiersz w stanie `SENDING` starszy niż to okno znaczy, że proces padł
 * w połowie wysyłki. Wracamy z nim do kolejki — przed drugą wysyłką chroni
 * `Idempotency-Key` u dostawcy.
 */
const STUCK_SENDING_MS = 10 * 60_000;

/** Jak często sprzątamy dane osobowe z wysłanych wierszy. */
const RETENTION_EVERY_MS = 60 * 60_000;
const SCRUB_AFTER_DAYS = 30;
const DELETE_AFTER_DAYS = 365;

/**
 * Robotnik skrzynki nadawczej.
 *
 * Jedna instancja Railway, więc zwykły `setInterval` z `unref` — jak
 * `SubscriptionsReconcileService` i `AgentRetentionService`. Żadnego Redisa
 * ani BullMQ: kolejka o siedmiu rodzajach wiadomości i kilkudziesięciu
 * sztukach dziennie nie jest powodem, żeby wprowadzać do projektu drugą bazę.
 */
@Injectable()
export class MailWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MailWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;

  private readonly counters = {
    sent: 0,
    failed: 0,
    retried: 0,
    suppressed: 0,
    relayBounces: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: MailRenderer,
    private readonly alerts: OpsAlertService,
    @Inject(MAIL_CLIENT) private readonly client: MailClient,
  ) {}

  onApplicationBootstrap(): void {
    const env = readMailEnv();
    this.logger.log(
      env.enabled
        ? `Poczta włączona: transport ${env.transport}, nadawca ${env.from}` +
            (env.redirectTo
              ? `, WSZYSTKO przekierowane na ${env.redirectTo}`
              : '')
        : 'Poczta wyłączona (MAIL_ENABLED=false) — nic się nie kolejkuje ani nie wysyła.',
    );

    // Pętla chodzi zawsze, a decyzję „wysyłać czy nie" podejmuje każdy przebieg
    // z osobna — zmienne czytamy per wywołanie, więc włączenie poczty nie
    // wymaga innego kodu startowego niż jej wyłączenie.
    this.timer = setInterval(() => void this.sweep(), env.workerIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): Record<string, number> {
    return { ...this.counters };
  }

  /**
   * Jeden przebieg. Nie rzuca nigdy — wyjątek w pętli tła ubiłby ją do końca
   * życia procesu, a nikt by tego nie zauważył aż do pierwszej reklamacji.
   */
  async sweep(): Promise<void> {
    if (this.running) return;
    const env = readMailEnv();
    if (!env.enabled) return;

    this.running = true;
    try {
      await this.recoverStuck();
      const claimed = await this.claim(env.batchSize);
      if (claimed.length > 0) {
        await mapWithConcurrency(claimed, SEND_CONCURRENCY, (row) =>
          this.deliver(row),
        );
      }
      await this.maybeRunRetention();
    } catch (error) {
      this.logger.error(
        `przebieg poczty padł: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Zajęcie porcji. Warunkowy `updateMany` na KAŻDYM wierszu z osobna, bo
   * tylko jego `count` mówi, kto ten wiersz naprawdę zajął.
   *
   * AUDYT 12.09.2026 (P1.12). Poprzednia wersja robiła jeden zbiorczy
   * `updateMany` z warunkiem `status: QUEUED`, a potem DOCZYTYWAŁA wiersze
   * po `status: SENDING`. Warunek faktycznie chronił przed podwójną zmianą
   * stanu — ale wynik `count` był wyrzucany, a doczytanie nie odróżniało
   * wierszy zajętych przez TEN przebieg od zajętych przez inny. Drugi
   * przebieg wchodzący równolegle zmieniał zero wierszy, po czym odczytywał
   * te same dwadzieścia wiadomości i wysyłał je PO RAZ DRUGI. Komentarz
   * obiecywał dokładnie odwrotność tego, co robił kod.
   *
   * Dziś nie boli, bo instancja jest jedna, a `running` w pętli nie pozwala
   * jej wejść samej sobie w drogę. Zaczyna boleć w sekundzie, w której na
   * Railway pojawi się druga replika — a wtedy objawem jest podwójny mail
   * do użytkownika, czyli rzecz widoczna i nieodwracalna.
   *
   * Koszt: dwadzieścia krótkich `UPDATE` po indeksie co piętnaście sekund.
   */
  private async claim(batchSize: number): Promise<MailMessage[]> {
    const now = new Date();
    const waiting = await this.prisma.mailMessage.findMany({
      where: { status: 'QUEUED', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      take: batchSize,
      select: { id: true },
    });
    if (waiting.length === 0) return [];

    const mine: string[] = [];
    for (const { id } of waiting) {
      const { count } = await this.prisma.mailMessage.updateMany({
        where: { id, status: 'QUEUED' },
        data: { status: 'SENDING' },
      });
      if (count === 1) mine.push(id);
    }
    if (mine.length === 0) return [];

    return this.prisma.mailMessage.findMany({
      where: { id: { in: mine }, status: 'SENDING' },
    });
  }

  private async recoverStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_SENDING_MS);
    const recovered = await this.prisma.mailMessage.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: cutoff } },
      data: { status: 'QUEUED' },
    });
    if (recovered.count > 0) {
      this.logger.warn(
        `${recovered.count} wiadomości wisiało w SENDING — wracają do kolejki.`,
      );
    }
  }

  private async deliver(row: MailMessage): Promise<void> {
    const env = readMailEnv();

    if (!isMailTemplateId(row.template)) {
      await this.markFailed(row, `nieznany szablon ${row.template}`);
      return;
    }

    let outgoing: OutgoingMail;
    try {
      const rendered = this.renderer.render(
        row.template,
        row.payload as Record<string, unknown>,
      );
      const headers: Record<string, string> = {
        'X-Scoffie-Template': row.template,
      };
      let to = row.to;
      let subject = rendered.subject;

      if (env.redirectTo !== '') {
        // Bezpiecznik deweloperski: prawdziwy odbiorca zostaje widoczny
        // w temacie i w nagłówku, żeby dało się sprawdzić, komu TO BY poszło.
        headers['X-Scoffie-Original-To'] = row.to;
        subject = `[→ ${row.to}] ${subject}`;
        to = env.redirectTo;
      }

      outgoing = {
        from: env.from,
        to,
        replyTo: env.replyTo || undefined,
        subject,
        html: rendered.html,
        text: rendered.text,
        headers,
        idempotencyKey: row.dedupeKey,
        templateId: row.template,
      };
    } catch (error) {
      // Zły `payload` nie naprawi się sam — nie ma sensu ponawiać.
      await this.markFailed(
        row,
        `renderowanie: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const result = await this.client.send(outgoing);

    if (result.ok) {
      this.counters.sent += 1;
      await this.prisma.mailMessage.update({
        where: { id: row.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
          subject: outgoing.subject,
          attempts: row.attempts + 1,
          lastError: null,
        },
      });
      return;
    }

    if (result.suppress) {
      await this.suppress(
        row.to,
        result.suppress.reason,
        result.suppress.detail,
      );
    }

    const attempts = row.attempts + 1;
    const env2 = readMailEnv();
    if (result.retryable && attempts < env2.maxAttempts) {
      this.counters.retried += 1;
      await this.prisma.mailMessage.update({
        where: { id: row.id },
        data: {
          status: 'QUEUED',
          attempts,
          nextAttemptAt: nextAttemptAt(attempts, new Date()),
          lastError: result.error.slice(0, 500),
        },
      });
      return;
    }

    await this.markFailed(row, result.error, attempts);
  }

  private async markFailed(
    row: MailMessage,
    error: string,
    attempts = row.attempts + 1,
  ): Promise<void> {
    this.counters.failed += 1;
    await this.prisma.mailMessage.update({
      where: { id: row.id },
      data: { status: 'FAILED', attempts, lastError: error.slice(0, 500) },
    });
    this.logger.warn(`mail ${row.template} nieudany: ${error}`);
    // Alert po SZABLONIE, nie po wiadomości: jeden zepsuty szablon albo jedna
    // zła konfiguracja odezwie się raz, a nie sto razy pod rząd.
    void this.alerts.notify(
      `mail-failed:${row.template}`,
      `Mail ${row.template} nie wyszedł po ${attempts} próbach: ${error}`,
    );
  }

  private async suppress(
    email: string,
    reason: string,
    detail?: string,
  ): Promise<void> {
    this.counters.suppressed += 1;
    if (isAppleRelay(email)) {
      this.counters.relayBounces += 1;
      // Osobny licznik, bo to JEDYNY objaw wypadnięcia domeny z rejestru
      // „Sign in with Apple for Email Communication" — bez rozróżnienia
      // wygląda to jak przypadkowy wzrost odrzutów.
      void this.alerts.notify(
        'mail-relay-bounce',
        'Odrzut z aliasu Apple Private Relay — sprawdź rejestrację domeny ' +
          'nadawczej w Apple Developer (Sign in with Apple for Email Communication).',
      );
    }
    await this.prisma.mailSuppression.upsert({
      where: { email: normalizeEmail(email) },
      create: {
        email: normalizeEmail(email),
        reason,
        detail: detail?.slice(0, 300) ?? null,
      },
      update: {},
    });
  }

  /**
   * Retencja. Wiersz przeżywa skasowanie konta, więc bez sprzątania trzymałby
   * adres i nazwę wyświetlaną osoby, której u nas już nie ma. Po 30 dniach
   * zostaje sam dowód nadania, po roku znika i on.
   *
   * AUDYT 12.09.2026 (P1.11). Szorowanie szło wyłącznie po `sentAt`, więc
   * wiersz, który NIGDY nie wyszedł — `FAILED` po wyczerpaniu prób, `SKIPPED`
   * z listy wykluczeń albo pominięty przy kasowaniu konta — trzymał adres
   * i `payload` (nazwa wyświetlana, nazwa domu) przez pełne dwanaście
   * miesięcy zamiast trzydziestu dni. Dokładnie odwrotnie, niż powinno być:
   * wiersz bez wysyłki nie jest nawet dowodem nadania.
   */
  private async maybeRunRetention(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRetentionAt < RETENTION_EVERY_MS) return;
    this.lastRetentionAt = now;

    const scrubBefore = new Date(now - SCRUB_AFTER_DAYS * 24 * 60 * 60_000);
    const scrubbed = await this.prisma.mailMessage.updateMany({
      where: {
        scrubbedAt: null,
        OR: [
          { sentAt: { lt: scrubBefore } },
          // Nigdy niewysłane liczymy od utworzenia — inaczej `sentAt: null`
          // nie pasuje do żadnego warunku i wiersz czeka do skasowania.
          { sentAt: null, createdAt: { lt: scrubBefore } },
        ],
      },
      data: {
        to: '',
        subject: null,
        payload: {},
        scrubbedAt: new Date(),
      },
    });

    const deleteBefore = new Date(now - DELETE_AFTER_DAYS * 24 * 60 * 60_000);
    const deleted = await this.prisma.mailMessage.deleteMany({
      where: { createdAt: { lt: deleteBefore } },
    });

    if (scrubbed.count > 0 || deleted.count > 0) {
      this.logger.log(
        `retencja poczty: wyczyszczono ${scrubbed.count}, usunięto ${deleted.count}`,
      );
    }
  }
}
