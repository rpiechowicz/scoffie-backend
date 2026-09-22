/**
 * Partia „przekąski i śniadania" (audyt 2, 3.09.2026).
 *
 * Dwie luki katalogu: keto i paleo nie wypełniały tygodnia w 4 z 6 slotów
 * (podwieczorek keto: zero przepisów), a pula „bez glutenu, mleka, jajek
 * i orzechów naraz" miała 2 śniadania. Stąd 12 przekąsek (wszystkie ≤ 420
 * kcal/porcja i ≤ 25 min, żeby mieściły się w progach klasyfikatora slotów)
 * i 8 śniadań bez czterech najczęstszych alergenów.
 *
 * Uruchomienie: `pnpm exec tsx scripts/lib/przekaski-i-sniadania-2026-09.ts`
 * — liczy makro z tabeli składników, sprawdza pule i progi, zapisuje partię
 * i dokleja nowe przepisy do `recipes-catalog-full-v2.json`. Potem
 * `pnpm recipes:recompute:nutrition -- --json-only --write` (sól ze sodu).
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
  /** Jedno zdanie po angielsku: co widać na talerzu. */
  photo: string;
  /** Naczynie do promptu; domyślnie talerz. */
  vessel?: 'plate' | 'bowl' | 'board';
  /** Do samokontroli generatora — które pule ma zasilić. */
  pools: ('VEGAN' | 'KETO' | 'PALEO' | 'FREE_FROM_4')[];
};

const DEFS: Def[] = [
  // ─── przekąski keto / paleo ───
  {
    title: 'Jajka faszerowane pastą z awokado',
    description:
      'Połówki jajek na twardo wypełnione kremową pastą z awokado, cytryny i szczypiorku. Przekąska bez węglowodanów, gotowa w kwadrans, dobra też do pudełka.',
    mealType: 'SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['jajko', 4, 'szt'],
      ['awokado', 1, 'szt'],
      ['cytryna', 20, 'g'],
      ['szczypiorek', 10, 'g'],
      ['oliwa z oliwek', 5, 'ml'],
      ['sól', 1, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Jajka ugotuj na twardo (9 minut), ostudź w zimnej wodzie i obierz.',
      'Przekrój jajka wzdłuż, wyjmij żółtka do miski.',
      'Do żółtek dodaj miąższ awokado, sok z cytryny, oliwę, sól i pieprz; rozgnieć widelcem na gładką pastę.',
      'Wmieszaj posiekany szczypiorek, część zostaw do posypania.',
      'Napełnij białka pastą, posyp szczypiorkiem i pieprzem.',
    ],
    photo:
      'Halved hard-boiled eggs filled with creamy green avocado paste, topped with chopped chives and cracked black pepper',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Roladki z łososia wędzonego z serkiem i ogórkiem',
    description:
      'Plastry wędzonego łososia zwinięte z serkiem kremowym, koperkiem i słupkami ogórka. Dziesięć minut pracy, zero gotowania, przekąska keto na zimno.',
    mealType: 'SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['łosoś wędzony', 100, 'g'],
      ['serek kremowy', 60, 'g'],
      ['ogórek', 0.5, 'szt'],
      ['koperek', 5, 'g'],
      ['cytryna', 10, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Ogórek pokrój w cienkie słupki, koperek posiekaj.',
      'Serek wymieszaj z koperkiem, sokiem z cytryny i pieprzem.',
      'Plastry łososia rozłóż na desce, posmaruj serkiem.',
      'Na brzegu każdego plastra ułóż słupki ogórka i ciasno zwiń.',
      'Przekrój roladki na pół i ułóż przekrojem do góry.',
    ],
    photo:
      'Smoked salmon roll-ups filled with white cream cheese, dill and cucumber sticks, cut in halves and arranged upright',
    vessel: 'board',
    pools: ['KETO'],
  },
  {
    title: 'Chipsy z parmezanu z pestkami dyni',
    description:
      'Kopczyki tartego parmezanu zapieczone na chrupiące krążki, posypane pestkami dyni i papryką. Słona przekąska keto zamiast chipsów, z jednego składnika i piekarnika.',
    mealType: 'SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['ser parmezan', 80, 'g'],
      ['pestki dyni', 15, 'g'],
      ['papryka słodka mielona', 1, 'g'],
    ],
    steps: [
      'Piekarnik nagrzej do 200°C, blachę wyłóż papierem.',
      'Parmezan zetrzyj drobno i układaj kopczyki po łyżce w odstępach.',
      'Każdy kopczyk lekko spłaszcz, posyp pestkami dyni i papryką.',
      'Piecz 5–6 minut, aż krążki się roztopią i zezłocą na brzegach.',
      'Wyjmij i zostaw na blasze 3 minuty — chipsy stwardnieją przy studzeniu.',
    ],
    photo:
      'Golden crispy baked parmesan crisps sprinkled with green pumpkin seeds and paprika, stacked loosely',
    vessel: 'board',
    pools: ['KETO'],
  },
  {
    title: 'Mus czekoladowy z awokado i kakao',
    description:
      'Gęsty, ciemny mus z dojrzałego awokado, kakao i mleka kokosowego, bez cukru, z garścią malin na wierzchu. Podwieczorek keto, który smakuje jak deser.',
    mealType: 'AFTERNOON_SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['awokado', 2, 'szt'],
      ['kakao', 15, 'g'],
      ['mleko kokosowe z puszki', 80, 'ml'],
      ['malina', 60, 'g'],
      ['cynamon', 1, 'g'],
    ],
    steps: [
      'Awokado obierz i wyjmij pestki.',
      'Zmiksuj miąższ z kakao, mlekiem kokosowym i cynamonem na gładki, gęsty mus.',
      'Spróbuj — jeśli chcesz słodziej, dodaj kilka rozgniecionych malin.',
      'Przełóż do dwóch miseczek i schłodź 10 minut w lodówce.',
      'Podawaj z resztą malin i szczyptą kakao.',
    ],
    photo:
      'Dark glossy chocolate avocado mousse in small bowls topped with fresh raspberries and a dusting of cocoa',
    vessel: 'bowl',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Kulki z pestek dyni, kakao i kokosa',
    description:
      'Osiem kulek z mielonych pestek dyni, kakao i mleka kokosowego, lekko dosłodzonych miodem. Bez pieczenia, bez glutenu i nabiału; do pudełka na kilka dni.',
    mealType: 'AFTERNOON_SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['pestki dyni', 80, 'g'],
      ['kakao', 10, 'g'],
      ['mleko kokosowe z puszki', 40, 'ml'],
      ['miód', 10, 'g'],
      ['cynamon', 1, 'g'],
    ],
    steps: [
      'Pestki dyni zmiel w blenderze na grubą mąkę.',
      'Dodaj kakao, cynamon, miód i mleko kokosowe; miksuj, aż masa zacznie się kleić.',
      'Odmierz łyżką osiem porcji i uformuj kulki wilgotnymi dłońmi.',
      'Obtocz część kulek w kakao.',
      'Schłodź 30 minut w lodówce, żeby stwardniały.',
    ],
    photo:
      'Eight small dark energy balls made of pumpkin seeds and cocoa, some dusted with cocoa powder, arranged in a shallow bowl',
    vessel: 'bowl',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Sałatka z tuńczykiem, awokado i ogórkiem',
    description:
      'Tuńczyk z puszki z kostkami awokado i ogórka, oliwą i cytryną. Sycąca przekąska keto bez gotowania, zjesz ją widelcem prosto z pudełka.',
    mealType: 'SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['tuńczyk w puszce', 150, 'g'],
      ['awokado', 1, 'szt'],
      ['ogórek', 0.5, 'szt'],
      ['oliwa z oliwek', 10, 'ml'],
      ['cytryna', 10, 'g'],
      ['szczypiorek', 5, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Tuńczyka odsącz i rozdrobnij widelcem.',
      'Awokado i ogórka pokrój w kostkę, szczypiorek posiekaj.',
      'Wymieszaj wszystko z oliwą i sokiem z cytryny.',
      'Dopraw pieprzem; sól zwykle jest zbędna, tuńczyk jest słony.',
      'Podawaj od razu albo schłodź w pudełku do 24 godzin.',
    ],
    photo:
      'Chunky tuna salad with avocado cubes, diced cucumber and chives glistening with olive oil',
    vessel: 'bowl',
    pools: ['KETO'],
  },
  {
    title: 'Roladki z szynki z serkiem i papryką',
    description:
      'Plastry szynki zwinięte z serkiem kremowym i paskami czerwonej papryki. Chrupiące, słone, gotowe w dziesięć minut; typowa przekąska keto na wynos.',
    mealType: 'SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['szynka', 100, 'g'],
      ['serek kremowy', 60, 'g'],
      ['papryka czerwona', 0.5, 'szt'],
      ['szczypiorek', 5, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Paprykę pokrój w cienkie paski, szczypiorek posiekaj.',
      'Serek wymieszaj ze szczypiorkiem i pieprzem.',
      'Każdy plaster szynki posmaruj serkiem.',
      'Ułóż paski papryki na brzegu i ciasno zwiń.',
      'Przekrój na pół i spinaj wykałaczką, jeśli roladki się rozwijają.',
    ],
    photo:
      'Ham roll-ups filled with cream cheese and red pepper strips, cut in halves and stacked on a wooden board',
    vessel: 'board',
    pools: ['KETO'],
  },
  {
    title: 'Kurczak w plastrach z guacamole',
    description:
      'Cienkie plastry piersi z kurczaka podsmażone na oliwie z papryką, podane z szybkim guacamole z czosnkiem i cytryną. Białko i tłuszcz, bez węglowodanów — keto i paleo.',
    mealType: 'SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['filet z kurczaka', 200, 'g'],
      ['awokado', 1, 'szt'],
      ['cytryna', 15, 'g'],
      ['czosnek', 1, 'szt'],
      ['oliwa z oliwek', 10, 'ml'],
      ['papryka słodka mielona', 2, 'g'],
      ['sól', 1, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Filet pokrój w plastry grubości palca, natrzyj papryką, solą i pieprzem.',
      'Smaż na oliwie po 3 minuty z każdej strony, aż będzie złoty.',
      'Awokado rozgnieć widelcem z przeciśniętym czosnkiem i sokiem z cytryny.',
      'Dopraw guacamole solą i pieprzem.',
      'Podawaj plastry kurczaka z guacamole do maczania.',
    ],
    photo:
      'Golden pan-seared chicken breast slices next to a small bowl of chunky green guacamole with lemon wedge',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Marchewki i ogórek z dipem z awokado',
    description:
      'Słupki marchewki i ogórka do maczania w kremowym dipie z awokado, cytryny i natki. Chrupiąca przekąska bez gotowania, keto i paleo.',
    mealType: 'SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['marchew', 3, 'szt'],
      ['ogórek', 0.5, 'szt'],
      ['awokado', 1, 'szt'],
      ['cytryna', 15, 'g'],
      ['oliwa z oliwek', 5, 'ml'],
      ['natka pietruszki', 5, 'g'],
      ['sól', 1, 'g'],
    ],
    steps: [
      'Marchewki obierz i pokrój w słupki, ogórka w grubsze paski.',
      'Awokado rozgnieć z sokiem z cytryny, oliwą i solą.',
      'Wmieszaj posiekaną natkę.',
      'Dip przełóż do miseczki, warzywa ułóż wokół.',
      'Jeśli dip ma czekać, przykryj go folią przylegającą, żeby nie ściemniał.',
    ],
    photo:
      'Bright orange carrot sticks and cucumber batons arranged around a small bowl of creamy avocado dip with parsley',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Muffiny jajeczne ze szpinakiem i pomidorkami',
    description:
      'Sześć muffinów z jajek, szpinaku, pomidorków i cebulki, pieczonych w foremkach. Białkowe drugie śniadanie na trzy dni, keto i paleo, dobre na zimno.',
    mealType: 'SECOND_BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 20,
    servings: 3,
    ingredients: [
      ['jajko', 6, 'szt'],
      ['szpinak', 60, 'g'],
      ['pomidor koktajlowy', 100, 'g'],
      ['cebula', 0.5, 'szt'],
      ['oliwa z oliwek', 10, 'ml'],
      ['sól', 1, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Piekarnik nagrzej do 180°C, sześć foremek na muffiny natłuść oliwą.',
      'Cebulę posiekaj i zeszklij na reszcie oliwy, dodaj szpinak i smaż, aż zwiędnie.',
      'Jajka roztrzep z solą i pieprzem.',
      'Do foremek rozłóż szpinak z cebulą i połówki pomidorków, zalej jajkami.',
      'Piecz 18–20 minut, aż muffiny się zetną i lekko wyrosną.',
    ],
    photo:
      'Six golden baked egg muffins studded with spinach and halved cherry tomatoes, one cut open to show the inside',
    pools: ['KETO', 'PALEO'],
  },
  {
    title: 'Chipsy z batata z papryką',
    description:
      'Cienkie plastry batata pieczone z oliwą i słodką papryką na chrupko. Słona przekąska paleo bez smażenia; najlepsze prosto z piekarnika.',
    mealType: 'AFTERNOON_SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['batat', 300, 'g'],
      ['oliwa z oliwek', 15, 'ml'],
      ['papryka słodka mielona', 2, 'g'],
      ['sól', 1, 'g'],
    ],
    steps: [
      'Piekarnik nagrzej do 200°C z termoobiegiem.',
      'Batata obierz i pokrój w plastry cienkie jak kartka — najlepiej na mandolinie.',
      'Wymieszaj z oliwą, papryką i solą, rozłóż w jednej warstwie na papierze.',
      'Piecz 15–18 minut, obracając w połowie, aż brzegi się zwiną i zezłocą.',
      'Ostudź 5 minut na blasze — dopiero wtedy chipsy zrobią się chrupiące.',
    ],
    photo:
      'Thin crispy baked sweet potato chips with paprika, golden with curled edges, piled on parchment',
    vessel: 'board',
    pools: ['PALEO'],
  },
  {
    title: 'Sałatka owocowa z pestkami dyni',
    description:
      'Jabłko, brzoskwinia, borówki i maliny z sokiem z cytryny, posypane prażonymi pestkami dyni. Lekki podwieczorek paleo, gotowy w dziesięć minut.',
    mealType: 'AFTERNOON_SNACK',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['jabłko', 1, 'szt'],
      ['brzoskwinia', 150, 'g'],
      ['borówka', 100, 'g'],
      ['malina', 100, 'g'],
      ['pestki dyni', 20, 'g'],
      ['cytryna', 10, 'g'],
    ],
    steps: [
      'Pestki dyni upraż na suchej patelni 2 minuty, aż zaczną strzelać.',
      'Jabłko i brzoskwinię pokrój w kostkę, skrop sokiem z cytryny.',
      'Dodaj borówki i maliny, delikatnie wymieszaj.',
      'Podziel na dwie miseczki.',
      'Posyp pestkami tuż przed podaniem, żeby zostały chrupiące.',
    ],
    photo:
      'Colorful fruit salad of apple, peach, blueberries and raspberries topped with toasted green pumpkin seeds',
    vessel: 'bowl',
    pools: ['PALEO', 'VEGAN', 'FREE_FROM_4'],
  },

  // ─── śniadania bez glutenu, nabiału, jajek i orzechów ───
  {
    title: 'Kasza jaglana na mleku kokosowym z malinami',
    description:
      'Kremowa jaglanka ugotowana na mleku kokosowym, z bananem, malinami i cynamonem. Śniadanie bez glutenu, nabiału, jajek i orzechów, słodkie bez cukru.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 20,
    servings: 2,
    ingredients: [
      ['kasza jaglana', 100, 'g'],
      ['mleko kokosowe z puszki', 150, 'ml'],
      ['malina', 120, 'g'],
      ['banan', 1, 'szt'],
      ['cynamon', 2, 'g'],
    ],
    steps: [
      'Kaszę przepłucz gorącą wodą, żeby pozbyć się goryczki.',
      'Zalej mlekiem kokosowym i 150 ml wody, gotuj pod przykryciem 15 minut na małym ogniu.',
      'Pod koniec wmieszaj rozgniecionego banana i cynamon.',
      'Rozłóż do miseczek.',
      'Podawaj z malinami; część rozgnieć, żeby puściły sok.',
    ],
    photo:
      'Creamy golden millet porridge with fresh raspberries, banana slices and a sprinkle of cinnamon',
    vessel: 'bowl',
    pools: ['VEGAN', 'FREE_FROM_4'],
  },
  {
    title: 'Pudding chia z bananem i kakao',
    description:
      'Nasiona chia namoczone przez noc w mleku kokosowym z kakao, rano z plastrami banana. Śniadanie do pudełka, bez glutenu, nabiału, jajek i orzechów.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['nasiona chia', 40, 'g'],
      ['mleko kokosowe z puszki', 120, 'ml'],
      ['banan', 1, 'szt'],
      ['kakao', 8, 'g'],
      ['cynamon', 1, 'g'],
    ],
    steps: [
      'Mleko kokosowe rozcieńcz 150 ml wody i wymieszaj z kakao i cynamonem.',
      'Wsyp chia, dokładnie wymieszaj, po 5 minutach wymieszaj jeszcze raz, żeby nie zbryliły się na dnie.',
      'Przełóż do dwóch słoiczków i odstaw do lodówki na noc (minimum 3 godziny).',
      'Rano sprawdź gęstość; za gęsty rozrzedź łyżką wody.',
      'Podawaj z plastrami banana i szczyptą kakao.',
    ],
    photo:
      'Dark chocolate chia pudding in glass-free ceramic cups topped with banana slices and a dusting of cocoa',
    vessel: 'bowl',
    pools: ['VEGAN', 'FREE_FROM_4'],
  },
  {
    title: 'Placuszki jaglano-bananowe',
    description:
      'Placuszki z ugotowanej kaszy jaglanej, rozgniecionego banana i nasion chia zamiast jajka, smażone na oliwie. Miękkie w środku, złote na brzegach; bez glutenu, nabiału, jajek i orzechów.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['kasza jaglana', 80, 'g'],
      ['banan', 2, 'szt'],
      ['nasiona chia', 15, 'g'],
      ['cynamon', 2, 'g'],
      ['oliwa z oliwek', 10, 'ml'],
    ],
    steps: [
      'Kaszę przepłucz i ugotuj w 200 ml wody do miękkości (12 minut), ostudź.',
      'Chia zalej 3 łyżkami wody i odstaw na 5 minut, aż zgęstnieje.',
      'Banany rozgnieć widelcem, wymieszaj z kaszą, chia i cynamonem na kleistą masę.',
      'Nakładaj łyżką na rozgrzaną oliwę, spłaszcz i smaż po 3 minuty z każdej strony.',
      'Podawaj ciepłe; dobre też na zimno następnego dnia.',
    ],
    photo:
      'Small golden millet banana pancakes stacked on a plate with banana slices and a cinnamon dusting',
    pools: ['VEGAN', 'FREE_FROM_4'],
  },
  {
    title: 'Tosty z batata z awokado i pomidorkami',
    description:
      'Plastry batata opieczone w tosterze zamiast chleba, z rozgniecionym awokado, pomidorkami i sezamem. Śniadanie bez glutenu, nabiału, jajek i orzechów; paleo i wegańskie.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['batat', 300, 'g'],
      ['awokado', 1, 'szt'],
      ['pomidor koktajlowy', 100, 'g'],
      ['sezam', 5, 'g'],
      ['cytryna', 10, 'g'],
      ['oliwa z oliwek', 5, 'ml'],
      ['sól', 1, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Batata umyj i pokrój wzdłuż w plastry grubości pół centymetra.',
      'Opiekaj w tosterze 2–3 cykle (albo w piekarniku 200°C przez 12 minut), aż zmiękną i zbrązowieją.',
      'Awokado rozgnieć z sokiem z cytryny, oliwą, solą i pieprzem.',
      'Posmaruj tosty pastą, ułóż połówki pomidorków.',
      'Posyp sezamem i pieprzem.',
    ],
    photo:
      'Toasted sweet potato slices topped with smashed avocado, halved cherry tomatoes and sesame seeds',
    pools: ['VEGAN', 'PALEO', 'FREE_FROM_4'],
  },
  {
    title: 'Smoothie bowl z borówkami i pestkami dyni',
    description:
      'Gęste smoothie z mrożonych bananów, borówek i mleka kokosowego, jedzone łyżką z malinami i prażonymi pestkami dyni. Bez glutenu, nabiału, jajek i orzechów.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    ingredients: [
      ['banan', 2, 'szt'],
      ['borówka', 150, 'g'],
      ['mleko kokosowe z puszki', 100, 'ml'],
      ['pestki dyni', 20, 'g'],
      ['malina', 50, 'g'],
    ],
    steps: [
      'Banany pokrój i zamroź dzień wcześniej — to one dają gęstość.',
      'Pestki dyni upraż na suchej patelni 2 minuty.',
      'Zmiksuj banany, 100 g borówek i mleko kokosowe na gęstą masę; miksuj krótko, żeby nie rozrzedzić.',
      'Przełóż do miseczek.',
      'Ułóż na wierzchu maliny, resztę borówek i pestki.',
    ],
    photo:
      'Thick purple blueberry smoothie bowl topped with rows of raspberries, blueberries and toasted pumpkin seeds',
    vessel: 'bowl',
    pools: ['VEGAN', 'PALEO', 'FREE_FROM_4'],
  },
  {
    title: 'Tofucznica ze szpinakiem i pomidorkami',
    description:
      'Rozdrobnione tofu podsmażone z cebulą, papryką i kminem, ze szpinakiem i pomidorkami — jak jajecznica, ale bez jajek. Ciepłe śniadanie bez glutenu, nabiału, jajek i orzechów.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 15,
    servings: 2,
    ingredients: [
      ['tofu', 250, 'g'],
      ['szpinak', 80, 'g'],
      ['pomidor koktajlowy', 150, 'g'],
      ['cebula', 0.5, 'szt'],
      ['oliwa z oliwek', 10, 'ml'],
      ['papryka słodka mielona', 2, 'g'],
      ['kmin rzymski', 1, 'g'],
      ['sól', 1, 'g'],
      ['pieprz czarny', 1, 'g'],
    ],
    steps: [
      'Tofu osusz i rozgnieć widelcem na grudki wielkości jajecznicy.',
      'Cebulę posiekaj i zeszklij na oliwie.',
      'Dodaj tofu, paprykę, kmin, sól i pieprz; smaż 5 minut, mieszając, aż się zrumieni.',
      'Wrzuć szpinak i połówki pomidorków, smaż 2 minuty, aż szpinak zwiędnie.',
      'Podawaj od razu, z dodatkowym pieprzem.',
    ],
    photo:
      'Golden crumbled tofu scramble with wilted spinach and blistered cherry tomatoes in a skillet-style plate',
    pools: ['VEGAN', 'FREE_FROM_4'],
  },
  {
    title: 'Kasza gryczana na słodko z jabłkiem i cynamonem',
    description:
      'Niepalona kasza gryczana ugotowana na mleku kokosowym, z duszonym jabłkiem i cynamonem. Sycące śniadanie bez glutenu, nabiału, jajek i orzechów.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['kasza gryczana', 100, 'g'],
      ['mleko kokosowe z puszki', 150, 'ml'],
      ['jabłko', 1, 'szt'],
      ['cynamon', 2, 'g'],
      ['oliwa z oliwek', 5, 'ml'],
    ],
    steps: [
      'Kaszę przepłucz, zalej mlekiem kokosowym i 150 ml wody, gotuj pod przykryciem 15 minut.',
      'Jabłko pokrój w kostkę i poddusz na oliwie z cynamonem 5 minut, aż zmięknie.',
      'Kaszę wymieszaj, jeśli za gęsta — dolej odrobinę wody.',
      'Rozłóż do miseczek.',
      'Na wierzch daj jabłko z sokiem z patelni.',
    ],
    photo:
      'Bowl of creamy buckwheat porridge topped with caramelized apple cubes and cinnamon',
    vessel: 'bowl',
    pools: ['VEGAN', 'FREE_FROM_4'],
  },
  {
    title: 'Ryż na mleku kokosowym z brzoskwinią',
    description:
      'Ryż jaśminowy ugotowany na mleku kokosowym do kremowej konsystencji, z kawałkami brzoskwini, cynamonem i sezamem. Słodkie śniadanie bez glutenu, nabiału, jajek i orzechów.',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 25,
    servings: 2,
    ingredients: [
      ['ryż jaśminowy', 80, 'g'],
      ['mleko kokosowe z puszki', 200, 'ml'],
      ['brzoskwinia', 200, 'g'],
      ['cynamon', 2, 'g'],
      ['sezam', 5, 'g'],
    ],
    steps: [
      'Ryż przepłucz, zalej mlekiem kokosowym i 200 ml wody.',
      'Gotuj na małym ogniu 18 minut, mieszając pod koniec, aż będzie kremowy.',
      'Brzoskwinię pokrój w cząstki.',
      'Sezam upraż na suchej patelni minutę.',
      'Podawaj ryż z brzoskwinią, cynamonem i sezamem.',
    ],
    photo:
      'Creamy coconut rice pudding in a bowl topped with fresh peach slices, cinnamon and toasted sesame',
    vessel: 'bowl',
    pools: ['VEGAN', 'FREE_FROM_4'],
  },
];

// ─── plumbing (jak w diety-batch-2026-09.ts) ───

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
    sodiumMg?: number;
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
    allergens: string[];
    dietTags: string[];
  }[];
};

const nutritionByNorm = new Map(
  NUTRITION.ingredients.map((e) => [e.normalizedName, e]),
);
const tagsByName = new Map(TAGS.ingredients.map((e) => [e.name, e]));

/** Stały UUID v4 z tytułu — ponowne uruchomienie generatora nie zmienia id. */
function stableUuid(title: string): string {
  const h = createHash('sha256')
    .update(`przekaski-2026-09:${title}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(
    (parseInt(h[16], 16) & 0x3) |
    0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Prompt zdjęcia w tej samej formie, co dopracowane przepisy katalogu
 * (audyt 2: prompty partii „diety" były 4–7× uboższe). Naczynie, kadr,
 * światło i zakazy są stałe — zmienia się tylko opis potrawy.
 */
export function richPhotoPrompt(
  title: string,
  photo: string,
  vessel: 'plate' | 'bowl' | 'board' = 'plate',
): string {
  const dish =
    vessel === 'bowl'
      ? 'served in a rustic opaque ceramic stoneware bowl'
      : vessel === 'board'
        ? 'served on a rustic wooden serving board'
        : 'served on a rustic opaque ceramic stoneware plate';
  const angle =
    vessel === 'bowl'
      ? 'high elevated camera angle looking down into the bowl at about 60 degrees so the food inside is clearly visible'
      : 'high elevated camera angle looking down at about 60 degrees so the food is clearly visible';
  const center =
    vessel === 'bowl' ? 'bowl' : vessel === 'board' ? 'board' : 'plate';
  return [
    'professional food photo',
    title,
    photo,
    dish,
    'the dish perfectly centered in the middle of the frame',
    'whole dish fully visible with even space on all sides',
    angle,
    'light grey stone kitchen countertop',
    'styled food scene with fresh ingredients, herbs and a linen napkin softly blurred in the background',
    'bright soft natural daylight, clean and airy, vivid fresh colors',
    'ultra realistic professional food photography',
    `wide landscape composition with the ${center} in the exact center of the image`,
    'no glass or transparent dishes, no text, no watermark, appetizing',
  ].join(', ');
}

const SNACK_LIMITS: Record<string, { kcal: number; minutes: number }> = {
  SNACK: { kcal: 350, minutes: 15 },
  AFTERNOON_SNACK: { kcal: 420, minutes: 25 },
  SECOND_BREAKFAST: { kcal: 480, minutes: 20 },
};

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
              sodiumMg: nut.sodiumMg ?? 0,
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
    const allergens = new Set<string>();
    for (const [name] of def.ingredients) {
      for (const t of tagsByName.get(name)?.dietTags ?? []) dietTags.add(t);
      for (const a of tagsByName.get(name)?.allergens ?? []) allergens.add(a);
    }
    const addedSalt =
      def.ingredients.find(([name]) => name === 'sól')?.[1] ?? 0;
    const perServingCarbs = result.totals.carbs / def.servings;
    const perServingKcal = result.totals.kcal / def.servings;
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
    const isFreeFrom4 = !['gluten', 'milk', 'lactose', 'eggs', 'nuts'].some(
      (a) => allergens.has(a),
    );
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
      if (pool === 'FREE_FROM_4' && !isFreeFrom4)
        errors.push(`${def.title}: ma alergeny ${[...allergens].join(',')}`);
    }
    const limit = SNACK_LIMITS[def.mealType];
    if (limit) {
      if (perServingKcal > limit.kcal)
        errors.push(
          `${def.title}: ${Math.round(perServingKcal)} kcal/porcja > ${limit.kcal} dla ${def.mealType}`,
        );
      if (def.prepTimeMinutes > limit.minutes)
        errors.push(
          `${def.title}: ${def.prepTimeMinutes} min > ${limit.minutes} dla ${def.mealType}`,
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
        // Sól łączną (sód × 2,5 + dodana) liczy `recipes:recompute:nutrition`.
        salt:
          Math.round((result.totals.sodiumMg * 0.0025 + addedSalt) * 10) / 10,
        addedSalt: Math.round(addedSalt * 10) / 10,
      },
      steps: def.steps.map((instruction, i) => ({ step: i + 1, instruction })),
      ingredients: def.ingredients.map(([ingredientName, amount, unit]) => ({
        ingredientName,
        amount,
        unit,
      })),
      image: {
        prompt: richPhotoPrompt(def.title, def.photo, def.vessel),
        imageUrl: RECIPE_IMAGE_PLACEHOLDER_URL,
      },
      _pools: {
        vegan: isVegan,
        paleo: isPaleo,
        keto: isKeto,
        freeFrom4: isFreeFrom4,
        kcalPerServing: Math.round(perServingKcal),
        carbsPerServing: Math.round(perServingCarbs),
      },
    };
  });
  return { recipes, errors };
}

if (require.main === module) {
  const { recipes, errors } = build();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(
    recipes
      .map(
        (r) =>
          `${r.title} · ${r.mealType} · ${r._pools.kcalPerServing} kcal/porcja · ${JSON.stringify(r._pools)}`,
      )
      .join('\n'),
  );
  const clean = recipes.map(({ _pools, ...rest }) => rest);
  const batch = {
    version: 'recipes-batch-przekaski-i-sniadania-20-v1',
    recipes: clean,
  };
  writeFileSync(
    join(CATALOG_DIR, 'recipes-batch-przekaski-i-sniadania-20-v1.json'),
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
}
