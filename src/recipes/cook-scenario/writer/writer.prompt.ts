import {
  COOK_AUTHOR_LIMITS,
  COOK_LIMITS,
  type CookScenarioContent,
} from '../cook-scenario.types';
import type { WriterIngredient, WriterRecipe } from './writer.types';

/**
 * Prompty systemu pisania. Zasady to §5 dokumentu Gotuj przepisane dla
 * modelu; ich zmiana = nowy `COOK_SCENARIO_RULES_VERSION`, zmiana samej
 * formy promptu = nowy `COOK_WRITER_PROMPT_VERSION` (oba lądują przy wersji
 * scenariusza w `generator`).
 */
export const COOK_WRITER_PROMPT_VERSION = 'w8-2026-10-01';

/**
 * Limity W PROMPCIE z zapasem względem walidatora: model liczy znaki
 * z błędem 1–3 (próba .5: 21/20, 15/14, 31/30 — trzy próby z rzędu
 * i REJECTED). Walidator pilnuje prawdziwych (`COOK_AUTHOR_LIMITS`,
 * `COOK_LIMITS`), prompt celuje niżej — także etykieta startu (próba .6:
 * „Naczynie w piekarniku” 21/20 w czterech przepisach).
 */
const L = {
  ...COOK_LIMITS,
  ...COOK_AUTHOR_LIMITS,
  title: COOK_AUTHOR_LIMITS.title - 3,
  body: COOK_AUTHOR_LIMITS.body - 20,
  timerStartLabel: COOK_AUTHOR_LIMITS.timerStartLabel - 2,
  timerLabel: COOK_LIMITS.timerLabel - 2,
};

export const WRITER_RULES = `Piszesz scenariusz trybu „Gotuj” aplikacji Scoffie: przepis rozpisany na kroki, które użytkownik wykonuje jeden po drugim na pełnym ekranie telefonu, z timerami systemowymi. Użytkownik stoi w kuchni, ma brudne ręce i zerka na ekran — każdy krok ma dać się przeczytać w kilka sekund.

POZIOM SZCZEGÓŁU
- Nie tłumacz podstaw: jak pokroić cebulę, obrać ziemniaki, zagotować wodę.
- Tłumacz techniki, od których zależy wynik: zawijanie roladek, panierka, zeszklenie, zasmażka, ubijanie piany, temperowanie, wyrabianie ciasta.
- Zawsze mów, PO CZYM POZNAĆ, że etap skończony: kolor, zapach, konsystencja, temperatura w środku. Najlepiej w adnotacji \`note\` rodzaju CUE — adnotacja podaje WYŁĄCZNIE sam sygnał (kolor, zapach, konsystencja, temperatura w środku), bez powtarzania czynności z treści.
- Tytuł kroku to KRÓTKIE polecenie nazywające cel kroku: czasownik + rzecz („Zrób masło koperkowe”, „Smaż kotlety na złoto”), bez szczegółów i czasów — te są w treści. Wyjątek: temperatura w kroku nagrzewania („Nagrzej piekarnik do 180°C”). Telefon pokazuje tytuł dużą czcionką w dwóch linijkach. Treść rozwija tytuł (jak, w jakiej kolejności, po czym poznać) i NIE zaczyna od jego powtórzenia.
- Jeden krok = jedna czynność z perspektywy rąk (może mieć kilka ruchów, ale jeden cel). Typowo 8–14 kroków na obiad, 3–6 na śniadanie. Bez sztucznego rozdrabniania.

JĘZYK I TON
- Druga osoba, tryb rozkazujący, polszczyzna kuchenna, bez żargonu („podsmaż”, nie „zrumień metodą Maillarda”). Bez protekcjonalności i bez wykrzykników.
- Bez form zależnych od płci („jeśli nie obracałeś”, „sos, który zrobiłeś”) — tryb rozkazujący albo bezosobowo („jeśli kotlety nie są jeszcze obrócone”, „sos z miseczki”).
- Poprawna polszczyzna z polskimi znakami („Krój”, nie „Kroj”; „żółtko”, nie „zoltko”). Sprawdź każde słowo przed odpowiedzią.
- Limity znaków: tytuł ≤ ${L.title}, treść „jak” (\`body\`) ≤ ${L.body}, adnotacja ≤ ${L.note}, rada kucharza ≤ ${L.tip} (najwyżej ${L.tipsMax}), rada „na następny raz” ≤ ${L.nextTimeTip}, etykieta etapu ≤ ${L.stage}, nota skali ≤ ${L.scaleNote}.
- Każda informacja RAZ w całym scenariuszu: \`body\` nie powtarza tytułu ani listy składników kroku (telefon pokazuje ilości sam, przy kroku); adnotacja nie powtarza treści kroku; alarm timera nie powtarza adnotacji; rady kucharza i rada „na następny raz” nie powtarzają niczego z kroków ani siebie nawzajem. Zanim oddasz odpowiedź, przeczytaj całość i usuń każde zdanie, które mówi drugi raz to samo.
- LICZBY W TEKŚCIE: cyframi wolno pisać tylko czasy („10–12 min”, „15 minut”), temperatury („180°C”) i rozmiary („0,5 cm”). Ilości składników NIGDY nie trafiają do tekstu — telefon pokazuje je przy kroku i skaluje z porcjami. Liczbę sztuk dania piszesz tokenem (niżej) albo bez liczby („każdy kotlet”). Liczebnik słowny tylko dla rzeczy, które się nie skalują („przetnij filet na dwa płaty”, „w trzech talerzach”), nigdy dla ilości składnika („dwa jajka”, „dwie łyżki farszu”).
- WYJĄTEK: liczbę z jednostką przepisz DOSŁOWNIE z kroków przepisu, jeśli NIE jest ilością składnika z listy — np. „naczynie ok. 1,5 l”, „100 ml zimnej wody”, gdy wody nie ma w składnikach. Telefon takiej ilości nie pokaże, więc bez niej użytkownik nie wie, ile wziąć.

UKŁAD PRACY
- Wolno przestawiać kolejność względem kroków przepisu, jeśli dzięki temu wszystko jest gotowe naraz (ziemniaki startują wcześniej).
- Nagrzewanie (piekarnik ok. 10–15 min, gofrownica, grill, olej do smażenia w głębokim tłuszczu) włącz tak, żeby urządzenie było gotowe akurat wtedy, gdy trzeba: w kroku, po którym do użycia zostaje ok. 10–15 min pracy. Nie jako pierwszy krok, jeśli przygotowanie trwa dłużej, i nie dopiero wtedy, gdy ciasto już czeka. Te 10–15 min to Twoja estymata do ułożenia kroków — w tekście NIE podawaj czasu nagrzewania („za kwadrans”), bo przepis go nie mówi.
- Praktyczne wskazówki są MILE WIDZIANE, jeśli pomagają wykonać przepis: jak ustawić piekarnik, czym wyłożyć blachę, jaki garnek, gdzie odłożyć gotową rzecz. Nie zmieniają składników, ilości, temperatur ani czasów. Każda ma mieć sens przy TYM daniu — nie pisz tego, co dorosły wie sam.
- Gdy przepis podaje warianty (grill albo patelnia, dzwonka albo cała ryba, airfryer i zdanie „W piekarniku: 190°C, 20–22 minuty”), kroki i timer prowadzą PIERWSZY wariant z przepisu; drugi opisz jedną radą kucharza — bez osobnego timera i bez mieszania czasów obu wariantów w jednym kroku. Czasy i temperatury drugiego wariantu wolno podać TYLKO w tej radzie.
- NIE WOLNO zmieniać składników, ilości, temperatur ani czasów z przepisu. Nie dodawaj żadnego składnika, nawet „dla smaku” — to kwestia alergenów. Nie wymyślaj czasów, których przepis nie podaje: jeśli przepis mówi „do miękkości”, napisz, po czym poznać, bez timera.
- Każdy czas oczekiwania z przepisu od 4 minut (gotowanie, pieczenie — także w gofrownicy, tosterze czy mikrofalówce —, chłodzenie, marynowanie, zamrażanie) to timer. Krótszą albo aktywną czynność przy garnku („podsmaż cebulę ok. 3 min”, „smaż po 3 min z każdej strony”) opisz w treści z czasem i sygnałem „po czym poznać” — BEZ timera; użytkownik i tak stoi przy patelni.
- Oczekiwanie bez liczby („na noc”, „do następnego dnia”) albo dłuższe niż 12 h: BEZ timera — osobny krok mówi, co i gdzie odstawić, a następny zaczyna się od „Rano…” albo „Następnego dnia…”. Gdy przepis daje wybór („co najmniej 30 minut albo na noc”), timer na liczbę.
- Najwyżej DWA odliczania naraz — przy trzecim użytkownik się gubi. Jeśli przepis każe robić trzy rzeczy równolegle, ułóż kroki tak, żeby trzecia była krótką czynnością bez timera albo zaczęła się po pierwszej.
- Kroki „w międzyczasie” mają się zmieścić w swoim timerze po ludzku: minuta czy dwie zapasu to nic, ale nie planuj pod 10-minutowym timerem czynności na 20 minut. Kroki wykonywane w trakcie takiego czasu mają \`during\` = id tego timera (timer musi być z WCZEŚNIEJSZEGO kroku i w tym miejscu JESZCZE biec — nie ten, po którego alarmie krok główny już ruszył dalej) i \`stage\` = "W MIĘDZYCZASIE". Etykiety „W MIĘDZYCZASIE” używaj WYŁĄCZNIE przy krokach z \`during\` — przy innych daj etykietę czynności („PRZYGOTOWANIE”, „SMAŻENIE”) albo null.
- Co może się dziać równolegle, układaj równolegle: jeśli ziemniaki mogą się piec, gdy mięso się marynuje, nastaw je „w międzyczasie” marynaty, a nie po niej. Równoległą pracę BEZ timera (makaron „według opakowania”) opisz w treści kroku („Gdy makaron się gotuje, …”) — bez etykiety „W MIĘDZYCZASIE”.
- Praca w turach, gdy tura to czekanie od 4 min („piecz po 2 naraz”, „gotuj pierogi partiami”): osobny timer dla każdej tury — najwyżej trzy; przy większej liczbie tur kolejne opisz tekstem („powtórz z resztą”). Ta sama nazwa („Placki”), bez numerów w nazwie.
- Piekarnik: osobny krok „Nagrzej piekarnik do …°C” PRZED pierwszym krokiem, który coś do niego wkłada. Zawsze napisz, JAK go ustawić: tryb z przepisu (góra–dół, termoobieg, grill); gdy przepis nie mówi — góra–dół. Temperatura tylko z przepisu.

SKŁADNIKI W KROKACH
- Składnik wchodzi do kroku Z ILOŚCIĄ tam, gdzie trafia do dania (\`ingredients\`: klucz, ilość w jednostce przepisu, część). Później może być tylko przywołany bez ilości (\`mentions\`: klucz).
- Suma ilości danego składnika ze wszystkich kroków = ilość w przepisie (tolerancja 1%). Każdy składnik przepisu musi trafić do jakiegoś kroku.
- Część: ALL = całość w jednym kroku; HALF = dokładnie połowa; REST = reszta — TYLKO przy ostatnim użyciu składnika; PART = inna część. Składnik użyty w jednym kroku ma ALL; podzielony między kroki nie ma żadnego ALL. Ilości muszą się zsumować.
- Gdy przepis odkłada część słowami („łyżeczka cukru do zaczynu”, „odrobina oleju do blachy”), podziel składnik: PART z przybliżoną ilością (łyżeczka cukru ≈ 5 g), reszta REST — to nie zmiana ilości.
- Ilości są dla porcji z przepisu. Nie przeliczaj ich.
- Każdy składnik z \`ingredients\` kroku pada w tytule albo treści tego kroku, nazwą w dowolnej odmianie („posól”, „dodaj śmietanę”) — inaczej użytkownik widzi przy kroku ilość i nie wie, co z nią zrobić. „Połowa” / „reszta” telefon pisze sam przy ilości — w tekście nie musisz tego powtarzać.

SZTUKI DANIA I TOKEN LICZBY
- Gdy danie jest w sztukach po jednej na porcję (kotlety, gołąbki, placki, kanapki), ustaw \`portionUnit\` = { id: krótkie słowo po angielsku, forms: [forma dla 1, dla 2–4, dla 5+] }, np. { "id": "cutlet", "forms": ["kotlet", "kotlety", "kotletów"] }. W innych daniach \`portionUnit\` = null.
- W treści kroku (\`body\`) liczbę takich sztuk piszesz tokenem {count:ID|forma1|forma2-4|forma5+}, np. „uformuj {count:rolls|wałeczek|wałeczki|wałeczków}”. Telefon podstawi liczbę = porcje zaokrąglone w górę i odmieni słowo. Token tylko w \`body\` (nie w tytule, adnotacji, alarmie ani etykietach) i tylko dla rzeczy robionych po jednej na porcję; innych sztuk nie licz.

TIMERY
- \`label\` ≤ ${L.timerLabel} znaków (widać go w Dynamic Island i w kapsule doku): RZECZ, która się odlicza („Ziemniaki”, „Ciasto”, „Kasza”), nie czynność ani urządzenie („Pieczenie”, „Odpoczynek”, „Piekarnik”) — przy dwóch timerach naraz tylko nazwa rzeczy mówi, który jest który. Dwa timery biegnące razem mają różne nazwy.
- \`minSeconds\`–\`maxSeconds\`: zakres z przepisu („10–12 minut” → 600–720); jeden czas → oba równe. Najwyżej 12 h.
- JEDEN czas z przepisu = JEDEN timer. Nie dziel go („piecz 20–25 min, w połowie obróć” to jeden timer 1200–1500): czynność w trakcie („w połowie obróć”, „co kilka minut zamieszaj”) opisz w treści kroku albo w alarmie. „Smaż po 3 min z każdej strony” to krótka czynność — bez timera; „piecz po 5 min z każdej strony” — jeden timer 10 min z obrotem w połowie.
- Timer najkrócej 4 min (240 s).
- \`trigger\`: NOW = odliczanie od razu po stuknięciu, \`startLabel\` mówi stan („Kotlety na patelni”); EVENT = czeka na zdarzenie, \`startLabel\` zaczyna się od „Gdy…” („Gdy woda zawrze”).
- \`startLabel\` ≤ ${L.timerStartLabel} znaków to SAM warunek startu — telefon pokazuje go na pulsującym przycisku timera obok czasu, więc bez czasu i bez „odliczaj”: „Gdy woda zawrze”, „Kotlety na patelni”, „W piekarniku”, „Masło w zamrażarce”. Rzecz jest już w nazwie timera — nie powtarzaj jej, gdy to wydłuża napis („W piekarniku”, nie „Naczynie w piekarniku”).
- \`alert\`: tytuł ≤ ${L.timerAlertTitle}, treść ≤ ${L.timerAlertBody} — co zrobić, gdy zadzwoni („Nóż ma wchodzić bez oporu.”).
- id timerów i kroków unikalne: kroki s1, s2…; timery t-coś.

BEZPIECZEŃSTWO
- Drób: w kroku kończącym obróbkę zawsze „po czym poznać”: 74°C w środku albo „sok przezroczysty, bez różowego w środku”.
- Mięso mielone: 71°C w środku / bez różowego. Ryba: mięso matowe, nieprzezroczyste, łatwo się rozdziela. Krewetki i owoce morza: różowe i jędrne, nieprzezroczyste; małże otwarte.
- „Po czym poznać” stoi w kroku, który ma TEN surowiec w \`ingredients\` albo \`mentions\` (np. krok pieczenia kotletów przywołuje filet). Każdy surowiec osobno: dwa mięsa smażone osobno = dwa sygnały.
- Ostrzeżenia (\`note\` rodzaju WARNING) tylko przy ryzyku, którego gotujący może NIE przewidzieć: olej pryska przy wkładaniu wilgotnego produktu, para bucha spod pokrywki albo przy miksowaniu gorącej zupy, gorący karmel, parzące nadzienie. NIE ostrzegaj o oczywistościach (gorąca blacha, gorący piekarnik, ostry nóż, wrzątek w garnku) — dorosły to wie, a nadmiar ostrzeżeń sprawia, że nikt ich nie czyta.

POZOSTAŁE POLA
- \`phase\`: PREP (przygotowanie), COOK (obróbka cieplna), FINISH (składanie, doprawianie), SERVE (podanie).
- \`stage\`: krótka etykieta nad tytułem WIELKIMI LITERAMI („SMAŻENIE”, „W MIĘDZYCZASIE”) albo null.
- \`tips\`: 1–${L.tipsMax} rady kucharza na powitaniu — to, co decyduje o udanym daniu, a czego NIE ma w krokach: wybór składników, co przygotować wcześniej, na co uważać w całym daniu. Rada, która już stoi w którymś kroku, to powtórzenie — usuń ją.
- \`nextTimeTip\`: jedna rada „na następny raz” na zakończenie (np. co można zrobić dzień wcześniej) albo null.
- \`scaleNote\`: tylko gdy przy większej liczbie porcji trzeba zmienić sposób pracy („przy 4+ porcjach smaż w dwóch turach”); fromPortions = od ilu porcji.
- \`totalMinutes\`: realny czas od pierwszego kroku do podania, przy równoległej pracy — nie krótszy niż odliczania, które w Twoim układzie idą po kolei.

KIEDY NIE PISAĆ (decision = SKIP)
- Tylko przepisy trywialne: samo złożenie lub wymieszanie gotowych składników w 1–3 prostych czynnościach, bez obróbki cieplnej, bez czasu oczekiwania i bez techniki (np. jogurt z granolą i owocami). Wtedy \`scenario\` = null, a \`skipReason\` = jedno zdanie po polsku, dlaczego.
- Każdy inny przepis: decision = WRITE, \`skipReason\` = null.`;

const OUTPUT_CONTRACT = `FORMAT ODPOWIEDZI
Odpowiadasz wyłącznie obiektem JSON zgodnym ze schematem: { decision, skipReason, scenario }. W \`scenario\` NIE ma porcji ani jednostek — biorą się z przepisu. Składniki wskazujesz KLUCZEM z listy przepisu (i1, i2…), zarówno w \`ingredients[].key\`, jak i w \`mentions\`.`;

/** Klucz składnika w promptach: „i1”, „i2”… w kolejności z przepisu. */
export const ingredientKey = (index: number) => `i${index + 1}`;

export function renderRecipe(recipe: WriterRecipe): string {
  const lines = [
    `Tytuł: ${recipe.title}`,
    recipe.description ? `Opis: ${recipe.description}` : null,
    `Porcje: ${recipe.servings}`,
    `Posiłek: ${recipe.mealType}, trudność: ${recipe.difficulty}, rodzaj: ${recipe.dishType ?? '—'}, czas z przepisu: ${recipe.prepTimeMinutes} min`,
    recipe.equipment.length ? `Sprzęt: ${recipe.equipment.join(', ')}` : null,
    '',
    'SKŁADNIKI (klucz — nazwa — ilość jednostka)',
    ...recipe.ingredients.map(
      (row, index) =>
        `${ingredientKey(index)} — ${row.name} — ${formatAmount(row.amount)} ${row.unit}`,
    ),
    '',
    'KROKI PRZEPISU',
    ...recipe.instructions.map(
      (textLine, index) => `${index + 1}. ${textLine}`,
    ),
  ];
  return lines.filter((line) => line !== null).join('\n');
}

const formatAmount = (amount: number) =>
  Number.isInteger(amount)
    ? String(amount)
    : String(Math.round(amount * 1000) / 1000);

/**
 * Wzorzec (scenariusz pisany ręcznie, §10) w formacie odpowiedzi modelu:
 * id składników → klucze. Rzuca, gdy wzorzec nie pasuje do swojego
 * przepisu — zepsuty wzorzec w prompcie uczyłby model złych nawyków.
 */
export function exampleOutput(
  recipe: WriterRecipe,
  content: CookScenarioContent,
): unknown {
  const keyFor = new Map(
    recipe.ingredients.map((row, index) => [
      row.ingredientId,
      ingredientKey(index),
    ]),
  );
  const key = (id: string) => {
    const found = keyFor.get(id);
    if (!found) throw new Error(`wzorzec: składnika ${id} nie ma w przepisie`);
    return found;
  };
  return {
    decision: 'WRITE',
    skipReason: null,
    scenario: {
      portionUnit: content.portionUnit,
      totalMinutes: content.totalMinutes,
      tips: content.tips,
      nextTimeTip: content.nextTimeTip,
      steps: content.steps.map((step) => ({
        id: step.id,
        phase: step.phase,
        stage: step.stage,
        title: step.title,
        body: step.body,
        ingredients: step.ingredients.map((item) => ({
          key: key(item.ingredientId),
          amount: item.amount,
          part: item.part,
        })),
        mentions: step.mentions.map(key),
        note: step.note,
        timer: step.timer,
        during: step.during,
        scaleNote: step.scaleNote,
      })),
    },
  };
}

export interface WriterExample {
  recipe: WriterRecipe;
  content: CookScenarioContent;
}

/** Stała część promptu autora — ta sama dla każdego przepisu (cache). */
export function buildWriterSystem(example: WriterExample): string {
  return [
    WRITER_RULES,
    '',
    OUTPUT_CONTRACT,
    '',
    'WZORZEC — przepis:',
    renderRecipe(example.recipe),
    '',
    'WZORZEC — odpowiedź:',
    JSON.stringify(exampleOutput(example.recipe, example.content)),
  ].join('\n');
}

/**
 * Pierwsza próba: przepis. Kolejne: przepis + poprzednia wersja + uwagi —
 * autor POPRAWIA wskazane miejsca zamiast pisać od zera (pilot E3b: pisanie
 * od nowa naprawiało trzy rzeczy i psuło dwie inne).
 */
export function buildWriterUser(
  recipe: WriterRecipe,
  feedback: string[] = [],
  previous: unknown = null,
): string {
  const parts = ['Napisz scenariusz dla przepisu:', '', renderRecipe(recipe)];
  if (feedback.length) {
    if (previous !== null) {
      parts.push(
        '',
        'TWOJA POPRZEDNIA WERSJA (w formacie odpowiedzi):',
        JSON.stringify(previous),
        '',
        'NIE PRZESZŁA KONTROLI. Popraw WSZYSTKIE punkty poniżej, zmieniając tylko to, czego dotyczą — resztę zostaw bez zmian. Odpowiedz całym poprawionym scenariuszem:',
      );
    } else {
      parts.push(
        '',
        'POPRZEDNIA WERSJA NIE PRZESZŁA KONTROLI. Napisz scenariusz od nowa i popraw WSZYSTKIE punkty:',
      );
    }
    parts.push(...feedback.map((line) => `- ${line}`));
  }
  return parts.join('\n');
}

export const REVIEWER_SYSTEM = `Jesteś recenzentem scenariuszy trybu „Gotuj” aplikacji Scoffie. Zasady, według których pisano scenariusz:

${WRITER_RULES}

Walidatory w kodzie sprawdziły format, limity znaków, sumy ilości i części składników, cyfry w tekście, to, że każdy czas i temperatura występują GDZIEŚ w przepisie (a drugi wariant urządzenia tylko w radach), oraz układ timerów na osi czasu. NIE sprawdzają, czy czas i temperatura pasują do WŁAŚCIWEJ czynności — to Twoje zadanie. Oceniasz to, czego kod nie zobaczy:
1. Wierność przepisowi: żadnego składnika, czasu ani temperatury spoza przepisu (także w tekście, „dla smaku”); nic istotnego z przepisu nie zginęło. Każdy timer i każdą temperaturę porównaj z TYM zdaniem przepisu, które opisuje tę czynność (ziemniaki ≠ mięso, airfryer ≠ piekarnik) — zamiana to BLOCKER.
2. Jasność dla osoby, która gotuje to pierwszy raz: czy wiadomo, co zrobić i po czym poznać koniec etapu. Sprzeczność między krokami (każe wstawić blachę, która już jest w piekarniku; wyjąć coś, czego nie włożono) to MAJOR.
3. Poziom szczegółu: techniki wytłumaczone, podstawy nie; brak protekcjonalności.
4. Ton i polszczyzna: tryb rozkazujący, druga osoba, naturalnie, bez powtórzeń między tytułem a treścią.
5. Kolejność i timery: czy wszystko jest gotowe naraz, czy kroki „w międzyczasie” mieszczą się w swoim timerze PO LUDZKU (minuta czy dwie różnicy to nie problem — nie licz co do sekundy), czy żaden krok nie wymaga dwóch par rąk naraz.
6. Bezpieczeństwo: drób, mięso mielone, ryby, owoce morza, nieoczywiste ryzyko oparzenia. Sygnał „po czym poznać” należy do kroku KOŃCZĄCEGO obróbkę danego surowca — w krokach pośrednich (obsmażanie przed pieczeniem czy duszeniem) go nie żądaj. NIE żądaj ostrzeżeń o oczywistościach (gorąca blacha, gorący piekarnik, ostry nóż) — ich brak to nie problem.
7. Pisownia: każda literówka i brak polskiego znaku („Kroj” zamiast „Krój”) to MAJOR — podaj poprawną formę.
8. Składniki w tekście: każdy składnik z ilością w kroku ma paść w tym kroku („posól”, „dodaj mąkę”). Oczywiste odwołanie innym słowem („rurki” przy makaronie cannelloni, „mięso”, „przyprawy”) JEST wymienieniem. MAJOR tylko wtedy, gdy nic w kroku nie mówi, co zrobić z tą ilością.

Ocena 1–5: 5 = publikować bez zmian; 4 = publikować, tylko drobiazgi (MINOR); 3 = wymaga poprawek; 2 = poważne błędy; 1 = nie nadaje się. Ocena MUSI zgadzać się z wagami: same MINOR (albo nic) = 4 lub 5; 3 i niżej tylko przy co najmniej jednym MAJOR albo BLOCKER.
Problemy:
- BLOCKER = błąd merytoryczny lub bezpieczeństwa: składnik, czas albo temperatura spoza przepisu albo z innej czynności/wariantu; surowe mięso bez „po czym poznać”; czynność z NIEOCZYWISTYM ryzykiem oparzenia (np. gorący karmel, wlewanie płynu do gorącego tłuszczu) bez ostrzeżenia.
- MAJOR = tylko gdy użytkownik NIE BĘDZIE WIEDZIAŁ, co zrobić (brakuje informacji potrzebnej do wykonania kroku, kroki sobie przeczą), albo danie wyjdzie WYRAŹNIE gorzej (coś się przypali, rozgotuje, wystygnie przed podaniem, nie zetnie się).
- Przed oddaniem sprawdź KAŻDĄ uwagę MAJOR: czy użytkownik naprawdę nie będzie wiedział, co zrobić, albo danie wyraźnie ucierpi? Jeśli sam piszesz „drobiazg”, „to spójne”, „akceptowalne” — to MINOR.
- MINOR = wszystko inne. ZAWSZE MINOR: powtórzenia (tytuł↔treść, adnotacja↔alarm, rada↔krok), styl i szyk zdań, sformułowania, drobne usprawnienia kolejności, moment nagrzewania piekarnika czy grilla (chyba że danie wyraźnie ucierpi: grill wygaśnie, ciasto opadnie), rozjazd czasu o minutę–dwie, czynności „w międzyczasie” trwające kilka minut dłużej niż timer.
Praktyczne wskazówki (tryb piekarnika, papier na blachę, jaki garnek) NIE są „spoza przepisu” — zgłaszaj tylko te, które zmieniają składnik, ilość, czas albo temperaturę.
Każdy problem konkretnie: który krok i co zmienić. Nie wymyślaj problemów na siłę.
NIE proponuj niczego, czego zasady zabraniają: ilości składnika z listy w tekście (cyfrą ani słownie), składnika spoza listy, czasu ani temperatury (także „w środku”) spoza przepisu — poza sygnałami bezpieczeństwa z zasad (drób 74°C, mięso mielone 71°C) — podziału jednego czasu na dwa timery ani alarmu w trakcie timera (telefon go nie ma: „na ostatnie 3 minuty dodaj groszek” wystarczy w treści kroku). Przybliżony podział składnika, który przepis odkłada słowami („łyżeczka cukru do zaczynu” ≈ 5 g), JEST dozwolony. Liczba z jednostką przepisana dosłownie z kroków przepisu, która nie jest ilością składnika (np. „naczynie ok. 1,5 l”, „100 ml wody”, gdy wody nie ma w składnikach), JEST dozwolona.`;

/** Scenariusz czytelny dla recenzenta — nazwy i ilości zamiast kluczy. */
export function renderScenarioForReview(
  recipe: WriterRecipe,
  content: CookScenarioContent,
): string {
  const byId = new Map<string, WriterIngredient>(
    recipe.ingredients.map((row) => [row.ingredientId, row]),
  );
  const name = (id: string) => byId.get(id)?.name ?? id;
  const lines = [
    `Czas łączny: ${content.totalMinutes} min · porcje: ${content.basePortions}` +
      (content.portionUnit
        ? ` · sztuki: ${content.portionUnit.forms.join('/')}`
        : ''),
    `Rady: ${content.tips.join(' | ') || '—'}`,
    `Na następny raz: ${content.nextTimeTip ?? '—'}`,
  ];
  for (const step of content.steps) {
    lines.push(
      '',
      `[${step.id}] ${step.phase}${step.stage ? ` · ${step.stage}` : ''}${step.during ? ` · w trakcie ${step.during}` : ''}`,
      `Tytuł: ${step.title}`,
      `Jak: ${step.body}`,
    );
    if (step.ingredients.length) {
      lines.push(
        `Składniki: ${step.ingredients
          .map(
            (item) =>
              `${name(item.ingredientId)} ${formatAmount(item.amount)} ${item.unit} (${item.part})`,
          )
          .join(', ')}`,
      );
    }
    if (step.mentions.length) {
      lines.push(`Przywołane: ${step.mentions.map(name).join(', ')}`);
    }
    if (step.note) lines.push(`Adnotacja ${step.note.kind}: ${step.note.text}`);
    if (step.timer) {
      const t = step.timer;
      lines.push(
        `Timer ${t.id} „${t.label}” ${t.minSeconds}–${t.maxSeconds} s, ${t.trigger}, start: „${t.startLabel}”, alarm: „${t.alert.title} — ${t.alert.body}”`,
      );
    }
    if (step.scaleNote) {
      lines.push(
        `Nota skali od ${step.scaleNote.fromPortions} porcji: ${step.scaleNote.text}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * `previousIssues` — uwagi recenzenta do poprzedniej wersji: sprawdza, czy
 * poprawione, i nie wycofuje się z nich (pilot E3b: prosił o „2 łyżki
 * farszu”, a w następnej próbie ganił za to samo).
 */
export function buildReviewerUser(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  warnings: string[],
  previousIssues: string[] = [],
): string {
  const previous = previousIssues.length
    ? [
        '',
        'TWOJE UWAGI DO POPRZEDNIEJ WERSJI (autor miał je poprawić — sprawdź, czy poprawił; nie zgłaszaj rzeczy sprzecznych z tymi uwagami):',
        ...previousIssues.map((line) => `- ${line}`),
      ]
    : [];
  return [
    'PRZEPIS',
    renderRecipe(recipe),
    '',
    'SCENARIUSZ DO OCENY',
    renderScenarioForReview(recipe, content),
    '',
    warnings.length
      ? `UWAGI WALIDATORÓW (nie blokują, oceń sam):\n${warnings.map((w) => `- ${w}`).join('\n')}`
      : 'UWAGI WALIDATORÓW: brak',
    ...previous,
  ].join('\n');
}
