import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Weryfikacja podpisu webhooka Resendu (schemat Svix), bez biblioteki.
 *
 * DLACZEGO RĘCZNIE. Cały algorytm to trzy linijki HMAC-a; pakiet `svix`
 * dokładałby zależność i własny cykl wydawniczy po to, żeby policzyć
 * `HMAC-SHA256(sekret, "id.timestamp.body")`. Wektory testowe pilnują, że
 * liczymy dokładnie to samo, co dostawca.
 *
 * Kontrakt (dokumentacja Svix i Resend, sprawdzona 10.09.2026):
 *   svix-id         — identyfikator wiadomości
 *   svix-timestamp  — sekundy uniksowe
 *   svix-signature  — lista podpisów po spacji, każdy jako `v1,<base64>`
 *   sekret          — `whsec_<base64>`; do HMAC-a idą ZDEKODOWANE bajty
 *
 * CIAŁO MUSI BYĆ SUROWE. Podpis liczy się z bajtów, więc przeparsowany
 * i ponownie zserializowany JSON daje inny wynik — stąd `rawBody: true`
 * przy tworzeniu aplikacji i jawna odmowa, gdy surowego ciała brakuje.
 */

/** Ile minut wstecz i w przód akceptujemy — chroni przed powtórką żądania. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: Buffer | string | undefined;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds: number;
}): SignatureCheck {
  if (input.secret.trim() === '') {
    return { ok: false, reason: 'brak MAIL_WEBHOOK_SECRET' };
  }
  if (input.rawBody === undefined) {
    // Cicha akceptacja byłaby gorsza niż odmowa: bez surowego ciała nie da się
    // odróżnić prawdziwego zdarzenia od podrobionego.
    return { ok: false, reason: 'brak surowego ciała żądania' };
  }
  if (!input.id || !input.timestamp || !input.signature) {
    return { ok: false, reason: 'brak nagłówków svix-*' };
  }

  const sent = Number(input.timestamp);
  if (!Number.isFinite(sent)) {
    return { ok: false, reason: 'svix-timestamp nie jest liczbą' };
  }
  if (Math.abs(input.nowSeconds - sent) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'svix-timestamp poza oknem tolerancji' };
  }

  const secretPart = input.secret.startsWith('whsec_')
    ? input.secret.slice('whsec_'.length)
    : input.secret;
  let key: Buffer;
  try {
    key = Buffer.from(secretPart, 'base64');
  } catch {
    return { ok: false, reason: 'sekret nie jest poprawnym base64' };
  }
  if (key.length === 0) {
    return { ok: false, reason: 'sekret nie jest poprawnym base64' };
  }

  const body =
    typeof input.rawBody === 'string'
      ? Buffer.from(input.rawBody, 'utf8')
      : input.rawBody;
  const signed = Buffer.concat([
    Buffer.from(`${input.id}.${input.timestamp}.`, 'utf8'),
    body,
  ]);
  const expected = createHmac('sha256', key).update(signed).digest();

  // Nagłówek niesie WIELE podpisów (rotacja sekretu, wiele wersji schematu):
  // wystarczy, że pasuje którykolwiek z wersją `v1`.
  const candidates = input.signature
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice('v1,'.length));

  if (candidates.length === 0) {
    return { ok: false, reason: 'brak podpisu w wersji v1' };
  }

  for (const candidate of candidates) {
    let actual: Buffer;
    try {
      actual = Buffer.from(candidate, 'base64');
    } catch {
      continue;
    }
    // Porównanie w stałym czasie i tylko przy równych długościach —
    // `timingSafeEqual` rzuca, gdy bufory się różnią rozmiarem.
    if (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    ) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'podpis się nie zgadza' };
}

/** Zdarzenia, na które reagujemy. Reszta jest przyjmowana i ignorowana. */
export type WebhookOutcome =
  | { kind: 'suppress'; email: string; reason: string; detail?: string }
  | { kind: 'failed'; providerMessageId: string | null; detail?: string }
  | { kind: 'ignore' };

/**
 * Ładunek dostawcy → decyzja. Czytamy defensywnie: kształt zdarzeń nie jest
 * częścią naszego kontraktu i może się zmienić bez uprzedzenia, a wywrócony
 * webhook oznacza ponowienia po stronie dostawcy i w końcu jego wyłączenie.
 */
export function interpretWebhook(payload: unknown): WebhookOutcome {
  if (typeof payload !== 'object' || payload === null)
    return { kind: 'ignore' };
  const event = payload as { type?: unknown; data?: unknown };
  const type = typeof event.type === 'string' ? event.type : '';
  const data = (
    typeof event.data === 'object' && event.data !== null ? event.data : {}
  ) as Record<string, unknown>;

  const to = firstEmail(data.to);
  const messageId = typeof data.email_id === 'string' ? data.email_id : null;

  switch (type) {
    case 'email.bounced':
      // Dokumentacja mówi wprost: „permanently rejected" — czyli twardy odrzut.
      // Miękkie opóźnienia przychodzą jako `email.delivery_delayed`.
      return to
        ? {
            kind: 'suppress',
            email: to,
            reason: 'HARD_BOUNCE',
            detail: detailOf(data),
          }
        : { kind: 'ignore' };
    case 'email.complained':
      return to
        ? {
            kind: 'suppress',
            email: to,
            reason: 'COMPLAINT',
            detail: detailOf(data),
          }
        : { kind: 'ignore' };
    case 'email.failed':
      return {
        kind: 'failed',
        providerMessageId: messageId,
        detail: detailOf(data),
      };
    default:
      return { kind: 'ignore' };
  }
}

function firstEmail(value: unknown): string | null {
  if (typeof value === 'string' && value.includes('@')) return value;
  if (Array.isArray(value)) {
    // `Array.isArray` na `unknown` daje `any[]` — jawny typ elementu, żeby
    // nic z ładunku dostawcy nie przeciekło do kodu jako `any`.
    const found = (value as unknown[]).find(
      (v) => typeof v === 'string' && v.includes('@'),
    );
    return typeof found === 'string' ? found : null;
  }
  return null;
}

function detailOf(data: Record<string, unknown>): string | undefined {
  const candidates = [
    data.reason,
    data.message,
    data.bounce_type,
    data.subtype,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.slice(0, 200);
    }
  }
  return undefined;
}
