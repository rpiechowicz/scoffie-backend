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
  warn,
} from './mail-kit';
import { clipSubject, formatDay } from './mail-format';
import {
  RenderedMail,
  SubscriptionExpiredPayload,
  SubscriptionGracePayload,
} from '../mail-template';

const APPLE_SUBSCRIPTIONS = 'https://apps.apple.com/account/subscriptions';
const IN_APP_PATH = 'Ustawienia → Asystent i plan';

/**
 * D — nieudana płatność, subskrypcja w okresie łaski.
 *
 * Dwa warianty, bo backend nie zawsze zna datę końca łaski (`graceExpiresAt`
 * bywa `null`). Bez ceny — `Subscription` nie przechowuje kwoty ani waluty.
 */
export function renderSubscriptionGrace(
  c: MailCtx,
  d: SubscriptionGracePayload,
): RenderedMail {
  const until = formatDay(d.graceEndsAtIso);
  const subject = clipSubject('Płatność nie przeszła. Plan działa');
  const preheader = until
    ? `Apple ponowi próbę do ${until}. Do tego czasu nic się nie zmienia.`
    : 'Apple ponawia próbę płatności. Plan działa normalnie.';

  const rows: [string, string][] = [['Plan', esc(d.planName)]];
  if (until) rows.push(['Plan działa do', esc(until)]);

  const body =
    head(c, { name: false }) +
    h1(c, 'Płatność nie przeszła') +
    warn(c, {
      title: until
        ? `Plan działa normalnie do ${esc(until)}`
        : 'Plan działa normalnie',
      body: until
        ? 'Apple spróbuje pobrać opłatę jeszcze kilka razy. Jeśli karta jest aktualna, nie musisz nic robić.'
        : 'Apple spróbuje pobrać opłatę jeszcze kilka razy przez najbliższe dni. Jeśli karta jest aktualna, nie musisz nic robić.',
    }) +
    p(
      c,
      `${b('Pula wiadomości nie odnowi się, dopóki płatność nie przejdzie')} — do tego czasu zostaje Wam reszta z opłaconego okresu.`,
      { pt: 20 },
    ) +
    p(
      c,
      `Jeśli ${until ? `do ${esc(until)} ` : ''}płatność się nie uda, plan się wyłączy: asystent przestanie układać tygodnie. ${b('Nic nie zniknie')} — plan, lista zakupów, przepisy i gospodarstwo zostają.`,
      { pt: 14 },
    ) +
    kv(c, rows) +
    list(c, {
      title: 'Najczęstsza przyczyna',
      pt: 26,
      items: [
        'Karta straciła ważność albo została wymieniona przez bank',
        'Brakło środków w chwili, gdy Apple próbował pobrać opłatę',
        'Zmiana kraju lub regionu na koncie Apple',
      ],
    }) +
    btn(c, { label: 'Ustawienia subskrypcji', href: APPLE_SUBSCRIPTIONS }) +
    p(
      c,
      'Kwotę, walutę i kartę zmienisz tylko w App Store. Ta wiadomość nie jest paragonem — paragony wysyła Apple.',
      { small: true, soft: true, pt: 22 },
    ) +
    foot(c, {
      reason: 'bo App Store zgłosił nieudaną płatność za subskrypcję.',
    });

  const text = `Płatność nie przeszła. Plan działa.

${
  until
    ? `Plan działa normalnie do ${until}. Apple spróbuje pobrać opłatę jeszcze kilka razy — jeśli karta jest aktualna, nie musisz nic robić.`
    : 'Plan działa normalnie. Apple spróbuje pobrać opłatę jeszcze kilka razy przez najbliższe dni — jeśli karta jest aktualna, nie musisz nic robić.'
}

Pula wiadomości nie odnowi się, dopóki płatność nie przejdzie — do tego czasu zostaje Wam reszta z opłaconego okresu.

Jeśli ${until ? `do ${until} ` : ''}płatność się nie uda, plan się wyłączy: asystent przestanie układać tygodnie. Nic nie zniknie — plan, lista zakupów, przepisy i gospodarstwo zostają.

Plan: ${d.planName}${until ? `\nPlan działa do: ${until}` : ''}

NAJCZĘSTSZA PRZYCZYNA
- Karta straciła ważność albo została wymieniona przez bank
- Brakło środków w chwili, gdy Apple próbował pobrać opłatę
- Zmiana kraju lub regionu na koncie Apple

Ustawienia subskrypcji: ${APPLE_SUBSCRIPTIONS}

Kwotę, walutę i kartę zmienisz tylko w App Store. Ta wiadomość nie jest paragonem — paragony wysyła Apple.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, bo App Store zgłosił nieudaną płatność za subskrypcję.
Regulamin: ${c.site}/terms/ · Polityka prywatności: ${c.site}/privacy/ · Pomoc: ${c.site}/support/
Scoffie · scoffie.app`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}

/**
 * E — subskrypcja wygasła albo została cofnięta.
 *
 * Bez słowa „PRO" — to nazwa poziomu w kodzie; użytkownik widzi „plan Solo"
 * i ekran „Asystent i plan". Jedno zdanie o innym płatniku w domu, bo wtedy
 * asystent działa dalej i mail bez tego wyglądałby na pomyłkę.
 */
export function renderSubscriptionExpired(
  c: MailCtx,
  d: SubscriptionExpiredPayload,
): RenderedMail {
  const when = formatDay(d.expiredAtIso);
  const subject = clipSubject(
    d.revoked
      ? 'Subskrypcja cofnięta. Plany zostają'
      : 'Subskrypcja wygasła. Plany zostają',
  );
  const preheader =
    'Asystent jest wyłączony. Plany, przepisy i lista zakupów zostają.';

  const opening = d.revoked
    ? `Apple cofnęło zakup subskrypcji${when ? ` ${esc(when)}` : ''} i zwróciło opłatę. Nic z Waszych danych nie zniknęło.`
    : `Subskrypcja skończyła się${when ? ` ${esc(when)}` : ''}. Nic z Waszych danych nie zniknęło — zmieniło się tylko to, co poniżej.`;

  const body =
    head(c) +
    h1(
      c,
      d.revoked
        ? 'Subskrypcja cofnięta. Kuchnia zostaje'
        : 'Subskrypcja wygasła. Kuchnia zostaje',
    ) +
    p(c, opening, { pt: 16 }) +
    list(c, {
      title: 'Przestaje działać',
      tone: 'off',
      pt: 26,
      items: [
        'Asystent — nowe wiadomości i układanie tygodnia za Was',
        'Zapisywanie planu przez asystenta',
      ],
    }) +
    list(c, {
      title: 'Zostaje',
      tone: 'ok',
      pt: 24,
      items: [
        'Ręczne układanie planu — jak zawsze, bez limitu',
        'Wszystkie dotychczasowe plany',
        'Przepisy Waszego domu i katalog',
        'Lista zakupów i jej historia',
        'Gospodarstwo i domownicy',
      ],
    }) +
    p(
      c,
      'Jeśli plan opłaca ktoś inny w Waszym domu, asystent działa dalej z jego planu.',
      { pt: 22, small: true, soft: true },
    ) +
    btn(c, { label: 'Włącz plan ponownie', href: APPLE_SUBSCRIPTIONS }) +
    p(
      c,
      `Albo w aplikacji: ${b(IN_APP_PATH)}. Ostatni plan: ${esc(d.planName)}.`,
      { small: true, soft: true, pt: 22 },
    ) +
    foot(c, {
      reason: d.revoked
        ? 'bo App Store cofnął zakup subskrypcji przypisanej do Twojego konta.'
        : 'bo subskrypcja przypisana do Twojego konta wygasła.',
    });

  const text = `${d.revoked ? 'Subskrypcja cofnięta. Kuchnia zostaje.' : 'Subskrypcja wygasła. Kuchnia zostaje.'}

${
  d.revoked
    ? `Apple cofnęło zakup subskrypcji${when ? ` ${when}` : ''} i zwróciło opłatę. Nic z Waszych danych nie zniknęło.`
    : `Subskrypcja skończyła się${when ? ` ${when}` : ''}. Nic z Waszych danych nie zniknęło.`
}

PRZESTAJE DZIAŁAĆ
- Asystent — nowe wiadomości i układanie tygodnia za Was
- Zapisywanie planu przez asystenta

ZOSTAJE
- Ręczne układanie planu — jak zawsze, bez limitu
- Wszystkie dotychczasowe plany
- Przepisy Waszego domu i katalog
- Lista zakupów i jej historia
- Gospodarstwo i domownicy

Jeśli plan opłaca ktoś inny w Waszym domu, asystent działa dalej z jego planu.

Włącz plan ponownie: ${APPLE_SUBSCRIPTIONS}
Albo w aplikacji: ${IN_APP_PATH}. Ostatni plan: ${d.planName}.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${d.revoked ? 'bo App Store cofnął zakup subskrypcji przypisanej do Twojego konta.' : 'bo subskrypcja przypisana do Twojego konta wygasła.'}
Regulamin: ${c.site}/terms/ · Polityka prywatności: ${c.site}/privacy/ · Pomoc: ${c.site}/support/
Scoffie · scoffie.app`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}
