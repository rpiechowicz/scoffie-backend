import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mapWithConcurrency } from '../common/concurrency.util';
import { createPrivateKey } from 'crypto';
import { connect } from 'http2';
import { SignJWT } from 'jose';

/**
 * Jedno powiadomienie APNs.
 *
 * Pola poza `title`/`body`/`data` istnieją po to, żeby push dało się wyciszyć
 * i pogrupować — bez nich każdy alert ląduje osobno na ekranie blokady, z
 * dźwiękiem i pełnym priorytetem. Domyślne wartości odtwarzają zachowanie
 * sprzed tej zmiany, więc wywołania, które nic nie ustawiają, wyglądają tak
 * jak dotąd.
 */
export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * `apns-collapse-id`. Dwa pushe z tym samym identyfikatorem NIE stają obok
   * siebie — nowszy podmienia starszy. To jest cała mechanika „jedno
   * powiadomienie na gospodarstwo i tydzień" na ekranie blokady: kolejne
   * podsumowanie planu wchodzi na miejsce poprzedniego zamiast dokładać
   * kolejny wiersz. APNs przycina to pole do 64 bajtów.
   */
  collapseId?: string;
  /**
   * `aps.thread-id`. Grupowanie w Centrum powiadomień — pushe z tym samym
   * wątkiem system zwija w jeden stos zamiast rozsypywać po liście.
   */
  threadId?: string;
  /**
   * `aps.interruption-level`. `passive` = trafia do Centrum powiadomień, ale
   * nie zapala ekranu i nie przerywa. To jest domyślny tryb dla rzeczy
   * rutynowych (zmiany planu). `active` zostawiamy dla zdarzeń, na które ktoś
   * naprawdę czeka — jak dołączenie domownika.
   */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
  /**
   * `apns-priority`. 5 = APNs może dostarczyć zbiorczo i oszczędzać baterię,
   * 10 = natychmiast. Podsumowania jadą piątką.
   */
  priority?: 5 | 10;
  /**
   * Sekundy życia powiadomienia. Podsumowanie planu sprzed doby jest już
   * nieaktualne — lepiej, żeby APNs je porzuciło, niż dowiozło rano.
   */
  expirationSeconds?: number;
  /**
   * `null` (domyślnie) = cisza. Historycznie każdy push grał `default`, i to
   * była połowa odczucia „spamu"; dźwięk zostaje tylko tam, gdzie sami go
   * poprosimy.
   */
  sound?: string | null;
}

/**
 * Środowisko APNs, do którego należy token urządzenia.
 *
 * Token wydany buildowi z `aps-environment: development` działa WYŁĄCZNIE na
 * `api.sandbox.push.apple.com`, a produkcyjny wyłącznie na `api.push.apple.com`
 * — wysłanie pod zły host kończy się `BadDeviceToken`. Jeden globalny
 * `APNS_USE_SANDBOX` nie wystarcza, bo do tego samego serwera pisze i telefon
 * z Xcode (sandbox), i build z TestFlight (produkcja).
 */
export type ApnsEnvironment = 'SANDBOX' | 'PRODUCTION';

export function otherApnsEnvironment(
  environment: ApnsEnvironment,
): ApnsEnvironment {
  return environment === 'SANDBOX' ? 'PRODUCTION' : 'SANDBOX';
}

export function parseApnsEnvironment(
  value: unknown,
): ApnsEnvironment | undefined {
  // Tylko string, bez `String(value)`: wartość przychodzi z payloadu socketu,
  // więc może być czymkolwiek — a `String({})` daje „[object Object]", czyli
  // napis, który cicho przelatuje przez porównania niżej zamiast odpaść jako
  // nieznane środowisko. Obiekt i liczba i tak nie są nazwą środowiska APNs,
  // więc odcięcie ich tutaj niczego nie zabiera.
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === 'SANDBOX' || normalized === 'DEVELOPMENT') {
    return 'SANDBOX';
  }
  if (normalized === 'PRODUCTION') {
    return 'PRODUCTION';
  }
  return undefined;
}

export class ApnsSendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(message);
  }
}

@Injectable()
export class ApnsService implements OnModuleInit {
  private readonly logger = new Logger(ApnsService.name);

  private readonly enabled = process.env.APNS_ENABLED === 'true';
  private readonly keyId = process.env.APNS_KEY_ID ?? '';
  private readonly teamId = process.env.APNS_TEAM_ID ?? '';
  private readonly bundleId = process.env.APNS_BUNDLE_ID ?? '';
  private readonly privateKeyRaw = (process.env.APNS_PRIVATE_KEY ?? '').replace(
    /\\n/g,
    '\n',
  );
  private readonly useSandbox = process.env.APNS_USE_SANDBOX !== 'false';

  private cachedJwt: { token: string; expiresAtMs: number } | null = null;

  /** Środowisko dla urządzeń, które nie powiedziały, z jakiego buildu są. */
  get defaultEnvironment(): ApnsEnvironment {
    return this.useSandbox ? 'SANDBOX' : 'PRODUCTION';
  }

  private hostFor(environment?: ApnsEnvironment | null): string {
    return (environment ?? this.defaultEnvironment) === 'SANDBOX'
      ? 'api.sandbox.push.apple.com'
      : 'api.push.apple.com';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('APNs disabled (APNS_ENABLED=false).');
      return;
    }
    if (!this.isConfigured()) {
      this.logger.warn(
        'APNs enabled but configuration is incomplete. Check APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_PRIVATE_KEY.',
      );
      return;
    }
    this.logger.log(
      `APNs enabled (${this.useSandbox ? 'sandbox' : 'production'}).`,
    );
  }

  isConfigured(): boolean {
    return (
      this.enabled &&
      Boolean(this.keyId && this.teamId && this.bundleId && this.privateKeyRaw)
    );
  }

  private async getJwt(): Promise<string> {
    const now = Date.now();
    if (this.cachedJwt && this.cachedJwt.expiresAtMs > now + 30_000) {
      return this.cachedJwt.token;
    }

    const privateKey = createPrivateKey(this.privateKeyRaw);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .setIssuer(this.teamId)
      .setIssuedAt()
      .sign(privateKey);

    this.cachedJwt = {
      token,
      expiresAtMs: now + 50 * 60 * 1000,
    };
    return token;
  }

  async sendToDevice(
    deviceToken: string,
    payload: PushPayload,
    appBundleId?: string,
    environment?: ApnsEnvironment | null,
  ): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const topic = appBundleId?.trim() || this.bundleId;

    const jwt = await this.getJwt();
    const client = connect(`https://${this.hostFor(environment)}`);

    // Błąd na poziomie sesji HTTP/2 bez słuchacza wywraca proces Node —
    // a sesja do APNs potrafi paść na zwykłym mignięciu sieci.
    client.on('error', () => {});

    try {
      await new Promise<void>((resolve, reject) => {
        const headers: Record<string, string | number> = {
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${jwt}`,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-priority': payload.priority ?? 10,
          'content-type': 'application/json',
        };

        // APNs odrzuca collapse-id dłuższe niż 64 bajty całym żądaniem, a nasze
        // klucze zawierają uuid gospodarstwa i datę tygodnia — przycinamy więc
        // tutaj, a nie licząc znaki w każdym miejscu, które klucz składa.
        const collapseId = payload.collapseId?.slice(0, 64);
        if (collapseId) {
          headers['apns-collapse-id'] = collapseId;
        }
        if (payload.expirationSeconds != null) {
          headers['apns-expiration'] = Math.floor(
            Date.now() / 1000 + payload.expirationSeconds,
          );
        }

        const req = client.request(headers);

        let responseStatus = 0;
        let responseBody = '';

        req.setEncoding('utf8');

        req.on('response', (headers) => {
          responseStatus = Number(headers[':status'] ?? 0);
        });

        req.on('data', (chunk) => {
          responseBody += chunk;
        });

        req.on('end', () => {
          if (responseStatus >= 200 && responseStatus < 300) {
            resolve();
            return;
          }
          reject(
            new ApnsSendError(
              `APNs ${responseStatus}: ${responseBody || 'Unknown error'}`,
              responseStatus,
              responseBody,
            ),
          );
        });

        req.on('error', reject);

        req.end(
          JSON.stringify({
            aps: {
              alert: {
                title: payload.title,
                body: payload.body,
              },
              // Bez `sound` iOS pokazuje powiadomienie bezgłośnie. Dźwięk jest
              // teraz decyzją wywołującego, nie domyślną cechą każdego pusha.
              ...(payload.sound ? { sound: payload.sound } : {}),
              ...(payload.threadId ? { 'thread-id': payload.threadId } : {}),
              ...(payload.interruptionLevel
                ? { 'interruption-level': payload.interruptionLevel }
                : {}),
            },
            ...(payload.data ? { data: payload.data } : {}),
          }),
        );
      });
    } finally {
      client.close();
    }
  }

  async sendMany(deviceTokens: string[], payload: PushPayload): Promise<void> {
    if (!deviceTokens.length) return;
    await mapWithConcurrency(deviceTokens, 8, async (token) => {
      try {
        await this.sendToDevice(token, payload);
      } catch (error) {
        this.logger.warn(
          `Failed APNs send for token tail=${token.slice(-8)}: ${(error as Error).message}`,
        );
      }
    });
  }
}
