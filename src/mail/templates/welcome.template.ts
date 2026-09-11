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
 * Bez kroku „Załóż dom": gospodarstwo powstaje w OSTATNIM kroku kreatora
 * w iOS, a `completeOnboarding` stempluje się dopiero po nim — w chwili
 * wysyłki dom już stoi, a próba założenia drugiego kończy się
 * `HOUSEHOLD_ALREADY_MEMBER`. Bez obietnicy zmiany nazwy domu: backend ma
 * `households:updateName`, ale aplikacja nigdy go nie woła.
 */
export function renderWelcome(c: MailCtx, d: WelcomePayload): RenderedMail {
  const subject = clipSubject('Twoje konto w Scoffie jest gotowe');
  const preheader = 'Zaproś domowników i zaplanujcie pierwszy tydzień.';

  const wiadomosci = `${d.trialMessages} ${plural(d.trialMessages, 'wiadomość', 'wiadomości', 'wiadomości')}`;
  const zapisy = `${d.trialPlans} ${plural(d.trialPlans, 'zapis', 'zapisy', 'zapisów')} planu tygodnia`;

  const body =
    head(c) +
    h1(c, 'Masz konto. Zacznij od planu na ten tydzień.') +
    lead(c, `Cześć, ${esc(d.displayName)}. Dobrze Cię tu widzieć.`) +
    p(
      c,
      'Jeden plan tygodnia, jedna lista zakupów i wspólne przepisy — dla całego domu.',
      { pt: 12 },
    ) +
    btn(c, { label: 'Otwórz Scoffie', href: `${c.site}/otworz/` }) +
    steps(c, {
      title: 'Od czego zacząć',
      items: [
        {
          t: 'Twój dom już stoi',
          d: 'Powstał razem z kontem. To w nim jest plan tygodnia, lista zakupów i przepisy.',
        },
        {
          t: 'Zaproś domowników',
          d: 'Link z Ustawień działa raz i przez tydzień — dla kolejnej osoby wygeneruj nowy. Kto otworzy go na iPhonie, wchodzi do Waszego domu.',
        },
        {
          t: 'Zaplanuj tydzień',
          d: 'Wybierz posiłki na siedem dni albo poproś asystenta — ułoży plan za Ciebie.',
        },
      ],
    }) +
    p(
      c,
      'Lista zakupów układa się sama z planu. Zmienisz obiad — lista przeliczy się razem z nim.',
      { pt: 26 },
    ) +
    panel(c, {
      pt: 22,
      html:
        `<div class="ink" style="font:700 15px/23px ${c.ff};color:${c.p.ink};">Dostęp próbny do asystenta</div>` +
        `<div class="soft" style="font:400 15px/23px ${c.ff};color:${c.p.soft};padding-top:3px;">${esc(wiadomosci)} i ${esc(zapisy)}. Przysługuje raz i nie odnawia się.</div>`,
    }) +
    p(
      c,
      `Pytania? Napisz do nas przez <a href="${c.site}/support/" style="color:${c.p.terra};text-decoration:underline;">pomoc</a>.`,
      { small: true, soft: true, pt: 22 },
    ) +
    foot(c, {
      reason: 'bo ten adres jest przypisany do Twojego konta w Scoffie.',
    });

  const text = `Masz konto. Zacznij od planu na ten tydzień.

Cześć, ${d.displayName}. Dobrze Cię tu widzieć.

Jeden plan tygodnia, jedna lista zakupów i wspólne przepisy — dla całego domu.

Otwórz Scoffie: ${c.site}/otworz/

OD CZEGO ZACZĄĆ
1. Twój dom już stoi — powstał razem z kontem. To w nim jest plan tygodnia, lista zakupów i przepisy.
2. Zaproś domowników — link z Ustawień działa raz i przez tydzień; dla kolejnej osoby wygeneruj nowy.
3. Zaplanuj tydzień — wybierz posiłki na siedem dni albo poproś asystenta.

Lista zakupów układa się sama z planu. Zmienisz obiad — lista przeliczy się razem z nim.

Dostęp próbny do asystenta: ${wiadomosci} i ${zapisy}. Przysługuje raz i nie odnawia się.

Pytania? ${c.site}/support/

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
