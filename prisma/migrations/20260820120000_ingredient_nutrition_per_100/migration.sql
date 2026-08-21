-- Wartości odżywcze składnika na 100 g / 100 ml.
--
-- Bez tego makro przepisu jest liczbą wpisaną z ręki, której nie da się
-- zweryfikować — audyt bazy v1 wykazał medianę odchyłki +43% i skrajności
-- do +87%, bo wartości były zgadywane, a nie liczone ze składników.
-- Mając te pola, `nutritionKcal` na Recipe staje się wielkością wyprowadzalną:
-- suma po RecipeIngredient, sprawdzalna skryptem i testem.
--
-- Nullable, bo katalog składników rośnie szybciej niż tabela wartości —
-- nowy składnik bez makro ma się dodać, a audyt ma go zgłosić jako lukę,
-- nie wysypać import.
--
-- Konwencja (patrz prisma/catalog/ingredient-nutrition-pl-v1.json):
--   * podstawa: 100 g dla jednostki `g`, 100 ml dla `ml`
--   * stan surowy — makaron i ryż jako sucha masa
--   * `nutritionCarbsPer100` to węglowodany PRZYSWAJALNE, bez błonnika (IŻŻ);
--     błonnik osobno w `nutritionFiberPer100`
--
-- `gramsPerPiece` obsługuje składniki mierzone w `szt` (jajko, banan, awokado,
-- ząbek czosnku, tortilla) — bez masy sztuki nie ma jak ich policzyć.
ALTER TABLE "Ingredient"
    ADD COLUMN "nutritionKcalPer100"    DOUBLE PRECISION,
    ADD COLUMN "nutritionProteinPer100" DOUBLE PRECISION,
    ADD COLUMN "nutritionCarbsPer100"   DOUBLE PRECISION,
    ADD COLUMN "nutritionFatPer100"     DOUBLE PRECISION,
    ADD COLUMN "nutritionFiberPer100"   DOUBLE PRECISION,
    ADD COLUMN "gramsPerPiece"          DOUBLE PRECISION,
    ADD COLUMN "nutritionSource"        TEXT;
