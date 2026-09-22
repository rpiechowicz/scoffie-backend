/**
 * Partia „diety" (3.09.2026): 28 zwykłych przepisów pod chude pule
 * wegańską, keto i paleo. Audyt 2.09 pokazał w katalogu 97 dań:
 * VEGAN 9, KETO 7, PALEO 6 — asystent z takim wyborem nie ułoży tygodnia
 * dla nikogo na tych dietach bez powtórek.
 *
 * Definicje trzymamy jako kod, a nie gotowy JSON: makro liczy ten sam
 * kalkulator, co `recipes:recompute:nutrition` (`computeRecipeNutrition`),
 * więc liczby w pliku są policzone z tabeli składników, nie wpisane z głowy.
 * Generator: `pnpm tsx scripts/lib/diety-batch-2026-09.ts` zapisuje
 * `prisma/catalog/recipes-batch-diety-28-v1.json` i dokleja partię do
 * `recipes-catalog-full-v2.json` (tak samo jak partia wegańska).
 *
 * Reguły doboru składników: tylko te z tabeli makro (138), nazwy dokładnie
 * jak w `ingredient-tags-pl-v1.json`, przyprawy w gramach (łyżeczki są
 * dozwolone tylko dla kategorii przypraw i nie ma po co ryzykować).
 * Keto = ≤ 20 g węglowodanów na porcję (reguła serwera); paleo = bez zbóż,
 * strączków, nabiału i przetworzonych (bulion z kartonu też jest „PROCESSED",
 * więc paleo gotuje na wodzie); wegańskie = bez mięsa, ryb, nabiału, jajek,
 * miodu.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeRecipeNutrition } from '../../src/recipes/recipe-nutrition.util';
import {
  normalizeIngredientAmount,
  normalizeText,
} from '../../src/recipes/ingredient-amount.util';
import { RECIPE_IMAGE_PLACEHOLDER_URL } from '../../src/recipes/recipe-image-placeholder';

type Ing = [name: string, amount: number, unit: 'g' | 'ml' | 'szt'];

type Def = {
  title: string;
  description: string;
  mealType:
    | 'BREAKFAST'
    | 'SECOND_BREAKFAST'
    | 'LUNCH'
    | 'AFTERNOON_SNACK'
    | 'DINNER'
    | 'SNACK';
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  prepTimeMinutes: number;
  servings: number;
  ingredients: Ing[];
  steps: string[];
  photo: string;
  /** Do samokontroli generatora — które pule ma zasilić. */
  pools: ('VEGAN' | 'KETO' | 'PALEO')[];
};

const DEFS: Def[] = [
  // ─── WEGAŃSKIE ────────────────────────────────────────────────────────
  {
    title: 'Tofu w sosie pomidorowym z ryżem basmati',
    description:
      'Kostki tofu podsmażone na złoto i duszone w gęstym sosie z passaty z czosnkiem i oregano, podane z sypkim ryżem basmati. Prosty obiad bez mięsa, gotowy w pół godziny.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 30,
    servings: 2,
    ingredients: [
      ['tofu', 300, 'g'],
      ['ryż basmati', 140, 'g'],
      ['passata pomidorowa', 300, 'ml'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['oliwa z oliwek', 20, 'ml'],
      ['oregano', 2, 'g'],
      ['papryka słodka mielona', 3, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Ryż wypłucz i ugotuj według instrukcji na opakowaniu.',
      'Tofu osusz, pokrój w kostkę i obsmaż na oliwie z każdej strony na złoto. Odłóż na talerz.',
      'Na tej samej patelni zeszklij posiekaną cebulę, dodaj czosnek, paprykę i oregano, smaż minutę.',
      'Wlej passatę, dopraw solą i pieprzem, gotuj 8 minut, aż sos zgęstnieje.',
      'Wrzuć tofu do sosu, wymieszaj i podgrzej 2 minuty. Podawaj z ryżem.',
    ],
    photo: 'Golden fried tofu cubes in thick tomato sauce over basmati rice',
    pools: ['VEGAN'],
  },
  {
    title: 'Gulasz z czerwonej soczewicy z batatem i szpinakiem',
    description:
      'Gęsty, rozgrzewający gulasz z czerwonej soczewicy, batata i pomidorów z puszki, z kminem i imbirem, na koniec ze szpinakiem. Jedno naczynie, dużo białka roślinnego.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 35,
    servings: 2,
    ingredients: [
      ['soczewica czerwona', 150, 'g'],
      ['batat', 300, 'g'],
      ['pomidor krojony z puszki', 400, 'g'],
      ['szpinak', 100, 'g'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['olej rzepakowy', 15, 'ml'],
      ['kmin rzymski', 2, 'g'],
      ['imbir mielony', 2, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Cebulę i czosnek posiekaj, batata obierz i pokrój w kostkę 2 cm.',
      'W garnku rozgrzej olej, zeszklij cebulę, dodaj czosnek, kmin i imbir, smaż minutę.',
      'Dodaj batata, soczewicę i pomidory, wlej 400 ml wody, dopraw solą i pieprzem.',
      'Gotuj pod przykryciem 20 minut, aż soczewica się rozpadnie, a batat zmięknie.',
      'Wmieszaj szpinak i gotuj 2 minuty, aż zwiędnie. Podawaj gorące.',
    ],
    photo:
      'Thick red lentil and sweet potato stew with wilted spinach in a bowl',
    pools: ['VEGAN'],
  },
  {
    title: 'Stir-fry z tofu, brokułem i papryką z ryżem jaśminowym',
    description:
      'Szybkie smażenie na dużym ogniu: tofu, brokuł, papryka i czosnek w sosie sojowym z sezamem, podane z ryżem jaśminowym. Kolacja gotowa w 25 minut.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['tofu', 250, 'g'],
      ['brokuł', 300, 'g'],
      ['papryka czerwona', 1, 'szt'],
      ['ryż jaśminowy', 140, 'g'],
      ['sos sojowy', 30, 'ml'],
      ['czosnek', 2, 'szt'],
      ['imbir mielony', 2, 'g'],
      ['olej rzepakowy', 20, 'ml'],
      ['sezam', 10, 'g'],
    ],
    steps: [
      'Ugotuj ryż. Brokuł podziel na różyczki, paprykę pokrój w paski, tofu w kostkę.',
      'Na rozgrzanym oleju obsmaż tofu na złoto i odłóż.',
      'Wrzuć brokuł i paprykę, smaż 5 minut na dużym ogniu, mieszając.',
      'Dodaj czosnek, imbir i tofu, wlej sos sojowy, smaż 2 minuty.',
      'Podawaj z ryżem, posypane sezamem.',
    ],
    photo:
      'Wok stir-fry of tofu, broccoli and red pepper with sesame over jasmine rice',
    pools: ['VEGAN'],
  },
  {
    title: 'Kasza gryczana z pieczarkami i cebulą',
    description:
      'Sypka kasza gryczana z pieczarkami smażonymi na złoto z cebulą, czosnkiem i majerankiem. Klasyczna, sycąca kolacja bez mięsa i nabiału.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['kasza gryczana', 150, 'g'],
      ['pieczarka', 400, 'g'],
      ['cebula', 2, 'szt'],
      ['czosnek', 2, 'szt'],
      ['olej rzepakowy', 20, 'ml'],
      ['majeranek', 2, 'g'],
      ['natka pietruszki', 10, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Kaszę ugotuj w osolonej wodzie do miękkości, odcedź.',
      'Pieczarki pokrój w plastry, cebulę w piórka, czosnek posiekaj.',
      'Na oleju smaż pieczarki na dużym ogniu, aż zbrązowieją, potem dodaj cebulę i smaż 5 minut.',
      'Dodaj czosnek i majeranek, dopraw solą i pieprzem, smaż minutę.',
      'Wymieszaj z kaszą i posyp natką.',
    ],
    photo:
      'Buckwheat groats with golden fried mushrooms and onions, parsley on top',
    pools: ['VEGAN'],
  },
  {
    title: 'Krem z dyni z mlekiem kokosowym',
    description:
      'Aksamitna zupa krem z pieczonej dyni, cebuli i czosnku, zmiksowana z mlekiem kokosowym, z nutą imbiru. Posypana pestkami dyni dla chrupkości.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 40,
    servings: 2,
    ingredients: [
      ['dynia', 700, 'g'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['mleko kokosowe z puszki', 200, 'ml'],
      ['oliwa z oliwek', 15, 'ml'],
      ['imbir mielony', 2, 'g'],
      ['pestki dyni', 20, 'g'],
      ['sól', 3, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Dynię obierz, pokrój w kostkę, cebulę w ćwiartki. Wymieszaj z oliwą, solą i pieprzem.',
      'Piecz w 200°C przez 25 minut, aż dynia zmięknie i przyrumieni się na brzegach.',
      'Przełóż do garnka z czosnkiem i imbirem, wlej 500 ml wody, gotuj 5 minut.',
      'Zmiksuj na gładko z mlekiem kokosowym, dopraw do smaku.',
      'Podawaj posypane pestkami dyni.',
    ],
    photo: 'Velvety roasted pumpkin and coconut soup topped with pumpkin seeds',
    pools: ['VEGAN', 'PALEO'],
  },
  {
    title: 'Pudding chia z mlekiem kokosowym i malinami',
    description:
      'Nasiona chia namoczone przez noc w mleku kokosowym, rano z malinami i bananem. Śniadanie bez gotowania, które robi się samo w lodówce.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['nasiona chia', 50, 'g'],
      ['mleko kokosowe z puszki', 300, 'ml'],
      ['malina', 150, 'g'],
      ['banan', 1, 'szt'],
      ['cynamon', 2, 'g'],
    ],
    steps: [
      'Nasiona chia wymieszaj z mlekiem kokosowym i cynamonem w słoiku.',
      'Odstaw na 10 minut, wymieszaj jeszcze raz, żeby nie było grudek, i wstaw do lodówki na noc.',
      'Rano rozłóż do miseczek, ułóż na wierzchu maliny i plasterki banana.',
    ],
    photo:
      'Coconut chia pudding in a glass jar topped with raspberries and banana slices',
    pools: ['VEGAN', 'PALEO'],
  },
  {
    title: 'Sałatka z ciecierzycą, ogórkiem i pomidorem',
    description:
      'Chrupiąca sałatka z ciecierzycy, ogórka, pomidora i cebuli z cytrynowo-oliwkowym dressingiem i natką. Lekka kolacja, która syci dzięki strączkom.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['ciecierzyca z puszki', 400, 'g'],
      ['ogórek', 1, 'szt'],
      ['pomidor', 2, 'szt'],
      ['cebula', 1, 'szt'],
      ['natka pietruszki', 15, 'g'],
      ['oliwa z oliwek', 25, 'ml'],
      ['cytryna', 1, 'szt'],
      ['kmin rzymski', 1, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Ciecierzycę odsącz i opłucz. Ogórek i pomidory pokrój w kostkę, cebulę drobno.',
      'Wymieszaj oliwę z sokiem z cytryny, kminem, solą i pieprzem.',
      'Połącz warzywa z ciecierzycą, polej dressingiem, posyp natką i wymieszaj.',
    ],
    photo:
      'Chickpea salad with cucumber, tomato, red onion and parsley in lemon dressing',
    pools: ['VEGAN'],
  },
  {
    title: 'Owsianka kakaowa z bananem na mleku owsianym',
    description:
      'Czekoladowa owsianka gotowana na mleku owsianym z kakao i cynamonem, z bananem i orzechami włoskimi. Bez nabiału, słodka od banana.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 12,
    servings: 2,
    ingredients: [
      ['płatki owsiane', 100, 'g'],
      ['mleko owsiane', 400, 'ml'],
      ['kakao', 15, 'g'],
      ['banan', 2, 'szt'],
      ['orzech włoski', 30, 'g'],
      ['cynamon', 2, 'g'],
    ],
    steps: [
      'Płatki zalej mlekiem owsianym, dodaj kakao i cynamon, zagotuj mieszając.',
      'Gotuj 5 minut na małym ogniu, aż zgęstnieje. Jednego banana rozgnieć widelcem i wmieszaj.',
      'Rozłóż do miseczek, na wierzch drugi banan w plasterkach i połamane orzechy.',
    ],
    photo: 'Chocolate oat porridge with banana slices and walnuts in a bowl',
    pools: ['VEGAN'],
  },
  {
    title: 'Zapiekanka z batata z czerwoną fasolą',
    description:
      'Warstwy pieczonego batata z pikantną fasolą w pomidorach, papryką i kminem. Sycąca zapiekanka bez mięsa i sera, dobra też na drugi dzień.',
    mealType: 'LUNCH',
    difficulty: 'MEDIUM',
    prepTimeMinutes: 50,
    servings: 2,
    ingredients: [
      ['batat', 500, 'g'],
      ['fasola czerwona z puszki', 400, 'g'],
      ['pomidor krojony z puszki', 400, 'g'],
      ['papryka czerwona', 1, 'szt'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['oliwa z oliwek', 20, 'ml'],
      ['kmin rzymski', 2, 'g'],
      ['papryka ostra mielona', 1, 'g'],
      ['sól', 2, 'g'],
    ],
    steps: [
      'Batata obierz i pokrój w plastry 1 cm. Ułóż na blasze, skrop oliwą, piecz 15 minut w 200°C.',
      'Cebulę, czosnek i paprykę podsmaż na reszcie oliwy, dodaj kmin i ostrą paprykę.',
      'Dodaj fasolę i pomidory, gotuj 10 minut, dopraw solą.',
      'W naczyniu żaroodpornym układaj na przemian batata i fasolę, zakończ batatem.',
      'Zapiekaj 20 minut w 200°C, aż wierzch się przyrumieni.',
    ],
    photo: 'Baked sweet potato and red bean casserole in a ceramic dish',
    pools: ['VEGAN'],
  },
  {
    title: 'Makaron penne z cukinią, pomidorkami i pestkami dyni',
    description:
      'Penne z cukinią smażoną z czosnkiem, pomidorkami koktajlowymi i oregano, posypane prażonymi pestkami dyni. Lekki obiad w 20 minut.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 20,
    servings: 2,
    ingredients: [
      ['makaron penne', 160, 'g'],
      ['cukinia', 300, 'g'],
      ['pomidor koktajlowy', 200, 'g'],
      ['czosnek', 2, 'szt'],
      ['oliwa z oliwek', 25, 'ml'],
      ['pestki dyni', 20, 'g'],
      ['oregano', 2, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Makaron ugotuj al dente, odlej pół szklanki wody z gotowania.',
      'Cukinię pokrój w półplasterki, smaż na oliwie 6 minut, dodaj czosnek i pomidorki przekrojone na pół.',
      'Smaż 3 minuty, dopraw oregano, solą i pieprzem.',
      'Wymieszaj z makaronem, podlewając wodą z gotowania. Posyp uprażonymi na suchej patelni pestkami.',
    ],
    photo:
      'Penne pasta with sautéed zucchini, cherry tomatoes and toasted pumpkin seeds',
    pools: ['VEGAN'],
  },
  // ─── KETO (nabiał i jajka dozwolone; ≤ 20 g węgli na porcję) ───────────
  {
    title: 'Kurczak w śmietanowym sosie ze szpinakiem',
    description:
      'Filet z kurczaka obsmażony i duszony w sosie ze śmietanki, parmezanu i czosnku ze szpinakiem. Kremowy obiad niskowęglowodanowy, bez dodatku skrobi.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['filet z kurczaka', 400, 'g'],
      ['śmietanka 30', 150, 'ml'],
      ['szpinak', 150, 'g'],
      ['ser parmezan', 30, 'g'],
      ['czosnek', 2, 'szt'],
      ['masło', 20, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Filety rozbij lekko, dopraw solą i pieprzem, obsmaż na maśle po 4 minuty z każdej strony. Odłóż.',
      'Na patelnię wrzuć posiekany czosnek, po chwili wlej śmietankę i zagotuj.',
      'Dodaj szpinak i starty parmezan, mieszaj, aż szpinak zwiędnie, a sos zgęstnieje.',
      'Włóż kurczaka z powrotem do sosu i duś 3 minuty.',
    ],
    photo: 'Chicken breast in creamy parmesan spinach sauce in a skillet',
    pools: ['KETO'],
  },
  {
    title: 'Łosoś z masłem czosnkowym i brokułem',
    description:
      'Filet z łososia pieczony z masłem czosnkowym i cytryną, obok brokuł skropiony oliwą. Dużo tłuszczu omega-3, prawie zero węglowodanów.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['łosoś', 300, 'g'],
      ['brokuł', 300, 'g'],
      ['masło', 30, 'g'],
      ['czosnek', 2, 'szt'],
      ['cytryna', 1, 'szt'],
      ['oliwa z oliwek', 15, 'ml'],
      ['koperek', 10, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Masło wymieszaj z posiekanym czosnkiem, koperkiem i skórką z cytryny.',
      'Łososia ułóż na blasze, dopraw solą i pieprzem, posmaruj masłem czosnkowym.',
      'Obok rozłóż różyczki brokułu skropione oliwą i solą.',
      'Piecz 15 minut w 200°C. Podawaj z ćwiartkami cytryny.',
    ],
    photo:
      'Baked salmon fillet with garlic butter and roasted broccoli, lemon wedges',
    pools: ['KETO'],
  },
  {
    title: 'Sałatka caprese z awokado',
    description:
      'Mozzarella, pomidorki koktajlowe i awokado z oliwą, sokiem z cytryny i oregano. Kolacja bez gotowania, która syci tłuszczem, nie pieczywem.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['mozzarella', 250, 'g'],
      ['pomidor koktajlowy', 250, 'g'],
      ['awokado', 1, 'szt'],
      ['oliwa z oliwek', 25, 'ml'],
      ['cytryna', 1, 'szt'],
      ['oregano', 1, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Mozzarellę porwij na kawałki, pomidorki przekrój na pół, awokado pokrój w plastry.',
      'Ułóż na talerzach, polej oliwą i sokiem z połowy cytryny.',
      'Dopraw solą, pieprzem i oregano.',
    ],
    photo:
      'Caprese salad with avocado slices, cherry tomatoes and torn mozzarella',
    pools: ['KETO'],
  },
  {
    title: 'Omlet z pieczarkami i parmezanem',
    description:
      'Puszysty omlet z trzech jajek z pieczarkami smażonymi na maśle, szczypiorkiem i parmezanem. Śniadanie keto gotowe w kwadrans.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['jajko', 6, 'szt'],
      ['pieczarka', 200, 'g'],
      ['ser parmezan', 30, 'g'],
      ['masło', 20, 'g'],
      ['szczypiorek', 10, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Pieczarki pokrój w plastry i smaż na połowie masła, aż odparują i zbrązowieją.',
      'Jajka roztrzep z solą i pieprzem. Na reszcie masła wylej połowę masy jajecznej.',
      'Gdy spód się zetnie, nałóż połowę pieczarek i parmezanu, złóż omlet na pół. Powtórz z drugą porcją.',
      'Posyp szczypiorkiem.',
    ],
    photo: 'Folded mushroom omelette with parmesan and chives on a plate',
    pools: ['KETO'],
  },
  {
    title: 'Cukinia zapiekana z mięsem mielonym i goudą',
    description:
      'Połówki cukinii wypełnione mielonym mięsem duszonym w pomidorach z papryką, zapieczone pod goudą. Obiad keto bez makaronu i ryżu.',
    mealType: 'LUNCH',
    difficulty: 'MEDIUM',
    prepTimeMinutes: 45,
    servings: 2,
    ingredients: [
      ['cukinia', 600, 'g'],
      ['wieprzowina i wołowina mielona', 300, 'g'],
      ['ser gouda', 80, 'g'],
      ['pomidor krojony z puszki', 200, 'g'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['oliwa z oliwek', 15, 'ml'],
      ['papryka słodka mielona', 3, 'g'],
      ['oregano', 2, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Cukinie przekrój wzdłuż, wydrąż środek łyżką, miąższ posiekaj.',
      'Na oliwie zeszklij cebulę i czosnek, dodaj mięso i smaż, aż się zrumieni.',
      'Dodaj miąższ cukinii, pomidory, paprykę i oregano, duś 10 minut, dopraw.',
      'Napełnij łódki mięsem, posyp startą goudą i piecz 20 minut w 190°C.',
    ],
    photo: 'Zucchini boats stuffed with minced meat and melted gouda cheese',
    pools: ['KETO'],
  },
  {
    title: 'Jajka zapiekane w awokado',
    description:
      'Połówki awokado z wbitym jajkiem, zapieczone i posypane szczypiorkiem i pestkami dyni. Śniadanie keto z dwóch składników, bez patelni.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 20,
    servings: 2,
    ingredients: [
      ['awokado', 2, 'szt'],
      ['jajko', 4, 'szt'],
      ['pestki dyni', 15, 'g'],
      ['szczypiorek', 10, 'g'],
      ['papryka słodka mielona', 2, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Awokado przekrój, usuń pestki i powiększ łyżką wgłębienia.',
      'Ułóż w foremce, żeby się nie przewracały, wbij do każdej połówki jajko, dopraw solą i pieprzem.',
      'Piecz 15 minut w 200°C, aż białko się zetnie.',
      'Posyp szczypiorkiem, papryką i pestkami dyni.',
    ],
    photo: 'Baked eggs in avocado halves with chives and pumpkin seeds',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Dorsz pieczony z cukinią i oliwkową gremolatą',
    description:
      'Filet z dorsza i plastry cukinii pieczone razem, polane oliwą z czosnkiem, natką i cytryną. Lekka kolacja niskowęglowodanowa.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['dorsz', 350, 'g'],
      ['cukinia', 400, 'g'],
      ['oliwa z oliwek', 30, 'ml'],
      ['czosnek', 2, 'szt'],
      ['natka pietruszki', 15, 'g'],
      ['cytryna', 1, 'szt'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Cukinię pokrój w plastry, rozłóż na blasze, skrop połową oliwy, dopraw.',
      'Na cukinii ułóż dorsza, dopraw solą i pieprzem. Piecz 15 minut w 200°C.',
      'Resztę oliwy wymieszaj z posiekanym czosnkiem, natką i skórką z cytryny.',
      'Polej rybę gremolatą i skrop sokiem z cytryny.',
    ],
    photo: 'Baked cod fillet on zucchini slices with parsley garlic gremolata',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Sałatka z kurczakiem, ogórkiem i orzechami włoskimi',
    description:
      'Grillowany kurczak na sałacie lodowej z ogórkiem, rzodkiewką i orzechami włoskimi, w dressingu z jogurtu greckiego i koperku. Kolacja z dużą porcją białka.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 20,
    servings: 2,
    ingredients: [
      ['filet z kurczaka', 300, 'g'],
      ['sałata lodowa', 200, 'g'],
      ['ogórek', 1, 'szt'],
      ['rzodkiewka', 100, 'g'],
      ['orzech włoski', 40, 'g'],
      ['jogurt grecki', 100, 'g'],
      ['koperek', 10, 'g'],
      ['oliwa z oliwek', 15, 'ml'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Kurczaka dopraw, usmaż na oliwie po 5 minut z każdej strony, pokrój w paski.',
      'Sałatę porwij, ogórek i rzodkiewki pokrój w plasterki.',
      'Jogurt wymieszaj z posiekanym koperkiem, szczyptą soli i pieprzu.',
      'Ułóż sałatę z warzywami, na wierzch kurczaka i orzechy, polej dressingiem.',
    ],
    photo:
      'Chicken salad with iceberg lettuce, cucumber, radish and walnuts, yogurt dill dressing',
    pools: ['KETO'],
  },
  // ─── PALEO (bez zbóż, strączków, nabiału, przetworzonych) ──────────────
  {
    title: 'Polędwiczka wieprzowa z pieczoną dynią i tymiankiem',
    description:
      'Polędwiczka obsmażona i dopieczona w piekarniku obok kostek dyni z czosnkiem i tymiankiem. Obiad paleo z jednej blachy.',
    mealType: 'LUNCH',
    difficulty: 'MEDIUM',
    prepTimeMinutes: 40,
    servings: 2,
    ingredients: [
      ['polędwiczka wieprzowa', 400, 'g'],
      ['dynia', 500, 'g'],
      ['czosnek', 3, 'szt'],
      ['oliwa z oliwek', 25, 'ml'],
      ['tymianek suszony', 2, 'g'],
      ['sól', 3, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Dynię pokrój w kostkę, wymieszaj z połową oliwy, czosnkiem, tymiankiem, solą i pieprzem. Piecz 15 minut w 200°C.',
      'Polędwiczkę dopraw i obsmaż na reszcie oliwy ze wszystkich stron.',
      'Ułóż mięso na blasze obok dyni i piecz jeszcze 15 minut.',
      'Odstaw mięso na 5 minut, pokrój w plastry i podawaj z dynią.',
    ],
    photo:
      'Sliced roast pork tenderloin with roasted pumpkin cubes and thyme on a sheet pan',
    pools: ['PALEO'],
  },
  {
    title: 'Indyk mielony duszony z papryką i cukinią',
    description:
      'Mielony indyk duszony z papryką, cukinią i pomidorami z puszki, z kminem i wędzoną papryką. Jedna patelnia, mało węglowodanów, bez nabiału.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 30,
    servings: 2,
    ingredients: [
      ['indyk mielony', 400, 'g'],
      ['papryka czerwona', 1, 'szt'],
      ['cukinia', 300, 'g'],
      ['pomidor krojony z puszki', 400, 'g'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['oliwa z oliwek', 20, 'ml'],
      ['papryka słodka mielona', 3, 'g'],
      ['kmin rzymski', 2, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Na oliwie zeszklij cebulę, dodaj czosnek i indyka, smaż rozdrabniając, aż zbieleje.',
      'Dodaj paprykę i cukinię pokrojone w kostkę, smaż 5 minut.',
      'Wlej pomidory, dodaj przyprawy, duś 15 minut bez przykrycia.',
      'Dopraw do smaku i podawaj.',
    ],
    photo: 'Ground turkey skillet with red pepper, zucchini and tomatoes',
    pools: ['PALEO', 'KETO'],
  },
  {
    title: 'Placuszki z batata z jajkiem',
    description:
      'Placuszki ze startego batata, jajka i cebuli, smażone na oleju na złoto, podane z pomidorem i szczypiorkiem. Śniadanie paleo bez mąki i bez nabiału.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['batat', 400, 'g'],
      ['jajko', 2, 'szt'],
      ['cebula', 1, 'szt'],
      ['olej rzepakowy', 25, 'ml'],
      ['pomidor', 2, 'szt'],
      ['szczypiorek', 10, 'g'],
      ['papryka słodka mielona', 2, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Batata obierz i zetrzyj na grubych oczkach, odciśnij z soku. Cebulę zetrzyj drobno.',
      'Wymieszaj z jajkami, papryką, solą i pieprzem.',
      'Nakładaj łyżką na rozgrzany olej, spłaszcz i smaż po 4 minuty z każdej strony.',
      'Podawaj z pomidorem w plastrach i szczypiorkiem.',
    ],
    photo: 'Golden sweet potato fritters with sliced tomato and chives',
    pools: ['PALEO'],
  },
  {
    title: 'Wołowina duszona z marchewką i selerem',
    description:
      'Kawałki wołowiny duszone powoli z marchewką, selerem, cebulą i koncentratem pomidorowym, z majerankiem. Gęsty gulasz paleo bez zasmażki.',
    mealType: 'LUNCH',
    difficulty: 'MEDIUM',
    prepTimeMinutes: 90,
    servings: 2,
    ingredients: [
      ['wołowina', 500, 'g'],
      ['marchew', 2, 'szt'],
      ['seler korzeniowy', 150, 'g'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['koncentrat pomidorowy', 30, 'g'],
      ['olej rzepakowy', 20, 'ml'],
      ['majeranek', 3, 'g'],
      ['sól', 3, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Wołowinę pokrój w kostkę, dopraw i obsmaż partiami na oleju. Odłóż.',
      'W tym samym garnku zeszklij cebulę, dodaj czosnek i koncentrat, smaż minutę.',
      'Włóż mięso, dodaj marchew i seler w kostce, majeranek, wlej 400 ml wody.',
      'Duś pod przykryciem 70 minut, aż mięso będzie miękkie, a sos gęsty. Dopraw.',
    ],
    photo: 'Slow-braised beef stew with carrot and celeriac in a rustic pot',
    pools: ['PALEO'],
  },
  {
    title: 'Sałatka z pieczonego buraka, jabłka i orzechów włoskich',
    description:
      'Pieczony burak z jabłkiem, sałatą lodową, orzechami włoskimi i dressingiem z oliwy i octu jabłkowego. Kolacja wegańska i paleo w jednym.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 45,
    servings: 2,
    ingredients: [
      ['burak', 400, 'g'],
      ['jabłko', 1, 'szt'],
      ['sałata lodowa', 150, 'g'],
      ['orzech włoski', 40, 'g'],
      ['oliwa z oliwek', 25, 'ml'],
      ['ocet jabłkowy', 15, 'ml'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Buraki zawiń w folię i piecz 40 minut w 200°C, obierz i pokrój w kostkę.',
      'Jabłko pokrój w cienkie plasterki, sałatę porwij.',
      'Oliwę wymieszaj z octem, solą i pieprzem.',
      'Połącz wszystko na talerzach, posyp orzechami i polej dressingiem.',
    ],
    photo: 'Roasted beetroot salad with apple slices, walnuts and lettuce',
    pools: ['VEGAN', 'PALEO'],
  },
  {
    title: 'Jajecznica z awokado i pomidorem',
    description:
      'Jajecznica na oliwie z pomidorem i kostkami awokado, ze szczypiorkiem. Śniadanie w 10 minut, bez pieczywa i nabiału.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['jajko', 5, 'szt'],
      ['awokado', 1, 'szt'],
      ['pomidor', 1, 'szt'],
      ['oliwa z oliwek', 15, 'ml'],
      ['szczypiorek', 10, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Pomidora pokrój w kostkę, podsmaż minutę na oliwie.',
      'Wbij jajka, dopraw i mieszaj na małym ogniu, aż się zetną, ale zostaną kremowe.',
      'Zdejmij z ognia, dodaj awokado w kostce i szczypiorek.',
    ],
    photo: 'Soft scrambled eggs with avocado cubes, tomato and chives',
    pools: ['PALEO', 'KETO'],
  },
  {
    title: 'Curry z kurczaka na mleku kokosowym z brokułem',
    description:
      'Kurczak duszony w mleku kokosowym z curry, imbirem i czosnkiem, z brokułem i papryką. Bez ryżu: syci tłuszcz kokosowy, a warzywa dają objętość.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 30,
    servings: 2,
    ingredients: [
      ['filet z kurczaka', 400, 'g'],
      ['mleko kokosowe z puszki', 400, 'ml'],
      ['brokuł', 300, 'g'],
      ['papryka czerwona', 1, 'szt'],
      ['cebula', 1, 'szt'],
      ['czosnek', 2, 'szt'],
      ['olej rzepakowy', 15, 'ml'],
      ['curry', 8, 'g'],
      ['imbir mielony', 2, 'g'],
      ['sól', 2, 'g'],
    ],
    steps: [
      'Kurczaka pokrój w kostkę, obsmaż na oleju, odłóż.',
      'Zeszklij cebulę z czosnkiem, dodaj curry i imbir, smaż minutę.',
      'Wlej mleko kokosowe, dodaj kurczaka, brokuł i paprykę, duś 12 minut pod przykryciem.',
      'Dopraw solą i podawaj.',
    ],
    photo: 'Coconut chicken curry with broccoli and red pepper in a bowl',
    pools: ['PALEO'],
  },
  {
    title: 'Mintaj pieczony z warzywami korzeniowymi',
    description:
      'Filet z mintaja pieczony na warstwie marchewki, pietruszki i pora z oliwą i tymiankiem. Lekka kolacja paleo z jednej blachy.',
    mealType: 'DINNER',
    difficulty: 'EASY',
    prepTimeMinutes: 35,
    servings: 2,
    ingredients: [
      ['mintaj', 400, 'g'],
      ['marchew', 2, 'szt'],
      ['pietruszka korzeń', 150, 'g'],
      ['por', 150, 'g'],
      ['oliwa z oliwek', 25, 'ml'],
      ['cytryna', 1, 'szt'],
      ['tymianek suszony', 2, 'g'],
      ['sól', 2, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Marchew i pietruszkę pokrój w słupki, por w plastry. Wymieszaj z połową oliwy, tymiankiem, solą.',
      'Piecz 15 minut w 200°C.',
      'Na warzywach ułóż mintaja, skrop resztą oliwy i sokiem z cytryny, dopraw. Piecz 12 minut.',
    ],
    photo: 'Baked pollock fillet over roasted carrot, parsnip and leek',
    pools: ['PALEO'],
  },
  {
    title: 'Kotlety z indyka z pieczonymi burakami',
    description:
      'Kotleciki z mielonego indyka z cebulą i jajkiem, bez bułki, smażone na oleju, z pieczonymi burakami i koperkiem. Obiad paleo z polskiej kuchni.',
    mealType: 'LUNCH',
    difficulty: 'EASY',
    prepTimeMinutes: 50,
    servings: 2,
    ingredients: [
      ['indyk mielony', 400, 'g'],
      ['jajko', 1, 'szt'],
      ['cebula', 1, 'szt'],
      ['burak', 400, 'g'],
      ['olej rzepakowy', 25, 'ml'],
      ['koperek', 10, 'g'],
      ['majeranek', 2, 'g'],
      ['sól', 3, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Buraki pokrój w ćwiartki, skrop częścią oleju, dopraw i piecz 35 minut w 200°C.',
      'Indyka wymieszaj z jajkiem, drobno startą cebulą, majerankiem, solą i pieprzem.',
      'Uformuj 6 kotletów i smaż na oleju po 5 minut z każdej strony.',
      'Podawaj z burakami posypanymi koperkiem.',
    ],
    photo: 'Turkey patties with roasted beetroot wedges and dill',
    pools: ['PALEO'],
  },
  {
    title: 'Miska smoothie z borówkami, bananem i chia',
    description:
      'Gęste smoothie z borówek, banana i mleka kokosowego, w misce, z nasionami chia i truskawkami na wierzchu. Śniadanie bez gotowania, wegańskie i paleo.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['borówka', 200, 'g'],
      ['banan', 2, 'szt'],
      ['mleko kokosowe z puszki', 200, 'ml'],
      ['nasiona chia', 20, 'g'],
      ['truskawka', 100, 'g'],
    ],
    steps: [
      'Borówki, jednego banana i mleko kokosowe zmiksuj na gęsto.',
      'Przelej do misek, ułóż na wierzchu plasterki drugiego banana i truskawki.',
      'Posyp nasionami chia.',
    ],
    photo:
      'Blueberry smoothie bowl topped with banana, strawberries and chia seeds',
    pools: ['VEGAN', 'PALEO'],
  },
];

const CATALOG_DIR = join(process.cwd(), 'prisma', 'catalog');
const NUTRITION = JSON.parse(
  readFileSync(join(CATALOG_DIR, 'ingredient-nutrition-pl-v1.json'), 'utf8'),
) as {
  ingredients: {
    normalizedName: string;
    unit: string;
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number;
    gramsPerPiece?: number | null;
  }[];
};
const TAGS = JSON.parse(
  readFileSync(join(CATALOG_DIR, 'ingredient-tags-pl-v1.json'), 'utf8'),
) as {
  ingredients: {
    name: string;
    normalizedName: string;
    category: string;
    dietTags: string[];
  }[];
};

const nutritionByNorm = new Map(
  NUTRITION.ingredients.map((e) => [e.normalizedName, e]),
);
const tagsByName = new Map(TAGS.ingredients.map((e) => [e.name, e]));

/** Stały UUID v4 z tytułu — ponowne uruchomienie generatora nie zmienia id. */
function stableUuid(title: string): string {
  const h = createHash('sha256').update(`diety-2026-09:${title}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(
    (parseInt(h[16], 16) & 0x3) |
    0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function build() {
  const errors: string[] = [];
  const recipes = DEFS.map((def) => {
    const items = def.ingredients.map(([name, amount, unit]) => {
      const tag = tagsByName.get(name);
      if (!tag) errors.push(`${def.title}: nieznany składnik „${name}"`);
      const norm = tag?.normalizedName ?? normalizeText(name);
      const nut = nutritionByNorm.get(norm);
      if (!nut) errors.push(`${def.title}: brak makro dla „${name}"`);
      if (unit === 'szt' && !nut?.gramsPerPiece)
        errors.push(`${def.title}: „${name}" nie ma wagi sztuki`);
      const normalized = normalizeIngredientAmount(
        name,
        tag?.category ?? 'inne',
        amount,
        unit,
      );
      return {
        name,
        normalizedAmount: normalized.normalizedAmount,
        normalizedUnit: normalized.normalizedUnit,
        nutrition: nut
          ? {
              kcal: nut.kcal,
              protein: nut.protein,
              carbs: nut.carbs,
              fat: nut.fat,
              fiber: nut.fiber,
              gramsPerPiece: nut.gramsPerPiece ?? null,
            }
          : null,
      };
    });
    const result = computeRecipeNutrition(items);
    if (result.missingNutrition.length || result.missingPieceWeight.length) {
      errors.push(
        `${def.title}: brak danych ${[...result.missingNutrition, ...result.missingPieceWeight].join(', ')}`,
      );
    }
    const dietTags = new Set<string>();
    for (const [name] of def.ingredients)
      for (const t of tagsByName.get(name)?.dietTags ?? []) dietTags.add(t);
    const salt = def.ingredients.find(([name]) => name === 'sól')?.[1] ?? 0;
    const perServingCarbs = result.totals.carbs / def.servings;
    const isVegan = ![
      'MEAT',
      'FISH',
      'CRUSTACEAN',
      'DAIRY',
      'EGG',
      'ANIMAL_OTHER',
    ].some((t) => dietTags.has(t));
    const isPaleo = ![
      'GRAIN',
      'GLUTEN_GRAIN',
      'LEGUME',
      'DAIRY',
      'PROCESSED',
    ].some((t) => dietTags.has(t));
    const isKeto = perServingCarbs <= 20;
    for (const pool of def.pools) {
      if (pool === 'VEGAN' && !isVegan)
        errors.push(
          `${def.title}: nie jest wegańskie (${[...dietTags].join(',')})`,
        );
      if (pool === 'PALEO' && !isPaleo)
        errors.push(
          `${def.title}: nie jest paleo (${[...dietTags].join(',')})`,
        );
      if (pool === 'KETO' && !isKeto)
        errors.push(
          `${def.title}: ${perServingCarbs.toFixed(1)} g węgli na porcję > 20`,
        );
    }
    return {
      id: stableUuid(def.title),
      title: def.title,
      description: def.description,
      mealType: def.mealType,
      difficulty: def.difficulty,
      prepTimeMinutes: def.prepTimeMinutes,
      servings: def.servings,
      nutrition: {
        kcal: Math.round(result.totals.kcal),
        protein: Math.round(result.totals.protein),
        carbs: Math.round(result.totals.carbs),
        fat: Math.round(result.totals.fat),
        fiber: Math.round(result.totals.fiber),
        // Sól z definicji to sól DODANA; łączną (ze sodu składników + dodana)
        // liczy `recipes:recompute:nutrition` i zapisuje w `salt`.
        salt: Math.round(salt * 10) / 10,
        addedSalt: Math.round(salt * 10) / 10,
      },
      steps: def.steps.map((instruction, i) => ({ step: i + 1, instruction })),
      ingredients: def.ingredients.map(([ingredientName, amount, unit]) => ({
        ingredientName,
        amount,
        unit,
      })),
      image: {
        prompt: `professional food photo, ${def.title}, ${def.photo}, natural light, no text`,
        imageUrl: RECIPE_IMAGE_PLACEHOLDER_URL,
      },
      _pools: {
        vegan: isVegan,
        paleo: isPaleo,
        keto: isKeto,
        carbsPerServing: Math.round(perServingCarbs),
      },
    };
  });
  return { recipes, errors };
}

const { recipes, errors } = build();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const summary = recipes.map(
  (r) =>
    `${r.title} · ${r.mealType} · ${r.nutrition.kcal} kcal/${r.servings} · ${JSON.stringify(r._pools)}`,
);
console.log(summary.join('\n'));
const clean = recipes.map(({ _pools, ...rest }) => rest);
const batch = { version: 'recipes-batch-diety-28-v1', recipes: clean };
writeFileSync(
  join(CATALOG_DIR, 'recipes-batch-diety-28-v1.json'),
  JSON.stringify(batch, null, 2) + '\n',
);
const fullPath = join(CATALOG_DIR, 'recipes-catalog-full-v2.json');
const full = JSON.parse(readFileSync(fullPath, 'utf8')) as {
  version: string;
  recipes: { id: string }[];
};
const known = new Set(full.recipes.map((r) => r.id));
const added = clean.filter((r) => !known.has(r.id));
full.recipes.push(...added);
writeFileSync(fullPath, JSON.stringify(full, null, 2) + '\n');
console.log(
  `zapisano partię ${clean.length}; do pełnego katalogu doklejono ${added.length} (razem ${full.recipes.length})`,
);
