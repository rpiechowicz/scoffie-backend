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
 * DWA WARIANTY, bo backend nie zawsze zna datę końca łaski: `graceExpiresAt`
 * bierze się z `renewal?.gracePeriodExpiresDate`, a `renewal` bywa nieobecne.
 * Wariant bez daty nie zgaduje — mówi „przez najbliższe dni". Wpisanie tam
 * wyliczonych 16 dni byłoby podaniem terminu, którego Apple nie potwierdziło.
 *
 * Ceny NIE MA. `Subscription` nie przechowuje kwoty ani waluty; jedyne źródło
 * to cennik pomocniczy w kodzie. W mailu o nieudanej płatności zmyślona kwota
 * jest gorsza niż jej brak.
 */
export function renderSubscriptionGrace(
  c: MailCtx,
  d: SubscriptionGracePayload,
): RenderedMail {
  const until = formatDay(d.graceEndsAtIso);
  const subject = clipSubject('Płatność nie przeszła. Plan działa');
  const preheader = until
    ? `Apple ponowi próbę do ${until}. Do tego czasu u Was nic się nie zmienia.`
    : 'Apple ponawia próbę płatności. Przez ten czas plan działa u Was normalnie.';

  const rows: [string, string][] = [['Plan', esc(d.planName)]];
  if (until) rows.push(['Plan działa do', esc(until)]);

  const body =
    head(c, { name: false }) +
    h1(c, 'Płatność nie przeszła') +
    warn(c, {
      title: until
        ? `Plan działa normalnie do ${esc(until)}`
        : 'Plan działa normalnie — na razie nic nie tracicie',
      body: until
        ? 'Apple spróbuje pobrać opłatę jeszcze kilka razy. Jeśli karta jest aktualna, najprawdopodobniej nie musisz robić nic.'
        : 'Apple będzie próbowało pobrać opłatę jeszcze kilka razy przez najbliższe dni. Jeśli karta jest aktualna, najprawdopodobniej nie musisz robić nic.',
    }) +
    p(
      c,
      'Piszemy zawczasu, żeby to nie zaskoczyło Cię w środku układania planu na tydzień. Asystent działa w całym gospodarstwie tak jak wczoraj.',
      { pt: 20 },
    ) +
    p(
      c,
      `Jedna rzecz jednak się zmienia: ${b('pula wiadomości nie odnowi się, dopóki płatność nie przejdzie')} — do tego czasu zostaje Wam reszta z opłaconego okresu. Gdy Apple pobierze opłatę, pula rusza od nowa.`,
      { pt: 14 },
    ) +
    p(
      c,
      `Jeśli ${until ? `do ${esc(until)} ` : ''}płatność się nie uda, plan po prostu się wyłączy: asystent przestanie układać nowe tygodnie. ${b('Nic nie zniknie')} — plan tygodnia, lista zakupów, przepisy i gospodarstwo zostają na miejscu.`,
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
      'Płatności prowadzi App Store — kwotę, walutę i kartę zobaczysz i zmienisz tylko tam; my nie widzimy ani jednego, ani drugiego. Ta wiadomość nie jest paragonem; paragony i przypomnienia o odnowieniu wysyła Apple.',
      { small: true, soft: true, pt: 22 },
    ) +
    foot(c, {
      reason: 'bo App Store zgłosił nieudaną płatność za subskrypcję.',
    });

  const text = `Płatność nie przeszła. Plan działa.

${
  until
    ? `Plan działa normalnie do ${until}. Apple spróbuje pobrać opłatę jeszcze kilka razy — jeśli karta jest aktualna, najprawdopodobniej nie musisz robić nic.`
    : 'Plan działa normalnie. Apple będzie próbowało pobrać opłatę jeszcze kilka razy przez najbliższe dni.'
}

Piszemy zawczasu, żeby to nie zaskoczyło Cię w środku układania planu na tydzień.

Jedna rzecz się zmienia: pula wiadomości nie odnowi się, dopóki płatność nie przejdzie — do tego czasu zostaje Wam reszta z opłaconego okresu.

Jeśli ${until ? `do ${until} ` : ''}płatność się nie uda, plan się wyłączy: asystent przestanie układać nowe tygodnie. Nic nie zniknie — plan tygodnia, lista zakupów, przepisy i gospodarstwo zostają.

Plan: ${d.planName}${until ? `\nPlan działa do: ${until}` : ''}

NAJCZĘSTSZA PRZYCZYNA
- Karta straciła ważność albo została wymieniona przez bank
- Brakło środków w chwili, gdy Apple próbował pobrać opłatę
- Zmiana kraju lub regionu na koncie Apple

Ustawienia subskrypcji: ${APPLE_SUBSCRIPTIONS}

Płatności prowadzi App Store — kwotę, walutę i kartę zobaczysz i zmienisz tylko tam. Ta wiadomość nie jest paragonem.

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
 * BEZ SŁOWA „PRO". To nazwa poziomu w kodzie, której użytkownik nie widzi
 * nigdzie: kupuje „plan Solo / We dwoje / Rodzina", ekran nazywa się
 * „Asystent i plan", plakietka mówi „Plan Solo" albo „Dostęp próbny".
 *
 * Asystent NIE znika bezwarunkowo: po wygaśnięciu `resolvePlan` spada na plan
 * próbny (kto go nie ruszył, ma jeszcze pulę), a jeśli inny domownik ma żywą
 * subskrypcję, asystent działa u całego domu dalej. Mail musi to powiedzieć,
 * bo inaczej jest po prostu nieprawdziwy dla części odbiorców.
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
    ? `Apple cofnęło zakup subskrypcji${when ? ` ${esc(when)}` : ''} i zwróciło opłatę, więc dostęp do asystenta zamknął się od razu. Nie usunęliśmy niczego i nie zamknęliśmy Ci dostępu do domu.`
    : `Subskrypcja skończyła się${when ? ` ${esc(when)}` : ''}. Nie usunęliśmy niczego i nie zamknęliśmy Ci dostępu do domu — zmieniło się tylko to, co poniżej.`;

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
        'Asystent z Waszego planu — nowe wiadomości i układanie tygodnia za Was',
        'Miesięczna pula zapisów planu przez asystenta',
      ],
    }) +
    list(c, {
      title: 'Zostaje',
      tone: 'ok',
      pt: 24,
      items: [
        'Ręczne układanie planu tygodnia — działa jak zawsze i nigdy nie miało limitu',
        'Wszystkie dotychczasowe plany — otwierasz i zmieniasz jak dotąd',
        'Przepisy Waszego domu i katalog, razem z tymi od asystenta',
        'Lista zakupów i jej historia',
        'Gospodarstwo i wszyscy domownicy',
      ],
    }) +
    p(
      c,
      'Dwa wyjątki, o których warto wiedzieć: jeśli nie zużyłeś jeszcze puli próbnej, zostaje Ci z niej to, co było. A jeśli plan opłaca ktoś inny w Waszym domu, asystent działa dalej — z jego planu.',
      { pt: 22, small: true, soft: true },
    ) +
    p(
      c,
      'Wielu domom Scoffie bez asystenta wystarcza w zupełności — plan na tydzień da się kliknąć w dziesięć minut w niedzielę. Ale jeśli brakuje Ci tego, że ktoś układa go za Ciebie, plan włączysz z powrotem bez zakładania czegokolwiek od nowa.',
      { pt: 22 },
    ) +
    btn(c, { label: 'Włącz plan ponownie', href: APPLE_SUBSCRIPTIONS }) +
    p(
      c,
      `Możesz też zrobić to w aplikacji: ${b(IN_APP_PATH)}. Ostatni plan: ${esc(d.planName)} — wróć do niego albo wybierz inny, jeśli w domu zmieniła się liczba osób.`,
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
    ? `Apple cofnęło zakup subskrypcji${when ? ` ${when}` : ''} i zwróciło opłatę, więc dostęp do asystenta zamknął się od razu.`
    : `Subskrypcja skończyła się${when ? ` ${when}` : ''}. Nie usunęliśmy niczego i nie zamknęliśmy dostępu do domu.`
}

PRZESTAJE DZIAŁAĆ
- Asystent z Waszego planu — nowe wiadomości i układanie tygodnia za Was
- Miesięczna pula zapisów planu przez asystenta

ZOSTAJE
- Ręczne układanie planu tygodnia — działa jak zawsze i nigdy nie miało limitu
- Wszystkie dotychczasowe plany — otwierasz i zmieniasz jak dotąd
- Przepisy Waszego domu i katalog, razem z tymi od asystenta
- Lista zakupów i jej historia
- Gospodarstwo i wszyscy domownicy

Dwa wyjątki: jeśli nie zużyłeś jeszcze puli próbnej, zostaje Ci z niej to, co było. A jeśli plan opłaca ktoś inny w Waszym domu, asystent działa dalej z jego planu.

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
