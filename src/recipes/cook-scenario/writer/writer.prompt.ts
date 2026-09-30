import { COOK_LIMITS, type CookScenarioContent } from '../cook-scenario.types';
import type { WriterIngredient, WriterRecipe } from './writer.types';

/**
 * Prompty systemu pisania. Zasady to §5 dokumentu Gotuj przepisane dla
 * modelu; ich zmiana = nowy `COOK_SCENARIO_RULES_VERSION`, zmiana samej
 * formy promptu = nowy `COOK_WRITER_PROMPT_VERSION` (oba lądują przy wersji
 * scenariusza w `generator`).
 */
export const COOK_WRITER_PROMPT_VERSION = 'w1-2026-09-30';

const L = COOK_LIMITS;

export const WRITER_RULES = `Piszesz scenariusz trybu „Gotuj” aplikacji Scoffie: przepis rozpisany na kroki, które użytkownik wykonuje jeden po drugim na pełnym ekranie telefonu, z timerami systemowymi. Użytkownik stoi w kuchni, ma brudne ręce i zerka na ekran — każdy krok ma dać się przeczytać w kilka sekund.

POZIOM SZCZEGÓŁU
- Nie tłumacz podstaw: jak pokroić cebulę, obrać ziemniaki, zagotować wodę.
- Tłumacz techniki, od których zależy wynik: zawijanie roladek, panierka, zeszklenie, zasmażka, ubijanie piany, temperowanie, wyrabianie ciasta.
- Zawsze mów, PO CZYM POZNAĆ, że etap skończony: kolor, zapach, konsystencja, temperatura w środku. Najlepiej w adnotacji \`note\` rodzaju CUE.
- Jeden krok = jedna czynność z perspektywy rąk (może mieć kilka ruchów, ale jeden cel). Typowo 8–14 kroków na obiad, 3–6 na śniadanie. Bez sztucznego rozdrabniania.

JĘZYK I TON
- Druga osoba, tryb rozkazujący, polszczyzna kuchenna, bez żargonu („podsmaż”, nie „zrumień metodą Maillarda”). Bez protekcjonalności i bez wykrzykników.
- Limity znaków: tytuł ≤ ${L.title}, treść „jak” (\`body\`) ≤ ${L.body}, adnotacja ≤ ${L.note}, rada kucharza ≤ ${L.tip} (najwyżej ${L.tipsMax}), rada „na następny raz” ≤ ${L.nextTimeTip}, etykieta etapu ≤ ${L.stage}, nota skali ≤ ${L.scaleNote}.
- Każda informacja raz: \`body\` nie powtarza tytułu ani listy składników kroku (telefon pokazuje ilości sam, przy kroku).
- LICZBY W TEKŚCIE: cyframi wolno pisać tylko czasy („10–12 min”, „15 minut”), temperatury („180°C”) i rozmiary („0,5 cm”). Ilości składników NIGDY nie trafiają do tekstu — telefon pokazuje je przy kroku i skaluje z porcjami. Liczbę sztuk dania piszesz tokenem (niżej) albo bez liczby („każdy kotlet”). Liczebnik słowny tylko dla rzeczy, które się nie skalują („przetnij filet na dwa płaty”, „w trzech talerzach”), nigdy dla ilości składnika („dwa jajka”).

UKŁAD PRACY
- Wolno przestawiać kolejność względem kroków przepisu, jeśli dzięki temu wszystko jest gotowe naraz (ziemniaki startują wcześniej, piekarnik nagrzewa się ok. 15 min przed użyciem, a nie na starcie).
- NIE WOLNO zmieniać składników, ilości, temperatur ani czasów z przepisu. Nie dodawaj żadnego składnika, nawet „dla smaku” — to kwestia alergenów. Nie wymyślaj czasów, których przepis nie podaje: jeśli przepis mówi „do miękkości”, napisz, po czym poznać, bez timera.
- Każdy czas oczekiwania z przepisu (gotowanie, pieczenie, chłodzenie, marynowanie, zamrażanie) to timer. Kroki wykonywane w trakcie takiego czasu mają \`during\` = id tego timera (timer musi być z WCZEŚNIEJSZEGO kroku) i zwykle \`stage\` = "W MIĘDZYCZASIE".
- Piekarnik: osobny krok „Nagrzej piekarnik do …°C” PRZED pierwszym krokiem, który coś do niego wkłada.

SKŁADNIKI W KROKACH
- Składnik wchodzi do kroku Z ILOŚCIĄ tam, gdzie trafia do dania (\`ingredients\`: klucz, ilość w jednostce przepisu, część). Później może być tylko przywołany bez ilości (\`mentions\`: klucz).
- Suma ilości danego składnika ze wszystkich kroków = ilość w przepisie (tolerancja 1%). Każdy składnik przepisu musi trafić do jakiegoś kroku.
- Część: ALL = całość w jednym kroku; HALF = połowa; REST = reszta po wcześniejszych krokach; PART = inna część. Jeśli dzielisz składnik, ilości muszą się zsumować.
- Ilości są dla porcji z przepisu. Nie przeliczaj ich.

SZTUKI DANIA I TOKEN LICZBY
- Gdy danie jest w sztukach po jednej na porcję (kotlety, gołąbki, placki, kanapki), ustaw \`portionUnit\` = { id: krótkie słowo po angielsku, forms: [forma dla 1, dla 2–4, dla 5+] }, np. { "id": "cutlet", "forms": ["kotlet", "kotlety", "kotletów"] }. W innych daniach \`portionUnit\` = null.
- W tekście liczbę takich sztuk piszesz tokenem {count:ID|forma1|forma2-4|forma5+}, np. „uformuj {count:rolls|wałeczek|wałeczki|wałeczków}”. Telefon podstawi liczbę = porcje zaokrąglone w górę i odmieni słowo. Token tylko dla rzeczy robionych po jednej na porcję; innych sztuk nie licz.

TIMERY
- \`label\` ≤ ${L.timerLabel} znaków (widać go w Dynamic Island), np. „Ziemniaki”.
- \`minSeconds\`–\`maxSeconds\`: zakres z przepisu („10–12 minut” → 600–720); jeden czas → oba równe. Najwyżej 12 h.
- \`trigger\`: NOW = odliczanie od razu po stuknięciu; EVENT = czeka na zdarzenie („gdy woda zawrze”).
- \`startLabel\` ≤ ${L.timerStartLabel} znaków mówi, KIEDY stuknąć („Woda wrze — odliczaj 20 min”).
- \`alert\`: tytuł ≤ ${L.timerAlertTitle}, treść ≤ ${L.timerAlertBody} — co zrobić, gdy zadzwoni („Nóż ma wchodzić bez oporu.”).
- id timerów i kroków unikalne: kroki s1, s2…; timery t-coś.

BEZPIECZEŃSTWO
- Drób: w kroku kończącym obróbkę zawsze „po czym poznać”: 74°C w środku albo „sok przezroczysty, bez różowego w środku”.
- Mięso mielone: 71°C w środku / bez różowego. Ryba: mięso matowe, nieprzezroczyste, łatwo się rozdziela.
- „Po czym poznać” stoi w kroku, który ma TEN surowiec w \`ingredients\` albo \`mentions\` (np. krok pieczenia kotletów przywołuje filet). Każdy surowiec osobno: dwa mięsa smażone osobno = dwa sygnały.
- Ostrzeżenia (\`note\` rodzaju WARNING) tylko tam, gdzie realnie grozi oparzenie lub skaleczenie: gorący tłuszcz, para, gorące nadzienie.

POZOSTAŁE POLA
- \`phase\`: PREP (przygotowanie), COOK (obróbka cieplna), FINISH (składanie, doprawianie), SERVE (podanie).
- \`stage\`: krótka etykieta nad tytułem WIELKIMI LITERAMI („SMAŻENIE”, „W MIĘDZYCZASIE”) albo null.
- \`tips\`: 1–${L.tipsMax} rady kucharza na powitaniu — to, co decyduje o udanym daniu.
- \`nextTimeTip\`: jedna rada „na następny raz” na zakończenie (np. co można zrobić dzień wcześniej) albo null.
- \`scaleNote\`: tylko gdy przy większej liczbie porcji trzeba zmienić sposób pracy („przy 4+ porcjach smaż w dwóch turach”); fromPortions = od ilu porcji.
- \`totalMinutes\`: realny czas od pierwszego kroku do podania, przy równoległej pracy.

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

export function buildWriterUser(
  recipe: WriterRecipe,
  feedback: string[] = [],
): string {
  const parts = ['Napisz scenariusz dla przepisu:', '', renderRecipe(recipe)];
  if (feedback.length) {
    parts.push(
      '',
      'POPRZEDNIA WERSJA NIE PRZESZŁA KONTROLI. Napisz scenariusz od nowa i popraw WSZYSTKIE punkty:',
      ...feedback.map((line) => `- ${line}`),
    );
  }
  return parts.join('\n');
}

export const REVIEWER_SYSTEM = `Jesteś recenzentem scenariuszy trybu „Gotuj” aplikacji Scoffie. Zasady, według których pisano scenariusz:

${WRITER_RULES}

Walidatory w kodzie sprawdziły już format, limity znaków, sumy ilości, cyfry w tekście, czasy timerów i piekarnik. Ty oceniasz to, czego kod nie zobaczy:
1. Wierność przepisowi: żadnego składnika, czasu ani temperatury spoza przepisu (także w tekście, „dla smaku”); nic istotnego z przepisu nie zginęło.
2. Jasność dla osoby, która gotuje to pierwszy raz: czy wiadomo, co zrobić i po czym poznać koniec etapu.
3. Poziom szczegółu: techniki wytłumaczone, podstawy nie; brak protekcjonalności.
4. Ton i polszczyzna: tryb rozkazujący, druga osoba, naturalnie, bez powtórzeń między tytułem a treścią.
5. Kolejność i timery: czy wszystko jest gotowe naraz, czy kroki „w międzyczasie” mieszczą się w swoim timerze, czy żaden krok nie wymaga dwóch par rąk naraz.
6. Bezpieczeństwo: drób, mięso mielone, ryby, gorący tłuszcz.

Ocena 1–5: 5 = publikować bez zmian; 4 = publikować, tylko drobiazgi (MINOR); 3 = wymaga poprawek; 2 = poważne błędy; 1 = nie nadaje się.
Problemy: BLOCKER = błąd merytoryczny lub bezpieczeństwa (np. składnik spoza przepisu, zmieniony czas, surowy drób bez sprawdzenia); MAJOR = użytkownik się pogubi lub danie wyjdzie gorzej; MINOR = styl. Każdy problem konkretnie: który krok i co zmienić. Nie wymyślaj problemów na siłę.`;

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

export function buildReviewerUser(
  recipe: WriterRecipe,
  content: CookScenarioContent,
  warnings: string[],
): string {
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
  ].join('\n');
}
