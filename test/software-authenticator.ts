import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'crypto';

/**
 * Programowy uwierzytelniacz WebAuthn do e2e panelu.
 *
 * Robi to, co Face ID / Touch ID w przeglądarce: klucz P-256 (ES256),
 * atestacja `none`, podpis `authenticatorData ‖ sha256(clientDataJSON)`.
 * Backend weryfikuje to PRAWDZIWYM `@simplewebauthn/server` — test nie omija
 * ani jednego sprawdzenia (wyzwanie, pochodzenie, RP ID, UV, podpis, licznik).
 */

// ——— minimalny koder CBOR (RFC 8949): tylko typy potrzebne WebAuthn ———

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  }
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const b64url = (data: Buffer | Uint8Array): string =>
  Buffer.from(data).toString('base64url');

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor(
    readonly rpId: string,
    readonly origin: string,
    /** false = uwierzytelniacz bez weryfikacji użytkownika (dotyk bez biometrii). */
    private readonly userVerified = true,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private rpIdHash(): Buffer {
    return createHash('sha256').update(this.rpId).digest();
  }

  private clientData(
    type: 'webauthn.create' | 'webauthn.get',
    challenge: string,
  ) {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
  }

  /** Odpowiedź na `navigator.credentials.create()` dla opcji z backendu. */
  register(options: { challenge: string }) {
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(this.publicJwk.x, 'base64url')],
        [-3, Buffer.from(this.publicJwk.y, 'base64url')],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const flags = FLAG_UP | FLAG_AT | (this.userVerified ? FLAG_UV : 0);
    const authData = Buffer.concat([
      this.rpIdHash(),
      Buffer.from([flags]),
      counter,
      Buffer.alloc(16), // AAGUID: zera (atestacja `none`)
      idLength,
      this.credentialId,
      cose,
    ]);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(
          this.clientData('webauthn.create', options.challenge),
        ),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /** Odpowiedź na `navigator.credentials.get()` — podpis nad wyzwaniem. */
  authenticate(
    options: { challenge: string },
    overrides: { tamper?: boolean } = {},
  ) {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const flags = FLAG_UP | (this.userVerified ? FLAG_UV : 0);
    const authenticatorData = Buffer.concat([
      this.rpIdHash(),
      Buffer.from([flags]),
      counter,
    ]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const signed = Buffer.concat([
      authenticatorData,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
    const signature = sign('sha256', signed, this.privateKey);
    if (overrides.tamper) signature[signature.length - 1] ^= 0xff;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }
}
