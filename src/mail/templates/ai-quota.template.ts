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

/**
 * C1 — wyczerpana pula próbna.
 *
 * Wiadomości i zapisy planu to DWA niezależne liczniki, więc mail mówi o tym,
 * który naprawdę padł. Makieta twierdziła „5 z 5 wiadomości i 1 z 1 planu"
 * niezależnie od stanu — czyli pokazywała nieprawdziwą liczbę w wiadomości,
 * której jedynym celem jest sprzedaż planu.
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
    ? 'Plan tygodnia, lista zakupów i przepisy działają dalej — bez asystenta i bez limitu.'
    : 'Rozmawiać z asystentem możesz dalej. Zapisać jego plan do kalendarza — już nie.';

  const wiad = `${d.messagesUsed} z ${d.messagesLimit} ${plural(d.messagesLimit, 'wiadomości', 'wiadomości', 'wiadomości')}`;
  const zapisy = `${d.plansUsed} z ${d.plansLimit} ${plural(d.plansLimit, 'zapisu', 'zapisów', 'zapisów')} planu`;
  const leftMessages = Math.max(0, d.messagesLimit - d.messagesUsed);

  const body =
    head(c, { name: false }) +
    h1(
      c,
      messagesOut
        ? 'Skończyły się wiadomości z okresu próbnego'
        : 'Próbny zapis planu jest wykorzystany',
    ) +
    warn(c, {
      title: messagesOut
        ? `Wykorzystane: ${esc(wiad)}`
        : `Wykorzystane: ${esc(zapisy)}`,
      body: messagesOut
        ? `Drugi licznik: ${esc(zapisy)}. Dostęp próbny dostaje się raz i nie odnawia się — ale to nie koniec Scoffie.`
        : leftMessages > 0
          ? `Rozmawiać z asystentem możesz dalej — zostało ${leftMessages} ${plural(leftMessages, 'wiadomość', 'wiadomości', 'wiadomości')}. Ułoży Ci tydzień i pokaże go w odpowiedzi, ale zapisać do planu już go nie zdoła.`
          : `Drugi licznik też jest pusty: ${esc(wiad)}. Dostęp próbny dostaje się raz i nie odnawia się.`,
    }) +
    p(
      c,
      'Najważniejsze: reszta aplikacji zostaje z Tobą. Plan tygodnia układasz dalej po swojemu i nigdy nie miało to limitu, lista zakupów nadal robi się z planu, a przepisy — te z katalogu i te Waszego domu — są tam, gdzie były.',
      { pt: 20 },
    ) +
    p(
      c,
      'Asystent to ta część, która zdejmuje z Ciebie myślenie „co ugotować w czwartek”. Pamięta, czego nie jadacie, potrafi ułożyć cały tydzień pod jedne zakupy i podmienić jeden obiad, gdy plany się zmienią.',
      { pt: 14 },
    ) +
    plans(c, { items: planCards(), pt: 28 }) +
    btn(c, { label: 'Zobacz cennik', href: `${c.site}/#cennik` }) +
    p(
      c,
      `Plan włączasz w aplikacji: ${b(IN_APP_PATH)}. Płatność prowadzi App Store, więc zmienisz go albo wyłączysz w każdej chwili — bez rozmowy z nami i bez okresu wypowiedzenia.`,
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

  const text = `${messagesOut ? 'Skończyły się wiadomości z okresu próbnego.' : 'Próbny zapis planu jest wykorzystany.'}

Wiadomości: ${wiad} · Zapisy planu: ${zapisy}
Dostęp próbny dostaje się raz i nie odnawia się — ale to nie koniec Scoffie.

Reszta aplikacji zostaje z Tobą: plan tygodnia układasz dalej po swojemu (nigdy nie miało to limitu), lista zakupów nadal robi się z planu, przepisy z katalogu i Waszego domu są tam, gdzie były.

Asystent to ta część, która zdejmuje myślenie „co ugotować w czwartek”. Pamięta, czego nie jadacie, ułoży cały tydzień pod jedne zakupy i podmieni jeden obiad, gdy plany się zmienią.

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
 * jest ten, kto uderzył w limit — bywa nim domownik, który niczego nie płaci.
 * Mówienie mu „Twój plan" i pokazywanie przycisku „Zmień plan" byłoby
 * podwójnie nietrafione: to nie jego pula i nie jego rachunek.
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
    : 'Plan tygodnia, lista zakupów i przepisy działają normalnie — bez zmian.';

  const rows: [string, string][] = [
    [
      d.isPayer ? 'Plan domu' : 'Plan domu',
      esc(d.planName) + (d.isPayer ? ' (opłacasz go Ty)' : ''),
    ],
    ['Wiadomości asystenta', `${d.messagesUsed} z ${d.messagesLimit}`],
    ['Zapisy planu przez asystenta', `${d.plansUsed} z ${d.plansLimit}`],
  ];
  if (willRenew) rows.push(['Pula wraca', esc(back)]);
  else if (!d.renews) rows.push(['Odnawianie', 'wyłączone w App Store']);

  const intro = willRenew
    ? `Wspólna pula wiadomości w Waszym domu właśnie się skończyła. Odnowi się ${esc(back)} — wtedy wrócicie do rozmowy tam, gdzie ją zostawiliście, bo historia zostaje.`
    : 'Wspólna pula wiadomości w Waszym domu właśnie się skończyła. Odnawianie subskrypcji jest wyłączone, więc pula nie wróci sama — wróci dopiero, gdy plan zostanie włączony na nowo.';

  const body =
    head(c, { name: false }) +
    h1(c, 'Asystent odpoczywa do końca okresu') +
    p(c, intro, { pt: 16 }) +
    (d.isPayer
      ? ''
      : p(
          c,
          `Pula jest wspólna dla całego gospodarstwa — nie liczy się osobno dla każdego. Plan opłaca ${d.payerName ? esc(d.payerName) : 'inna osoba w Waszym domu'}, więc to po jej stronie jest decyzja, czy go zmienić.`,
          { pt: 14, small: true, soft: true },
        )) +
    kv(c, rows, { title: 'Zużycie całego domu w tym okresie' }) +
    list(c, {
      title: 'Co działa bez asystenta',
      tone: 'ok',
      pt: 26,
      items: [
        'Plan tygodnia — układacie go ręcznie, tyle razy, ile chcecie; to nigdy nie miało limitu',
        'Lista zakupów — dalej przelicza się sama z tego, co jest w planie',
        'Przepisy z katalogu i przepisy Waszego domu, razem z tymi od asystenta',
      ],
    }) +
    p(
      c,
      'Mała rada na przyszły okres: jedna dobrze opisana wiadomość („ułóż tydzień na cztery osoby, bez ryb, dwa obiady na dwa dni”) robi więcej niż pięć krótkich.',
      { pt: 24 },
    ) +
    (d.isPayer
      ? btn(c, {
          label: 'Zmień plan',
          href: 'https://apps.apple.com/account/subscriptions',
          kind: 'secondary',
        }) +
        p(
          c,
          `Plan prowadzi App Store — zmienisz go tam albo w aplikacji: ${b(IN_APP_PATH)}. Przejście na wyższy plan działa od razu i podnosi pulę całemu domowi; niższy wchodzi dopiero od najbliższego odnowienia. Jeśli obecny Wam wystarcza — nie musisz nic robić.`,
          { small: true, soft: true, pt: 22 },
        )
      : p(
          c,
          'Nie musisz nic robić. Jeśli w domu uznacie, że pula jest za mała, plan zmienia osoba, która go opłaca.',
          { small: true, soft: true, pt: 24 },
        )) +
    foot(c, {
      reason:
        'bo wspólna pula wiadomości asystenta w Waszym domu się skończyła.',
    });

  const text = `Asystent odpoczywa do końca okresu.

${willRenew ? `Wspólna pula wiadomości w Waszym domu właśnie się skończyła. Odnowi się ${back} — wtedy wrócicie do rozmowy tam, gdzie ją zostawiliście, bo historia zostaje.` : 'Wspólna pula wiadomości w Waszym domu właśnie się skończyła. Odnawianie subskrypcji jest wyłączone, więc pula nie wróci sama.'}
${d.isPayer ? '' : `\nPula jest wspólna dla całego gospodarstwa. Plan opłaca ${d.payerName ?? 'inna osoba w Waszym domu'}.\n`}
ZUŻYCIE CAŁEGO DOMU W TYM OKRESIE
Plan domu: ${d.planName}${d.isPayer ? ' (opłacasz go Ty)' : ''}
Wiadomości asystenta: ${d.messagesUsed} z ${d.messagesLimit}
Zapisy planu przez asystenta: ${d.plansUsed} z ${d.plansLimit}
${willRenew ? `Pula wraca: ${back}` : 'Odnawianie: wyłączone w App Store'}

CO DZIAŁA BEZ ASYSTENTA
- Plan tygodnia — układacie go ręcznie, tyle razy, ile chcecie; to nigdy nie miało limitu
- Lista zakupów — dalej przelicza się sama z tego, co jest w planie
- Przepisy z katalogu i przepisy Waszego domu, razem z tymi od asystenta

Mała rada na przyszły okres: jedna dobrze opisana wiadomość („ułóż tydzień na cztery osoby, bez ryb”) robi więcej niż pięć krótkich.

${
  d.isPayer
    ? `Zmień plan: https://apps.apple.com/account/subscriptions
Albo w aplikacji: ${IN_APP_PATH}. Przejście na wyższy plan działa od razu i podnosi pulę całemu domowi; niższy wchodzi od najbliższego odnowienia.`
    : 'Nie musisz nic robić. Jeśli w domu uznacie, że pula jest za mała, plan zmienia osoba, która go opłaca.'
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
