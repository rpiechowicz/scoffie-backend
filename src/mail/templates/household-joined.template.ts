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
 * POPRAWIONE WOBEC MAKIETY:
 *
 * — „Twoje prywatne przepisy zostają Twoje" wypadło. W modelu NIE MA
 *   prywatnych przepisów: przepis należy do GOSPODARSTWA (`householdId`),
 *   a widoczność to `isCatalog = true OR householdId = mój dom`. `authorId`
 *   niczego nie filtruje.
 * — „dorzucisz coś do listy zakupów" wypadło. Lista liczy się WYŁĄCZNIE
 *   z pozycji planu; jedyne, co można na niej zrobić, to odhaczyć pozycję.
 * — przekąski nie są domyślne. Dom startuje ze śniadaniem, obiadem i kolacją;
 *   pozostałe pory włącza się w ustawieniach gospodarstwa.
 * — dołożone zdanie o poprzednim domu: przyjęcie zaproszenia KOŃCZY
 *   dotychczasowe członkostwo, a dom bez domowników jest kasowany.
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
    'Plan tygodnia, lista zakupów i przepisy są od teraz wspólne. Zobacz, co już jest.';

  const body =
    head(c) +
    h1(c, 'Jesteś w domu') +
    p(c, 'Zaproszenie przyjęte — od teraz planujecie jedzenie razem.', {
      pt: 14,
    }) +
    house(c, { name: d.householdName, members: d.members, pt: 20 }) +
    p(
      c,
      'Wszystko, co tu jest, jest wspólne. Jak w środę wieczorem podmienisz obiad, lista zakupów przeliczy się sama, a pozostali zobaczą nową wersję od razu. Odhaczysz jajka w sklepie — reszta domu widzi to w tej samej chwili, więc nikt nie kupi drugiego opakowania.',
      { pt: 20 },
    ) +
    list(c, {
      title: 'Co widzisz wspólnie',
      items: [
        `${b('Plan tygodnia')} — śniadania, obiady i kolacje na każdy dzień. II śniadanie, podwieczorek i przekąskę dokładacie w ustawieniach domu, jeśli chcecie. Plan możesz zmieniać, nie tylko przeglądać.`,
        `${b('Lista zakupów')} — składa się sama z tego, co jest w planie. Odhaczanie widzą wszyscy w czasie realnym.`,
        `${b('Przepisy')} — wspólny katalog Scoffie i przepisy tego domu. Co dopiszecie, widzi i może zmienić każdy domownik.`,
      ],
    }) +
    p(
      c,
      'Jeśli byłeś wcześniej w innym gospodarstwie, tamte przepisy, plany i listy zostają przy nim — nie przenoszą się tutaj razem z Tobą.',
      { pt: 20, small: true, soft: true },
    ) +
    btn(c, { label: 'Otwórz Scoffie', href: `${c.site}/otworz` }) +
    p(
      c,
      'Dobry pierwszy krok: wejdź w plan tygodnia i sprawdź, czy jest tam coś, czego nie jadasz. Przytrzymaj danie i wybierz „Zamień przepis lub osoby”.',
      { pt: 24 },
    ) +
    panel(c, {
      pt: 22,
      html:
        `<div class="ink" style="font:700 15px/23px ${c.ff};color:${c.p.ink};">Jeśli ktoś w domu ma opłacony plan, asystent działa też u Ciebie</div>` +
        `<div class="soft" style="font:400 15px/23px ${c.ff};color:${c.p.soft};padding-top:3px;">Subskrypcja należy do tej osoby i to ona ją rozlicza — Ty nic nie opłacasz. Pula wiadomości jest wspólna dla całego domu, więc dzielicie ją między siebie. Gdyby kiedyś subskrypcję wyłączyła, plan, lista i przepisy zostają; zniknie tylko asystent.</div>`,
    }) +
    foot(c, { reason: 'bo Twoje konto zostało dodane do gospodarstwa.' });

  const members = d.members.map((m) => m.name).join(', ');
  const text = `Jesteś w domu.

Zaproszenie przyjęte — od teraz planujecie jedzenie razem.

Gospodarstwo: ${d.householdName}
Domownicy (${d.members.length}): ${members}

Wszystko, co tu jest, jest wspólne. Jak w środę wieczorem podmienisz obiad, lista zakupów przeliczy się sama i pozostali zobaczą nową wersję od razu. Odhaczysz jajka w sklepie — reszta domu widzi to w tej samej chwili.

CO WIDZISZ WSPÓLNIE
- Plan tygodnia — śniadania, obiady i kolacje na każdy dzień. II śniadanie, podwieczorek i przekąskę dokładacie w ustawieniach domu. Plan możesz zmieniać.
- Lista zakupów — składa się sama z tego, co jest w planie. Odhaczanie widzą wszyscy.
- Przepisy — wspólny katalog Scoffie i przepisy tego domu. Co dopiszecie, widzi i może zmienić każdy domownik.

Jeśli byłeś wcześniej w innym gospodarstwie, tamte przepisy, plany i listy zostają przy nim.

Otwórz Scoffie: ${c.site}/otworz

Dobry pierwszy krok: wejdź w plan tygodnia i sprawdź, czy jest tam coś, czego nie jadasz. Przytrzymaj danie i wybierz „Zamień przepis lub osoby”.

Jeśli ktoś w domu ma opłacony plan, asystent działa też u Ciebie. Subskrypcja należy do tej osoby — Ty nic nie opłacasz, a pula wiadomości jest wspólna dla całego domu.

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
