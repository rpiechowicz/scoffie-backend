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
 * F — konto usunięte. Najostrożniejszy mail z całego zestawu, bo dotyka RODO:
 * nie wolno mu twierdzić, że coś zostało usunięte, jeśli kod tego nie usuwa.
 *
 * CO BYŁO NIEPRAWDĄ W MAKIECIE:
 *
 * — „Prywatne przepisy i plany zostały usunięte razem z kontem". `deleteAccount`
 *   ich NIE KASUJE: przepisuje autorstwo na konto bota katalogu i zostawia je
 *   w gospodarstwie. Znikają wyłącznie wtedy, gdy dom był jednoosobowy i poszedł
 *   jako pusty — stąd wariant po `householdRemains`.
 * — „Przepisy dodane do wspólnego katalogu w nim zostają". Użytkownik NIGDY
 *   niczego nie dodaje do wspólnego katalogu: `isCatalog: true` powstaje
 *   wyłącznie przy imporcie, a `recipes:create` zawsze daje `false`.
 * — milczenie o subskrypcji. `purchaserUserId` jest `SetNull`, właścicielem
 *   jest `identityHash` — umowa z Apple żyje dalej i pobierze kolejną opłatę.
 *   To jedyna rzecz po usunięciu konta, która kosztuje pieniądze.
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

  const wspolne = d.householdRemains
    ? d.keptRecipes > 0
      ? `${b('Przepisy i plany zostają domownikom.')} Wszystko, co powstało w Waszym gospodarstwie — ${d.keptRecipes} ${plural(d.keptRecipes, 'przepis', 'przepisy', 'przepisów')} dodane przez Ciebie, plan tygodnia i lista zakupów — należy do domu, nie do konta. Zostaje na miejscu, więc domownikom nie rozsypie się plan w połowie tygodnia; przy Twoich przepisach autorstwo przechodzi na konto Scoffie.`
      : `${b('Wspólne rzeczy zostają w domu.')} Plan tygodnia, lista zakupów i przepisy gospodarstwa należą do domu, nie do konta — domownicy mają je dalej u siebie, dokładnie tam, gdzie były.`
    : `${b('Dom zniknął razem z kontem.')} Byłeś w gospodarstwie sam, więc poszło razem z Tobą — a z nim jego plany tygodnia, listy zakupów i przepisy. Wspólny katalog przepisów Scoffie to osobny zbiór, który prowadzimy my; jego to nie dotyczy.`;

  const body =
    head(c, { name: false }) +
    h1(c, 'Konto usunięte') +
    p(
      c,
      'Zrobione — usunęliśmy Twój profil, preferencje, rozmowy z asystentem, kroki ze Zdrowia, poświadczenia Cookidoo, tokeny logowania i dziennik zgód. Tego nie da się cofnąć, więc piszemy tylko po to, żeby zostało Ci to na papierze i żeby było jasne, co dalej z rzeczami, które były wspólne.',
      { pt: 16 },
    ) +
    kv(c, rows) +
    (d.hasLiveSubscription
      ? warn(c, {
          pt: 26,
          title: 'Subskrypcja nie kończy się razem z kontem',
          body: `Płatność prowadzi Apple, nie my, więc usunięcie konta w Scoffie jej nie zatrzymuje — dopóki nie wyłączysz odnawiania, App Store pobierze opłatę za kolejny okres. Zrobisz to w Ustawieniach iPhone’a → [Twoje imię] → Subskrypcje → Scoffie, najlepiej co najmniej 24 godziny przed końcem bieżącego okresu.`,
        })
      : '') +
    p(c, wspolne, { pt: 26 }) +
    p(
      c,
      `${b('Okres próbny nie wraca.')} Jeśli kiedyś powstanie tu nowe konto na tym samym Apple ID, dostęp próbny do asystenta się nie odnowi — przysługuje raz. Opłacona subskrypcja odwrotnie: odnajdzie się sama.`,
      { pt: 14 },
    ) +
    p(
      c,
      'Zostaje jeden ślad: nieodwracalny pseudonim wyliczony z Twojego identyfikatora logowania, a przy nim licznik wykorzystanej próby i zapis subskrypcji. Trzymamy go właśnie po to, żeby te dwie rzeczy działały tak, jak wyżej. Przy gospodarstwie zostają jeszcze notatki pamięci domu i rozliczenie kosztów asystenta — bez powiązania z Tobą. Szczegóły opisuje Polityka prywatności w punkcie o okresach przechowywania.',
      { pt: 14, small: true, soft: true },
    ) +
    p(
      c,
      'Poza tym nie wysyłamy już żadnych wiadomości. Dziękujemy za czas spędzony w Scoffie — i za każdy przepis, który po Tobie został.',
      { pt: 14 },
    ) +
    textLink(c, {
      label: 'Zostały pytania? Pomoc — scoffie.app/support',
      href: `${c.site}/support/`,
      pt: 16,
    }) +
    foot(c, { reason: 'bo konto powiązane z tym adresem zostało usunięte.' });

  const text = `Konto usunięte.

Zrobione — usunęliśmy Twój profil, preferencje, rozmowy z asystentem, kroki ze Zdrowia, poświadczenia Cookidoo, tokeny logowania i dziennik zgód. Tego nie da się cofnąć.

Konto: ${d.email}${when ? `\nUsunięte: ${when}` : ''}
${
  d.hasLiveSubscription
    ? `
SUBSKRYPCJA NIE KOŃCZY SIĘ RAZEM Z KONTEM
Płatność prowadzi Apple, nie my — usunięcie konta w Scoffie jej nie zatrzymuje. Wyłącz odnawianie w Ustawieniach iPhone'a → [Twoje imię] → Subskrypcje → Scoffie, najlepiej co najmniej 24 godziny przed końcem bieżącego okresu.
`
    : ''
}
${
  d.householdRemains
    ? d.keptRecipes > 0
      ? `Przepisy i plany zostają domownikom. Wszystko, co powstało w Waszym gospodarstwie — ${d.keptRecipes} ${plural(d.keptRecipes, 'przepis', 'przepisy', 'przepisów')} dodane przez Ciebie, plan tygodnia i lista zakupów — należy do domu, nie do konta. Przy Twoich przepisach autorstwo przechodzi na konto Scoffie.`
      : 'Wspólne rzeczy zostają w domu. Plan tygodnia, lista zakupów i przepisy gospodarstwa należą do domu, nie do konta.'
    : 'Dom zniknął razem z kontem. Byłeś w gospodarstwie sam, więc poszło razem z Tobą — a z nim jego plany, listy zakupów i przepisy.'
}

Okres próbny nie wraca. Jeśli kiedyś powstanie tu nowe konto na tym samym Apple ID, dostęp próbny do asystenta się nie odnowi. Opłacona subskrypcja odwrotnie: odnajdzie się sama.

Zostaje jeden ślad: nieodwracalny pseudonim wyliczony z Twojego identyfikatora logowania, a przy nim licznik wykorzystanej próby i zapis subskrypcji. Przy gospodarstwie zostają notatki pamięci domu i rozliczenie kosztów asystenta — bez powiązania z Tobą.

Poza tym nie wysyłamy już żadnych wiadomości. Dziękujemy za czas spędzony w Scoffie.

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
