# Katalog 1000 — lista nowych przepisów (zatwierdzona 28.09.2026)

Rozbudowa katalogu z 500 do ~1072 przepisów: 572 nowych. Lista
zatwierdzona przez Rafała po czterech rundach (Artifact „Katalog 1000”). Klucz
(np. `OB-042`) wiąże pozycję listy z definicją przepisu w generatorze — tytuł
może zostać dopracowany, klucz zostaje. Etykiety to ZAMIAR: alergeny i tagi
diet policzą się ze składników, a kuchnia, sezon, okazja, sprzęt i cechy idą
do pól taksonomii (`src/recipes/recipe-taxonomy.ts`).

| Kategoria | Nowe |
|---|---|
| Śniadania (`SN`) | 88 |
| Drugie śniadania i lunchboxy (`DS`) | 57 |
| Obiady (`OB`) | 195 |
| Kolacje (`KO`) | 116 |
| Desery i podwieczorki (`DE`) | 47 |
| Przekąski (`PR`) | 40 |
| Napoje (`NA`) | 29 |
| **Razem** | **572** |

Zasady treści:

- składniki do kupienia w Lidlu, Biedronce, Selgrosie albo Makro — zwykły
  użytkownik kupi wszystko bez sklepu specjalistycznego;
- 2 porcje (ciasta i dania świąteczne — tyle, ile wychodzi z blachy);
- krewetki i śledź DOZWOLONE (decyzja 28.09.2026); innych owoców morza
  (kalmary, małże, ośmiornice) nie ma;
- kuchnie świata tylko: włoska, hiszpańska, grecka, indyjska, tajska,
  meksykańska, amerykańska;
- przepis na airfryer ma w krokach wariant na piekarnik;
- soki, kompoty i lemoniady to dodatek do posiłku (cecha `SIDE`) — planer nie
  stawia ich zamiast posiłku;
- przepisy od święta (Wigilia, Boże Narodzenie, Wielkanoc, impreza) planer
  proponuje tylko w ich okresie albo na prośbę (cecha `OCCASIONAL`), sezonowe —
  tylko w sezonie;
- każdy przepis przechodzi kontrolę generatora (składniki z katalogu, makro
  liczone ze składników, limit soli, kaloryczność pory); niezaliczony = zamiana
  na podobny i informacja dla Rafała.

## Śniadania (`SN`)


### Bezglutenowe i bezmleczne

- `SN-001` Kasza gryczana na mleku kokosowym z gruszką i orzechami — bez glutenu, bez mleka, wegańskie
- `SN-002` Pudding z komosy ryżowej z mlekiem kokosowym i mango — bez glutenu, bez mleka, wegańskie
- `SN-003` Placuszki bananowe z mąki gryczanej — bez glutenu
- `SN-004` Hash z batatów z jajkiem sadzonym i awokado — bez glutenu, bez mleka
- `SN-005` Frittata z pieczonymi warzywami bez sera — bez glutenu, bez mleka
- `SN-006` Chleb bezglutenowy z pastą z awokado i jajkiem — bez glutenu, bez mleka
- `SN-007` Ryżanka na napoju migdałowym z jabłkiem i cynamonem — bez glutenu, bez mleka, wegańskie
- `SN-008` Wafle ryżowe z hummusem, ogórkiem i rzodkiewką — bez glutenu, bez mleka, wegańskie, do 30 min
- `SN-009` Placki z kaszy jaglanej z warzywami i jogurtem kokosowym — bez glutenu, bez mleka, wegańskie
- `SN-010` Omlet z ziołami i wędzonym łososiem — bez glutenu, bez mleka, ryba, do 30 min
- `SN-011` Jajka sadzone na pieczonych ziemniakach z boczkiem — bez glutenu, bez mleka
- `SN-012` Pieczone jabłka z płatkami jaglanymi i orzechami — bez glutenu, bez mleka, wegańskie

### Lekkie (do 350 kcal)

- `SN-013` Jogurt naturalny z otrębami i jabłkiem — lekkie, wegetariańskie, do 30 min
- `SN-014` Jajko na miękko z warzywami i kromką chleba — lekkie, wegetariańskie, bez mleka, do 30 min
- `SN-015` Grzanka z pomidorem i bazylią — kuchnia włoska, lekkie, wegańskie, do 30 min
- `SN-016` Jogurt grecki z malinami i siemieniem lnianym — lekkie, wegetariańskie, wysokobiałkowe, bez glutenu
- `SN-017` Kefir z płatkami owsianymi i truskawkami — lekkie, wegetariańskie, do 30 min
- `SN-018` Wafle ryżowe z twarożkiem i rzodkiewką — lekkie, wegetariańskie, bez glutenu, do 30 min
- `SN-019` Jajka zapiekane w papryce — lekkie, wegetariańskie, bez glutenu, bez mleka
- `SN-020` Omlet z pomidorem i szczypiorkiem — lekkie, wegetariańskie, bez glutenu, bez mleka, do 30 min
- `SN-021` Serek wiejski z jabłkiem i cynamonem — lekkie, wysokobiałkowe, wegetariańskie, bez glutenu, do 30 min
- `SN-022` Kanapki z pieczonym indykiem i warzywami na chlebie żytnim — lekkie, wysokobiałkowe, bez mleka, do 30 min

### Wegańskie

- `SN-023` Owsianka proteinowa na napoju sojowym z masłem orzechowym — wegańskie, wysokobiałkowe
- `SN-024` Owsianka z tahini, bananem i sezamem — wegańskie
- `SN-025` Kanapki z pastą z ciecierzycy i suszonych pomidorów — wegańskie
- `SN-026` Placki bananowo-owsiane bez jajek z musem jabłkowym — wegańskie, dla dzieci
- `SN-027` Tost z awokado, ciecierzycą i pestkami dyni — wegańskie, do 30 min
- `SN-028` Naleśniki wegańskie z masłem orzechowym i truskawkami — wegańskie
- `SN-029` Domowa granola z orzechami i jogurtem sojowym — wegańskie, na kilka dni
- `SN-030` Kanapki z pastą z białej fasoli i pieczonej papryki — wegańskie
- `SN-031` Owsianka nocna z jabłkiem, cynamonem i jogurtem sojowym — wegańskie, do 30 min, na kilka dni
- `SN-032` Kanapki z wędzonym tofu, pomidorem i szczypiorkiem — wegańskie, wysokobiałkowe, do 30 min
- `SN-033` Gofry wegańskie z owocami i syropem klonowym — wegańskie, gofrownica
- `SN-034` Pasta z czerwonej soczewicy z ogórkiem kiszonym na chlebie — wegańskie, wysokobiałkowe
- `SN-035` Placki z ciecierzycy na słono z pomidorami — wegańskie, wysokobiałkowe, bez glutenu
- `SN-036` Kanapki z pastą z tofu i szczypiorkiem — wegańskie, wysokobiałkowe, do 30 min

### Kuchnie świata

- `SN-037` Chilaquiles z jajkiem sadzonym i salsą — kuchnia meksykańska, wegetariańskie
- `SN-038` Burrito śniadaniowe z jajecznicą, fasolą i serem — kuchnia meksykańska, wegetariańskie, do pudełka
- `SN-039` Pan con tomate z szynką serrano — kuchnia hiszpańska, do 30 min, bez mleka
- `SN-040` Huevos a la flamenca — jajka zapiekane z chorizo i groszkiem — kuchnia hiszpańska, bez glutenu
- `SN-041` Kagianas — greckie jajka z pomidorami i fetą — kuchnia grecka, wegetariańskie, bez glutenu, do 30 min
- `SN-042` Kanapka z jajkiem, cheddarem i bekonem na angielskiej bułeczce — kuchnia amerykańska
- `SN-043` Masala omlet z pomidorem i kolendrą — kuchnia indyjska, wegetariańskie, bez glutenu, do 30 min
- `SN-044` Upma — kasza manna z warzywami po indyjsku — kuchnia indyjska, wegańskie
- `SN-045` Huevos rancheros — jajka z salsą i fasolą na tortilli — kuchnia meksykańska, wegetariańskie, bez glutenu
- `SN-046` Frittata po włosku z suszonymi pomidorami i bazylią — kuchnia włoska, wegetariańskie, bez glutenu
- `SN-047` Tosty BLT z bekonem, sałatą i pomidorem — kuchnia amerykańska, do 30 min
- `SN-048` Tajski omlet z ryżem i sosem chili — kuchnia tajska, bez mleka, do 30 min

### Sezonowe

- `SN-049` Jajecznica ze szparagami i szczypiorkiem — wiosna, wegetariańskie, bez glutenu, do 30 min
- `SN-050` Owsianka z rabarbarem i truskawkami — wiosna, wegetariańskie
- `SN-051` Bułki z pastą z awokado i rzodkiewką — wiosna, wegańskie, do 30 min
- `SN-052` Tost z ricottą, bobem i miętą — lato, wegetariańskie
- `SN-053` Frittata z młodą cukinią i miętą — lato, wegetariańskie, bez glutenu
- `SN-054` Kasza jaglana z czereśniami i jogurtem — lato, wegetariańskie, bez glutenu
- `SN-055` Owsianka nocna z malinami i porzeczkami — lato, wegetariańskie, na kilka dni
- `SN-056` Jajecznica z kurkami i koperkiem — lato, jesień, wegetariańskie, bez glutenu
- `SN-057` Tosty z serem, gruszką i orzechami — jesień, wegetariańskie
- `SN-058` Jajka w sosie z grzybów leśnych na grzance — jesień, wegetariańskie
- `SN-059` Owsianka dyniowa z cynamonem i orzechami — jesień, wegetariańskie
- `SN-060` Grzanki z pieczonym burakiem, twarożkiem i orzechami — zima, wegetariańskie
- `SN-061` Owsianka z pomarańczą i kakao — zima, wegetariańskie
- `SN-062` Jaglanka z pieczonym jabłkiem i żurawiną — zima, wegańskie, bez glutenu
- `SN-063` Jajka zapiekane z porem i boczkiem — zima, bez glutenu

### Airfryer

- `SN-064` Frittata z papryką i fetą — airfryer, wegetariańskie, bez glutenu
- `SN-065` Placuszki twarogowe pieczone z owocami — airfryer, wegetariańskie, na kilka dni
- `SN-066` Hash browns z jajkiem sadzonym — airfryer, kuchnia amerykańska, wegetariańskie, bez glutenu
- `SN-067` Tosty z mozzarellą i pomidorem — airfryer, wegetariańskie, do 30 min
- `SN-068` Pieczone jabłka z owsianą kruszonką — airfryer, wegetariańskie
- `SN-069` Koszyczki z szynki z jajkiem — airfryer, wysokobiałkowe, keto, bez glutenu
- `SN-070` Muffinki owsiane z borówkami — airfryer, wegetariańskie, do pudełka, dla dzieci
- `SN-071` Bajgle twarogowe — airfryer, wysokobiałkowe, wegetariańskie
- `SN-072` Ziemniaki śniadaniowe z jajkiem i szczypiorkiem — airfryer, wegetariańskie, bez glutenu

### Wysokobiałkowe i keto

- `SN-073` Omlet białkowy z indykiem i warzywami — wysokobiałkowe, lekkie, bez glutenu
- `SN-074` Serek wiejski z jajkiem na twardo i szczypiorkiem — wysokobiałkowe, bez glutenu, do 30 min
- `SN-075` Kanapki z pastą z jajek i tuńczyka — wysokobiałkowe, ryba
- `SN-076` Owsianka z twarogiem i jagodami — wysokobiałkowe, wegetariańskie
- `SN-077` Jajecznica z indykiem i papryką — wysokobiałkowe, bez glutenu, do 30 min
- `SN-078` Pudding proteinowy z chia i skyrem — wysokobiałkowe, wegetariańskie, bez glutenu, na kilka dni
- `SN-079` Omlet z awokado, boczkiem i serem — keto, bez glutenu
- `SN-080` Jajka sadzone z awokado i wędzonym łososiem — keto, ryba, bez glutenu, do 30 min
- `SN-081` Muffinki jajeczne z brokułem i cheddarem — keto, bez glutenu, do pudełka, na kilka dni
- `SN-082` Pudding chia na mleku kokosowym z orzechami bez cukru — keto, wegańskie, bez glutenu

### Śniadanie wielkanocne

- `SN-083` Jajka faszerowane pieczarkami i szczypiorkiem — Wielkanoc, wegetariańskie, bez glutenu
- `SN-084` Jajka faszerowane pastą z tuńczyka — Wielkanoc, ryba, bez glutenu
- `SN-085` Jajka faszerowane w skorupkach zapiekane — Wielkanoc, wegetariańskie
- `SN-086` Rolada z kurczaka ze szpinakiem na zimno — Wielkanoc, wysokobiałkowe, bez glutenu
- `SN-087` Pasztet z soczewicy i warzyw — Wielkanoc, wegańskie
- `SN-088` Schab pieczony ze śliwką na zimno — Wielkanoc, Boże Narodzenie, bez glutenu, bez mleka

## Drugie śniadania i lunchboxy (`DS`)


### Sałatki do pudełka

- `DS-001` Sałatka z bulgurem, ciecierzycą i fetą — do pudełka, kuchnia grecka, wegetariańskie, na kilka dni
- `DS-002` Sałatka z makaronem orzo, pomidorami i mozzarellą — do pudełka, kuchnia włoska, wegetariańskie
- `DS-003` Naleśniki zapiekane z kurczakiem i szpinakiem — do pudełka, wysokobiałkowe
- `DS-004` Sałatka z kurczakiem, kaszą pęczak i ogórkiem — do pudełka, wysokobiałkowe, na kilka dni
- `DS-005` Sałatka z komosy ryżowej, czarną fasolą i awokado — do pudełka, kuchnia meksykańska, wegańskie, bez glutenu
- `DS-006` Burrito z batatem i czarną fasolą — do pudełka, kuchnia meksykańska, wegańskie
- `DS-007` Sałatka grecka z kurczakiem i kaszą — do pudełka, kuchnia grecka, wysokobiałkowe
- `DS-008` Sałatka z kuskusem, pieczonymi warzywami i hummusem — do pudełka, wegańskie
- `DS-009` Pieczony indyk z ryżem i warzywami — do pudełka, wysokobiałkowe, lekkie, bez glutenu, bez mleka, na kilka dni
- `DS-010` Sałatka z fasolką szparagową, jajkiem i ziemniakami — do pudełka, lato, wegetariańskie, bez glutenu
- `DS-011` Sałatka z młodych ziemniaków, szparagów i rzodkiewki — do pudełka, wiosna, wegańskie, bez glutenu
- `DS-012` Sałatka z kaszą gryczaną, kurczakiem i pieczarkami — do pudełka, jesień, wysokobiałkowe
- `DS-013` Makaron z kurczakiem i brokułem w sosie jogurtowym — do pudełka, wysokobiałkowe
- `DS-014` Sałatka z arbuzem, fetą i miętą — lato, kuchnia grecka, wegetariańskie, lekkie, bez glutenu
- `DS-015` Sałatka z kurczakiem, kukurydzą i czarną fasolą — do pudełka, kuchnia meksykańska, wysokobiałkowe, bez glutenu
- `DS-016` Sałatka z soczewicą, pomidorkami i fetą — do pudełka, kuchnia grecka, wegetariańskie, wysokobiałkowe
- `DS-017` Ryż z tofu, marchewką i sosem sezamowym — do pudełka, wegańskie, wysokobiałkowe, na kilka dni

### Do pudełka na ciepło

- `DS-018` Curry z soczewicą i batatem — do pudełka, kuchnia indyjska, wegańskie, na kilka dni
- `DS-019` Sałatka makaronowa z tuńczykiem, oliwkami i pomidorami — do pudełka, kuchnia włoska, ryba
- `DS-020` Miska z ryżem, krewetkami, ogórkiem i sosem sezamowym — do pudełka, krewetki, bez mleka
- `DS-021` Kuskus z krewetkami, papryką i natką — do pudełka, krewetki, bez mleka

### Wrapy, kanapki i tortille

- `DS-022` Wrap z kurczakiem tikka i sosem jogurtowym — do pudełka, kuchnia indyjska, wysokobiałkowe
- `DS-023` Kanapka z hummusem buraczanym, fetą i rukolą — do pudełka, wegetariańskie
- `DS-024` Tortilla zwijana z jajkiem, szpinakiem i fetą — do pudełka, wegetariańskie
- `DS-025` Pita z pastą z ciecierzycy i warzywami — do pudełka, wegańskie
- `DS-026` Kanapka z tofu, awokado i kiełkami — do pudełka, wegańskie
- `DS-027` Bagietka z kurczakiem, mozzarellą i pesto — do pudełka, kuchnia włoska, wysokobiałkowe
- `DS-028` Tortilla z fasolą, ryżem i salsą — do pudełka, kuchnia meksykańska, wegańskie
- `DS-029` Kanapka z pieczoną papryką, hummusem i rukolą — do pudełka, wegańskie, do 30 min
- `DS-030` Tortilla z hummusem, marchewką i szpinakiem — do pudełka, wegańskie, do 30 min
- `DS-031` Mini tortille z kurczakiem i guacamole — do pudełka, kuchnia meksykańska, impreza

### Wypieki i przekąski do pudełka

- `DS-032` Muffinki wytrawne z cukinią i fetą — do pudełka, wegetariańskie, na kilka dni
- `DS-033` Mini frittaty z szynką i warzywami — do pudełka, bez glutenu, wysokobiałkowe
- `DS-034` Placuszki szpinakowe z serem — do pudełka, wegetariańskie, dla dzieci
- `DS-035` Paszteciki z ciasta francuskiego z pieczarkami — do pudełka, wegetariańskie, impreza
- `DS-036` Pierożki pieczone z soczewicą i ziemniakami — do pudełka, wegańskie
- `DS-037` Batony owsiane z orzechami i daktylami — do pudełka, wegańskie, dla dzieci, na kilka dni
- `DS-038` Kulki proteinowe z masłem orzechowym i płatkami owsianymi — do pudełka, wysokobiałkowe, wegetariańskie
- `DS-039` Drożdżowe bułeczki z serem i szynką — do pudełka, dla dzieci

### Słoiki, nabiał i owoce

- `DS-040` Chia z jogurtem i musem z malin w słoiku — do pudełka, lato, wegetariańskie, bez glutenu
- `DS-041` Owsianka nocna z kakao i wiśniami w słoiku — do pudełka, wegetariańskie, na kilka dni
- `DS-042` Serek wiejski z ogórkiem, rzodkiewką i koperkiem — wiosna, wysokobiałkowe, bez glutenu, do 30 min
- `DS-043` Twarożek z pieczoną dynią, miodem i orzechami — jesień, wegetariańskie
- `DS-044` Skyr z pieczonymi śliwkami i cynamonem — jesień, wysokobiałkowe, wegetariańskie
- `DS-045` Jogurt kokosowy z mango i granolą — wegańskie
- `DS-046` Sałatka owocowa z miętą i limonką — lato, wegańskie, lekkie, bez glutenu
- `DS-047` Zimowa sałatka owocowa z pomarańczą, granatem i kiwi — zima, wegańskie, lekkie, bez glutenu
- `DS-048` Twarożek z truskawkami i bazylią — lato, wysokobiałkowe, wegetariańskie, bez glutenu

### Białkowe i lekkie

- `DS-049` Jajka na twardo z warzywami i sosem jogurtowym — wysokobiałkowe, lekkie, bez glutenu, do pudełka
- `DS-050` Tofu pieczone z sosem sojowym i sezamem — wegańskie, wysokobiałkowe, do pudełka
- `DS-051` Roladki z szynki z twarożkiem i ogórkiem — keto, wysokobiałkowe, bez glutenu, do 30 min
- `DS-052` Hummus z pieczonej dyni z warzywami — jesień, wegańskie, bez glutenu, do pudełka
- `DS-053` Kurczak tandoori z sosem raita na zimno — kuchnia indyjska, wysokobiałkowe, bez glutenu, do pudełka
- `DS-054` Koreczki z mozzarellą, pomidorkami i bazylią — kuchnia włoska, wegetariańskie, keto, bez glutenu, impreza
- `DS-055` Sałatka jajeczna z awokado i szczypiorkiem — keto, wysokobiałkowe, bez glutenu
- `DS-056` Kotleciki z indyka i cukinii na zimno z dipem — do pudełka, wysokobiałkowe, na kilka dni
- `DS-057` Sałatka makaronowa z szynką i groszkiem — do pudełka, impreza

## Obiady (`OB`)


### Szybkie (do 30 minut)

- `OB-001` Makaron z kurczakiem, cukinią i pomidorkami — do 30 min, wysokobiałkowe
- `OB-002` Kotlety z indyka z kaszą i surówką — do 30 min, wysokobiałkowe
- `OB-003` Makaron z brokułem, czosnkiem i parmezanem — kuchnia włoska, do 30 min, wegetariańskie
- `OB-004` Łosoś z patelni z kaszą i fasolką szparagową — ryba, do 30 min, bez glutenu, wysokobiałkowe
- `OB-005` Indyk z pieczarkami w sosie śmietanowym z makaronem — do 30 min, wysokobiałkowe
- `OB-006` Makaron z sosem z ciecierzycy i pomidorów — kuchnia włoska, wegańskie, do 30 min
- `OB-007` Bulgur z warzywami i halloumi — kuchnia grecka, do 30 min, wegetariańskie
- `OB-008` Quesadilla z czarną fasolą i kukurydzą — kuchnia meksykańska, do 30 min, wegetariańskie
- `OB-009` Makaron z sosem pomidorowym i mielonym indykiem — do 30 min, wysokobiałkowe
- `OB-010` Kurczak z ciecierzycą i szpinakiem w pomidorach — do 30 min, wysokobiałkowe, bez glutenu, bez mleka
- `OB-011` Dorsz w sezamowej panierce z ryżem i ogórkiem — ryba, do 30 min, bez mleka
- `OB-012` Polędwiczka wieprzowa z kaszą gryczaną i buraczkami — do 30 min, wysokobiałkowe, bez glutenu
- `OB-013` Pierś z kurczaka z pesto, ryżem i pomidorami — kuchnia włoska, do 30 min, wysokobiałkowe, bez glutenu
- `OB-014` Kasza jęczmienna z kiełbasą i warzywami z jednego garnka — do 30 min
- `OB-015` Jajka w sosie chrzanowym z ziemniakami — do 30 min, wegetariańskie, bez glutenu
- `OB-016` Makaron z soczewicą po bolońsku — wegańskie, do 30 min, wysokobiałkowe
- `OB-017` Kurczak cytrynowy z kuskusem i warzywami — do 30 min, wysokobiałkowe, bez mleka
- `OB-018` Makaron z cukinią, miętą i fetą — lato, do 30 min, wegetariańskie
- `OB-019` Bulgur z mielonym indykiem i papryką — do 30 min, wysokobiałkowe, bez mleka
- `OB-020` Penne z kiełbasą i pomidorami — do 30 min
- `OB-021` Gnocchi z cukinią i boczkiem — kuchnia włoska, do 30 min
- `OB-022` Ryż z kurczakiem i warzywami po meksykańsku — kuchnia meksykańska, do 30 min, wysokobiałkowe, bez glutenu, bez mleka
- `OB-023` Kurczak w sosie musztardowo-miodowym z kaszą — do 30 min, wysokobiałkowe
- `OB-024` Kopytka zapiekane ze szpinakiem i serem — do 30 min, wegetariańskie
- `OB-025` Makaron ze szpinakiem i fetą — kuchnia włoska, do 30 min, wegetariańskie
- `OB-026` Makaron z tuńczykiem i brokułem w sosie cytrynowym — kuchnia włoska, ryba, do 30 min, bez mleka
- `OB-027` Makaron orzo z kurczakiem i szpinakiem — kuchnia włoska, do 30 min, wysokobiałkowe
- `OB-028` Mielona wołowina z ryżem, kukurydzą i fasolą — kuchnia meksykańska, do 30 min, bez glutenu, bez mleka
- `OB-029` Makaron ryżowy z wołowiną i warzywami — do 30 min, bez glutenu, bez mleka
- `OB-030` Mintaj w sosie cytrynowym z ryżem — ryba, do 30 min, lekkie, bez glutenu
- `OB-031` Dorsz z pomidorkami i oliwkami z kuskusem — kuchnia grecka, ryba, do 30 min, bez mleka
- `OB-032` Makaron z twarogiem, masłem i cukrem — do 30 min, wegetariańskie, dla dzieci
- `OB-033` Zupa z ciecierzycy i pomidorów — do 30 min, wegańskie, bez glutenu, lekkie
- `OB-034` Leczo z dynią i kiełbasą — jesień, do 30 min, bez glutenu, bez mleka
- `OB-035` Kurczak z brokułem w sosie sojowo-czosnkowym z ryżem — do 30 min, wysokobiałkowe, bez mleka
- `OB-036` Kasza jaglana z kurczakiem i warzywami z jednego garnka — do 30 min, wysokobiałkowe, bez glutenu, bez mleka
- `OB-037` Mięso mielone z cukinią i ryżem po grecku — kuchnia grecka, do 30 min, bez glutenu, bez mleka
- `OB-038` Szpinak z jajkiem sadzonym i ziemniakami — do 30 min, wegetariańskie, bez glutenu
- `OB-039` Kurczak w sosie z suszonych pomidorów z makaronem — kuchnia włoska, do 30 min, wysokobiałkowe
- `OB-040` Miska z ryżem, fasolą, kukurydzą i awokado — kuchnia meksykańska, do 30 min, wegańskie, bez glutenu
- `OB-041` Makaron z soczewicą i szpinakiem w sosie kokosowym — kuchnia indyjska, do 30 min, wegańskie, wysokobiałkowe
- `OB-042` Indyk w sosie curry z brokułem i ryżem — kuchnia indyjska, do 30 min, wysokobiałkowe, bez glutenu
- `OB-043` Łosoś z patelni z makaronem i cukinią — ryba, do 30 min, wysokobiałkowe

### Lekkie (do 450 kcal)

- `OB-044` Dorsz pieczony z warzywami śródziemnomorskimi — kuchnia grecka, ryba, lekkie, bez glutenu, bez mleka
- `OB-045` Zupa krem z brokułów z pestkami — lekkie, wegetariańskie, bez glutenu
- `OB-046` Kurczak pieczony z warzywami korzeniowymi — lekkie, wysokobiałkowe, bez glutenu, bez mleka
- `OB-047` Kurczak w sosie pomidorowo-paprykowym z kaszą jaglaną — lekkie, wysokobiałkowe, bez glutenu, bez mleka
- `OB-048` Indyk w sosie cytrynowo-kaparowym z kaszą — kuchnia włoska, lekkie, wysokobiałkowe, bez mleka
- `OB-049` Mintaj na parze z kaszą jaglaną i marchewką — ryba, lekkie, bez glutenu, bez mleka
- `OB-050` Cukinia faszerowana indykiem i pomidorami — lato, lekkie, wysokobiałkowe, bez glutenu
- `OB-051` Zupa pomidorowa z soczewicą — lekkie, wegańskie
- `OB-052` Kalafior w czerwonym curry po tajsku — kuchnia tajska, lekkie, wegańskie, bez glutenu
- `OB-053` Kotlety z indyka z cukinią w sosie jogurtowym z kaszą — lekkie, wysokobiałkowe
- `OB-054` Zupa gulaszowa z indyka — lekkie, wysokobiałkowe, bez mleka
- `OB-055` Ryba pieczona w papilotach z cytryną i koperkiem — ryba, lekkie, bez glutenu, bez mleka
- `OB-056` Kurczak tikka z sałatką z ogórka — kuchnia indyjska, lekkie, wysokobiałkowe, bez glutenu
- `OB-057` Zupa jarzynowa z młodych warzyw z koperkiem — lato, lekkie, wegańskie, bez glutenu
- `OB-058` Pieczony kurczak z ciecierzycą i papryką — lekkie, wysokobiałkowe, bez glutenu, bez mleka
- `OB-059` Kapusta duszona z indykiem i pomidorami — zima, lekkie, wysokobiałkowe, bez glutenu, bez mleka
- `OB-060` Zupa z młodej kapusty z koperkiem — wiosna, lekkie, wegańskie, bez glutenu
- `OB-061` Pieczarki faszerowane kaszą i szpinakiem — lekkie, wegetariańskie

### Wegańskie i roślinne białko

- `OB-062` Tofu w curry z warzywami i ryżem — kuchnia tajska, wegańskie, wysokobiałkowe, bez glutenu
- `OB-063` Gulasz z soczewicy i ziemniaków — wegańskie, wysokobiałkowe, bez glutenu, na kilka dni
- `OB-064` Kotlety z fasoli i kaszy jaglanej z surówką — wegańskie, bez glutenu
- `OB-065` Chili z indykiem i czarną fasolą — kuchnia meksykańska, wysokobiałkowe, na kilka dni
- `OB-066` Dal z czerwonej soczewicy z ryżem basmati — kuchnia indyjska, wegańskie, wysokobiałkowe, bez glutenu
- `OB-067` Tofu w sosie orzechowym z makaronem ryżowym — kuchnia tajska, wegańskie, wysokobiałkowe
- `OB-068` Pierogi z kaszą gryczaną i grzybami — wegetariańskie
- `OB-069` Makaron z pesto z jarmużu i orzechami — jesień, wegańskie
- `OB-070` Burgery z ciecierzycy z frytkami z batatów — wegańskie
- `OB-071` Leczo z ciecierzycą — lato, wegańskie, bez glutenu
- `OB-072` Kasza gryczana z pieczarkami i wędzonym tofu — wegańskie, wysokobiałkowe, bez glutenu
- `OB-073` Wegańska fasolka po bretońsku z wędzoną papryką — wegańskie, wysokobiałkowe, bez glutenu
- `OB-074` Bataty faszerowane czarną fasolą i salsą — kuchnia meksykańska, wegańskie, bez glutenu
- `OB-075` Gołąbki z kaszą i grzybami w sosie pomidorowym — zima, wegańskie
- `OB-076` Kotlety sojowe w sosie grzybowym z ziemniakami — wegańskie, wysokobiałkowe
- `OB-077` Curry z dynią i ciecierzycą — kuchnia indyjska, jesień, wegańskie, bez glutenu
- `OB-078` Bigos wegetariański z grzybami — zima, wegańskie, bez glutenu
- `OB-079` Risotto z grzybami i groszkiem bez sera — kuchnia włoska, wegańskie, bez glutenu
- `OB-080` Tofu pieczone z warzywami korzeniowymi i sosem tahini — wegańskie, wysokobiałkowe, bez glutenu

### Ryby

- `OB-081` Łosoś pieczony z pesto i ziemniakami — ryba, bez glutenu
- `OB-082` Dorsz w sosie curry z ryżem — kuchnia tajska, ryba, bez glutenu, bez mleka
- `OB-083` Pstrąg w migdałach z młodymi ziemniakami — lato, ryba, bez glutenu
- `OB-084` Makrela z grilla z sałatką z pomidorów i cebuli — grill, majówka, ryba, bez glutenu
- `OB-085` Mintaj zapiekany pod pierzynką z warzyw — ryba, bez glutenu
- `OB-086` Morszczuk w sosie pomidorowym z oliwkami i kaszą — kuchnia grecka, ryba, bez mleka
- `OB-087` Pulpety z dorsza w sosie koperkowym — ryba
- `OB-088` Zupa rybna z pomidorami po śródziemnomorsku — kuchnia grecka, ryba, lekkie, bez glutenu
- `OB-089` Fish and chips — airfryer, ryba
- `OB-090` Miska burrito z łososiem i fasolą — kuchnia meksykańska, ryba, bez glutenu
- `OB-091` Łosoś z warzywami z jednej blachy — ryba, lekkie, bez glutenu, bez mleka
- `OB-092` Spaghetti z sardynkami, pomidorami i kaparami — kuchnia włoska, ryba, bez mleka
- `OB-093` Kedgeree — ryż z wędzoną makrelą, jajkiem i groszkiem — ryba
- `OB-094` Łosoś z kaszą jaglaną, szpinakiem i sosem cytrynowym — ryba, bez glutenu
- `OB-095` Rybna tikka masala z mintajem i ryżem — kuchnia indyjska, ryba, bez glutenu

### Krewetki

- `OB-096` Makaron z krewetkami, czosnkiem i chili — kuchnia włoska, krewetki, do 30 min, bez mleka
- `OB-097` Makaron z krewetkami w sosie śmietanowo-cytrynowym — kuchnia włoska, krewetki, do 30 min
- `OB-098` Risotto z krewetkami i cukinią — kuchnia włoska, krewetki, bez glutenu
- `OB-099` Paella z krewetkami i kurczakiem — kuchnia hiszpańska, krewetki, bez glutenu, bez mleka
- `OB-100` Krewetki w curry z mlekiem kokosowym i ryżem — kuchnia tajska, krewetki, do 30 min, bez glutenu, bez mleka
- `OB-101` Pad thai z krewetkami — kuchnia tajska, krewetki, bez mleka
- `OB-102` Zupa kokosowa z krewetkami i makaronem ryżowym — kuchnia tajska, krewetki, lekkie, bez mleka
- `OB-103` Krewetki saganaki w sosie pomidorowym z fetą i orzo — kuchnia grecka, krewetki
- `OB-104` Krewetki tikka masala z ryżem basmati — kuchnia indyjska, krewetki, bez glutenu
- `OB-105` Tacos z krewetkami i salsą z mango — kuchnia meksykańska, krewetki
- `OB-106` Krewetki po cajuńsku z ryżem i kukurydzą — kuchnia amerykańska, krewetki, bez glutenu, bez mleka
- `OB-107` Ryż smażony z krewetkami i groszkiem — krewetki, do 30 min, bez mleka
- `OB-108` Krewetki z cukinią i pomidorkami z kaszą jaglaną — krewetki, lekkie, do 30 min, bez glutenu, bez mleka
- `OB-109` Krewetki w panierce kokosowej z ryżem i sosem chili — airfryer, krewetki, bez mleka

### Kuchnie świata

- `OB-110` Pasta alla Norma z bakłażanem i ricottą — kuchnia włoska, lato, wegetariańskie
- `OB-111` Kaszotto z pęczaku z dynią i szałwią — jesień, wegetariańskie
- `OB-112` Kurczak cacciatore z polentą — kuchnia włoska, wysokobiałkowe, bez glutenu, bez mleka
- `OB-113` Saltimbocca z indyka z szałwią i szynką — kuchnia włoska, wysokobiałkowe
- `OB-114` Ribollita — toskańska zupa z fasolą i jarmużem — kuchnia włoska, zima, wegańskie
- `OB-115` Makaron amatriciana z boczkiem — kuchnia włoska
- `OB-116` Musaka z bakłażanem i mięsem mielonym — kuchnia grecka
- `OB-117` Pastitsio — grecka zapiekanka makaronowa — kuchnia grecka
- `OB-118` Gemista — pomidory i papryki faszerowane ryżem — kuchnia grecka, lato, wegańskie, bez glutenu
- `OB-119` Butter chicken z ryżem basmati — kuchnia indyjska, wysokobiałkowe, bez glutenu
- `OB-120` Aloo gobi — ziemniaki z kalafiorem po indyjsku — kuchnia indyjska, wegańskie, bez glutenu
- `OB-121` Chana masala z ryżem — kuchnia indyjska, wegańskie, wysokobiałkowe, bez glutenu
- `OB-122` Kurczak z bazylią i chili po tajsku z ryżem i jajkiem — kuchnia tajska, wysokobiałkowe, bez mleka, do 30 min
- `OB-123` Zielone curry z kurczakiem — kuchnia tajska, bez glutenu, bez mleka
- `OB-124` Zupa kokosowa z kurczakiem i czerwoną pastą curry — kuchnia tajska, lekkie, bez glutenu, bez mleka
- `OB-125` Burrito z wołowiną i ryżem — kuchnia meksykańska
- `OB-126` Tinga de pollo w tortillach — kuchnia meksykańska, wysokobiałkowe
- `OB-127` Carnitas z wieprzowiny z tortillami — kuchnia meksykańska, na kilka dni
- `OB-128` Kurczak BBQ z pieczoną kukurydzą i ziemniakami — kuchnia amerykańska, wysokobiałkowe, bez glutenu
- `OB-129` Meatloaf — pieczeń z mielonego z puree — kuchnia amerykańska
- `OB-130` Paella warzywna z ciecierzycą — kuchnia hiszpańska, wegańskie, bez glutenu
- `OB-131` Lasagne ze szpinakiem i ricottą — kuchnia włoska, wegetariańskie
- `OB-132` Arroz con pollo — ryż z kurczakiem po hiszpańsku — kuchnia hiszpańska, wysokobiałkowe, bez glutenu, bez mleka
- `OB-133` Kurczak satay z sosem orzechowym i ryżem — kuchnia tajska, wysokobiałkowe, bez mleka
- `OB-134` Giouvetsi — wołowina z makaronem orzo w pomidorach — kuchnia grecka
- `OB-135` Pollo asado — pieczony kurczak po meksykańsku z salsą — kuchnia meksykańska, wysokobiałkowe, bez glutenu, bez mleka

### Sezonowe

- `OB-136` Zupa krem ze szparagów z groszkiem — wiosna, wegetariańskie, bez glutenu
- `OB-137` Kurczak ze szparagami i młodymi ziemniakami — wiosna, wysokobiałkowe, bez glutenu
- `OB-138` Risotto ze szparagami i groszkiem — wiosna, kuchnia włoska, wegetariańskie, bez glutenu
- `OB-139` Botwinka z młodymi ziemniakami — wiosna, lekkie, wegetariańskie, bez glutenu
- `OB-140` Młoda kapusta duszona z koperkiem i kiełbasą — wiosna, lato, bez glutenu
- `OB-141` Chłodnik ogórkowy z jogurtem i koperkiem — lato, lekkie, wegetariańskie, bez glutenu
- `OB-142` Makaron z bobem, boczkiem i śmietaną — lato
- `OB-143` Zupa truskawkowa z makaronem — lato, wegetariańskie
- `OB-144` Knedle ze śliwkami — lato, jesień, wegetariańskie
- `OB-145` Fasolka szparagowa z czosnkiem i kurczakiem — lato, wysokobiałkowe, bez glutenu
- `OB-146` Kurki w sosie śmietanowym z kopytkami — lato, wegetariańskie
- `OB-147` Zupa krem z dyni z imbirem — jesień, wegańskie, bez glutenu
- `OB-148` Pieczona dynia z kaszą, fetą i pestkami — jesień, wegetariańskie, bez glutenu
- `OB-149` Gulasz z grzybów leśnych z kaszą gryczaną — jesień, wegetariańskie
- `OB-150` Udka z kurczaka pieczone z jabłkami i śliwkami — jesień, bez glutenu, bez mleka
- `OB-151` Zupa z kurkami i ziemniakami — lato, jesień, wegetariańskie
- `OB-152` Kotlety z kaszy jaglanej z dynią — jesień, wegetariańskie
- `OB-153` Kwaśnica z żeberkami — zima, bez glutenu, bez mleka
- `OB-154` Pieczone warzywa korzeniowe z kaszą i jajkiem — zima, wegetariańskie, bez glutenu
- `OB-155` Zupa fasolowa z wędzonką — zima, bez mleka
- `OB-156` Zupa krem z pieczonych buraków z kozim serem — zima, wegetariańskie, bez glutenu
- `OB-157` Pęczak z kiszoną kapustą i grzybami — zima, wegańskie

### Airfryer

- `OB-158` Udka z kurczaka z ziemniakami — airfryer, wysokobiałkowe, bez glutenu, bez mleka
- `OB-159` Burgery wołowe z frytkami — airfryer, kuchnia amerykańska
- `OB-160` Kurczak w panierce z płatków kukurydzianych — airfryer, dla dzieci, wysokobiałkowe
- `OB-161` Żeberka BBQ z ziemniakami — airfryer
- `OB-162` Łosoś z batatami i fasolką — airfryer, ryba, bez glutenu, bez mleka
- `OB-163` Cordon bleu z sałatą — airfryer
- `OB-164` Chrupiące tofu z ryżem i warzywami — airfryer, wegańskie, wysokobiałkowe
- `OB-165` Skrzydełka BBQ z coleslawem — airfryer, kuchnia amerykańska
- `OB-166` Karkówka z ziemniakami i surówką — airfryer, bez glutenu
- `OB-167` Papryki faszerowane kaszą jaglaną i fetą — airfryer, bez glutenu
- `OB-168` Pierś z indyka z kaszą i brokułem — airfryer, wysokobiałkowe, lekkie
- `OB-169` Pałki z kurczaka w miodzie i musztardzie z ryżem — airfryer, wysokobiałkowe, bez mleka
- `OB-170` Polędwiczka wieprzowa z batatami — airfryer, wysokobiałkowe, bez glutenu, bez mleka
- `OB-171` Kurczak tandoori z ryżem — airfryer, kuchnia indyjska, wysokobiałkowe, bez glutenu
- `OB-172` Gnocchi z warzywami i pesto — airfryer, kuchnia włoska, wegetariańskie
- `OB-173` Kotlety z łososia z kaszą i ogórkiem — airfryer, ryba
- `OB-174` Ziemniaki hasselback z twarożkiem i boczkiem — airfryer, bez glutenu
- `OB-175` Klopsiki z indyka z kaszą i sosem jogurtowym — airfryer, wysokobiałkowe, lekkie

### Keto i low-carb

- `OB-176` Udka z kurczaka w sosie musztardowym z fasolką — keto, bez glutenu
- `OB-177` Zapiekanka z kalafiora z mięsem mielonym i serem — keto, bez glutenu
- `OB-178` Karkówka z grilla z sałatką z ogórka — keto, grill, majówka, bez glutenu
- `OB-179` Łosoś z sosem koperkowym i szparagami — keto, wiosna, ryba, bez glutenu
- `OB-180` Makaron z cukinii z pesto i kurczakiem — keto, wysokobiałkowe, bez glutenu
- `OB-181` Pieczeń wieprzowa z kapustą kiszoną — keto, zima, bez glutenu, bez mleka
- `OB-182` Sałatka cobb z kurczakiem, jajkiem, boczkiem i awokado — keto, kuchnia amerykańska, wysokobiałkowe, bez glutenu
- `OB-183` Pulpety wołowe w sosie pomidorowym z cukinią — keto, bez glutenu
- `OB-184` Stek z masłem ziołowym i pieczarkami — keto, bez glutenu
- `OB-185` Tofu z warzywami w sosie orzechowym — keto, wegańskie

### Święta i okazje

- `OB-186` Kaczka pieczona z jabłkami i żurawiną — Boże Narodzenie, bez glutenu, bez mleka
- `OB-187` Rolada wołowa z ogórkiem kiszonym i kluskami śląskimi — Boże Narodzenie
- `OB-188` Indyk pieczony z nadzieniem z żurawiną — Boże Narodzenie
- `OB-189` Barszcz biały z jajkiem i kiełbasą — Wielkanoc
- `OB-190` Szaszłyki z kurczaka i warzyw z grilla — grill, majówka, wysokobiałkowe, bez glutenu

### Grill i majówka

- `OB-191` Żeberka z grilla w sosie BBQ z kukurydzą — grill, majówka, kuchnia amerykańska, bez glutenu, bez mleka
- `OB-192` Pierś z kurczaka z grilla z cukinią i sosem jogurtowym — grill, majówka, lekkie, wysokobiałkowe, bez glutenu
- `OB-193` Udka z kurczaka z grilla w marynacie paprykowej — grill, majówka, wysokobiałkowe, bez glutenu, bez mleka
- `OB-194` Pstrąg z grilla z masłem czosnkowym — grill, majówka, ryba, bez glutenu
- `OB-195` Kaszanka z grilla z cebulą i chlebem — grill, majówka, bez mleka

## Kolacje (`KO`)


### Szybkie i lekkie

- `KO-001` Sałatka z kurczakiem, grejpfrutem i awokado — zima, lekkie, wysokobiałkowe, bez glutenu, do 30 min
- `KO-002` Tosty z hummusem, jajkiem i rukolą — do 30 min, wegetariańskie
- `KO-003` Zupa krem z pomidorów z bazylią — lekkie, wegańskie, bez glutenu
- `KO-004` Sałatka z pieczonym łososiem, ogórkiem i koperkiem — ryba, lekkie, bez glutenu
- `KO-005` Wrap z indykiem, fasolą i salsą na ciepło — kuchnia meksykańska, do 30 min, wysokobiałkowe
- `KO-006` Zupa krem z cukinii z serkiem — lato, lekkie, wegetariańskie, bez glutenu
- `KO-007` Sałatka caprese z pełnoziarnistą grzanką — kuchnia włoska, lato, wegetariańskie, do 30 min
- `KO-008` Kasza jaglana z warzywami z patelni i jajkiem — do 30 min, wegetariańskie, bez glutenu
- `KO-009` Kotlety z komosy ryżowej i warzyw — wegańskie, bez glutenu, lekkie
- `KO-010` Kurczak z warzywami z patelni z sosem jogurtowym — do 30 min, wysokobiałkowe, lekkie, bez glutenu
- `KO-011` Placki dyniowe na słono z jogurtem — jesień, wegetariańskie
- `KO-012` Zupa krem z selera z gruszką — zima, wegańskie, bez glutenu, lekkie
- `KO-013` Zapiekane tortille z fasolą i serem — kuchnia meksykańska, wegetariańskie, do 30 min

### Lekkie bez mleka

- `KO-014` Zupa krem z marchewki z imbirem — lekkie, wegańskie, bez glutenu, bez mleka
- `KO-015` Pieczony kurczak z salsą z mango i ryżem — kuchnia meksykańska, wysokobiałkowe, bez mleka, bez glutenu
- `KO-016` Kurczak z warzywami na parze z sosem sojowym — lekkie, wysokobiałkowe, bez mleka
- `KO-017` Fasola z tuńczykiem po toskańsku — kuchnia włoska, ryba, lekkie, bez glutenu, bez mleka, do 30 min
- `KO-018` Kurczak z fasolką szparagową i sezamem — lekkie, wysokobiałkowe, bez glutenu, bez mleka
- `KO-019` Zupa z pieczonych pomidorów i papryki — lato, lekkie, wegańskie, bez glutenu, bez mleka
- `KO-020` Makaron ryżowy z warzywami i jajkiem — wegetariańskie, bez glutenu, bez mleka, do 30 min
- `KO-021` Ryba po hiszpańsku z papryką i pomidorami — kuchnia hiszpańska, ryba, lekkie, bez glutenu, bez mleka
- `KO-022` Cukinia faszerowana kaszą jaglaną i warzywami — wegańskie, lekkie, bez glutenu, bez mleka
- `KO-023` Placki z mąki z ciecierzycy z warzywami — wegańskie, bez glutenu, bez mleka
- `KO-024` Jajka w koszulce na szpinaku z pomidorami — wegetariańskie, lekkie, bez glutenu, bez mleka
- `KO-025` Kurczak pieczony z pomidorkami i oliwkami — kuchnia grecka, lekkie, wysokobiałkowe, bez glutenu, bez mleka

### Wegańskie i wegetariańskie

- `KO-026` Tofu z warzywami z patelni w sosie sojowym — wegańskie, wysokobiałkowe, do 30 min
- `KO-027` Kotlety z soczewicy z sosem pomidorowym — wegańskie, wysokobiałkowe
- `KO-028` Placki z kalafiora z sosem czosnkowym — wegetariańskie
- `KO-029` Cukinia zapiekana z serem i pomidorami — lato, wegetariańskie, lekkie, bez glutenu
- `KO-030` Makaron ryżowy z tofu, marchewką i sosem limonkowym — kuchnia tajska, wegańskie
- `KO-031` Tarta z porem i kozim serem — wegetariańskie
- `KO-032` Miska z hummusem i pieczonymi warzywami — wegańskie, bez glutenu
- `KO-033` Zapiekanka z ziemniakami, brokułem i serem — wegetariańskie, bez glutenu
- `KO-034` Kasza z fasolą i warzywami po meksykańsku z jednej patelni — kuchnia meksykańska, wegańskie, bez glutenu

### Ryby

- `KO-035` Pasta z pieczonego łososia z twarożkiem na chlebie — ryba, do 30 min
- `KO-036` Sałatka z wędzoną makrelą, ziemniakami i jajkiem — ryba, bez glutenu
- `KO-037` Tatar z wędzonego łososia z awokado — ryba, keto, bez glutenu, do 30 min
- `KO-038` Kanapki ze szprotkami, jajkiem i szczypiorkiem — ryba, do 30 min
- `KO-039` Wędzony pstrąg z sałatką z buraka i chrzanem — zima, ryba, bez glutenu
- `KO-040` Sardynki na grzankach z pomidorem — kuchnia hiszpańska, ryba, do 30 min

### Krewetki

- `KO-041` Krewetki w maśle czosnkowym z bagietką — kuchnia hiszpańska, krewetki, do 30 min
- `KO-042` Sałatka z krewetkami, awokado i mango — krewetki, lekkie, bez glutenu, bez mleka
- `KO-043` Wrap z krewetkami, sałatą i sosem jogurtowym — krewetki, do 30 min
- `KO-044` Makaron ryżowy z krewetkami i warzywami z patelni — krewetki, do 30 min, bez glutenu, bez mleka
- `KO-045` Omlet z krewetkami i szczypiorkiem — krewetki, keto, bez glutenu, bez mleka, do 30 min
- `KO-046` Krewetki z brokułem i czosnkiem — krewetki, keto, lekkie, bez glutenu, bez mleka, do 30 min
- `KO-047` Szaszłyki z krewetek z grilla z sosem czosnkowym — grill, majówka, krewetki, bez glutenu

### Kuchnie świata

- `KO-048` Pizza na cienkim cieście z pieczarkami i szynką — kuchnia włoska
- `KO-049` Panzanella — sałatka z pomidorów i chleba — kuchnia włoska, lato, wegańskie
- `KO-050` Tarta z boczkiem i cebulą — do pudełka
- `KO-051` Zupa z zielonej soczewicy z marchewką i tymiankiem — zima, wegańskie, bez glutenu
- `KO-052` Patatas bravas z jajkiem sadzonym — kuchnia hiszpańska, wegetariańskie, bez glutenu
- `KO-053` Salmorejo z jajkiem i szynką — kuchnia hiszpańska, lato, bez mleka
- `KO-054` Halloumi z grilla z sałatką z arbuza — kuchnia grecka, lato, grill, wegetariańskie
- `KO-055` Pakory warzywne z raitą — kuchnia indyjska, wegetariańskie, bez glutenu
- `KO-056` Tostadas z fasolą, awokado i fetą — kuchnia meksykańska, wegetariańskie
- `KO-057` Kanapka z kurczakiem BBQ i coleslawem — kuchnia amerykańska
- `KO-058` Kurczak z ananasem i orzeszkami po tajsku z ryżem — kuchnia tajska, bez mleka, bez glutenu
- `KO-059` Chana chaat — sałatka z ciecierzycy po indyjsku — kuchnia indyjska, wegańskie, lekkie
- `KO-060` Piadina z szynką, rukolą i mozzarellą — kuchnia włoska, do 30 min

### Sezonowe

- `KO-061` Szparagi z jajkiem w koszulce i sosem holenderskim — wiosna, wegetariańskie, bez glutenu
- `KO-062` Zupa krem z młodego groszku z miętą — wiosna, wegańskie, bez glutenu
- `KO-063` Szparagi zapiekane z szynką i serem — wiosna, keto, bez glutenu
- `KO-064` Bób z masłem i koperkiem — lato, wegetariańskie, bez glutenu, do 30 min
- `KO-065` Młode ziemniaki pieczone z czosnkiem i sosem ziołowym — lato, wegetariańskie, bez glutenu
- `KO-066` Kalafior z bułką tartą i masłem — lato, wegetariańskie
- `KO-067` Omlet z młodymi warzywami i koperkiem — lato, wegetariańskie, bez glutenu, bez mleka, do 30 min
- `KO-068` Placki ziemniaczane z sosem grzybowym — jesień, wegetariańskie
- `KO-069` Sałatka z jarmużem, jabłkiem i orzechami — jesień, wegańskie, bez glutenu
- `KO-070` Sałatka z pieczonych buraków, pomarańczy i fety — zima, wegetariańskie, bez glutenu
- `KO-071` Zupa krem z pietruszki z grzankami — zima, wegetariańskie
- `KO-072` Pieczone ziemniaki z twarożkiem i kiszonym ogórkiem — zima, wegetariańskie, bez glutenu

### Airfryer

- `KO-073` Tosty z kurczakiem i serem — airfryer, do 30 min, wysokobiałkowe
- `KO-074` Kotleciki z cukinii z dipem jogurtowym — airfryer, lato, wegetariańskie
- `KO-075` Pierożki z ciasta francuskiego z mięsem — airfryer
- `KO-076` Kotlety z kaszy gryczanej — airfryer, wegetariańskie
- `KO-077` Kalafior w panierce z ostrym sosem — airfryer, wegetariańskie
- `KO-078` Szaszłyki z halloumi i warzyw — airfryer, wegetariańskie, bez glutenu
- `KO-079` Brokuł i kalafior z sosem sezamowym — airfryer, wegańskie, lekkie
- `KO-080` Pieczarki faszerowane serem i szczypiorkiem — airfryer, wegetariańskie, keto, bez glutenu
- `KO-081` Pierogi pieczone z sosem czosnkowym — airfryer
- `KO-082` Tacos z kurczakiem i kapustą — airfryer, kuchnia meksykańska, wysokobiałkowe
- `KO-083` Pizza na tortilli z warzywami — airfryer, kuchnia włoska, wegetariańskie, do 30 min, dla dzieci
- `KO-084` Bataty z serkiem i szczypiorkiem — airfryer, wegetariańskie, bez glutenu, lekkie
- `KO-085` Pierś z indyka w ziołach z sałatką — airfryer, lekkie, wysokobiałkowe, bez glutenu

### Grill i majówka

- `KO-086` Kiełbasa z grilla z sałatką ziemniaczaną — grill, majówka
- `KO-087` Biała kiełbasa z grilla z chrzanem — grill, majówka, bez glutenu, bez mleka
- `KO-088` Grillowana cukinia i bakłażan z sosem czosnkowym — grill, majówka, lato, wegańskie, bez glutenu
- `KO-089` Oscypek z grilla z żurawiną — grill, majówka, wegetariańskie
- `KO-090` Ziemniaki z grilla w folii z twarożkiem — grill, majówka, wegetariańskie, bez glutenu
- `KO-091` Burgery z indyka z grilla — grill, majówka, wysokobiałkowe
- `KO-092` Kukurydza z grilla z masłem ziołowym — grill, majówka, lato, wegetariańskie, bez glutenu
- `KO-093` Łosoś z grilla z cytryną i ziołami — grill, majówka, ryba, bez glutenu, bez mleka
- `KO-094` Pieczarki z grilla faszerowane serem i czosnkiem — grill, majówka, wegetariańskie, keto, bez glutenu
- `KO-095` Camembert z grilla z żurawiną i bagietką — grill, majówka, impreza, wegetariańskie
- `KO-096` Szaszłyki z tofu i warzyw z grilla — grill, majówka, wegańskie, wysokobiałkowe
- `KO-097` Papryka z grilla faszerowana fetą — grill, majówka, lato, wegetariańskie, bez glutenu
- `KO-098` Sałatka z grillowanych warzyw i bulguru — grill, majówka, kuchnia grecka, wegańskie
- `KO-099` Kurczak z grilla w ziołach z bagietką czosnkową — grill, majówka, wysokobiałkowe
- `KO-100` Bakłażan z grilla z mozzarellą i pomidorami — grill, majówka, kuchnia włoska, wegetariańskie, bez glutenu
- `KO-101` Szaszłyki z kiełbasy, cebuli i papryki — grill, majówka, dla dzieci

### Wigilia

- `KO-102` Barszcz czerwony z uszkami z grzybami — Wigilia, wegetariańskie
- `KO-103` Zupa grzybowa wigilijna — Wigilia, wegańskie
- `KO-104` Dorsz w sosie chrzanowym — Wigilia, ryba, bez glutenu
- `KO-105` Karp smażony — Wigilia, ryba, bez mleka
- `KO-106` Karp pieczony z ziołami — Wigilia, ryba, bez glutenu
- `KO-107` Śledzie w oleju z cebulą — Wigilia, ryba
- `KO-108` Śledzie w śmietanie z jabłkiem — Wigilia, ryba
- `KO-109` Kapusta z grzybami — Wigilia, wegańskie, bez glutenu
- `KO-110` Łazanki z kapustą i grzybami — Wigilia, wegetariańskie
- `KO-111` Paszteciki z grzybami do barszczu — Wigilia, wegetariańskie
- `KO-112` Kulebiak z kapustą i grzybami — Wigilia, wegetariańskie

### Impreza

- `KO-113` Tacos z mieloną wołowiną i serem — kuchnia meksykańska, impreza
- `KO-114` Sałatka meksykańska warstwowa z fasolą i kukurydzą — kuchnia meksykańska, impreza
- `KO-115` Sałatka z tortellini, szynką i kukurydzą — impreza
- `KO-116` Mini burgery z wołowiną — kuchnia amerykańska, impreza

## Desery i podwieczorki (`DE`)


### Boże Narodzenie

- `DE-001` Makowiec zawijany — Boże Narodzenie, Wigilia
- `DE-002` Piernik staropolski dojrzewający — Boże Narodzenie
- `DE-003` Pierniczki lukrowane — Boże Narodzenie, dla dzieci
- `DE-004` Sernik krakowski z kratką — Boże Narodzenie
- `DE-005` Kutia z makiem, miodem i bakaliami — Wigilia, wegetariańskie
- `DE-006` Kluski z makiem — Wigilia
- `DE-007` Keks z bakaliami — Boże Narodzenie
- `DE-008` Drożdżowe ślimaczki z makiem — zima, Boże Narodzenie

### Wielkanoc

- `DE-009` Mazurek kajmakowy — Wielkanoc
- `DE-010` Babka drożdżowa wielkanocna — Wielkanoc
- `DE-011` Babka cytrynowa ucierana — Wielkanoc
- `DE-012` Pascha z twarogu i bakalii — Wielkanoc, bez glutenu
- `DE-013` Mazurek pomarańczowy z bakaliami — Wielkanoc

### Sezonowe

- `DE-014` Ciasto biszkoptowe z rabarbarem i bezą — wiosna
- `DE-015` Mus z rabarbaru z jogurtem — wiosna, lekkie, bez glutenu
- `DE-016` Drożdżówka z jagodami — lato
- `DE-017` Tarta z truskawkami i kremem — lato
- `DE-018` Lody jogurtowe z truskawkami — lato, lekkie, bez glutenu
- `DE-019` Tarta ze śliwkami i migdałami — jesień
- `DE-020` Pieczone gruszki z cynamonem i jogurtem — jesień, lekkie, bez glutenu
- `DE-021` Ciasto dyniowe z cynamonem — jesień
- `DE-022` Muffinki dyniowe — jesień
- `DE-023` Ciasto pomarańczowe na oliwie — zima
- `DE-024` Ciasto korzenne z jabłkami — zima

### Fit i wegańskie

- `DE-025` Brownie z fasoli — wegańskie, bez glutenu
- `DE-026` Sernik z kaszy jaglanej — wegańskie, bez glutenu
- `DE-027` Ciasteczka owsiane z bananem bez cukru — wegańskie, dla dzieci
- `DE-028` Mus czekoladowy z aquafaby — wegańskie, bez glutenu
- `DE-029` Batoniki proteinowe bez pieczenia — wysokobiałkowe, wegetariańskie
- `DE-030` Sernik proteinowy ze skyru na zimno — wysokobiałkowe, bez glutenu
- `DE-031` Galaretka z owocami i jogurtem — lekkie, bez glutenu
- `DE-032` Tiramisu fit ze skyrem — wysokobiałkowe
- `DE-033` Budyń kokosowy z ananasem — wegańskie, bez glutenu
- `DE-034` Muffinki bananowe bez cukru — wegetariańskie, dla dzieci
- `DE-035` Budyń jaglany z malinami — wegańskie, bez glutenu

### Kuchnie świata

- `DE-036` Flan — karmelowy krem jajeczny — kuchnia hiszpańska, bez glutenu
- `DE-037` Ryż na mleku z musem truskawkowym — lato, wegetariańskie, bez glutenu
- `DE-038` Churros z sosem czekoladowym — kuchnia hiszpańska, airfryer
- `DE-039` Crostata z dżemem morelowym — kuchnia włoska
- `DE-040` Kheer — indyjski pudding ryżowy z kardamonem — kuchnia indyjska, bez glutenu
- `DE-041` Ryż kokosowy z mango — kuchnia tajska, wegańskie, bez glutenu
- `DE-042` Cookies z czekoladą — kuchnia amerykańska, dla dzieci

### Grill i impreza

- `DE-043` Banany z grilla z czekoladą — grill, majówka, wegetariańskie, dla dzieci
- `DE-044` Brzoskwinie z grilla z jogurtem i miodem — grill, majówka, lato, lekkie, bez glutenu
- `DE-045` Babeczki z kremem na imprezę — kuchnia amerykańska, impreza, dla dzieci
- `DE-046` Sernik na zimno z galaretką — impreza, wegetariańskie
- `DE-047` Brownie z orzechami włoskimi — airfryer, wegetariańskie

## Przekąski (`PR`)


### Impreza i Sylwester

- `PR-001` Taquitos z kurczakiem — kuchnia meksykańska, airfryer, impreza
- `PR-002` Tortilla chipsy z guacamole — airfryer, kuchnia meksykańska, impreza, wegańskie, bez glutenu
- `PR-003` Tartaletki z kozim serem i żurawiną — impreza, Boże Narodzenie, wegetariańskie
- `PR-004` Paluchy drożdżowe z sezamem — impreza, wegańskie
- `PR-005` Kulki mozzarelli w panierce — airfryer, impreza, wegetariańskie
- `PR-006` Deska serów z owocami i orzechami — impreza, wegetariańskie, bez glutenu, do 30 min
- `PR-007` Samosy z ziemniakami i groszkiem — airfryer, kuchnia indyjska, impreza, wegańskie
- `PR-008` Popcorn domowy z masłem — impreza, wegetariańskie, bez glutenu, dla dzieci, do 30 min
- `PR-009` Pieczone ziemniaczki z dipem czosnkowym — impreza, wegetariańskie, bez glutenu
- `PR-010` Śliwki zawijane w boczku — Boże Narodzenie, impreza, keto, bez glutenu
- `PR-011` Bagietka z masłem czosnkowym z grilla — grill, majówka, impreza, wegetariańskie
- `PR-012` Szaszłyki owocowe z czekoladą — impreza, wegańskie, bez glutenu, dla dzieci
- `PR-013` Kąski kurczaka w sezamie z sosem słodko-ostrym — impreza, wysokobiałkowe
- `PR-014` Dip serowy z jalapeño do nachos — kuchnia meksykańska, impreza, wegetariańskie, bez glutenu
- `PR-015` Salsa pomidorowa z kukurydzą i chipsami — kuchnia meksykańska, impreza, wegańskie, bez glutenu
- `PR-016` Precle drożdżowe z solą i sosem serowym — impreza, wegetariańskie
- `PR-017` Krewetki w cieście z sosem słodko-chili — airfryer, impreza, krewetki, bez mleka
- `PR-018` Koktajl krewetkowy z sosem koktajlowym — kuchnia amerykańska, impreza, Boże Narodzenie, krewetki, keto, bez glutenu
- `PR-019` Krewetki marynowane z czosnkiem i ziołami — kuchnia grecka, impreza, krewetki, keto, bez glutenu, bez mleka

### Chrupiące i fit

- `PR-020` Chrupiące kostki tofu z sosem chili — airfryer, wegańskie, wysokobiałkowe
- `PR-021` Dip z białej fasoli z rozmarynem i warzywami — kuchnia włoska, wegańskie, bez glutenu
- `PR-022` Domowy mix orzechów i suszonych owoców — wegańskie, bez glutenu, do pudełka
- `PR-023` Oliwki marynowane z czosnkiem i ziołami — kuchnia grecka, impreza, wegańskie, keto, bez glutenu
- `PR-024` Prażone migdały z wędzoną papryką — wegańskie, keto, bez glutenu
- `PR-025` Chipsy z marchewki i pietruszki — airfryer, zima, wegańskie, bez glutenu
- `PR-026` Frytki z selera z dipem — airfryer, zima, wegetariańskie, bez glutenu
- `PR-027` Frytki z cukinii z parmezanem — airfryer, lato, wegetariańskie
- `PR-028` Warzywa z dipem jogurtowo-ziołowym — lekkie, wegetariańskie, bez glutenu, do 30 min
- `PR-029` Orzechy prażone z rozmarynem i miodem — wegetariańskie, keto, bez glutenu
- `PR-030` Krakersy z nasion bez mąki — wegańskie, keto, bez glutenu
- `PR-031` Pomidorki koktajlowe nadziewane twarożkiem — keto, wegetariańskie, bez glutenu, impreza
- `PR-032` Jabłka z masłem orzechowym i cynamonem — wegańskie, bez glutenu, do 30 min, dla dzieci
- `PR-033` Młoda marchewka z hummusem — wiosna, wegańskie, bez glutenu, do 30 min
- `PR-034` Pestki dyni prażone z sosem sojowym — jesień, wegańskie

### Airfryer

- `PR-035` Nuggetsy z kalafiora — airfryer, wegetariańskie
- `PR-036` Krążki cebulowe — airfryer, impreza, wegetariańskie
- `PR-037` Pieczarki w panierce z sosem czosnkowym — airfryer, impreza, wegetariańskie
- `PR-038` Frytki z przyprawą paprykową — airfryer, wegańskie, bez glutenu, dla dzieci
- `PR-039` Kulki ziemniaczane z serem — airfryer, impreza, wegetariańskie
- `PR-040` Kiełbaski koktajlowe w sosie słodko-ostrym — airfryer, impreza, bez mleka

## Napoje (`NA`)


### Smoothie i koktajle

- `NA-001` Koktajl proteinowy z kefirem, truskawkami i owsem — blender, wysokobiałkowe
- `NA-002` Zielone smoothie z jarmużem, gruszką i imbirem — blender, wegańskie
- `NA-003` Smoothie z mango, marchewką i jogurtem — blender, wegetariańskie
- `NA-004` Koktajl czekoladowy z bananem i masłem orzechowym na napoju sojowym — blender, wegańskie, wysokobiałkowe
- `NA-005` Smoothie jagodowe z jogurtem sojowym i owsem — blender, wegańskie
- `NA-006` Koktajl owsiany z jabłkiem i cynamonem — blender, jesień, wegańskie
- `NA-007` Smoothie z burakiem, malinami i bananem — blender, zima, wegańskie
- `NA-008` Koktajl z twarogiem i wiśniami — blender, wysokobiałkowe
- `NA-009` Smoothie tropikalne z ananasem i kokosem — blender, wegańskie
- `NA-010` Frappe proteinowe ze skyrem i kawą — blender, wysokobiałkowe
- `NA-011` Koktajl dyniowy z cynamonem — blender, jesień, wegetariańskie
- `NA-012` Smoothie truskawkowo-rabarbarowe — blender, wiosna, wegetariańskie
- `NA-013` Koktajl malinowy z maślanką — blender, lato, lekkie
- `NA-014` Lassi z mango — kuchnia indyjska, blender, wegetariańskie
- `NA-015` Smoothie ze szpinakiem, awokado i kiwi — blender, wegańskie
- `NA-016` Koktajl śniadaniowy z owsem, jogurtem i borówkami — blender, wegetariańskie, lekkie
- `NA-017` Koktajl z kefiru, banana i siemienia lnianego — blender, wegetariańskie, lekkie
- `NA-018` Koktajl morelowy ze skyrem — blender, lato, wysokobiałkowe, wegetariańskie
- `NA-019` Koktajl malinowo-bananowy na napoju owsianym — blender, wegańskie, dla dzieci

### Soki i napoje zimne

- `NA-020` Sok z buraka, marchewki i jabłka — sokowirówka, zima, wegańskie, dodatek do posiłku
- `NA-021` Sok z marchwi, pomarańczy i imbiru — sokowirówka, wegańskie, dodatek do posiłku
- `NA-022` Zielony sok z selerem naciowym, ogórkiem i jabłkiem — sokowirówka, wegańskie, dodatek do posiłku
- `NA-023` Kompot z suszu — Wigilia, wegańskie, dodatek do posiłku
- `NA-024` Lemoniada arbuzowa z miętą — impreza, lato, wegańskie, dodatek do posiłku

### Ciepłe

- `NA-025` Kakao z cynamonem — zima, dla dzieci, wegetariańskie
- `NA-026` Złote mleko z kurkumą — kuchnia indyjska, zima, wegańskie
- `NA-027` Czekolada na gorąco — zima, wegetariańskie
- `NA-028` Chai latte — kuchnia indyjska, zima, wegetariańskie
- `NA-029` Bezalkoholowy grzaniec z soku jabłkowego — Boże Narodzenie, zima, wegańskie, dodatek do posiłku
