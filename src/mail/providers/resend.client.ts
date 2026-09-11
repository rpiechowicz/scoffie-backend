import { Injectable, Logger } from '@nestjs/common';
import { MailClient, MailSendResult, OutgoingMail } from './mail-client';
import { readMailEnv } from '../mail-env';

const ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Resend przez zwykłe `fetch`, bez SDK — dokładnie jak `OpsAlertService`.
 *
 * DLACZEGO BEZ BIBLIOTEKI. Całe API to jeden POST z JSON-em; pakiet dołożyłby
 * zależność, własny cykl wydawniczy i własne zdanie na temat ponowień, których
 * i tak nie chcemy (ponawia skrzynka nadawcza, bo tylko ona wie, czy wiadomość
 * jest jeszcze aktualna). Wstrzykiwany `fetch` daje testy bez sieci i bez klucza.
 *
 * Kontrakt (dokumentacja z 10.09.2026):
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer re_…
 *   Idempotency-Key: <do 256 znaków, ważny 24 h>
 *   { from, to, subject, html, text, reply_to, headers, tags }
 *   200 → { id }
 */
@Injectable()
export class ResendMailClient implements MailClient {
  readonly name = 'resend';
  private readonly logger = new Logger(ResendMailClient.name);

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly endpoint: string = ENDPOINT,
  ) {}

  async send(mail: OutgoingMail): Promise<MailSendResult> {
    const apiKey = readMailEnv().apiKey;
    if (apiKey === '') {
      // Nie do ponowienia: bez klucza kolejne próby wyglądają tak samo.
      return { ok: false, retryable: false, error: 'brak RESEND_API_KEY' };
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
    if (mail.idempotencyKey) {
      headers['idempotency-key'] = mail.idempotencyKey.slice(0, 256);
    }

    const body: Record<string, unknown> = {
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    };
    if (mail.replyTo) body.reply_to = mail.replyTo;
    if (mail.headers && Object.keys(mail.headers).length > 0) {
      body.headers = mail.headers;
    }
    if (mail.templateId) {
      // Etykieta u dostawcy: pozwala zobaczyć w panelu, który szablon odbija
      // się najczęściej. Wartość musi być z wąskiego alfabetu — nasze
      // identyfikatory (WELCOME, ACCOUNT_DELETED) są bezpieczne.
      body.tags = [{ name: 'template', value: mail.templateId }];
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Zerwane połączenie albo timeout. Ponawiamy — ale UWAGA: wiadomość
      // mogła już wyjść. Przed drugą próbą chroni `Idempotency-Key`.
      return {
        ok: false,
        retryable: true,
        error: `sieć: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (response.ok) {
      const id = await this.readMessageId(response);
      return { ok: true, providerMessageId: id };
    }

    const detail = await this.readErrorText(response);
    return this.mapFailure(response.status, detail);
  }

  private async readMessageId(response: Response): Promise<string | null> {
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object' && 'id' in parsed) {
        const id = (parsed as { id?: unknown }).id;
        return typeof id === 'string' ? id : null;
      }
    } catch {
      // Sukces bez ciała jest nadal sukcesem — identyfikator jest wygodą,
      // nie warunkiem. Bez niego stracimy tylko powiązanie z webhookiem.
    }
    return null;
  }

  private async readErrorText(response: Response): Promise<string> {
    try {
      const raw = await response.text();
      // Ucinamy: w `lastError` ma się zmieścić powód, a nie cała odpowiedź.
      return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch {
      return '';
    }
  }

  /**
   * Które odmowy ma sens ponawiać.
   *
   * Kluczowa jest 422: dostawca mówi wtedy, że wiadomości NIE DA SIĘ wysłać
   * w tej postaci (najczęściej adres nie istnieje albo domena nadawcza nie
   * jest zweryfikowana). Ponawianie takiej odmowy pięć razy to pięć wpisów
   * w statystykach dostawcy i zero szans na doręczenie.
   */
  private mapFailure(status: number, detail: string): MailSendResult {
    const error = `HTTP ${status}${detail ? `: ${detail}` : ''}`;

    if (status === 401 || status === 403) {
      this.logger.error(
        `Resend odrzucił klucz (${status}) — poczta stoi do czasu poprawienia RESEND_API_KEY.`,
      );
      return { ok: false, retryable: false, error };
    }
    if (status === 422 || status === 400) {
      const invalidAddress =
        /invalid.*(recipient|to|email)|not.*valid.*email/i.test(detail);
      return {
        ok: false,
        retryable: false,
        error,
        suppress: invalidAddress
          ? { reason: 'INVALID_ADDRESS', detail: detail.slice(0, 200) }
          : undefined,
      };
    }
    if (status === 429 || status >= 500) {
      return { ok: false, retryable: true, error };
    }
    // Nieznany kod: ponawiamy raz czy dwa zamiast od razu spisywać na straty —
    // fałszywe FAILED jest droższe niż jedno żądanie więcej.
    return { ok: false, retryable: true, error };
  }
}
