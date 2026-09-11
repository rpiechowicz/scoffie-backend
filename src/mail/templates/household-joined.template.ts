import {
  MailCtx,
  b,
  btn,
  doc,
  foot,
  h1,
  head,
  house,
  list,
  p,
  panel,
} from './mail-kit';
import { HouseholdJoinedPayload, RenderedMail } from '../mail-template';

/**
 * B — „Witaj w gospodarstwie". Wyzwalacz: przyjęcie zaproszenia
 * (`households.service`, ustawienie `Invitation.redeemedAt`).
 *
 * Bez „prywatnych przepisów" — w modelu ich nie ma, przepis należy do
 * gospodarstwa i widzą go wszyscy domownicy. Bez „dorzucisz coś do listy
 * zakupów" — lista liczy się wyłącznie z planu. Bez przekąsek w domyślnym
 * planie — dom startuje ze śniadaniem, obiadem i kolacją.
 */
export function renderHouseholdJoined(
  c: MailCtx,
  d: HouseholdJoinedPayload,
): RenderedMail {
  // Nazwa domu w temacie tylko wtedy, gdy MIEŚCI SIĘ w całości. Ucięta
  // („Witaj w gospodarstwie Gospodarstwo Rodziny W…") wygląda jak błąd
  // wysyłki — lepszy temat bez nazwy niż nazwa w połowie.
  const pelny = `Witaj w gospodarstwie ${d.householdName}`;
  const subject =
    [...pelny].length <= 45 ? pelny : 'Witaj w nowym gospodarstwie';
  const preheader =
    'Plan tygodnia, lista zakupów i przepisy są od teraz wspólne.';

  const body =
    head(c) +
    h1(c, 'Jesteś w domu') +
    p(c, 'Zaproszenie przyjęte — od teraz planujecie jedzenie razem.', {
      pt: 14,
    }) +
    house(c, { name: d.householdName, members: d.members, pt: 20 }) +
    list(c, {
      title: 'Co widzicie wspólnie',
      pt: 26,
      items: [
        `${b('Plan tygodnia')} — śniadania, obiady i kolacje na każdy dzień; inne pory włączycie w ustawieniach domu. Możesz go zmieniać, nie tylko oglądać.`,
        `${b('Lista zakupów')} — układa się sama z planu. Odhaczenie w sklepie widzą wszyscy od razu.`,
        `${b('Przepisy')} — wspólny katalog Scoffie i przepisy Waszego domu. Co dodacie, widzi każdy domownik.`,
      ],
    }) +
    btn(c, { label: 'Otwórz Scoffie', href: `${c.site}/otworz/` }) +
    p(
      c,
      'Dobry pierwszy krok: sprawdź w planie, czy jest tam coś, czego nie jadasz. Przytrzymaj danie i wybierz „Zamień przepis lub osoby”.',
      { pt: 24 },
    ) +
    panel(c, {
      pt: 22,
      html:
        `<div class="ink" style="font:700 15px/23px ${c.ff};color:${c.p.ink};">Jeśli ktoś w domu ma opłacony plan, asystent działa też u Ciebie</div>` +
        `<div class="soft" style="font:400 15px/23px ${c.ff};color:${c.p.soft};padding-top:3px;">Płaci ta osoba, a pula wiadomości jest wspólna dla całego domu.</div>`,
    }) +
    foot(c, { reason: 'bo Twoje konto zostało dodane do gospodarstwa.' });

  const members = d.members.map((m) => m.name).join(', ');
  const text = `Jesteś w domu.

Zaproszenie przyjęte — od teraz planujecie jedzenie razem.

Gospodarstwo: ${d.householdName}
Domownicy (${d.members.length}): ${members}

CO WIDZICIE WSPÓLNIE
- Plan tygodnia — śniadania, obiady i kolacje na każdy dzień; inne pory włączycie w ustawieniach domu. Możesz go zmieniać.
- Lista zakupów — układa się sama z planu. Odhaczenie w sklepie widzą wszyscy od razu.
- Przepisy — wspólny katalog Scoffie i przepisy Waszego domu. Co dodacie, widzi każdy domownik.

Otwórz Scoffie: ${c.site}/otworz/

Dobry pierwszy krok: sprawdź w planie, czy jest tam coś, czego nie jadasz. Przytrzymaj danie i wybierz „Zamień przepis lub osoby”.

Jeśli ktoś w domu ma opłacony plan, asystent działa też u Ciebie. Płaci ta osoba, a pula wiadomości jest wspólna dla całego domu.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, bo Twoje konto zostało dodane do gospodarstwa.
Regulamin: ${c.site}/terms/ · Polityka prywatności: ${c.site}/privacy/ · Pomoc: ${c.site}/support/
Scoffie · scoffie.app`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}
