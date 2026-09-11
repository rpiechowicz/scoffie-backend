/**
 * Renderuje wszystkie szablony maili do plików HTML i tekstowych.
 *
 * `pnpm mail:preview [katalog]` (domyślnie `var/mail-preview`)
 *
 * PO CO OSOBNY SKRYPT, SKORO JEST PODGLĄD W APLIKACJI. Bo nie ma — i celowo.
 * Endpoint pod tokenem operatora nie otwiera się w przeglądarce (nagłówka
 * `x-ops-token` nie da się dopisać do adresu), a podgląd bez tokenu byłby
 * publiczną stroną z treścią naszych wiadomości. Pliki na dysku otwiera się
 * dwuklikiem i nie wystawiają niczego na świat.
 *
 * Skrypt NIE dotyka bazy i NIE wysyła niczego — renderuje z danych
 * przykładowych (`mail-fixtures.ts`), tych samych, które sprawdzają testy.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MailRenderer } from '../src/mail/mail-renderer';
import { MAIL_FIXTURES } from '../src/mail/templates/mail-fixtures';
import { ctx, esc } from '../src/mail/templates/mail-kit';
import { readMailEnv } from '../src/mail/mail-env';

async function main(): Promise<void> {
  const outDir = resolve(process.cwd(), process.argv[2] ?? 'var/mail-preview');
  await mkdir(outDir, { recursive: true });

  const env = readMailEnv();
  const renderer = new MailRenderer();
  const rows: string[] = [];

  for (const fixture of MAIL_FIXTURES) {
    for (const width of [600, 320]) {
      const c = ctx({
        w: width,
        assetBase: env.assetBaseUrl,
        site: env.siteUrl,
      });
      const mail = renderer.renderWith(
        c,
        fixture.template,
        fixture.payload as unknown as Record<string, unknown>,
      );
      const name = `${fixture.key}-${width}`;
      await writeFile(join(outDir, `${name}.html`), mail.html, 'utf8');

      if (width === 600) {
        await writeFile(
          join(outDir, `${fixture.key}.txt`),
          [
            `Temat (${[...mail.subject].length} znaków): ${mail.subject}`,
            `Preheader (${[...mail.preheader].length} znaków): ${mail.preheader}`,
            '',
            mail.text,
          ].join('\n'),
          'utf8',
        );
        rows.push(
          `<tr><td><b>${esc(fixture.label)}</b><br><span class="t">${esc(fixture.template)}</span></td>` +
            `<td>${esc(mail.subject)}<br><span class="t">${[...mail.subject].length}/45 znaków</span></td>` +
            `<td><a href="${fixture.key}-600.html">600&nbsp;px</a> · <a href="${fixture.key}-320.html">320&nbsp;px</a> · <a href="${fixture.key}.txt">tekst</a></td></tr>`,
        );
      }
    }
  }

  const index = `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">
<title>Scoffie — podgląd maili</title>
<style>
body{margin:0;padding:32px;background:#F4EDE1;color:#2A211C;font:16px/1.5 system-ui,Segoe UI,sans-serif}
h1{font:500 30px/1.2 Georgia,serif;margin:0 0 6px}
p.lead{color:#6B5B4E;margin:0 0 24px}
table{border-collapse:collapse;background:#FBF7F0;border:1px solid #E8DDCD;border-radius:12px;overflow:hidden;width:100%;max-width:980px}
td{border-top:1px solid #E8DDCD;padding:12px 16px;vertical-align:top}
tr:first-child td{border-top:0}
a{color:#A94F30}
.t{color:#7F6B5B;font-size:13px}
</style></head><body>
<h1>Podgląd maili Scoffie</h1>
<p class="lead">${MAIL_FIXTURES.length} stanów, każdy w 600 i 320 px. Obrazki lecą z <code>${esc(env.assetBaseUrl)}</code>, linki na <code>${esc(env.siteUrl)}</code>.<br>
Tryb ciemny sprawdzisz, przełączając motyw systemu — strona nie wymusza żadnego.</p>
<table>${rows.join('\n')}</table>
</body></html>`;

  await writeFile(join(outDir, 'index.html'), index, 'utf8');
  console.log(`Gotowe: ${join(outDir, 'index.html')}`);
  console.log(
    `${MAIL_FIXTURES.length} stanów × 2 szerokości + wersje tekstowe.`,
  );
}

main().catch((error: unknown) => {
  console.error('[mail:preview]', error);
  process.exit(1);
});
