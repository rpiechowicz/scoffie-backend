/**
 * Wysyłka próbna: wszystkie stany maili na JEDEN, podany wprost adres.
 *
 * `pnpm mail:test <adres> [klucz-stanu]`
 *
 * ZASADY BEZPIECZEŃSTWA (wszystkie trzy są celowe):
 *  1. Adres podaje się W POLECENIU. Skrypt nigdy nie czyta odbiorców z bazy —
 *     nie ma jak przypadkiem wysłać czegokolwiek prawdziwym użytkownikom.
 *  2. Nie dotyka skrzynki nadawczej ani bazy. To sprawdzian RENDEROWANIA
 *     i DOSTARCZALNOŚCI, nie kolejki; kolejkę sprawdzają testy.
 *  3. Idzie tym samym klientem, co produkcja (`ResendMailClient`), więc
 *     sprawdza także klucz, domenę nadawczą i podpis DKIM.
 */
import { MailRenderer } from '../src/mail/mail-renderer';
import {
  MAIL_FIXTURES,
  fixtureByKey,
} from '../src/mail/templates/mail-fixtures';
import { ctx } from '../src/mail/templates/mail-kit';
import { readMailEnv } from '../src/mail/mail-env';
import { ResendMailClient } from '../src/mail/providers/resend.client';
import { StubMailClient } from '../src/mail/providers/stub.client';
import { looksLikeEmail } from '../src/mail/mail-eligibility';

/** Odstęp między wiadomościami — dostawcy mają limit żądań na sekundę. */
const ODSTEP_MS = 700;

async function main(): Promise<void> {
  const [adres, klucz] = process.argv.slice(2);

  if (!adres || !looksLikeEmail(adres)) {
    console.error('Użycie: pnpm mail:test <adres> [klucz-stanu]');
    console.error(`Stany: ${MAIL_FIXTURES.map((f) => f.key).join(', ')}`);
    process.exit(1);
  }

  const env = readMailEnv();
  const wybrane = klucz
    ? [fixtureByKey(klucz)].filter((f) => f !== undefined)
    : MAIL_FIXTURES;

  if (wybrane.length === 0) {
    console.error(`Nie znam stanu „${klucz}".`);
    process.exit(1);
  }

  const client =
    env.transport === 'resend' ? new ResendMailClient() : new StubMailClient();

  console.log(`Transport: ${client.name}`);
  console.log(`Nadawca:   ${env.from}`);
  console.log(`Odbiorca:  ${adres}`);
  console.log(`Wiadomości: ${wybrane.length}`);
  if (client.name === 'stub') {
    console.log(
      'UWAGA: MAIL_TRANSPORT nie jest ustawione na „resend" — maile trafią na dysk, nie na świat.',
    );
  }
  console.log('');

  const renderer = new MailRenderer();
  const c = ctx({ assetBase: env.assetBaseUrl, site: env.siteUrl });
  let wyslane = 0;
  let bledy = 0;

  for (const fixture of wybrane) {
    const mail = renderer.renderWith(
      c,
      fixture.template,
      fixture.payload as unknown as Record<string, unknown>,
    );

    const wynik = await client.send({
      from: env.from,
      to: adres,
      replyTo: env.replyTo || undefined,
      // Prefiks, żeby w skrzynce od razu było widać, że to próba, i który stan.
      subject: `[próba: ${fixture.key}] ${mail.subject}`,
      html: mail.html,
      text: mail.text,
      headers: {
        'X-Scoffie-Template': fixture.template,
        'X-Scoffie-Fixture': fixture.key,
      },
      templateId: fixture.template,
    });

    if (wynik.ok) {
      wyslane += 1;
      console.log(`  ✓ ${fixture.key.padEnd(18)} ${fixture.label}`);
    } else {
      bledy += 1;
      console.log(
        `  ✗ ${fixture.key.padEnd(18)} ${wynik.error}${wynik.retryable ? ' (do ponowienia)' : ''}`,
      );
    }

    if (fixture !== wybrane[wybrane.length - 1]) {
      await new Promise((resolve) => setTimeout(resolve, ODSTEP_MS));
    }
  }

  console.log('');
  console.log(`Wysłane: ${wyslane}, nieudane: ${bledy}`);
  if (bledy > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error('[mail:test]', error);
  process.exit(1);
});
