/**
 * Wspólny kontrakt dostawcy wysyłki. Rdzeń poczty nie wie, czy pod spodem
 * jest Resend, czy zapis na dysk — dzięki temu cała ścieżka (kolejka,
 * ponowienia, wykluczenia, renderowanie) testuje się bez sieci i bez klucza.
 */

export type OutgoingMail = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Dodatkowe nagłówki — np. ślad prawdziwego odbiorcy przy przekierowaniu. */
  headers?: Record<string, string>;
  /**
   * Klucz idempotencji dostawcy. Ten sam klucz w ciągu doby nie wyśle drugiej
   * wiadomości — to druga linia obrony po `MailMessage.dedupeKey`, na wypadek
   * gdyby odpowiedź dostawcy zgubiła się PO wysłaniu (my widzimy błąd sieci,
   * u odbiorcy mail już leży).
   */
  idempotencyKey?: string;
  /** Identyfikator szablonu — u dostawcy jako etykieta, do statystyk. */
  templateId?: string;
};

export type MailSendResult =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      /** `true` = spróbuj później; `false` = nie ma po co, oznacz jako FAILED. */
      retryable: boolean;
      /** Krótki opis do `MailMessage.lastError` — bez treści wiadomości. */
      error: string;
      /** Gdy dostawca wprost mówi, że adres jest martwy. */
      suppress?: { reason: string; detail?: string };
    };

export interface MailClient {
  readonly name: string;
  send(mail: OutgoingMail): Promise<MailSendResult>;
}

/** Token wstrzykiwania — pozwala testowi podmienić dostawcę na atrapę. */
export const MAIL_CLIENT = Symbol('MAIL_CLIENT');
