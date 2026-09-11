import {
  MailCtx,
  b,
  btn,
  doc,
  esc,
  foot,
  h1,
  head,
  kv,
  list,
  p,
  textLink,
} from './mail-kit';
import { clipSubject, formatDay } from './mail-format';
import { LegalUpdatePayload, RenderedMail } from '../mail-template';

/**
 * G — zmiana regulaminu lub polityki prywatności. Najsurowszy z zestawu.
 *
 * Punkty „co się zmienia" są PARAMETREM, nie treścią w kodzie. Zdanie
 * o akceptacji ma wariant: przy zmianie istotnej (podniesione minimum wersji)
 * aplikacja poprosi o zgodę jeszcze raz i „dalsze korzystanie oznacza
 * akceptację" byłoby nieprawdą.
 */
export function renderLegalUpdate(
  c: MailCtx,
  d: LegalUpdatePayload,
): RenderedMail {
  const from = formatDay(d.effectiveDateIso);
  const subject = clipSubject(
    from ? `Zmieniamy regulamin od ${from}` : 'Zmieniamy regulamin i politykę',
  );
  const preheader = from
    ? `Wchodzi w życie ${from}. Streszczenie zmian i pełne dokumenty.`
    : 'Streszczenie zmian i pełne dokumenty.';

  const rows: [string, string][] = [];
  if (from) rows.push(['Wchodzi w życie', esc(from)]);
  rows.push(['Dotyczy', 'Regulaminu i Polityki prywatności']);
  rows.push(['Wersja dokumentów', esc(d.version)]);

  const acceptance = d.requiresConsent
    ? 'Ta zmiana jest istotna, więc poprosimy Cię w aplikacji o potwierdzenie nowej wersji. Do tego czasu obowiązuje wersja, którą już zaakceptowałeś. Jeśli się nie zgadzasz, konto usuniesz w Ustawieniach.'
    : `Dalsze korzystanie ze Scoffie${from ? ` po ${esc(from)}` : ''} oznacza akceptację nowej wersji. Jeśli się nie zgadzasz, konto usuniesz w Ustawieniach.`;

  const body =
    head(c, { name: false }) +
    h1(c, 'Zmieniamy regulamin i politykę prywatności') +
    p(
      c,
      'Poniżej data i to, co się zmienia. Wiąże tekst dokumentu, nie to streszczenie.',
      { pt: 16 },
    ) +
    kv(c, rows, { pt: 20 }) +
    list(c, {
      title: 'Co się zmienia',
      pt: 26,
      items: d.changes.map(
        (change) => `${b(change.title)} — ${esc(change.body)}`,
      ),
    }) +
    p(c, acceptance, { pt: 24 }) +
    btn(c, { label: 'Przeczytaj regulamin', href: `${c.site}/terms/` }) +
    textLink(c, {
      label: 'Polityka prywatności — scoffie.app/privacy',
      href: `${c.site}/privacy/`,
      pt: 8,
    }) +
    foot(c, {
      reason: 'bo zmieniają się warunki, na jakich korzystasz z konta.',
    });

  const changeLines = d.changes
    .map((change, i) => `${i + 1}. ${change.title} — ${change.body}`)
    .join('\n');

  const text = `Zmieniamy regulamin i politykę prywatności.

Poniżej data i to, co się zmienia. Wiąże tekst dokumentu, nie to streszczenie.

${from ? `Wchodzi w życie: ${from}\n` : ''}Dotyczy: Regulaminu i Polityki prywatności
Wersja dokumentów: ${d.version}

CO SIĘ ZMIENIA
${changeLines}

${
  d.requiresConsent
    ? 'Ta zmiana jest istotna, więc poprosimy Cię w aplikacji o potwierdzenie nowej wersji. Do tego czasu obowiązuje wersja, którą już zaakceptowałeś. Jeśli się nie zgadzasz, konto usuniesz w Ustawieniach.'
    : `Dalsze korzystanie ze Scoffie${from ? ` po ${from}` : ''} oznacza akceptację nowej wersji. Jeśli się nie zgadzasz, konto usuniesz w Ustawieniach.`
}

Regulamin: ${c.site}/terms/
Polityka prywatności: ${c.site}/privacy/

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, bo zmieniają się warunki, na jakich korzystasz z konta.
Pomoc: ${c.site}/support/
Scoffie · scoffie.app`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}
