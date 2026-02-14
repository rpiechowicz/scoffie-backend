import { Injectable, Logger } from '@nestjs/common';
import { createPrivateKey } from 'crypto';
import { connect } from 'http2';
import { SignJWT } from 'jose';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
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
export class ApnsService {
  private readonly logger = new Logger(ApnsService.name);

  private readonly enabled = process.env.APNS_ENABLED === 'true';
  private readonly keyId = process.env.APNS_KEY_ID ?? '';
  private readonly teamId = process.env.APNS_TEAM_ID ?? '';
  private readonly bundleId = process.env.APNS_BUNDLE_ID ?? '';
  private readonly privateKeyRaw = (process.env.APNS_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
  private readonly useSandbox = process.env.APNS_USE_SANDBOX !== 'false';

  private cachedJwt: { token: string; expiresAtMs: number } | null = null;

  private get host(): string {
    return this.useSandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  }

  isConfigured(): boolean {
    return this.enabled && Boolean(this.keyId && this.teamId && this.bundleId && this.privateKeyRaw);
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

  async sendToDevice(deviceToken: string, payload: PushPayload): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const jwt = await this.getJwt();
    const client = connect(`https://${this.host}`);

    try {
      await new Promise<void>((resolve, reject) => {
        const req = client.request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${jwt}`,
          'apns-topic': this.bundleId,
          'apns-push-type': 'alert',
          'content-type': 'application/json',
        });

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
              sound: 'default',
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
    await Promise.all(
      deviceTokens.map(async (token) => {
        try {
          await this.sendToDevice(token, payload);
        } catch (error) {
          this.logger.warn(`Failed APNs send for token tail=${token.slice(-8)}: ${(error as Error).message}`);
        }
      }),
    );
  }
}
