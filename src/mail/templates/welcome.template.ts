import {
  MailCtx,
  btn,
  doc,
  esc,
  foot,
  h1,
  head,
  lead,
  p,
  panel,
  plural,
  steps,
} from './mail-kit';
import { clipSubject } from './mail-format';
import { RenderedMail, WelcomePayload } from '../mail-template';

/**
 * A — „Witaj w Scoffie". Wyzwalacz: `users.service.completeOnboarding`.
 *
 * CZEGO TU NIE MA, CHOĆ BYŁO W MAKIECIE:
 *
 * — kroku „Załóż dom". Gospodarstwo powstaje w OSTATNIM kroku kreatora
 *   (`WelcomeView`, krok 5), a `completeOnboarding` stempluje się dopiero
 *   po nim. W chwili wysyłki dom już stoi, a próba założenia drugiego kończy
 *   się `HOUSEHOLD_ALREADY_MEMBER` (409) — mail kazałby zrobić rzecz zrobioną
 *   i technicznie zablokowaną.
 * — obietnicy „nazwę zmienisz w Ustawieniach". Backend ma
 *   `households:updateName`, ale aplikacja nigdy go nie woła.
 * — zdania „bez zakładania niczego od nowa" przy zapraszaniu. Zapraszany
 *   przechodzi WŁASNY onboarding z własnym domem, a dołączenie wymaga zgody
 *   na wyjście z niego (`INVITATION_REQUIRES_LEAVE`).
 */
export function renderWelcome(c: MailCtx, d: WelcomePayload): RenderedMail {
  const subject = clipSubject('Twoje konto w Scoffie jest gotowe');
  const preheader =
    'Zaproś domowników i zaplanujcie pierwszy tydzień. Zajmie to kilka minut.';

  const wiadomosci = `${d.trialMessages} ${plural(d.trialMessages, 'wiadomość', 'wiadomości', 'wiadomości')}`;
  const zapisy = `${d.trialPlans} ${plural(d.trialPlans, 'zapis', 'zapisy', 'zapisów')} planu tygodnia`;

  const body =
    head(c) +
    h1(c, 'Masz konto. Zacznij od planu na ten tydzień.') +
    lead(c, `Cześć, ${esc(d.displayName)}. Dobrze Cię tu widzieć.`) +
    p(
      c,
      'Scoffie zbiera w jednym miejscu to, co u większości domów rozjeżdża się po karteczkach i głowach: co jecie w tym tygodniu, co trzeba kupić i gdzie są te przepisy, które faktycznie się powtarzają. Jeden plan, jedna lista, jeden dom.',
      { pt: 12 },
    ) +
    btn(c, { label: 'Otwórz Scoffie', href: `${c.site}/otworz` }) +
    steps(c, {
      title: 'Od czego zacząć',
      items: [
        {
          t: 'Twój dom już stoi',
          d: 'Powstał razem z kontem i to w nim siedzi plan tygodnia, lista zakupów i przepisy. Wszystko, co od teraz dodasz, ląduje właśnie tam.',
        },
        {
          t: 'Zaproś domowników',
          d: 'Link z Ustawień działa raz i jest ważny tydzień — dla kolejnej osoby wygeneruj nowy. Kto otworzy go na iPhonie, wchodzi do Waszego domu i od razu widzi ten sam plan.',
        },
        {
          t: 'Zaplanuj pierwszy tydzień',
          d: 'Wybierz posiłki na siedem dni albo powiedz asystentowi, co lubicie i czego nie — ułoży plan za Ciebie.',
        },
      ],
    }) +
    p(
      c,
      'Lista zakupów robi się sama z tego, co jest w planie — nie musisz jej pisać. Podmienisz obiad w środę wieczorem, lista przeliczy się razem z nim.',
      { pt: 26 },
    ) +
    panel(c, {
      pt: 22,
      html:
        `<div class="ink" style="font:700 15px/23px ${c.ff};color:${c.p.ink};">Na start masz dostęp próbny do asystenta</div>` +
        `<div class="soft" style="font:400 15px/23px ${c.ff};color:${c.p.soft};padding-top:3px;">${esc(wiadomosci)} i ${esc(zapisy)} — warto wykorzystać je na tydzień, który naprawdę chcesz przetestować. Próbę dostajesz raz i nie odnawia się.</div>`,
    }) +
    p(
      c,
      `Jak coś nie zagra albo czegoś nie znajdziesz — napisz do nas przez <a href="${c.site}/support/" style="color:${c.p.terra};text-decoration:underline;">pomoc</a>. Odpisujemy jak ludzie, nie jak formularz.`,
      { small: true, soft: true, pt: 22 },
    ) +
    foot(c, {
      reason: 'bo ten adres jest przypisany do Twojego konta w Scoffie.',
    });

  const text = `Masz konto. Zacznij od planu na ten tydzień.

Cześć, ${d.displayName}. Dobrze Cię tu widzieć.

Scoffie zbiera w jednym miejscu to, co u większości domów rozjeżdża się po karteczkach i głowach: co jecie w tym tygodniu, co trzeba kupić i gdzie są te przepisy, które faktycznie się powtarzają. Jeden plan, jedna lista, jeden dom.

Otwórz Scoffie: ${c.site}/otworz

OD CZEGO ZACZĄĆ
1. Twój dom już stoi — powstał razem z kontem. To w nim siedzi plan tygodnia, lista zakupów i przepisy.
2. Zaproś domowników — link z Ustawień działa raz i jest ważny tydzień; dla kolejnej osoby wygeneruj nowy.
3. Zaplanuj pierwszy tydzień — wybierz posiłki na siedem dni albo powiedz asystentowi, co lubicie.

Lista zakupów robi się sama z tego, co jest w planie — nie musisz jej pisać.

Na start masz dostęp próbny do asystenta: ${wiadomosci} i ${zapisy}. Próbę dostajesz raz i nie odnawia się.

Jak coś nie zagra — napisz: ${c.site}/support/

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, bo ten adres jest przypisany do Twojego konta w Scoffie.
Regulamin: ${c.site}/terms/ · Polityka prywatności: ${c.site}/privacy/ · Pomoc: ${c.site}/support/
Scoffie · scoffie.app`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}
