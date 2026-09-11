import { SUBSCRIPTION_PRODUCTS } from '../../config/subscription-products';
import {
  MailCtx,
  MailPlan,
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
  plans,
  plural,
  warn,
} from './mail-kit';
import { clipSubject, formatDay, formatPrice } from './mail-format';
import {
  AiQuotaExhaustedPayload,
  AiTrialExhaustedPayload,
  RenderedMail,
} from '../mail-template';

/** Ustawienia w aplikacji, do których odsyłamy zamiast martwego `/plany`. */
const IN_APP_PATH = 'Ustawienia → Asystent i plan';

/**
 * Plany z JEDNEGO źródła prawdy (`subscription-products.ts`). Makieta miała je
 * wpisane w treść; przy pierwszej zmianie cennika mail kłamałby o pieniądzach.
 */
function planCards(currentName?: string): MailPlan[] {
  return Object.values(SUBSCRIPTION_PRODUCTS).map((product) => ({
    name: product.name,
    price: formatPrice(product.pricePln),
    messages: product.messagesPerMonth,
    plans: product.plansPerMonth,
    current: currentName !== undefined && product.name === currentName,
  }));
}

const CO_DZIALA = [
  'Plan tygodnia — układacie go ręcznie, bez limitu',
  'Lista zakupów — dalej liczy się sama z planu',
  'Przepisy z katalogu i Waszego domu, także te od asystenta',
];

/**
 * C1 — wyczerpana pula próbna.
 *
 * Wiadomości i zapisy planu to DWA niezależne liczniki, więc mail mówi
 * o tym, który naprawdę padł. Makieta twierdziła „5 z 5 wiadomości i 1 z 1
 * planu" niezależnie od stanu.
 */
export function renderAiTrialExhausted(
  c: MailCtx,
  d: AiTrialExhaustedPayload,
): RenderedMail {
  const messagesOut = d.exhausted === 'messages';
  const subject = clipSubject(
    messagesOut
      ? 'Próbne wiadomości się skończyły'
      : 'Próbny zapis planu wykorzystany',
  );
  const preheader = messagesOut
    ? 'Plan, lista i przepisy działają dalej. Asystent czeka na plan.'
    : 'Rozmawiać z asystentem możesz dalej. Zapisać jego plan — już nie.';

  const wiad = `${d.messagesUsed} z ${d.messagesLimit} wiadomości`;
  const zapisy = `${d.plansUsed} z ${d.plansLimit} ${plural(d.plansLimit, 'zapisu', 'zapisów', 'zapisów')} planu`;
  const left = Math.max(0, d.messagesLimit - d.messagesUsed);

  const warnBody = messagesOut
    ? 'Dostęp próbny przysługuje raz i nie odnawia się.'
    : left > 0
      ? `Zostało Ci ${left} ${plural(left, 'wiadomość', 'wiadomości', 'wiadomości')} — asystent ułoży tydzień i pokaże go w odpowiedzi, ale do kalendarza już go nie zapisze.`
      : 'Wiadomości próbne też są wykorzystane. Dostęp próbny przysługuje raz.';

  const body =
    head(c, { name: false }) +
    h1(
      c,
      messagesOut
        ? 'Skończyły się wiadomości próbne'
        : 'Próbny zapis planu wykorzystany',
    ) +
    warn(c, {
      title: `Wykorzystane: ${esc(messagesOut ? wiad : zapisy)}`,
      body: esc(warnBody),
    }) +
    p(
      c,
      'Reszta aplikacji działa bez zmian: plan tygodnia układasz ręcznie bez limitu, lista zakupów dalej robi się z planu, przepisy są tam, gdzie były.',
      { pt: 20 },
    ) +
    p(
      c,
      'Asystent pamięta, czego nie jadacie, układa cały tydzień pod jedne zakupy i podmienia obiad, gdy plany się zmienią.',
      { pt: 14 },
    ) +
    plans(c, { items: planCards(), pt: 28 }) +
    btn(c, { label: 'Zobacz cennik', href: `${c.site}/#cennik` }) +
    p(
      c,
      `Plan włączasz w aplikacji: ${b(IN_APP_PATH)}. Płatność prowadzi App Store — zmienisz go albo wyłączysz w każdej chwili.`,
      { small: true, soft: true, pt: 22 },
    ) +
    foot(c, {
      reason:
        'bo dostęp próbny do asystenta w Twoim koncie został wykorzystany.',
    });

  const planLines = planCards()
    .map(
      (pl) =>
        `${pl.name} — ${pl.price} — ${pl.messages} wiadomości asystenta, ${pl.plans} zapisów planu`,
    )
    .join('\n');

  const text = `${messagesOut ? 'Skończyły się wiadomości próbne.' : 'Próbny zapis planu wykorzystany.'}

Wykorzystane: ${messagesOut ? wiad : zapisy}. ${warnBody}

Reszta aplikacji działa bez zmian: plan tygodnia układasz ręcznie bez limitu, lista zakupów dalej robi się z planu, przepisy są tam, gdzie były.

Asystent pamięta, czego nie jadacie, układa cały tydzień pod jedne zakupy i podmienia obiad, gdy plany się zmienią.

PLANY
${planLines}

Płaci jedna osoba, a pula jest wspólna dla całego gospodarstwa.

Zobacz cennik: ${c.site}/#cennik
Plan włączasz w aplikacji: ${IN_APP_PATH}.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, bo dostęp próbny do asystenta w Twoim koncie został wykorzystany.
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
 * C2 — wyczerpana pula w opłaconym planie. DWA warianty.
 *
 * Pula wisi na `sub:<id>`, czyli na jednej umowie dla całego domu. Adresatem
 * jest ten, kto uderzył w limit — bywa nim domownik, który niczego nie płaci
 * i dla którego przycisk „Zmień plan" byłby martwy.
 */
export function renderAiQuotaExhausted(
  c: MailCtx,
  d: AiQuotaExhaustedPayload,
): RenderedMail {
  const back = formatDay(d.renewsAtIso);
  const willRenew = d.renews && back !== null;

  const subject = clipSubject(
    willRenew ? `Asystent wraca ${back}` : 'Pula asystenta się skończyła',
  );
  const preheader = willRenew
    ? `Pula wiadomości odnowi się ${back}. Plan, lista i przepisy działają normalnie.`
    : 'Plan tygodnia, lista zakupów i przepisy działają normalnie.';

  const intro = willRenew
    ? `Wspólna pula wiadomości w Waszym domu się skończyła. Odnowi się ${esc(back)} — historia rozmów zostaje.`
    : 'Wspólna pula wiadomości w Waszym domu się skończyła. Odnawianie jest wyłączone, więc pula wróci dopiero po ponownym włączeniu planu.';

  const rows: [string, string][] = [
    ['Plan domu', esc(d.planName) + (d.isPayer ? ' (opłacasz go Ty)' : '')],
    ['Wiadomości asystenta', `${d.messagesUsed} z ${d.messagesLimit}`],
    ['Zapisy planu przez asystenta', `${d.plansUsed} z ${d.plansLimit}`],
  ];
  if (willRenew) rows.push(['Pula wraca', esc(back)]);
  else if (!d.renews) rows.push(['Odnawianie', 'wyłączone w App Store']);

  const platnik = d.payerName ? esc(d.payerName) : 'inna osoba w Waszym domu';

  const body =
    head(c, { name: false }) +
    h1(c, 'Asystent odpoczywa do końca okresu') +
    p(c, intro, { pt: 16 }) +
    (d.isPayer
      ? ''
      : p(
          c,
          `Plan opłaca ${platnik} — decyzja o zmianie jest po tej stronie.`,
          {
            pt: 14,
            small: true,
            soft: true,
          },
        )) +
    kv(c, rows, { title: 'Zużycie całego domu w tym okresie' }) +
    list(c, {
      title: 'Co działa bez asystenta',
      tone: 'ok',
      pt: 26,
      items: CO_DZIALA,
    }) +
    (d.isPayer
      ? btn(c, {
          label: 'Zmień plan',
          href: 'https://apps.apple.com/account/subscriptions',
          kind: 'secondary',
        }) +
        p(
          c,
          `Plan zmienisz w App Store albo w aplikacji: ${b(IN_APP_PATH)}. Wyższy plan działa od razu dla całego domu; niższy — od najbliższego odnowienia.`,
          { small: true, soft: true, pt: 22 },
        )
      : p(c, 'Nie musisz nic robić.', { small: true, soft: true, pt: 24 })) +
    foot(c, {
      reason:
        'bo wspólna pula wiadomości asystenta w Waszym domu się skończyła.',
    });

  const text = `Asystent odpoczywa do końca okresu.

${
  willRenew
    ? `Wspólna pula wiadomości w Waszym domu się skończyła. Odnowi się ${back} — historia rozmów zostaje.`
    : 'Wspólna pula wiadomości w Waszym domu się skończyła. Odnawianie jest wyłączone, więc pula wróci dopiero po ponownym włączeniu planu.'
}
${d.isPayer ? '' : `\nPlan opłaca ${d.payerName ?? 'inna osoba w Waszym domu'} — decyzja o zmianie jest po tej stronie.\n`}
ZUŻYCIE CAŁEGO DOMU W TYM OKRESIE
Plan domu: ${d.planName}${d.isPayer ? ' (opłacasz go Ty)' : ''}
Wiadomości asystenta: ${d.messagesUsed} z ${d.messagesLimit}
Zapisy planu przez asystenta: ${d.plansUsed} z ${d.plansLimit}
${willRenew ? `Pula wraca: ${back}` : 'Odnawianie: wyłączone w App Store'}

CO DZIAŁA BEZ ASYSTENTA
${CO_DZIALA.map((item) => `- ${item}`).join('\n')}

${
  d.isPayer
    ? `Zmień plan: https://apps.apple.com/account/subscriptions
Albo w aplikacji: ${IN_APP_PATH}. Wyższy plan działa od razu dla całego domu; niższy — od najbliższego odnowienia.`
    : 'Nie musisz nic robić.'
}

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, bo wspólna pula wiadomości asystenta w Waszym domu się skończyła.
Regulamin: ${c.site}/terms/ · Polityka prywatności: ${c.site}/privacy/ · Pomoc: ${c.site}/support/
Scoffie · scoffie.app`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}
