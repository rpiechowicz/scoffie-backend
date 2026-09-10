import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MailClient, MailSendResult, OutgoingMail } from './mail-client';
import { readMailEnv } from '../mail-env';

/**
 * Dostawca, który niczego nie wysyła — zapisuje maila na dysk i loguje ścieżkę.
 *
 * To jest DOMYŚLNY transport. Środowisko deweloperskie ma z definicji nie mieć
 * możliwości napisania do prawdziwego człowieka: pomyłki w kolejkowaniu wychodzą
 * w praniu (podwójny mail, zły odbiorca, pusta zmienna w treści), a maila nie
 * da się odwołać. Zapisany plik otwiera się w przeglądarce i pokazuje dokładnie
 * to, co poszłoby na świat.
 */
@Injectable()
export class StubMailClient implements MailClient {
  readonly name = 'stub';
  private readonly logger = new Logger(StubMailClient.name);

  /** Licznik zamiast znacznika czasu w nazwie — żeby dwa maile wysłane w tej
   *  samej milisekundzie nie nadpisały się nawzajem. */
  private sequence = 0;

  async send(mail: OutgoingMail): Promise<MailSendResult> {
    const dir = resolve(process.cwd(), readMailEnv().stubDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.sequence += 1;
    const base = `${stamp}-${this.sequence.toString().padStart(3, '0')}-${safe(
      mail.templateId ?? 'mail',
    )}-${safe(mail.to)}`;

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${base}.html`), mail.html, 'utf8');
      await writeFile(
        join(dir, `${base}.txt`),
        [
          `Do: ${mail.to}`,
          `Od: ${mail.from}`,
          `Odpowiedź do: ${mail.replyTo ?? '—'}`,
          `Temat: ${mail.subject}`,
          '',
          mail.text,
        ].join('\n'),
        'utf8',
      );
    } catch (error) {
      // Brak prawa zapisu nie ma prawa wywrócić kolejki — to atrapa.
      return {
        ok: false,
        retryable: false,
        error: `stub: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    this.logger.log(`[stub] ${mail.templateId ?? 'mail'} → ${base}.html`);
    return { ok: true, providerMessageId: `stub-${base}` };
  }
}

/** Nazwa pliku bez znaków, których nie zniesie Windows ani powłoka. */
function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 60);
}
