import { createHmac } from 'node:crypto';
import {
  WEBHOOK_TOLERANCE_SECONDS,
  interpretWebhook,
  verifyWebhookSignature,
} from './mail-webhook-signature';

/**
 * Podpis liczy się z BAJTÓW ciała. Test pilnuje trzech rzeczy, które łatwo
 * zepsuć przy refaktorze i których nie widać, dopóki dostawca nie zacznie
 * odbijać wszystkiego: kolejności `id.timestamp.body`, kodowania sekretu
 * (base64 PO prefiksie `whsec_`) i okna czasowego.
 */
const SECRET_BYTES = Buffer.from('scoffie-testowy-sekret-webhooka!!');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const ID = 'msg_2abc';
const TS = 1_800_000_000;
const BODY = JSON.stringify({ type: 'email.bounced', data: { to: 'a@b.pl' } });

/** Podpis policzony NIEZALEŻNIE od implementacji — wprost ze specyfikacji. */
function sign(body: string, id = ID, ts = TS): string {
  const signed = `${id}.${ts}.${body}`;
  return createHmac('sha256', SECRET_BYTES).update(signed).digest('base64');
}

const base = {
  secret: SECRET,
  rawBody: Buffer.from(BODY, 'utf8'),
  id: ID,
  timestamp: String(TS),
  nowSeconds: TS,
};

describe('verifyWebhookSignature', () => {
  it('przyjmuje poprawny podpis', () => {
    expect(
      verifyWebhookSignature({ ...base, signature: `v1,${sign(BODY)}` }),
    ).toEqual({ ok: true });
  });

  it('bierze podpis pasujący z listy, nie tylko pierwszy', () => {
    const signature = `v1,${'A'.repeat(44)} v1,${sign(BODY)}`;
    expect(verifyWebhookSignature({ ...base, signature })).toEqual({
      ok: true,
    });
  });

  it('ignoruje wersje inne niż v1', () => {
    const result = verifyWebhookSignature({
      ...base,
      signature: `v2,${sign(BODY)}`,
    });
    expect(result).toEqual({ ok: false, reason: 'brak podpisu w wersji v1' });
  });

  it('odrzuca zmienione ciało — nawet o jeden znak', () => {
    const signature = `v1,${sign(BODY)}`;
    const result = verifyWebhookSignature({
      ...base,
      rawBody: Buffer.from(BODY.replace('a@b.pl', 'c@d.pl'), 'utf8'),
      signature,
    });
    expect(result).toEqual({ ok: false, reason: 'podpis się nie zgadza' });
  });

  it('odrzuca podpis policzony dla innego identyfikatora wiadomości', () => {
    const result = verifyWebhookSignature({
      ...base,
      signature: `v1,${sign(BODY, 'msg_inne')}`,
    });
    expect(result.ok).toBe(false);
  });

  it('odrzuca żądanie spoza okna tolerancji', () => {
    const result = verifyWebhookSignature({
      ...base,
      signature: `v1,${sign(BODY)}`,
      nowSeconds: TS + WEBHOOK_TOLERANCE_SECONDS + 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'svix-timestamp poza oknem tolerancji',
    });
  });

  it('przyjmuje żądanie z drugiego końca okna tolerancji', () => {
    const result = verifyWebhookSignature({
      ...base,
      signature: `v1,${sign(BODY)}`,
      nowSeconds: TS - WEBHOOK_TOLERANCE_SECONDS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('bez surowego ciała ODMAWIA, zamiast przepuścić', () => {
    // Cicha akceptacja byłaby gorsza niż odmowa: bez bajtów nie da się
    // odróżnić prawdziwego zdarzenia od podrobionego.
    const result = verifyWebhookSignature({
      ...base,
      rawBody: undefined,
      signature: `v1,${sign(BODY)}`,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'brak surowego ciała żądania',
    });
  });

  it('bez sekretu odmawia', () => {
    const result = verifyWebhookSignature({
      ...base,
      secret: '   ',
      signature: `v1,${sign(BODY)}`,
    });
    expect(result).toEqual({ ok: false, reason: 'brak MAIL_WEBHOOK_SECRET' });
  });

  it('działa z sekretem podanym bez prefiksu whsec_', () => {
    const result = verifyWebhookSignature({
      ...base,
      secret: SECRET_BYTES.toString('base64'),
      signature: `v1,${sign(BODY)}`,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('interpretWebhook', () => {
  it('twardy odrzut wyklucza adres', () => {
    expect(
      interpretWebhook({
        type: 'email.bounced',
        data: { to: ['kto@example.com'], reason: 'mailbox does not exist' },
      }),
    ).toEqual({
      kind: 'suppress',
      email: 'kto@example.com',
      reason: 'HARD_BOUNCE',
      detail: 'mailbox does not exist',
    });
  });

  it('skarga na spam wyklucza adres', () => {
    expect(
      interpretWebhook({
        type: 'email.complained',
        data: { to: 'kto@example.com' },
      }),
    ).toMatchObject({ kind: 'suppress', reason: 'COMPLAINT' });
  });

  it('opóźnienie dostarczenia NIE wyklucza — to odrzut miękki', () => {
    expect(
      interpretWebhook({
        type: 'email.delivery_delayed',
        data: { to: 'kto@example.com' },
      }),
    ).toEqual({ kind: 'ignore' });
  });

  it('nieznane zdarzenie jest ignorowane, a nie wywraca webhooka', () => {
    expect(interpretWebhook({ type: 'contact.created' })).toEqual({
      kind: 'ignore',
    });
    expect(interpretWebhook(null)).toEqual({ kind: 'ignore' });
    expect(interpretWebhook('nie json')).toEqual({ kind: 'ignore' });
  });

  it('odrzut bez adresu nie tworzy pustego wykluczenia', () => {
    expect(interpretWebhook({ type: 'email.bounced', data: {} })).toEqual({
      kind: 'ignore',
    });
  });
});
