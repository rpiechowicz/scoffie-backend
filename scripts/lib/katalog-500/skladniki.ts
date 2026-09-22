/**
 * Uzupełnienia katalogu składników dla partii „Katalog 500" (22.09.2026).
 *
 * Grupa 1 — składniki już obecne w `ingredient-tags-pl-v1.json`, którym
 * brakowało wpisu w tabeli makro (wszystkie spożywcze poza alkoholami;
 * pominięte `krewetka` i `śledź` — zakaz z 24.08/22.09.2026).
 * Grupa 2 — nowe składniki potrzebne do 355 dań z `katalog-500-lista.md`.
 *
 * Wartości na 100 g / 100 ml wg IŻŻ (Kunachowicz) albo USDA, produkt tak, jak
 * się go kupuje; makarony, kasze i suche strączki = sucha masa; `carbs` bez
 * błonnika.
 *
 * Mięso i ryby z kością kupowane w całości/na sztuki (udko, podudzie,
 * skrzydełko, kurczak cały, noga z indyka, żeberko, golonka, pstrąg, makrela)
 * liczymy NA MASĘ ZAKUPU (z kością, wartości części jadalnej × udział części
 * jadalnej), a `gramsPerPiece` to masa sztuki przy zakupie — wtedy przepis
 * w gramach (tyle, ile się kupuje) i przepis w sztukach dają to samo makro
 * i tę samą listę zakupów.
 */
import type { IngredientAddition, Nutrition100 } from './types';

function n(
  unit: 'g' | 'ml',
  kcal: number,
  protein: number,
  carbs: number,
  fat: number,
  fiber: number,
  sodiumMg: number,
  gramsPerPiece?: number,
): Nutrition100 {
  return {
    unit,
    kcal,
    protein,
    carbs,
    fat,
    fiber,
    sodiumMg,
    ...(gramsPerPiece ? { gramsPerPiece } : {}),
  };
}

const BONE_NOTE =
  'Wartości na masę zakupu z kością (część jadalna × jej udział); w przepisie podawaj masę zakupu albo sztuki.';

/** Grupa 1: nazwa jest w katalogu i ma tagi — brakuje tylko makro. */
const EXISTING: IngredientAddition[] = [
  // ─── owoce ───
  { name: 'ananas', nutrition: n('g', 50, 0.5, 11.7, 0.1, 1.4, 1, 550), note: 'gramsPerPiece = miąższ średniego ananasa.' },
  { name: 'arbuz', nutrition: n('g', 30, 0.6, 7.2, 0.2, 0.4, 1) },
  { name: 'czereśnia', nutrition: n('g', 63, 1.1, 14, 0.2, 2.1, 0) },
  { name: 'grejpfrut', nutrition: n('g', 42, 0.8, 9.1, 0.1, 1.6, 0, 250) },
  { name: 'gruszka', nutrition: n('g', 57, 0.4, 12.1, 0.1, 3.1, 1, 150) },
  { name: 'jeżyna', nutrition: n('g', 43, 1.4, 4.9, 0.5, 5.3, 1) },
  { name: 'kiwi', nutrition: n('g', 61, 1.1, 11.7, 0.5, 3, 3, 70) },
  { name: 'klementynka', nutrition: n('g', 47, 0.9, 10.3, 0.2, 1.7, 1, 60) },
  { name: 'limonka', nutrition: n('g', 30, 0.7, 6, 0.2, 2.8, 2, 60) },
  { name: 'mandarynka', nutrition: n('g', 53, 0.8, 11.5, 0.3, 1.8, 2, 70) },
  { name: 'mango', nutrition: n('g', 60, 0.8, 13.4, 0.4, 1.6, 1, 300) },
  { name: 'melon', nutrition: n('g', 34, 0.8, 7.3, 0.2, 0.9, 16, 600), note: 'gramsPerPiece = miąższ melona ok. 1 kg.' },
  { name: 'morela', nutrition: n('g', 48, 1.4, 9.1, 0.4, 2, 1) },
  { name: 'nektarynka', nutrition: n('g', 44, 1.1, 9.1, 0.3, 1.7, 0, 130) },
  { name: 'pomarańcza', nutrition: n('g', 47, 0.9, 9.4, 0.1, 2.4, 0, 180) },
  { name: 'pomarańcza czerwona', nutrition: n('g', 47, 0.9, 9.4, 0.1, 2.4, 0, 150) },
  { name: 'porzeczka czarna', nutrition: n('g', 50, 1.3, 8.6, 0.4, 5.8, 2) },
  { name: 'porzeczka czerwona', nutrition: n('g', 52, 1.4, 9.6, 0.2, 4.3, 1) },
  { name: 'śliwka', nutrition: n('g', 46, 0.7, 10, 0.3, 1.4, 0) },
  { name: 'winogrono białe', nutrition: n('g', 69, 0.7, 17.2, 0.2, 0.9, 2) },
  { name: 'winogrono czerwone', nutrition: n('g', 69, 0.7, 17.2, 0.2, 0.9, 2) },
  { name: 'wiśnia', nutrition: n('g', 50, 1, 10.6, 0.3, 1.6, 3) },
  { name: 'żurawina', nutrition: n('g', 46, 0.5, 8.6, 0.1, 3.6, 2), note: 'Świeża/mrożona; suszona i sos to osobne pozycje.' },

  // ─── konserwy i słoiki ───
  { name: 'ananas z puszki', nutrition: n('g', 65, 0.4, 15.5, 0.1, 0.9, 1), note: 'W lekkim syropie, odsączony.' },
  { name: 'brzoskwinia z puszki', nutrition: n('g', 60, 0.5, 14.2, 0.1, 1.3, 5), note: 'W lekkim syropie, odsączona.' },
  { name: 'groszek konserwowy', nutrition: n('g', 70, 4.5, 8.5, 0.4, 4.1, 250), note: 'Odsączony.' },
  { name: 'ogórek konserwowy', nutrition: n('g', 30, 0.5, 6.2, 0.1, 0.6, 700), note: 'Słodko-kwaśny w occie.' },
  { name: 'oliwka czarna', nutrition: n('g', 116, 0.8, 3.1, 10.9, 3.2, 735), note: 'Odsączona.' },
  { name: 'oliwka zielona', nutrition: n('g', 145, 1, 0.5, 15.3, 3.3, 1556), note: 'Odsączona.' },

  // ─── piekarnia ───
  { name: 'bułka grahamka', nutrition: n('g', 257, 9.2, 46.6, 2.6, 5.5, 480, 70) },
  { name: 'bułka kajzerka', nutrition: n('g', 295, 9.5, 56, 3.5, 2.5, 500, 50) },
  { name: 'bułka pełnoziarnista', nutrition: n('g', 250, 9, 42, 3.5, 6.5, 450, 70) },
  { name: 'chleb orkiszowy', nutrition: n('g', 245, 9.5, 42, 2.5, 6, 450) },
  { name: 'chleb pełnoziarnisty', nutrition: n('g', 240, 8.5, 39, 3.5, 7.5, 450) },
  { name: 'chleb żytni', nutrition: n('g', 230, 6, 43, 1.8, 6.5, 450) },
  { name: 'maca', nutrition: n('g', 390, 10, 80.8, 1.4, 2.9, 2) },
  { name: 'pita', nutrition: n('g', 275, 9.1, 53.5, 1.2, 2.2, 530, 60) },
  { name: 'rogalik', nutrition: n('g', 406, 8.2, 43.2, 21, 2.6, 470, 60), note: 'Rogalik maślany (croissant).' },
  { name: 'tortilla pełnoziarnista', nutrition: n('g', 295, 9, 44, 7.5, 6.5, 600, 60) },

  // ─── warzywa ───
  { name: 'bakłażan', nutrition: n('g', 24, 1, 2.9, 0.2, 3, 2, 300) },
  { name: 'bób', nutrition: n('g', 72, 7.1, 8.2, 0.4, 5.8, 8), note: 'Świeży, wyłuskany ze strąka.' },
  { name: 'brukselka', nutrition: n('g', 43, 3.4, 5.2, 0.3, 3.8, 25) },
  { name: 'cebula czerwona', nutrition: n('g', 40, 1.1, 7.6, 0.1, 1.7, 4, 100) },
  { name: 'cebula dymka', nutrition: n('g', 32, 1.8, 4.7, 0.2, 2.6, 16) },
  { name: 'fasolka szparagowa', nutrition: n('g', 31, 1.8, 4.3, 0.2, 2.7, 6) },
  { name: 'groszek', nutrition: n('g', 81, 5.4, 9.5, 0.4, 5.7, 5), note: 'Świeży, łuskany.' },
  { name: 'imbir', nutrition: n('g', 80, 1.8, 15.8, 0.8, 2, 13) },
  { name: 'jarmuż', nutrition: n('g', 43, 4.3, 4.4, 0.9, 4.1, 38) },
  { name: 'kalafior', nutrition: n('g', 25, 1.9, 3, 0.3, 2, 30, 600), note: 'gramsPerPiece = różyczki z główki ok. 1 kg.' },
  { name: 'kalarepa', nutrition: n('g', 27, 1.7, 2.6, 0.1, 3.6, 20, 200) },
  { name: 'kapusta czerwona', nutrition: n('g', 31, 1.4, 5.3, 0.2, 2.1, 27) },
  { name: 'kapusta pekińska', nutrition: n('g', 16, 1.2, 2.2, 0.2, 1.2, 9) },
  { name: 'kapusta włoska', nutrition: n('g', 27, 2, 3, 0.1, 3.1, 28) },
  { name: 'kukurydza', nutrition: n('g', 86, 3.3, 16.7, 1.4, 2, 15, 150), note: 'Świeża kolba; gramsPerPiece = ziarno z jednej kolby.' },
  { name: 'papryka', nutrition: n('g', 26, 1, 4, 0.3, 1.9, 3, 160), note: 'Średnia z papryk czerwonej, żółtej i zielonej.' },
  { name: 'papryka zielona', nutrition: n('g', 20, 0.9, 2.9, 0.2, 1.7, 3, 150) },
  { name: 'papryka żółta', nutrition: n('g', 27, 1, 5.4, 0.2, 0.9, 2, 160) },
  { name: 'roszponka', nutrition: n('g', 21, 2, 2.2, 0.4, 1.5, 4) },
  { name: 'rukola', nutrition: n('g', 25, 2.6, 2.1, 0.7, 1.6, 27) },
  { name: 'seler naciowy', nutrition: n('g', 16, 0.7, 1.4, 0.2, 1.6, 80) },
  { name: 'szalotka', nutrition: n('g', 72, 2.5, 13.6, 0.1, 3.2, 12, 30) },
  { name: 'ziemniak młody', nutrition: n('g', 70, 1.7, 13.5, 0.1, 1.8, 6) },

  // ─── mięso ───
  { name: 'baleron', nutrition: n('g', 210, 17, 1, 15.5, 0, 1000) },
  { name: 'gulasz wołowy', nutrition: n('g', 160, 20, 0, 9, 0, 60), note: 'Surowe mięso gulaszowe z łopatki.' },
  { name: 'kabanos', nutrition: n('g', 440, 24, 1.5, 38, 0, 1400) },
  { name: 'karkówka', nutrition: n('g', 240, 16.5, 0, 19.5, 0, 60) },
  { name: 'kaszanka', nutrition: n('g', 250, 11, 17, 15, 1, 700) },
  { name: 'kiełbasa', nutrition: n('g', 300, 14, 1.5, 26.5, 0, 1000) },
  { name: 'kiełbasa chorizo', nutrition: n('g', 400, 24, 2, 33, 0, 1500) },
  { name: 'kiełbasa drobiowa', nutrition: n('g', 220, 14, 3, 17, 0, 900) },
  { name: 'kiełbasa krakowska', nutrition: n('g', 250, 18, 1, 19.5, 0, 1100) },
  { name: 'kiełbasa wędzona', nutrition: n('g', 310, 15, 1.5, 27, 0, 1000) },
  { name: 'kurczak mielony', nutrition: n('g', 145, 17.5, 0, 8.2, 0, 60) },
  { name: 'łopatka wieprzowa mielona', nutrition: n('g', 236, 17.5, 0, 18, 0, 60) },
  { name: 'mortadela', nutrition: n('g', 295, 13, 2, 26, 0, 1000) },
  { name: 'noga z indyka', nutrition: n('g', 108, 14.6, 0, 5.3, 0, 60), note: `${BONE_NOTE} Część jadalna ok. 75%.` },
  { name: 'parówka', nutrition: n('g', 270, 12, 3, 23.5, 0, 950, 35) },
  { name: 'pasztetowa', nutrition: n('g', 290, 12, 4, 25, 0, 900) },
  { name: 'podudzie z kurczaka', nutrition: n('g', 116, 12.6, 0, 7.3, 0, 60, 110), note: `${BONE_NOTE} Część jadalna ok. 70%.` },
  { name: 'polędwica wołowa', nutrition: n('g', 140, 21, 0, 6.2, 0, 55) },
  { name: 'salami', nutrition: n('g', 400, 22, 1, 34, 0, 1800) },
  { name: 'schab mielony', nutrition: n('g', 180, 20, 0, 11, 0, 55) },
  { name: 'skrzydełko z kurczaka', nutrition: n('g', 120, 9.9, 0, 8.6, 0, 45, 90), note: `${BONE_NOTE} Część jadalna ok. 54%.` },
  { name: 'udziec z indyka', nutrition: n('g', 120, 19.5, 0, 4.7, 0, 70), note: 'Mięso z udźca bez kości i skóry (tak się go zwykle kupuje).' },
  { name: 'wędlina wieprzowa', nutrition: n('g', 170, 17, 1.5, 10.5, 0, 1000) },
  { name: 'wieprzowina', nutrition: n('g', 220, 17.5, 0, 16.5, 0, 60), note: 'Średnia z kawałków (łopatka, schab, szynka).' },
  { name: 'wieprzowina mielona chuda', nutrition: n('g', 170, 20, 0, 10, 0, 65) },
  { name: 'wołowina mielona', nutrition: n('g', 215, 18.5, 0, 15.5, 0, 65) },

  // ─── przekąski i słodycze ───
  { name: 'baton białkowy', nutrition: n('g', 370, 30, 35, 12, 6, 300) },
  { name: 'baton czekoladowy', nutrition: n('g', 480, 5, 62, 23, 2, 180) },
  { name: 'biszkopt', nutrition: n('g', 385, 9, 78, 4, 1.5, 100), note: 'Biszkopty podłużne (do tiramisu, deserów).' },
  { name: 'chips kukurydziany', nutrition: n('g', 489, 7, 60, 24, 4.5, 450) },
  { name: 'chips ziemniaczany', nutrition: n('g', 540, 6.5, 49.5, 34.5, 4, 550) },
  { name: 'chrupka kukurydziana', nutrition: n('g', 390, 8, 80, 3.5, 3, 400) },
  { name: 'ciastko', nutrition: n('g', 480, 6, 64, 22, 2, 300) },
  { name: 'ciastko owsiane', nutrition: n('g', 460, 6.5, 63, 19, 4, 350) },
  { name: 'czekolada gorzka', nutrition: n('g', 570, 7.8, 36, 41, 10.9, 20), note: 'Ok. 70% kakao.' },
  { name: 'czekolada mleczna', nutrition: n('g', 535, 7.7, 56, 29.7, 3.4, 80) },
  { name: 'czekolada nadziewana', nutrition: n('g', 500, 5, 60, 26, 2, 80) },
  { name: 'draże czekoladowe', nutrition: n('g', 500, 8, 60, 25, 3, 50) },
  { name: 'krakers', nutrition: n('g', 450, 9, 66, 16, 3, 900) },
  { name: 'orzech laskowy', nutrition: n('g', 628, 15, 7, 60.8, 9.7, 0) },
  { name: 'orzeszek ziemny', nutrition: n('g', 567, 25.8, 7.6, 49.2, 8.5, 18), note: 'Niesolone; solone prażone mają ok. 400 mg sodu.' },
  { name: 'paluszek słony', nutrition: n('g', 380, 10, 75, 4, 3, 1600) },
  { name: 'popcorn', nutrition: n('g', 480, 8, 55, 24, 10, 700), note: 'Gotowy, solony (mikrofalowy).' },
  { name: 'precel', nutrition: n('g', 380, 10, 77, 3, 3, 1400), note: 'Chrupkie precelki.' },
  { name: 'ptasie mleczko', nutrition: n('g', 430, 3, 62, 19, 0.5, 30) },
  { name: 'rodzynka', nutrition: n('g', 299, 3.1, 75.3, 0.5, 3.7, 11) },
  { name: 'słonecznik łuszczony', nutrition: n('g', 584, 20.8, 11.4, 51.5, 8.6, 9) },
  { name: 'wafel czekoladowy', nutrition: n('g', 530, 6, 60, 29, 2, 100) },
  { name: 'wafel ryżowy', nutrition: n('g', 387, 8, 78.4, 2.8, 4.2, 150) },
  { name: 'żelka', nutrition: n('g', 340, 6, 78, 0.2, 0, 30) },

  // ─── przyprawy i sosy ───
  { name: 'bazylia suszona', nutrition: n('g', 233, 23, 10.2, 4.1, 37.7, 76) },
  { name: 'cukier brązowy', nutrition: n('g', 380, 0.1, 98, 0, 0, 28) },
  { name: 'cukier puder', nutrition: n('g', 400, 0, 99.8, 0, 0, 1) },
  { name: 'czosnek granulowany', nutrition: n('g', 331, 16.6, 63.7, 0.7, 9, 60) },
  { name: 'kminek', nutrition: n('g', 333, 19.8, 11.9, 14.6, 38, 17) },
  { name: 'koperek suszony', nutrition: n('g', 253, 20, 30, 4.4, 13.6, 208) },
  { name: 'kurkuma', nutrition: n('g', 312, 9.7, 44.4, 3.3, 22.7, 27) },
  { name: 'liść laurowy', nutrition: n('g', 313, 7.6, 48.7, 8.4, 26.3, 23) },
  { name: 'ocet winny', nutrition: n('ml', 19, 0, 0.3, 0, 0, 8) },
  { name: 'rozmaryn suszony', nutrition: n('g', 331, 4.9, 21.5, 15.2, 42.6, 50) },
  { name: 'sos pomidorowy', nutrition: n('g', 60, 1.5, 8.5, 2, 1.5, 400), note: 'Gotowy sos do makaronu ze słoika.' },
  { name: 'zioło angielskie', nutrition: n('g', 263, 6.1, 30, 8.7, 21.6, 77), note: 'Ziele angielskie (nazwa w katalogu to „zioło angielskie").' },

  // ─── inne ───
  { name: 'białko w proszku', nutrition: n('g', 390, 75, 8, 6.5, 0, 200), note: 'Odżywka serwatkowa WPC 80.' },
  { name: 'drożdże instant', nutrition: n('g', 325, 40.4, 14.8, 7.6, 26.9, 51) },
  { name: 'kolagen spożywczy', nutrition: n('g', 360, 90, 0, 0, 0, 200) },
  { name: 'syrop klonowy', nutrition: n('g', 260, 0, 67, 0.1, 0, 12) },
  { name: 'żelatyna', nutrition: n('g', 335, 85.6, 0, 0.1, 0, 196) },

  // ─── mrożonki ───
  { name: 'brokuł mrożony', nutrition: n('g', 30, 2.8, 3.6, 0.3, 3, 24) },
  { name: 'fasolka szparagowa mrożona', nutrition: n('g', 33, 1.8, 4.3, 0.2, 2.9, 3) },
  { name: 'frytka mrożona', nutrition: n('g', 150, 2.2, 22.5, 5.5, 2.3, 150), note: 'Do piekarnika, przed pieczeniem.' },
  { name: 'jagoda mrożona', nutrition: n('g', 45, 0.7, 8.5, 0.6, 3.3, 1) },
  { name: 'kalafior mrożony', nutrition: n('g', 24, 1.9, 2.7, 0.3, 2.3, 24) },
  { name: 'mieszanka chińska mrożona', nutrition: n('g', 35, 2, 5, 0.3, 2.5, 20) },
  { name: 'mieszanka warzywna mrożona', nutrition: n('g', 40, 2.5, 5.5, 0.4, 3.2, 30) },
  { name: 'szpinak mrożony', nutrition: n('g', 29, 3.6, 1.3, 0.6, 2.9, 74) },
  { name: 'truskawka mrożona', nutrition: n('g', 35, 0.4, 7.2, 0.1, 2.1, 2) },
  { name: 'warzywo na patelnię mrożone', nutrition: n('g', 55, 2, 6, 2.5, 2.8, 200), note: 'Mieszanka z dodatkiem oleju i przypraw.' },

  // ─── cukiernia ───
  { name: 'ciasto kruche', nutrition: n('g', 440, 5.5, 47, 25, 2, 350), note: 'Gotowe surowe ciasto z lodówki.' },
  { name: 'drożdże',nutrition: n('g', 105, 8.4, 9.9, 1.9, 8.1, 30), note: 'Świeże w kostce.' },
  { name: 'drożdżówka', nutrition: n('g', 350, 7.5, 52, 12, 1.8, 250, 90) },
  { name: 'galaretka', nutrition: n('g', 380, 7.8, 88, 0, 0, 400), note: 'Proszek z torebki (sucha masa).' },
  { name: 'kisiel', nutrition: n('g', 370, 0.2, 92, 0, 0.3, 50), note: 'Proszek z torebki (sucha masa).' },
  { name: 'muffin', nutrition: n('g', 400, 5.5, 51, 19, 1.5, 350, 80) },
  { name: 'pączek', nutrition: n('g', 390, 6, 50, 18, 1.5, 250, 70) },

  // ─── zboża i makarony (sucha masa) ───
  { name: 'bulgur', nutrition: n('g', 342, 12.3, 63.4, 1.3, 12.5, 17) },
  { name: 'ciecierzyca sucha', nutrition: n('g', 370, 20.5, 50.8, 6, 12.2, 24) },
  { name: 'fasola sucha', nutrition: n('g', 333, 23.4, 45, 0.9, 15.2, 16) },
  { name: 'kasza manna', nutrition: n('g', 350, 8.7, 73, 1.3, 2.5, 1) },
  { name: 'komosa ryżowa', nutrition: n('g', 368, 14.1, 57.2, 6.1, 7, 5) },
  { name: 'mąka pełnoziarnista', nutrition: n('g', 340, 13.2, 61.5, 2.5, 10.7, 2) },
  { name: 'mąka ziemniaczana', nutrition: n('g', 350, 0.6, 85.2, 0.1, 0, 10) },
  { name: 'makaron razowy', nutrition: n('g', 350, 13.9, 64, 2.5, 8, 8) },
  { name: 'płatki żytnie', nutrition: n('g', 330, 10, 62, 2, 12, 3) },
  { name: 'ryż brązowy', nutrition: n('g', 362, 7.5, 73, 2.7, 3.4, 5) },
  { name: 'soczewica zielona', nutrition: n('g', 352, 24.6, 52.6, 1.1, 10.7, 6) },

  // ─── napoje ───
  // Herbata i kawa mielona/ziarnista: sucha masa (tak się kupuje i tak liczy
  // lista zakupów), ale makro to tylko to, co przechodzi do naparu — fusy
  // i torebka lądują w koszu. Kawa rozpuszczalna rozpuszcza się w całości.
  { name: 'herbata czarna', nutrition: n('g', 100, 0, 25, 0, 0, 300), note: 'Sucha masa; makro = to, co przechodzi do naparu (ok. 2 kcal z torebki).' },
  { name: 'herbata miętowa', nutrition: n('g', 100, 0, 25, 0, 0, 100), note: 'Sucha masa; makro = to, co przechodzi do naparu.' },
  { name: 'herbata owocowa', nutrition: n('g', 150, 0.5, 37, 0, 0, 50), note: 'Sucha masa; makro = to, co przechodzi do naparu.' },
  { name: 'herbata rumiankowa', nutrition: n('g', 100, 0, 25, 0, 0, 100), note: 'Sucha masa; makro = to, co przechodzi do naparu.' },
  { name: 'herbata zielona', nutrition: n('g', 100, 10, 15, 0, 0, 100), note: 'Sucha masa; makro = to, co przechodzi do naparu.' },
  { name: 'kawa bezkofeinowa', nutrition: n('g', 17, 2, 1.5, 0.3, 0, 33), note: 'Sucha masa; makro = to, co przechodzi do naparu (ok. 6 g na 100 ml).' },
  { name: 'kawa mielona', nutrition: n('g', 17, 2, 1.5, 0.3, 0, 33), note: 'Sucha masa; makro = to, co przechodzi do naparu (ok. 6 g na 100 ml).' },
  { name: 'kawa rozpuszczalna', nutrition: n('g', 353, 12.2, 75.4, 0.5, 0, 37), note: 'Proszek (USDA) — rozpuszcza się w całości.' },
  { name: 'kawa ziarnista', nutrition: n('g', 17, 2, 1.5, 0.3, 0, 33), note: 'Sucha masa; makro = to, co przechodzi do naparu (ok. 6 g na 100 ml).' },
  { name: 'napój energetyczny', nutrition: n('ml', 45, 0, 11, 0, 0, 80) },
  { name: 'napój izotoniczny', nutrition: n('ml', 25, 0, 6, 0, 0, 50) },
  { name: 'napój tonic', nutrition: n('ml', 34, 0, 8.8, 0, 0, 12) },
  { name: 'pepsi', nutrition: n('ml', 42, 0, 10.6, 0, 0, 4) },
  { name: 'sok jabłkowy', nutrition: n('ml', 46, 0.1, 11.2, 0.1, 0.2, 4) },
  { name: 'sok marchwiowy', nutrition: n('ml', 40, 0.9, 8.5, 0.2, 0.8, 66) },
  { name: 'sok pomarańczowy', nutrition: n('ml', 45, 0.7, 10.2, 0.2, 0.2, 1) },
  { name: 'sprite', nutrition: n('ml', 19, 0, 4.7, 0, 0, 5), note: 'Polska receptura z obniżonym cukrem (cukier + słodziki).' },
  { name: 'woda gazowana', nutrition: n('ml', 0, 0, 0, 0, 0, 10) },
  { name: 'woda niegazowana', nutrition: n('ml', 0, 0, 0, 0, 0, 5) },

  // ─── nabiał ───
  { name: 'jogurt owocowy', nutrition: n('g', 95, 3.3, 14, 2.8, 0.2, 50) },
  { name: 'jogurt pitny', nutrition: n('ml', 75, 2.8, 11.5, 1.8, 0, 45) },
  { name: 'kefir', nutrition: n('ml', 51, 3.4, 4.7, 2, 0, 40), note: 'Kefir 2%.' },
  { name: 'margaryna', nutrition: n('g', 720, 0.2, 0.5, 80, 0, 150), note: 'Kostka do pieczenia, ok. 80% tłuszczu.' },
  { name: 'margaryna do smarowania', nutrition: n('g', 535, 0.2, 0.5, 60, 0, 400), note: 'Kubek, ok. 60% tłuszczu.' },
  { name: 'maślanka', nutrition: n('ml', 38, 3.3, 4.6, 0.8, 0, 50) },
  { name: 'masło klarowane', nutrition: n('g', 900, 0, 0, 99.8, 0, 2) },
  { name: 'mleko bez laktozy', nutrition: n('ml', 47, 3.3, 4.8, 1.5, 0, 45), note: 'Mleko 1,5%.' },
  { name: 'mleko migdałowe', nutrition: n('ml', 24, 0.5, 3, 1.1, 0.2, 70), note: 'Wersja klasyczna, słodzona.' },
  { name: 'mleko skondensowane', nutrition: n('g', 321, 7.9, 54.4, 8.7, 0, 127), note: 'Słodzone.' },
  { name: 'mozzarella tarta', nutrition: n('g', 300, 24, 2, 22, 0, 600) },
  { name: 'ser camembert', nutrition: n('g', 300, 19.8, 0.5, 24.3, 0, 700) },
  { name: 'ser cheddar', nutrition: n('g', 403, 24.9, 1.3, 33.1, 0, 621) },
  { name: 'ser edamski', nutrition: n('g', 357, 25, 1.4, 27.8, 0, 800) },
  { name: 'ser grillowy', nutrition: n('g', 320, 22, 1, 25, 0, 800) },
  { name: 'ser halloumi', nutrition: n('g', 320, 21, 1.5, 25.5, 0, 1100) },
  { name: 'ser mascarpone', nutrition: n('g', 430, 4.6, 3.6, 44, 0, 40) },
  { name: 'ser pleśniowy', nutrition: n('g', 330, 20, 0.5, 27.5, 0, 650), note: 'Typu brie z białą pleśnią.' },
  { name: 'ser ricotta', nutrition: n('g', 140, 9, 3.5, 10, 0, 100) },
  { name: 'ser twaróg chudy', nutrition: n('g', 99, 19.8, 3.5, 0.5, 0, 45) },
  { name: 'ser twaróg tłusty', nutrition: n('g', 175, 17.7, 3.5, 10.1, 0, 45) },
  { name: 'ser żółty', nutrition: n('g', 356, 25, 2.2, 27.4, 0, 800), note: 'Jak gouda.' },
  { name: 'serek homogenizowany', nutrition: n('g', 160, 8, 15, 7.5, 0, 50), note: 'Waniliowy, słodzony.' },
  { name: 'serek kanapkowy', nutrition: n('g', 220, 7, 3, 20, 0, 400) },
  { name: 'skyr owocowy', nutrition: n('g', 80, 8.5, 10.5, 0.2, 0, 45) },
  { name: 'śmietana 12', nutrition: n('g', 133, 2.7, 3.9, 12, 0, 40) },
  { name: 'śmietanka 12', nutrition: n('ml', 133, 2.7, 3.9, 12, 0, 40) },
  { name: 'śmietanka 18', nutrition: n('ml', 184, 2.6, 3.6, 18, 0, 40) },

  // ─── oleje i tłuszcze ───
  { name: 'olej kokosowy', nutrition: n('g', 890, 0, 0, 99, 0, 0), note: 'W g — w temperaturze pokojowej jest stały.' },
  { name: 'olej słonecznikowy', nutrition: n('ml', 810, 0, 0, 92, 0, 0) },
  { name: 'smalec', nutrition: n('g', 900, 0, 0, 99.5, 0, 0) },

  // ─── ryby ───
  { name: 'karp', nutrition: n('g', 110, 18, 0, 4.5, 0, 50), note: 'Filet/dzwonka, część jadalna.' },
  { name: 'pstrąg', nutrition: n('g', 85, 12.5, 0, 3.7, 0, 30, 300), note: `Cały patroszony. ${BONE_NOTE} Część jadalna ok. 60%.` },
  { name: 'sandacz', nutrition: n('g', 84, 19.2, 0, 0.7, 0, 50), note: 'Filet.' },
  { name: 'tuńczyk', nutrition: n('g', 108, 24.4, 0, 0.9, 0, 45), note: 'Świeży stek.' },
];

/** Grupa 2: nowe składniki (nazwa + kategoria + tagi + makro). */
const NEW: IngredientAddition[] = [
  // ─── owoce ───
  { name: 'jagoda', category: 'owoce', allergens: [], dietTags: [], nutrition: n('g', 45, 0.7, 8.5, 0.6, 3.3, 1), note: 'Świeże jagody leśne (czarne borówki); borówka amerykańska to „borówka".' },
  { name: 'rabarbar', category: 'owoce', allergens: [], dietTags: [], nutrition: n('g', 21, 0.9, 2.7, 0.2, 1.8, 4), note: 'Botanicznie warzywo, w kuchni i w sklepie traktowany jak owoc.' },

  // ─── warzywa (w tym świeże zioła, jak koperek i natka) ───
  { name: 'bazylia', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 23, 3.2, 1, 0.6, 1.6, 4), note: 'Świeża (doniczka); suszona to „bazylia suszona".' },
  { name: 'mięta', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 44, 3.3, 1.5, 0.7, 6.8, 31), note: 'Świeża.' },
  { name: 'kolendra', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 23, 2.1, 0.9, 0.5, 2.8, 46), note: 'Świeże liście.' },
  { name: 'szczaw', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 22, 2, 0.3, 0.7, 2.9, 4), note: 'Świeży; szczaw ze słoika ma podobne makro, ale jest solony.' },
  { name: 'botwina', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 25, 1.9, 3.1, 0.1, 2.9, 120), note: 'Młode buraczki z liśćmi (pęczek, sezonowo).' },
  { name: 'papryczka chili', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 40, 1.9, 7.4, 0.4, 1.5, 9, 15), note: 'Świeża, ostra.' },
  { name: 'sałata rzymska', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 17, 1.2, 1.2, 0.3, 2.1, 8) },
  { name: 'grzyb suszony', category: 'warzywa', allergens: [], dietTags: [], nutrition: n('g', 290, 30, 20, 3.5, 25, 20), note: 'Suszone grzyby leśne (borowik, podgrzybek) — do bigosu, uszek, zupy grzybowej.' },

  // ─── mięso (bez zmian w PROCESSED: surowe) ───
  { name: 'wątróbka drobiowa', category: 'mieso', allergens: [], dietTags: ['MEAT'], nutrition: n('g', 119, 16.9, 0.7, 4.8, 0, 71) },
  { name: 'udko z kurczaka', category: 'mieso', allergens: [], dietTags: ['MEAT'], nutrition: n('g', 175, 13, 0, 13.1, 0, 65, 180), note: `Z kością i skórą. ${BONE_NOTE} Część jadalna ok. 79%.` },
  { name: 'kurczak cały', category: 'mieso', allergens: [], dietTags: ['MEAT'], nutrition: n('g', 146, 12.6, 0, 10.3, 0, 50, 1600), note: `Tuszka do pieczenia. ${BONE_NOTE} Część jadalna ok. 68%.` },
  { name: 'żeberko wieprzowe', category: 'mieso', allergens: [], dietTags: ['MEAT'], nutrition: n('g', 200, 11.2, 0, 16.9, 0, 60), note: `Surowe żeberka. ${BONE_NOTE} Część jadalna ok. 72%.` },
  { name: 'golonka wieprzowa', category: 'mieso', allergens: [], dietTags: ['MEAT'], nutrition: n('g', 200, 14, 0, 16, 0, 70, 1000), note: `Surowa, ze skórą. ${BONE_NOTE} Część jadalna ok. 65%.` },

  // ─── ryby ───
  { name: 'makrela', category: 'ryby-owoce-morza', allergens: ['fish'], dietTags: ['FISH'], nutrition: n('g', 133, 12.1, 0, 9, 0, 60, 350), note: `Świeża/mrożona, cała patroszona. ${BONE_NOTE} Część jadalna ok. 65%.` },
  { name: 'makrela wędzona', category: 'ryby-owoce-morza', allergens: ['fish'], dietTags: ['FISH'], nutrition: n('g', 250, 19, 0, 19.5, 0, 800), note: 'Mięso bez skóry i ości — w przepisie podawaj masę mięsa (z całej ryby ok. 65%).' },

  // ─── konserwy i słoiki ───
  { name: 'sardynka w oleju', category: 'konserwy-i-sloiki', allergens: ['fish'], dietTags: ['FISH', 'PROCESSED'], nutrition: n('g', 208, 24.6, 0, 11.5, 0, 400), note: 'Puszka, odsączona.' },
  { name: 'pomidor suszony w oleju', category: 'konserwy-i-sloiki', allergens: [], dietTags: [], nutrition: n('g', 175, 3, 7, 14, 5, 900), note: 'Ze słoika, lekko odsączony.' },
  { name: 'fasola w sosie pomidorowym', category: 'konserwy-i-sloiki', allergens: [], dietTags: ['LEGUME', 'PROCESSED'], nutrition: n('g', 78, 4.7, 10.8, 0.2, 3.7, 240), note: 'Puszka typu baked beans, z sosem.' },
  { name: 'dżem', category: 'konserwy-i-sloiki', allergens: [], dietTags: ['PROCESSED'], nutrition: n('g', 200, 0.4, 48.5, 0.1, 1, 10), note: 'Owocowy (truskawkowy, wiśniowy…), zwykły lub niskosłodzony — średnia.' },
  { name: 'sos żurawinowy', category: 'konserwy-i-sloiki', allergens: [], dietTags: ['PROCESSED'], nutrition: n('g', 170, 0.2, 41, 0.1, 1.5, 10), note: 'Żurawina do mięs i serów ze słoika.' },

  // ─── przyprawy i sosy ───
  { name: 'pesto bazyliowe', category: 'przyprawy-i-sosy', allergens: ['lactose', 'milk', 'nuts'], dietTags: ['DAIRY', 'PROCESSED'], nutrition: n('g', 450, 5, 5, 45, 2, 1000), note: 'Pesto alla genovese ze słoika: ser (mleko) i orzechy nerkowca/pinii — nadmiarowo.' },
  { name: 'sos barbecue', category: 'przyprawy-i-sosy', allergens: ['mustard'], dietTags: ['PROCESSED'], nutrition: n('g', 170, 1, 40, 0.5, 0.8, 900), note: 'Gorczyca częsta w składzie — nadmiarowo.' },
  { name: 'sos słodko-kwaśny', category: 'przyprawy-i-sosy', allergens: [], dietTags: ['PROCESSED'], nutrition: n('g', 120, 0.3, 29, 0.2, 0.3, 500) },
  { name: 'sos chili słodki', category: 'przyprawy-i-sosy', allergens: [], dietTags: ['PROCESSED'], nutrition: n('g', 220, 0.3, 53, 0.3, 0.8, 900) },
  { name: 'pasta curry', category: 'przyprawy-i-sosy', allergens: ['crustaceans', 'fish'], dietTags: ['CRUSTACEAN', 'FISH', 'PROCESSED'], nutrition: n('g', 110, 2, 12, 5, 4, 3000), note: 'Tajska pasta curry (czerwona/zielona). Wiele marek ma pastę krewetkową — nadmiarowo fish + crustaceans.' },
  { name: 'płatki chili', category: 'przyprawy-i-sosy', allergens: [], dietTags: [], nutrition: n('g', 318, 12, 22, 14, 27.2, 30) },
  { name: 'papryka wędzona mielona', category: 'przyprawy-i-sosy', allergens: [], dietTags: [], nutrition: n('g', 282, 14, 19, 13, 35, 68) },
  { name: 'garam masala', category: 'przyprawy-i-sosy', allergens: [], dietTags: [], nutrition: n('g', 380, 15, 30, 15, 30, 50) },
  { name: 'gałka muszkatołowa', category: 'przyprawy-i-sosy', allergens: [], dietTags: [], nutrition: n('g', 525, 5.8, 28.5, 36.3, 20.8, 16) },
  { name: 'zioła prowansalskie', category: 'przyprawy-i-sosy', allergens: [], dietTags: [], nutrition: n('g', 270, 10, 25, 6, 40, 50) },
  { name: 'przyprawa do gyrosa', category: 'przyprawy-i-sosy', allergens: ['celery', 'mustard'], dietTags: ['PROCESSED'], nutrition: n('g', 250, 9, 30, 6, 20, 8000), note: 'Mieszanka z solą (ok. 20%); seler i gorczyca częste w mieszankach — nadmiarowo.' },
  { name: 'przyprawa do piernika', category: 'przyprawy-i-sosy', allergens: [], dietTags: [], nutrition: n('g', 330, 5, 45, 8, 35, 30) },
  { name: 'cebula prażona', category: 'przyprawy-i-sosy', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 600, 6, 40, 44, 6, 1000), note: 'Chrupiąca cebulka smażona w mące pszennej (do hot dogów, sałatek).' },
  { name: 'ocet balsamiczny', category: 'przyprawy-i-sosy', allergens: ['sulphites'], dietTags: [], nutrition: n('ml', 88, 0.5, 17, 0, 0, 23) },
  { name: 'cukier waniliowy', category: 'przyprawy-i-sosy', allergens: [], dietTags: ['PROCESSED'], nutrition: n('g', 395, 0, 98.5, 0, 0, 1), note: 'Cukier z wanilią/wanilinowy z torebki.' },

  // ─── oleje ───
  { name: 'olej sezamowy', category: 'olej-i-tluszcz', allergens: ['sesame'], dietTags: [], nutrition: n('ml', 810, 0, 0, 92, 0, 0) },

  // ─── inne ───
  { name: 'tahini', category: 'inne', allergens: ['sesame'], dietTags: [], nutrition: n('g', 595, 17, 11.2, 53.8, 9.3, 115), note: 'Pasta sezamowa.' },

  // ─── cukiernia ───
  { name: 'ciasto francuskie', category: 'cukiernia', allergens: ['gluten', 'lactose', 'milk'], dietTags: ['DAIRY', 'GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 380, 5.5, 38, 23, 1.5, 450), note: 'Gotowe z lodówki; część marek na margarynie z mlekiem/maśle — mleko nadmiarowo.' },
  { name: 'wiórki kokosowe', category: 'cukiernia', allergens: [], dietTags: [], nutrition: n('g', 660, 6.9, 7.4, 64.5, 16.3, 37), note: 'Kokos nie jest orzechem — bez nuts.' },
  { name: 'soda oczyszczona', category: 'cukiernia', allergens: [], dietTags: [], nutrition: n('g', 0, 0, 0, 0, 0, 27400) },

  // ─── przekąski i słodycze ───
  { name: 'herbatnik', category: 'przekaska-i-slodycz', allergens: ['eggs', 'gluten', 'lactose', 'milk'], dietTags: ['DAIRY', 'EGG', 'GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 440, 7.5, 73, 12, 2.5, 350), note: 'Herbatniki maślane (Petit Beurre) — mleko/masło, często jajko; nadmiarowo.' },
  { name: 'czekolada biała', category: 'przekaska-i-slodycz', allergens: ['lactose', 'milk', 'soy'], dietTags: ['DAIRY', 'LEGUME', 'PROCESSED'], nutrition: n('g', 539, 5.9, 59, 32.1, 0.2, 90) },
  { name: 'migdał', category: 'przekaska-i-slodycz', allergens: ['nuts'], dietTags: [], nutrition: n('g', 579, 21.2, 9.7, 49.9, 12.5, 1), note: 'Całe lub płatki migdałowe — to samo makro.' },
  { name: 'daktyl suszony', category: 'przekaska-i-slodycz', allergens: [], dietTags: [], nutrition: n('g', 282, 2.5, 67, 0.4, 8, 2) },
  { name: 'śliwka suszona', category: 'przekaska-i-slodycz', allergens: [], dietTags: [], nutrition: n('g', 240, 2.2, 57, 0.4, 7.1, 2) },
  { name: 'morela suszona', category: 'przekaska-i-slodycz', allergens: ['sulphites'], dietTags: [], nutrition: n('g', 241, 3.4, 55, 0.5, 7.3, 10), note: 'Zwykle siarkowana (E220) — sulphites nadmiarowo.' },
  { name: 'żurawina suszona', category: 'przekaska-i-slodycz', allergens: [], dietTags: ['PROCESSED'], nutrition: n('g', 308, 0.1, 76.5, 1.1, 5.7, 5), note: 'Słodzona cukrem, jak w sklepie.' },

  // ─── napoje ───
  { name: 'syrop malinowy', category: 'napoje', allergens: [], dietTags: ['PROCESSED'], nutrition: n('ml', 260, 0, 64, 0, 0, 10), note: '„Sok malinowy" do herbaty i kaszy manny (syrop z cukrem).' },

  // ─── nabiał ───
  { name: 'ser gorgonzola', category: 'nabial-i-jajko', allergens: ['lactose', 'milk'], dietTags: ['DAIRY'], nutrition: n('g', 350, 19, 0.5, 30, 0, 1200) },
  { name: 'ser kozi', category: 'nabial-i-jajko', allergens: ['lactose', 'milk'], dietTags: ['DAIRY'], nutrition: n('g', 266, 18.5, 0.9, 21, 0, 460), note: 'Miękki (roladka/serek); mleko kozie też wywołuje alergię na białko mleka.' },
  { name: 'mleko w proszku', category: 'nabial-i-jajko', allergens: ['lactose', 'milk'], dietTags: ['DAIRY'], nutrition: n('g', 496, 26.3, 38.4, 26.7, 0, 371), note: 'Pełne (do bloku czekoladowego).' },

  // ─── mrożonki ───
  { name: 'malina mrożona', category: 'mrozonka', allergens: [], dietTags: [], nutrition: n('g', 50, 1.2, 5.4, 0.7, 6.5, 1) },
  { name: 'wiśnia mrożona', category: 'mrozonka', allergens: [], dietTags: [], nutrition: n('g', 50, 1, 10.6, 0.3, 1.6, 3), note: 'Drylowana.' },
  { name: 'edamame', category: 'mrozonka', allergens: ['soy'], dietTags: ['LEGUME'], nutrition: n('g', 120, 11.9, 3.6, 5.2, 5.2, 6), note: 'Łuskane ziarna; w strąkach część jadalna to ok. 55% masy.' },

  // ─── piekarnia ───
  { name: 'bajgiel', category: 'piekarnia', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 260, 10, 50, 1.5, 2.3, 450, 90) },
  { name: 'ciabatta', category: 'piekarnia', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 265, 9, 49, 3.5, 2.5, 500) },
  { name: 'bułka do hamburgera', category: 'piekarnia', allergens: ['gluten', 'sesame'], dietTags: ['GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 280, 9, 48, 5, 2.5, 450, 75), note: 'Zwykle posypana sezamem — nadmiarowo.' },
  { name: 'bułka do hot doga', category: 'piekarnia', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 270, 9, 48, 4, 2.5, 450, 60) },

  // ─── zboża i makarony (sucha masa) ───
  { name: 'groch łuskany', category: 'zboza-i-makarony', allergens: [], dietTags: ['LEGUME'], nutrition: n('g', 330, 23, 48, 1.5, 15, 15), note: 'Suchy, połówki.' },
  { name: 'makaron tagliatelle', category: 'zboza-i-makarony', allergens: ['eggs', 'gluten'], dietTags: ['EGG', 'GLUTEN_GRAIN', 'GRAIN'], nutrition: n('g', 385, 14, 70, 4, 3, 20), note: 'Jajeczny, suchy (gniazda).' },
  { name: 'makaron lasagne', category: 'zboza-i-makarony', allergens: ['eggs', 'gluten'], dietTags: ['EGG', 'GLUTEN_GRAIN', 'GRAIN'], nutrition: n('g', 360, 12.5, 71, 1.5, 3, 5), note: 'Płaty; część marek jajeczna — eggs nadmiarowo.' },
  { name: 'makaron cannelloni', category: 'zboza-i-makarony', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN'], nutrition: n('g', 360, 12.5, 71, 1.5, 3, 5), note: 'Rurki z semoliny.' },
  { name: 'makaron łazanki', category: 'zboza-i-makarony', allergens: ['eggs', 'gluten'], dietTags: ['EGG', 'GLUTEN_GRAIN', 'GRAIN'], nutrition: n('g', 365, 13, 71, 2, 3, 10), note: 'Często jajeczne — eggs nadmiarowo.' },
  { name: 'makaron kolanka', category: 'zboza-i-makarony', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN'], nutrition: n('g', 371, 13, 71.5, 1.5, 3.2, 6) },
  { name: 'makaron ryżowy', category: 'zboza-i-makarony', allergens: [], dietTags: ['GRAIN'], nutrition: n('g', 360, 6, 80, 0.6, 1.6, 20) },
  { name: 'makaron udon', category: 'zboza-i-makarony', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN'], nutrition: n('g', 348, 8.5, 71.5, 1.1, 2.4, 1500), note: 'Suchy (sól w cieście); świeży podgotowany z próżniowej paczki ma ok. 2,6× mniej na 100 g.' },
  { name: 'makaron sojowy', category: 'zboza-i-makarony', allergens: [], dietTags: ['LEGUME'], nutrition: n('g', 350, 0.2, 85.6, 0.1, 0.5, 10), note: 'Szklisty makaron ze skrobi fasoli mung — mimo nazwy bez soi.' },
  { name: 'gnocchi', category: 'zboza-i-makarony', allergens: ['gluten'], dietTags: ['GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 152, 3.5, 32, 0.3, 1.8, 450), note: 'Gotowe z paczki (ziemniak, mąka pszenna); typowo bez jajka.' },
  { name: 'tortellini z serem', category: 'zboza-i-makarony', allergens: ['eggs', 'gluten', 'lactose', 'milk'], dietTags: ['DAIRY', 'EGG', 'GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'], nutrition: n('g', 275, 10, 42, 7, 2, 500), note: 'Świeże z lodówki, z nadzieniem serowym (np. ricotta-szpinak).' },
  { name: 'papier ryżowy', category: 'zboza-i-makarony', allergens: [], dietTags: ['GRAIN'], nutrition: n('g', 335, 3, 80, 0.3, 1, 500), note: 'Arkusze do sajgonek i spring rolls.' },
];

export const ADDITIONS: IngredientAddition[] = [...EXISTING, ...NEW];
