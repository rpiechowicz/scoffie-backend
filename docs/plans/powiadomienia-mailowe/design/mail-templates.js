/* Scoffie — szablony transakcyjne A–G. Treść po polsku, na „ty", formy neutralne
   płciowo (nie wiemy, kto to jest — mamy tylko nazwę wyświetlaną z aplikacji).
   Ton: jak notatka od kogoś z domu. Ciepło i konkretnie, bez wykrzykników. */
const MAIL = (function () {
const H = MK.HOST;
const clip = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
const fill = (s, d) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => d[k] != null ? d[k] : '{{' + k + '}}');

const SAMPLE = {
  nazwa_wyswietlana: 'Marta',
  nazwa_gospodarstwa: 'Dom na Wiśniowej',
  domownicy: ['Marta Wrona', 'Kuba', 'Zosia'],
  adres_email: 'marta@icloud.com',
  plan: 'Solo', plan_id: 'solo', cena: '29,99 zł/mc',
  limit_wiadomosci: '30', zuzyte_wiadomosci: '30', limit_planow: '8', zuzyte_plany: '6',
  data_odnowienia: '14 października', data_konca_lask: '17 września',
  data_wygasniecia: '3 września', data_usuniecia: '10 września 2026', data_wejscia: '1 października'
};
const FOOT = { A: 'bo na ten adres powstało konto w Scoffie.', B: 'bo Twoje konto zostało dodane do gospodarstwa.',
  C1: 'bo trial asystenta w Twoim koncie został wykorzystany do końca.', C2: 'bo pula wiadomości asystenta w Twoim planie się skończyła.',
  D: 'bo App Store zgłosił nieudaną płatność za subskrypcję.', E: 'bo subskrypcja PRO w Twoim koncie wygasła.',
  F: 'bo konto powiązane z tym adresem zostało usunięte.', G: 'bo zmieniają się warunki, na jakich korzystasz z konta.' };
const b = s => `<b style="font-weight:700;">${s}</b>`;

const T = [];

/* A — Witaj w Scoffie */
T.push({
  id: 'A', name: 'Witaj w Scoffie', trigger: 'po ukończeniu onboardingu (pierwsze uruchomienie po Sign in with Apple)',
  subject: 'Twoje konto w Scoffie jest gotowe',
  preheader: 'Załóż dom, zaproś swoich i zaplanuj pierwszy tydzień. Zajmie to kilka minut.',
  vars: ['nazwa_wyswietlana'],
  blocks: ['nagłówek ze nazwą', 'przycisk główny', 'co dalej (3 kroki)', 'panel z trialem', 'stopka'],
  body: (c, d) => MK.head(c) + MK.h1(c, 'Masz konto. Zacznij od planu na ten tydzień.')
    + MK.lead(c, `Cześć, ${MK.v(c, 'nazwa_wyswietlana', d.nazwa_wyswietlana)}. Dobrze Cię tu widzieć.`)
    + MK.p(c, 'Scoffie zbiera w jednym miejscu to, co u większości domów rozjeżdża się po karteczkach i głowach: co jecie w tym tygodniu, co trzeba kupić i gdzie są te przepisy, które faktycznie się powtarzają. Jeden plan, jedna lista, jeden dom.', { pt: 12 })
    + MK.btn(c, { label: 'Otwórz Scoffie', href: H + '/otworz' })
    + MK.steps(c, { title: 'Od czego zacząć', items: [
      { t: 'Załóż dom', d: 'Nadaj mu nazwę — choćby „Wiśniowa" albo „U nas". To on trzyma plan, listę zakupów i przepisy.' },
      { t: 'Zaproś domowników linkiem', d: 'Kto otworzy link, od razu widzi ten sam plan i tę samą listę. Bez zakładania niczego od nowa.' },
      { t: 'Zaplanuj pierwszy tydzień', d: 'Wybierz posiłki na siedem dni albo powiedz asystentowi, co lubicie i czego nie — ułoży plan za Ciebie.' }] })
    + MK.p(c, `Lista zakupów robi się sama z tego, co wrzucisz do planu — nie musisz jej pisać. Jak coś zmienisz w środę wieczorem, lista też się zmieni.`, { pt: 26 })
    + MK.panel(c, { pt: 22, html: `<div class="ink" style="font:700 15px/23px ${c.ff};color:${c.p.ink};">Na start masz trial asystenta</div><div class="soft" style="font:400 15px/23px ${c.ff};color:${c.p.soft};padding-top:3px;">5 wiadomości i 1 gotowy plan tygodnia — dobrze wykorzystać je na tydzień, który naprawdę chcesz przetestować. Trial dostajesz raz i nie odnawia się.</div>` })
    + MK.p(c, `Jak coś nie zagra albo czegoś nie znajdziesz — napisz do nas przez <a href="${H}/support/" style="color:${c.p.terra};text-decoration:underline;">pomoc</a>. Odpisujemy jak ludzie, nie jak formularz.`, { small: true, soft: true, pt: 22 })
    + MK.foot(c, { reason: FOOT.A }),
  text: d => `Masz konto. Zacznij od planu na ten tydzień.

Cześć, {{nazwa_wyswietlana}}. Dobrze Cię tu widzieć.

Scoffie zbiera w jednym miejscu to, co u większości domów rozjeżdża się po karteczkach i głowach: co jecie w tym tygodniu, co trzeba kupić i gdzie są te przepisy, które faktycznie się powtarzają. Jeden plan, jedna lista, jeden dom.

Otwórz Scoffie: ${H}/otworz

OD CZEGO ZACZĄĆ
1. Załóż dom — nadaj mu nazwę, choćby „Wiśniowa". To on trzyma plan, listę zakupów i przepisy.
2. Zaproś domowników linkiem — kto otworzy link, od razu widzi ten sam plan i tę samą listę.
3. Zaplanuj pierwszy tydzień — wybierz posiłki na siedem dni albo powiedz asystentowi, co lubicie.

Lista zakupów robi się sama z tego, co wrzucisz do planu — nie musisz jej pisać.

Na start masz trial asystenta: 5 wiadomości i 1 gotowy plan tygodnia. Dostajesz go raz i nie odnawia się.

Jak coś nie zagra — napisz: ${H}/support/

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.A}
Regulamin: ${H}/terms/ · Polityka prywatności: ${H}/privacy/ · Pomoc: ${H}/support/
Scoffie · scoffie.app`
});

/* B — Witaj w gospodarstwie */
T.push({
  id: 'B', name: 'Witaj w gospodarstwie', trigger: 'po przyjęciu zaproszenia linkiem do cudzego gospodarstwa',
  subject: 'Witaj w gospodarstwie {{nazwa_gospodarstwa}}',
  subjectOf: d => clip('Witaj w gospodarstwie ' + d.nazwa_gospodarstwa, 45),
  subjectNote: 'Nazwa gospodarstwa bywa długa — temat ucinamy do 45 znaków z wielokropkiem.',
  preheader: 'Plan tygodnia, lista zakupów i przepisy domu są od teraz wspólne. Zobacz, co już jest.',
  vars: ['nazwa_gospodarstwa', 'domownicy', 'liczba_domownikow'],
  blocks: ['nagłówek ze nazwą', 'karta gospodarstwa', 'lista', 'przycisk główny', 'panel o PRO', 'stopka'],
  body: (c, d) => MK.head(c) + MK.h1(c, 'Jesteś w domu')
    + MK.p(c, 'Zaproszenie przyjęte — od teraz planujecie jedzenie razem.', { pt: 14 })
    + MK.house(c, { name: d.nazwa_gospodarstwa, members: d.domownicy, pt: 20 })
    + MK.p(c, 'Wszystko, co tu jest, jest wspólne. Jak dorzucisz coś do listy zakupów w drodze z pracy, pozostali zobaczą to od razu — i odwrotnie, więc nikt nie kupi drugiego opakowania jajek.', { pt: 20 })
    + MK.list(c, { title: 'Co widzisz wspólnie', items: [
      `${b('Plan tygodnia')} — śniadania, obiady, kolacje i przekąski na każdy dzień. Możesz go zmieniać, nie tylko przeglądać.`,
      `${b('Lista zakupów')} — składa się sama z tego, co jest w planie. Odhaczanie widzą wszyscy w czasie realnym.`,
      `${b('Przepisy domu')} — wspólny katalog obok Twoich własnych. Twoje prywatne zostają Twoje.`] })
    + MK.btn(c, { label: 'Zobacz plan tygodnia', href: H + '/plan' })
    + MK.p(c, 'Dobry pierwszy krok: wejdź w plan i sprawdź, czy jest tam coś, czego nie jadasz. Podmiana pojedynczego posiłku to dwa dotknięcia.', { pt: 24 })
    + MK.panel(c, { pt: 22, html: `<div class="ink" style="font:700 15px/23px ${c.ff};color:${c.p.ink};">Jeśli ktoś w domu ma PRO, asystent działa też u Ciebie</div><div class="soft" style="font:400 15px/23px ${c.ff};color:${c.p.soft};padding-top:3px;">Subskrypcja należy do tej osoby i to ona ją rozlicza — Ty nic nie opłacasz. Gdyby kiedyś ją wyłączyła, plan, lista i przepisy zostają; zniknie tylko asystent.</div>` })
    + MK.foot(c, { reason: FOOT.B }),
  text: d => `Jesteś w domu.

Zaproszenie przyjęte — od teraz planujecie jedzenie razem.

Gospodarstwo: {{nazwa_gospodarstwa}}
Domownicy ({{liczba_domownikow}}): {{domownicy}}

Wszystko, co tu jest, jest wspólne. Jak dorzucisz coś do listy zakupów w drodze z pracy, pozostali zobaczą to od razu.

CO WIDZISZ WSPÓLNIE
- Plan tygodnia — śniadania, obiady, kolacje i przekąski na każdy dzień. Możesz go zmieniać.
- Lista zakupów — składa się sama z tego, co jest w planie. Odhaczanie widzą wszyscy.
- Przepisy domu — wspólny katalog obok Twoich własnych. Twoje prywatne zostają Twoje.

Zobacz plan tygodnia: ${H}/plan

Dobry pierwszy krok: sprawdź w planie, czy jest tam coś, czego nie jadasz. Podmiana posiłku to dwa dotknięcia.

Jeśli ktoś w domu ma PRO, asystent działa też u Ciebie. Subskrypcja należy do tej osoby — Ty nic nie opłacasz.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.B}
Regulamin: ${H}/terms/ · Polityka prywatności: ${H}/privacy/ · Pomoc: ${H}/support/
Scoffie · scoffie.app`
});

/* C1 — trial wyczerpany */
T.push({
  id: 'C1', name: 'Limit asystenta — koniec triala', trigger: '5. wiadomość triala albo 1. plan triala zużyty',
  subject: 'Trial asystenta się skończył',
  preheader: '5 wiadomości i 1 plan są za Tobą. Plan, lista i przepisy działają dalej, bez limitu.',
  vars: ['brak — treść jest stała'],
  blocks: ['nagłówek (znak)', 'blok uwagi', 'zestawienie planów', 'przycisk główny', 'stopka'],
  body: (c, d) => MK.head(c, { name: false }) + MK.h1(c, 'Trial asystenta się skończył')
    + MK.warn(c, { title: 'Wykorzystane: 5 z 5 wiadomości i 1 z 1 planu', body: 'Trial dostaje się raz i nie odnawia się — ale to nie koniec Scoffie.' })
    + MK.p(c, 'Najważniejsze: reszta aplikacji zostaje z Tobą bez żadnych limitów. Plan tygodnia układasz dalej po swojemu, lista zakupów nadal robi się z planu, a przepisy — własne i domu — są tam, gdzie były.', { pt: 20 })
    + MK.p(c, 'Asystent to ta część, która zdejmuje z Ciebie myślenie „co ugotować w czwartek". Pamięta, czego nie jadacie, potrafi ułożyć cały tydzień pod jedne zakupy i podmienić jeden obiad, gdy plany się zmienią.', { pt: 14 })
    + MK.plans(c, { pt: 28 })
    + MK.btn(c, { label: 'Zobacz plany', href: H + '/plany' })
    + MK.p(c, 'Płatność prowadzi App Store, więc plan zmienisz albo wyłączysz w każdej chwili w ustawieniach subskrypcji — bez rozmowy z nami i bez okresu wypowiedzenia.', { small: true, soft: true, pt: 22 })
    + MK.foot(c, { reason: FOOT.C1 }),
  text: d => `Trial asystenta się skończył.

Wykorzystane: 5 z 5 wiadomości i 1 z 1 planu. Trial dostaje się raz i nie odnawia się — ale to nie koniec Scoffie.

Reszta aplikacji zostaje z Tobą bez limitów: plan tygodnia układasz dalej po swojemu, lista zakupów nadal robi się z planu, przepisy własne i domu są tam, gdzie były.

Asystent to ta część, która zdejmuje myślenie „co ugotować w czwartek". Pamięta, czego nie jadacie, ułoży cały tydzień pod jedne zakupy i podmieni jeden obiad, gdy plany się zmienią.

PLANY
Solo — 29,99 zł/mc — 30 wiadomości asystenta, 8 planów tygodnia
We dwoje — 39,99 zł/mc — 50 wiadomości asystenta, 12 planów tygodnia
Rodzina — 49,99 zł/mc — 75 wiadomości asystenta, 18 planów tygodnia

Subskrypcja należy do jednej osoby, a PRO działa u wszystkich w gospodarstwie.

Zobacz plany: ${H}/plany

Płatność prowadzi App Store — plan zmienisz albo wyłączysz w każdej chwili.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.C1}
Regulamin: ${H}/terms/ · Polityka prywatności: ${H}/privacy/ · Pomoc: ${H}/support/
Scoffie · scoffie.app`
});

/* C2 — pula w opłaconym planie wyczerpana */
T.push({
  id: 'C2', name: 'Limit asystenta — pula w planie', trigger: 'ostatnia wiadomość z puli w opłaconym planie',
  subject: 'Asystent wraca {{data_odnowienia}}',
  subjectOf: d => clip('Asystent wraca ' + d.data_odnowienia, 45),
  preheader: 'Pula wiadomości odnowi się 14 października. Plan, lista i przepisy działają normalnie.',
  vars: ['plan', 'zuzyte_wiadomosci', 'limit_wiadomosci', 'zuzyte_plany', 'limit_planow', 'data_odnowienia'],
  blocks: ['nagłówek (znak)', 'klucz–wartość', 'lista', 'przycisk drugorzędny', 'stopka'],
  body: (c, d) => MK.head(c, { name: false }) + MK.h1(c, 'Asystent odpoczywa do końca okresu')
    + MK.p(c, `Pula wiadomości w Twoim planie właśnie się skończyła. Odnowi się ${MK.v(c, 'data_odnowienia', d.data_odnowienia)} — wtedy wrócicie do rozmowy tam, gdzie ją zostawiliście, bo historia zostaje.`, { pt: 16 })
    + MK.kv(c, [
      ['Twój plan', MK.v(c, 'plan', d.plan)],
      ['Wiadomości asystenta', MK.v(c, 'zuzyte_wiadomosci', d.zuzyte_wiadomosci) + ' z ' + MK.v(c, 'limit_wiadomosci', d.limit_wiadomosci)],
      ['Plany tygodnia', MK.v(c, 'zuzyte_plany', d.zuzyte_plany) + ' z ' + MK.v(c, 'limit_planow', d.limit_planow)],
      ['Pula wraca', MK.v(c, 'data_odnowienia', d.data_odnowienia)]], { title: 'Zużycie w tym okresie' })
    + MK.list(c, { title: 'Co działa bez asystenta', tone: 'ok', pt: 26, items: [
      'Plan tygodnia — przeciągasz posiłki w kalendarzu, tyle razy, ile chcesz',
      'Lista zakupów — dalej przelicza się sama z tego, co jest w planie',
      'Przepisy własne i domu, razem z tym, co asystent podał wcześniej'] })
    + MK.p(c, 'Mała rada na przyszły okres: jedna dobrze opisana wiadomość („ułóż tydzień na cztery osoby, bez ryb, dwa obiady na dwa dni") robi więcej niż pięć krótkich.', { pt: 24 })
    + MK.btn(c, { label: 'Zmień plan', href: H + '/plany', kind: 'secondary' })
    + MK.p(c, 'Zmiana planu działa od razu i dopisuje resztę puli. Jeśli obecny plan Ci wystarcza — nie musisz nic robić, po prostu wróć po odnowieniu.', { small: true, soft: true, pt: 22 })
    + MK.foot(c, { reason: FOOT.C2 }),
  text: d => `Asystent odpoczywa do końca okresu.

Pula wiadomości w Twoim planie właśnie się skończyła. Odnowi się {{data_odnowienia}} — wtedy wrócicie do rozmowy tam, gdzie ją zostawiliście, bo historia zostaje.

ZUŻYCIE W TYM OKRESIE
Twój plan: {{plan}}
Wiadomości asystenta: {{zuzyte_wiadomosci}} z {{limit_wiadomosci}}
Plany tygodnia: {{zuzyte_plany}} z {{limit_planow}}
Pula wraca: {{data_odnowienia}}

CO DZIAŁA BEZ ASYSTENTA
- Plan tygodnia — przeciągasz posiłki w kalendarzu, tyle razy, ile chcesz
- Lista zakupów — dalej przelicza się sama z tego, co jest w planie
- Przepisy własne i domu, razem z tym, co asystent podał wcześniej

Mała rada na przyszły okres: jedna dobrze opisana wiadomość („ułóż tydzień na cztery osoby, bez ryb") robi więcej niż pięć krótkich.

Zmień plan: ${H}/plany

Zmiana planu działa od razu i dopisuje resztę puli. Jeśli obecny plan Ci wystarcza — nie musisz nic robić.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.C2}
Regulamin: ${H}/terms/ · Polityka prywatności: ${H}/privacy/ · Pomoc: ${H}/support/
Scoffie · scoffie.app`
});

/* D — problem z płatnością (okres łaski) */
T.push({
  id: 'D', name: 'Problem z płatnością', trigger: 'App Store zgłasza nieudane odnowienie — subskrypcja w okresie łaski',
  subject: 'Płatność nie przeszła. PRO działa',
  preheader: 'Apple ponowi próbę do 17 września. Do tego czasu u Ciebie nic się nie zmienia.',
  vars: ['plan', 'cena', 'data_konca_lask'],
  blocks: ['nagłówek (znak)', 'blok uwagi', 'klucz–wartość', 'lista', 'przycisk główny (App Store)', 'stopka'],
  body: (c, d) => MK.head(c, { name: false }) + MK.h1(c, 'Płatność nie przeszła')
    + MK.warn(c, { title: `PRO działa normalnie do ${MK.v(c, 'data_konca_lask', d.data_konca_lask)}`, body: 'Apple spróbuje pobrać opłatę jeszcze kilka razy. Jeśli karta jest aktualna, najprawdopodobniej nie musisz robić nic.' })
    + MK.p(c, 'Piszemy zawczasu, żeby to nie zaskoczyło Cię w środku układania planu na tydzień. Asystent i limity planów działają w całym gospodarstwie tak jak wczoraj.', { pt: 20 })
    + MK.p(c, `Jeśli do ${MK.v(c, 'data_konca_lask', d.data_konca_lask)} płatność się nie uda, PRO po prostu się wyłączy: asystent przestanie odpowiadać i wróci limit planów. ${b('Nic nie zniknie')} — plan tygodnia, lista zakupów, przepisy i gospodarstwo zostają na miejscu.`, { pt: 14 })
    + MK.kv(c, [['Plan', MK.v(c, 'plan', d.plan)], ['Cena', MK.v(c, 'cena', d.cena)], ['PRO działa do', MK.v(c, 'data_konca_lask', d.data_konca_lask)]])
    + MK.list(c, { title: 'Najczęstsza przyczyna', pt: 26, items: [
      'Karta straciła ważność albo została wymieniona przez bank',
      'Brakło środków w chwili, gdy Apple próbował pobrać opłatę',
      'Zmiana kraju lub regionu na koncie Apple'] })
    + MK.btn(c, { label: 'Ustawienia subskrypcji', href: 'https://apps.apple.com/account/subscriptions' })
    + MK.p(c, 'Płatności prowadzi App Store — kartę i subskrypcję zmienisz tylko tam, my nie widzimy żadnych danych karty. Ta wiadomość nie jest paragonem; paragony i przypomnienia o odnowieniu wysyła Apple.', { small: true, soft: true, pt: 22 })
    + MK.foot(c, { reason: FOOT.D }),
  text: d => `Płatność nie przeszła. PRO działa.

PRO działa normalnie do {{data_konca_lask}}. Apple spróbuje pobrać opłatę jeszcze kilka razy — jeśli karta jest aktualna, najprawdopodobniej nie musisz robić nic.

Piszemy zawczasu, żeby to nie zaskoczyło Cię w środku układania planu na tydzień.

Jeśli do {{data_konca_lask}} płatność się nie uda, PRO się wyłączy: asystent przestanie odpowiadać i wróci limit planów. Nic nie zniknie — plan tygodnia, lista zakupów, przepisy i gospodarstwo zostają.

Plan: {{plan}}
Cena: {{cena}}
PRO działa do: {{data_konca_lask}}

NAJCZĘSTSZA PRZYCZYNA
- Karta straciła ważność albo została wymieniona przez bank
- Brakło środków w chwili, gdy Apple próbował pobrać opłatę
- Zmiana kraju lub regionu na koncie Apple

Ustawienia subskrypcji: https://apps.apple.com/account/subscriptions

Płatności prowadzi App Store — kartę zmienisz tylko tam, my nie widzimy danych karty. Ta wiadomość nie jest paragonem.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.D}
Regulamin: ${H}/terms/ · Polityka prywatności: ${H}/privacy/ · Pomoc: ${H}/support/
Scoffie · scoffie.app`
});

/* E — subskrypcja wygasła */
T.push({
  id: 'E', name: 'Subskrypcja wygasła', trigger: 'koniec okresu łaski albo świadome wyłączenie odnowienia',
  subject: 'PRO wygasło. Plany zostają',
  preheader: 'Asystent i limity planów są wyłączone. Wszystko, co już ugotowaliście, zostaje.',
  vars: ['plan', 'cena', 'data_wygasniecia'],
  blocks: ['nagłówek ze nazwą', 'dwie listy (nie działa / zostaje)', 'przycisk główny', 'stopka'],
  body: (c, d) => MK.head(c) + MK.h1(c, 'PRO wygasło. Kuchnia zostaje')
    + MK.p(c, `Subskrypcja skończyła się ${MK.v(c, 'data_wygasniecia', d.data_wygasniecia)}. Nie usunęliśmy niczego i nie zamknęliśmy Ci dostępu do domu — zmieniło się tylko to, co poniżej.`, { pt: 16 })
    + MK.list(c, { title: 'Przestaje działać', tone: 'off', pt: 26, items: [
      'Asystent AI — nowe wiadomości i układanie planu za Ciebie',
      'Limit planów tygodnia z PRO — nowe plany układasz ręcznie'] })
    + MK.list(c, { title: 'Zostaje', tone: 'ok', pt: 24, items: [
      'Wszystkie dotychczasowe plany tygodnia — otwierasz i zmieniasz jak dotąd',
      'Przepisy własne i przepisy domu, razem z tymi od asystenta',
      'Lista zakupów i jej historia',
      'Gospodarstwo i wszyscy domownicy'] })
    + MK.p(c, 'Wielu domom Scoffie bez asystenta wystarcza w zupełności — plan na tydzień da się kliknąć w dziesięć minut w niedzielę. Ale jeśli brakuje Ci tego, że ktoś układa go za Ciebie, PRO wraca od razu i w dwóch dotknięciach, bez zakładania czegokolwiek od nowa.', { pt: 24 })
    + MK.btn(c, { label: 'Wróć do PRO', href: H + '/plany' })
    + MK.p(c, `Ostatni plan: ${MK.v(c, 'plan', d.plan)} — ${MK.v(c, 'cena', d.cena)}. Możesz wrócić do niego albo wybrać inny, jeśli w domu zmieniła się liczba osób.`, { small: true, soft: true, pt: 22 })
    + MK.foot(c, { reason: FOOT.E }),
  text: d => `PRO wygasło. Kuchnia zostaje.

Subskrypcja skończyła się {{data_wygasniecia}}. Nie usunęliśmy niczego i nie zamknęliśmy dostępu do domu.

PRZESTAJE DZIAŁAĆ
- Asystent AI — nowe wiadomości i układanie planu za Ciebie
- Limit planów tygodnia z PRO — nowe plany układasz ręcznie

ZOSTAJE
- Wszystkie dotychczasowe plany tygodnia — otwierasz i zmieniasz jak dotąd
- Przepisy własne i przepisy domu, razem z tymi od asystenta
- Lista zakupów i jej historia
- Gospodarstwo i wszyscy domownicy

Wielu domom Scoffie bez asystenta wystarcza — plan na tydzień da się kliknąć w dziesięć minut w niedzielę. Jeśli jednak brakuje Ci tego, że ktoś układa go za Ciebie, PRO wraca od razu.
Wróć do PRO: ${H}/plany

Ostatni plan: {{plan}} — {{cena}}. Możesz wrócić do niego albo wybrać inny.

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.E}
Regulamin: ${H}/terms/ · Polityka prywatności: ${H}/privacy/ · Pomoc: ${H}/support/
Scoffie · scoffie.app`
});

/* F — konto usunięte */
T.push({
  id: 'F', name: 'Konto usunięte', trigger: 'w chwili usunięcia konta (nieodwracalne — bez przycisku „anuluj")',
  subject: 'Twoje konto zostało usunięte',
  preheader: 'Dane konta są usunięte. Przepisy dodane do wspólnego katalogu w nim zostają.',
  vars: ['adres_email', 'data_usuniecia'],
  blocks: ['nagłówek (znak)', 'klucz–wartość', 'dwa akapity z faktami', 'link do pomocy', 'stopka'],
  body: (c, d) => MK.head(c, { name: false }) + MK.h1(c, 'Konto usunięte')
    + MK.p(c, 'Zrobione — konto i jego dane zniknęły ze Scoffie. Tego nie da się cofnąć, więc piszemy tylko po to, żeby zostało Ci to na papierze i żeby było jasne, co dalej z rzeczami, które były wspólne.', { pt: 16 })
    + MK.kv(c, [['Konto', MK.v(c, 'adres_email', d.adres_email)], ['Usunięte', MK.v(c, 'data_usuniecia', d.data_usuniecia)]])
    + MK.p(c, `${b('Przepisy we wspólnym katalogu zostają.')} To, co trafiło do katalogu domu albo do katalogu publicznego, jest już częścią wspólnego zbioru — Twoi domownicy dalej mają z tego kolacje i nikomu nie znika plan w połowie tygodnia. Prywatne przepisy i plany, które były tylko Twoje, zostały usunięte razem z kontem.`, { pt: 26 })
    + MK.p(c, `${b('Okres próbny nie wraca.')} Jeśli kiedyś powstanie tu nowe konto, trial asystenta się nie odnowi — 5 wiadomości i 1 plan przysługują raz. Wszystko inne w aplikacji będzie działać od pierwszej minuty.`, { pt: 14 })
    + MK.p(c, 'Nie prosimy o nic więcej i nie wysyłamy już żadnych wiadomości. Dziękujemy za czas spędzony w Scoffie — i za każdy przepis, który po Tobie został.', { pt: 14 })
    + MK.textLink(c, { label: 'Zostały pytania? Pomoc — scoffie.app/support', href: H + '/support/', pt: 16 })
    + MK.foot(c, { reason: FOOT.F }),
  text: d => `Konto usunięte.

Zrobione — konto i jego dane zniknęły ze Scoffie. Tego nie da się cofnąć, więc piszemy tylko po to, żeby zostało Ci to na papierze.

Konto: {{adres_email}}
Usunięte: {{data_usuniecia}}

Przepisy we wspólnym katalogu zostają. To, co trafiło do katalogu domu albo publicznego, jest już częścią wspólnego zbioru — Twoi domownicy dalej mają z tego kolacje. Prywatne przepisy i plany zostały usunięte razem z kontem.

Okres próbny nie wraca. Jeśli kiedyś powstanie tu nowe konto, trial asystenta się nie odnowi — 5 wiadomości i 1 plan przysługują raz.

Nie prosimy o nic więcej i nie wysyłamy już żadnych wiadomości. Dziękujemy za czas spędzony w Scoffie.

Zostały pytania? ${H}/support/

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.F}
Regulamin: ${H}/terms/ · Polityka prywatności: ${H}/privacy/
Scoffie · scoffie.app`
});

/* G — zmiana regulaminu / polityki prywatności */
T.push({
  id: 'G', name: 'Zmiana regulaminu', trigger: 'publikacja nowej wersji dokumentów — wysyłka przed datą wejścia w życie',
  subject: 'Zmieniamy regulamin od {{data_wejscia}}',
  subjectOf: d => clip('Zmieniamy regulamin od ' + d.data_wejscia, 45),
  preheader: 'Wchodzi w życie 1 października. Trzy punkty streszczenia i pełne dokumenty.',
  vars: ['data_wejscia'],
  blocks: ['nagłówek (znak)', 'klucz–wartość', 'lista zmian', 'przycisk główny', 'stopka'],
  body: (c, d) => MK.head(c, { name: false }) + MK.h1(c, 'Zmieniamy regulamin i politykę prywatności')
    + MK.p(c, 'Bez owijania: poniżej data i to, co się zmienia. Streszczenie jest po ludzku, ale wiąże tekst dokumentu, nie ten mail.', { pt: 16 })
    + MK.kv(c, [['Wchodzi w życie', MK.v(c, 'data_wejscia', d.data_wejscia)], ['Dotyczy', 'Regulaminu i Polityki prywatności']], { pt: 20 })
    + MK.list(c, { title: 'Co się zmienia', pt: 26, items: [
      `${b('Asystent AI')} — opisujemy, co wysyłamy do modelu (treść Twojej prośby i plan), czego nie wysyłamy i jak długo trzymamy rozmowy.`,
      `${b('Usunięcie konta z gospodarstwa')} — precyzujemy, co dzieje się z przepisami i planami, które zostały we wspólnym katalogu.`,
      `${b('Nazwa usługi')} — Weekly Meals występuje w dokumentach jako Scoffie. Zmiana redakcyjna, ta sama firma i ta sama aplikacja.`] })
    + MK.p(c, `Dalsze korzystanie ze Scoffie po ${MK.v(c, 'data_wejscia', d.data_wejscia)} oznacza akceptację nowej wersji. Jeśli się nie zgadzasz, konto usuniesz w Ustawieniach — bez pisania do nas i bez pytań.`, { pt: 24 })
    + MK.btn(c, { label: 'Przeczytaj regulamin', href: H + '/terms/' })
    + MK.textLink(c, { label: 'Polityka prywatności — scoffie.app/privacy', href: H + '/privacy/', pt: 8 })
    + MK.foot(c, { reason: FOOT.G }),
  text: d => `Zmieniamy regulamin i politykę prywatności.

Bez owijania: poniżej data i to, co się zmienia. Streszczenie jest po ludzku, ale wiąże tekst dokumentu, nie ten mail.

Wchodzi w życie: {{data_wejscia}}
Dotyczy: Regulaminu i Polityki prywatności

CO SIĘ ZMIENIA
1. Asystent AI — opisujemy, co wysyłamy do modelu, czego nie wysyłamy i jak długo trzymamy rozmowy.
2. Usunięcie konta z gospodarstwa — precyzujemy, co dzieje się z przepisami i planami we wspólnym katalogu.
3. Nazwa usługi — Weekly Meals występuje w dokumentach jako Scoffie. Zmiana redakcyjna.

Dalsze korzystanie ze Scoffie po {{data_wejscia}} oznacza akceptację nowej wersji. Jeśli się nie zgadzasz, konto usuniesz w Ustawieniach.

Regulamin: ${H}/terms/
Polityka prywatności: ${H}/privacy/

--
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${FOOT.G}
Pomoc: ${H}/support/
Scoffie · scoffie.app`
});

const byId = id => T.filter(t => t.id === id)[0];
const subjectOf = (t, d) => t.subjectOf ? t.subjectOf(d) : fill(t.subject, d);
return { T, SAMPLE, byId, subjectOf, fill, clip };
})();
window.MAIL = MAIL;
