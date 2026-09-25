import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
// `import type`: typ użyty w sygnaturze z dekoratorem, a `emitDecoratorMetadata`
// próbowałby go wciągnąć jako wartość (TS1272).
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { OpsAlertService } from '../observability/ops-alert.service';
import { readMailEnv } from './mail-env';
import { isAppleRelay, normalizeEmail } from './mail-eligibility';
import {
  interpretWebhook,
  verifyWebhookSignature,
} from './mail-webhook-signature';

/**
 * Odrzuty i skargi od dostawcy.
 *
 * PO CO TO W OGÓLE JEST. Wysyłanie na adres, który raz twardo odbił, psuje
 * reputację domeny WSZYSTKIM pozostałym wiadomościom — łącznie z tymi, na
 * które ktoś czeka. Lista wykluczeń to jedyny sposób, żeby jeden martwy adres
 * nie kosztował dostarczalności całej reszty.
 *
 * `@SkipThrottle`, bo to nie jest ruch użytkownika: przy serii odrzutów
 * dostawca wysyła zdarzenia pakietami i limit z gardy odbijałby je jako 429,
 * a dostawca po kilku takich odpowiedziach wyłącza webhook. Bramką jest
 * podpis, nie licznik żądań.
 */
// Trasa operatorska/serwerowa, nie API aplikacji — poza openapi.json.
@ApiExcludeController()
@Controller('mail/webhooks')
export class MailWebhookController {
  private readonly logger = new Logger(MailWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: OpsAlertService,
  ) {}

  @Post('resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @SkipThrottle({ default: true, ip: true })
  async resend(@Req() req: RawBodyRequest<Request>): Promise<void> {
    const env = readMailEnv();
    const check = verifyWebhookSignature({
      secret: env.webhookSecret,
      rawBody: req.rawBody,
      id: header(req, 'svix-id'),
      timestamp: header(req, 'svix-timestamp'),
      signature: header(req, 'svix-signature'),
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    if (!check.ok) {
      // 204 mimo odmowy: dostawca ma przestać ponawiać, a my nie mamy powodu
      // opowiadać nadawcy, CZEGO zabrakło. Powód idzie do logu i do alertu.
      //
      // Z KONTEKSTEM ŻĄDANIA, bo bez niego nie da się odróżnić dwóch zupełnie
      // różnych sytuacji: „Svix wysłał JSON, a sekret się nie zgadza" od
      // „ktoś POST-nął pod ten adres bez ciała" (skaner, ręczne sprawdzenie
      // z curl-a). 11.09.2026 alert bez tych danych kosztował pół dnia
      // szukania błędu, którego w kodzie nie było.
      const kontekst =
        `${req.method} ${req.originalUrl ?? req.url}; content-type=` +
        `${header(req, 'content-type') ?? '-'}; content-length=` +
        `${header(req, 'content-length') ?? '-'}; json=${
          req.body !== undefined && typeof req.body === 'object' ? 'tak' : 'nie'
        }; svix-id=${header(req, 'svix-id') ? 'jest' : 'brak'}`;
      this.logger.warn(
        `webhook poczty odrzucony: ${check.reason} [${kontekst}]`,
      );
      // Klucz per powód: zły sekret i pusty POST ze skanera to dwa różne
      // alerty, a jeden wspólny klucz wyciszałby drugi na sześć godzin.
      void this.alerts.notify(
        `mail-webhook-rejected:${check.reason}`,
        `Webhook poczty odrzucony: ${check.reason} [${kontekst}]` +
          (check.reason === 'podpis się nie zgadza'
            ? ' — sprawdź MAIL_WEBHOOK_SECRET.'
            : ''),
      );
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        typeof req.rawBody === 'string'
          ? req.rawBody
          : (req.rawBody as Buffer).toString('utf8'),
      );
    } catch {
      this.logger.warn('webhook poczty: ciało nie jest JSON-em');
      return;
    }

    const outcome = interpretWebhook(payload);
    if (outcome.kind === 'ignore') return;

    if (outcome.kind === 'suppress') {
      const email = normalizeEmail(outcome.email);
      await this.prisma.mailSuppression.upsert({
        where: { email },
        create: {
          email,
          reason: outcome.reason,
          detail: outcome.detail ?? null,
        },
        update: {},
      });
      this.logger.log(`wykluczony adres (${outcome.reason})`);

      if (isAppleRelay(email)) {
        // Aliasy Apple odbijają się WSZYSTKIE naraz, gdy domena nadawcza
        // wypadnie z rejestru „Sign in with Apple for Email Communication".
        // Bez tego rozróżnienia wygląda to jak przypadkowy wzrost odrzutów.
        void this.alerts.notify(
          'mail-relay-bounce',
          'Odrzut z aliasu Apple Private Relay — sprawdź rejestrację domeny ' +
            'nadawczej w Apple Developer.',
        );
      }
      return;
    }

    if (outcome.providerMessageId) {
      await this.prisma.mailMessage.updateMany({
        where: { providerMessageId: outcome.providerMessageId },
        data: {
          status: 'FAILED',
          lastError: `dostawca: ${outcome.detail ?? 'email.failed'}`.slice(
            0,
            500,
          ),
        },
      });
    }
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
