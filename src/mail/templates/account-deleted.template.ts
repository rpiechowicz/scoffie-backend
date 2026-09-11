import {
  MailCtx,
  b,
  doc,
  esc,
  foot,
  h1,
  head,
  kv,
  p,
  plural,
  textLink,
  warn,
} from './mail-kit';
import { clipSubject, formatDayYear } from './mail-format';
import { AccountDeletedPayload, RenderedMail } from '../mail-template';

/**
 * F — konto usunięte. Trzy fakty, które człowiek musi dostać, i nic ponad to:
 * co jest usunięte, co zostaje domownikom, i że subskrypcja w App Store żyje
 * dalej (to jedyna rzecz po usunięciu konta, która kosztuje pieniądze).
 *
 * `deleteAccount` NIE kasuje przepisów — zostają w gospodarstwie. Gdy dom był
 * jednoosobowy, idzie razem z kontem; stąd wariant po `householdRemains`.
 */
export function renderAccountDeleted(
  c: MailCtx,
  d: AccountDeletedPayload,
): RenderedMail {
  const when = formatDayYear(d.deletedAtIso);
  const subject = clipSubject('Twoje konto zostało usunięte');
  const preheader = d.householdRemains
    ? 'Konto usunięte. Przepisy i plany zostają domownikom.'
    : 'Konto usunięte. Gospodarstwo zniknęło razem z nim.';

  const rows: [string, string][] = [['Konto', esc(d.email)]];
  if (when) rows.push(['Usunięte', esc(when)]);

  const przepisy = `${d.keptRecipes} ${plural(d.keptRecipes, 'przepis', 'przepisy', 'przepisów')}`;
  const wspolne = d.householdRemains
    ? d.keptRecipes > 0
      ? `${b('Przepisy i plany zostają domownikom.')} ${esc(przepisy)}, które dodałeś, plan tygodnia i lista zakupów należą do domu, nie do konta — Twoi domownicy mają je dalej.`
      : `${b('Wspólne rzeczy zostają w domu.')} Plan tygodnia, lista zakupów i przepisy należą do domu, nie do konta — domownicy mają je dalej.`
    : `${b('Dom zniknął razem z kontem.')} Byłeś w gospodarstwie sam, więc jego plany, listy zakupów i przepisy też są usunięte.`;
  const wspolneText = d.householdRemains
    ? d.keptRecipes > 0
      ? `Przepisy i plany zostają domownikom. ${przepisy}, które dodałeś, plan tygodnia i lista zakupów należą do domu, nie do konta — Twoi domownicy mają je dalej.`
      : 'Wspólne rzeczy zostają w domu. Plan tygodnia, lista zakupów i przepisy należą do domu, nie do konta — domownicy mają je dalej.'
    : 'Dom zniknął razem z kontem. Byłeś w gospodarstwie sam, więc jego plany, listy zakupów i przepisy też są usunięte.';

  const subskrypcja =
    'Płatność prowadzi Apple, więc usunięcie konta jej nie zatrzymuje. Wyłącz odnawianie: Ustawienia iPhone’a → Twoje imię → Subskrypcje → Scoffie — najlepiej co najmniej dobę przed końcem bieżącego okresu.';

  const body =
    head(c, { name: false }) +
    h1(c, 'Konto usunięte') +
    p(
      c,
      'Zrobione — Twoje konto, profil, preferencje i rozmowy z asystentem są usunięte. Tego nie da się cofnąć.',
      { pt: 16 },
    ) +
    kv(c, rows) +
    (d.hasLiveSubscription
      ? warn(c, {
          pt: 26,
          title: 'Subskrypcja nie kończy się razem z kontem',
          body: esc(subskrypcja),
        })
      : '') +
    p(c, wspolne, { pt: 26 }) +
    p(
      c,
      `${b('Dostęp próbny nie wraca.')} Przy nowym koncie na tym samym Apple ID asystent nie da drugiej próby. Opłacona subskrypcja odnajdzie się sama.`,
      { pt: 14 },
    ) +
    p(
      c,
      'To ostatnia wiadomość od nas. Dziękujemy za czas spędzony w Scoffie.',
      { pt: 14 },
    ) +
    textLink(c, {
      label: 'Zostały pytania? Pomoc — scoffie.app/support',
      href: `${c.site}/support/`,
      pt: 16,
    }) +
    foot(c, { reason: 'bo konto powiązane z tym adresem zostało usunięte.' });

  const text = `Konto usunięte.

Zrobione — Twoje konto, profil, preferencje i rozmowy z asystentem są usunięte. Tego nie da się cofnąć.

Konto: ${d.email}${when ? `\nUsunięte: ${when}` : ''}
${
  d.hasLiveSubscription
    ? `
SUBSKRYPCJA NIE KOŃCZY SIĘ RAZEM Z KONTEM
${subskrypcja}
`
    : ''
}
${wspolneText}

Dostęp próbny nie wraca. Przy nowym koncie na tym samym Apple ID asystent nie da drugiej próby. Opłacona subskrypcja odnajdzie się sama.

To ostatnia wiadomość od nas. Dziękujemy za czas spędzony w Scoffie.

Zostały pytania? ${c.site}/support/

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, bo konto powiązane z tym adresem zostało usunięte.
Regulamin: ${c.site}/terms/ · Polityka prywatności: ${c.site}/privacy/
Scoffie · scoffie.app`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}
