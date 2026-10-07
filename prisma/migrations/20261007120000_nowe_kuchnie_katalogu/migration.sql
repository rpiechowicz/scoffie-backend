-- Nowe kuchnie katalogu (7.10.2026): FRENCH, MIDDLE_EASTERN, ASIAN.
--
-- Połowa katalogu (530 z 1072) stała w `OTHER`, a „Inne” nie miało kafelka,
-- więc filtr „wszystkie kuchnie” chował te przepisy. 99 przepisów
-- jednoznacznie kojarzonych z kuchnią dostaje ją (także istniejące: polska,
-- włoska, amerykańska…); reszta zostaje `OTHER` = kafelek „Inne”.
--
-- Baza = źródło prawdy katalogu, plik `prisma/catalog/recipes-catalog-full-v2.json`
-- = eksport z tymi samymi wartościami (na pustej bazie migracja nic nie zmienia,
-- bootstrap wczytuje kuchnię z pliku). Warunek `cuisine = 'OTHER'` nie nadpisuje
-- kuchni zmienionej w panelu. Każdy UPDATE przesuwa rewizję katalogu
-- (wyzwalacz `CatalogChange`) — telefony dostaną zmianę deltą.
-- `updatedAt` rośnie jak przy zapisie z panelu: formularz panelu otwarty przed
-- migracją dostanie 409 zamiast po cichu wrócić do `OTHER`.
-- Po migracji: OTHER 431, POLISH 322, ITALIAN 81, MEXICAN 48, AMERICAN 47, ASIAN 31, GREEK 30, INDIAN 27, THAI 16, SPANISH 15, MIDDLE_EASTERN 13, FRENCH 11.

-- ASIAN
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '7cdb10af-b39f-4bcb-b714-80588455fffe'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Indyk po chińsku z warzywami i ryżem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '85725c62-604e-44ba-aae7-6448b8c1de3c'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kurczak kung pao z ryżem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'a79981a7-7205-4ad6-9e4d-a3b0cf2f7cb6'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kurczak słodko-kwaśny z ananasem i ryżem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '8c6f5576-9551-413f-9f4b-e60dafa5ad79'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kurczak teriyaki z makaronem i warzywami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '8d02f142-ffa0-499a-b0bf-955d3f6bdae2'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kurczak z brokułem w sosie sojowo-czosnkowym z ryżem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '6b63c55f-dfaf-442b-be35-04423ba2d1b2'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Łosoś w miodzie i sosie sojowym z ryżem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '92d695b0-a49d-4055-a722-195a7811556c'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron ryżowy z kurczakiem i orzeszkami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'cb64462d-31ad-4175-9370-6b876bdd21f4'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron ryżowy z wołowiną i warzywami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '81ccd206-2a3b-4549-a190-3a76771acd5f'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron udon z wołowiną i warzywami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'c006d938-c4d2-4775-bdf1-93665fecbdc8'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ryż smażony z krewetkami i groszkiem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '3b7b5787-1226-4852-98ae-1bc963e90083'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Wołowina z brokułem po chińsku z ryżem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '9069fb8f-cd5f-408d-b444-e5e10cc3af2a'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Miska z ryżem, krewetkami, ogórkiem i sosem sezamowym
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '23998a08-38bb-48e2-beb2-ffb82f890786'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ryż z tofu, marchewką i sosem sezamowym
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '7b7e23e4-ea6f-45ec-8883-4391176ec282'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tofu pieczone z sosem sojowym i sezamem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '0f55eb5d-9e9a-4b43-943f-a9a93d302789'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Dorsz w sezamowej panierce z ryżem i ogórkiem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '7f006b33-12ae-4b8c-94b2-27d8eb6aa7fb'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Chrupiące tofu z ryżem i warzywami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '4a8a3b52-fe27-4801-9a6c-eb442023eacb'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kurczak z fasolką szparagową i sezamem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '6b97847c-57c6-4753-b772-83f763f94c1f'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kurczak z warzywami na parze z sosem sojowym
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '443f8e16-08a0-4088-b04a-df6a7df40068'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron ryżowy z krewetkami i warzywami z patelni
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '9d056db8-3320-49e8-85bb-7a2ebb623adb'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron ryżowy z warzywami i jajkiem
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'fbfe4605-43a0-488d-9259-3ac3a1a72186'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron sojowy z kurczakiem i warzywami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '01b9aad4-630e-4220-9637-89e0cb6b10cc'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pieczone sajgonki z kurczakiem i warzywami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '6a577570-6d4c-408f-9f58-4a69deabe6a1'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ryż smażony z jajkiem i warzywami
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '9a2f9bcb-599b-45a0-8adb-a2db1213dc13'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ryż z mielonym indykiem i fasolką po azjatycku
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '2e500ad6-49fc-4d15-bc65-096f072f0c40'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Stir-fry z tofu, brokułem i papryką z ryżem jaśminowym
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '71a9ecea-681a-4b62-accf-e8c469e1ca85'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tofu z warzywami z patelni w sosie sojowym
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '872de2cf-bb8d-4f6e-b502-71fccb62a5c9'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tofu z warzywami w sosie orzechowym
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '594f5ff4-2ee4-460e-ae8b-273b509389db'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Edamame z czosnkiem i chili
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '0e561f9d-16ec-4d7c-b487-dc9bd137752f'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kąski kurczaka w sezamie z sosem słodko-ostrym
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '02d3c137-2eab-43f1-bb94-60c4414fcd99'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Chrupiące kostki tofu z sosem chili
UPDATE "Recipe" SET "cuisine" = 'ASIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '495cd0ea-37f7-4399-83f9-448966882449'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Krewetki w panierce kokosowej z ryżem i sosem chili

-- MIDDLE_EASTERN
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '9c3e3970-87ad-4d97-b267-9201eb4df077'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Jajka po turecku z jogurtem czosnkowym
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '24a81d51-40e7-403b-92f4-cdc0f5a8426e'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Szakszuka z papryką i cebulą
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '9b5bf0af-b51b-4f79-8b52-83c24adc6d0a'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Zielona szakszuka ze szpinakiem i cukinią
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'e2668b2a-0c01-431c-8f96-2130b1b6f366'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Hummus z pieczonej dyni z warzywami
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '671cd8e4-acdc-4842-b34f-02ec33be5f8f'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Hummus z warzywami do maczania
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'c975e5a9-e881-4d4b-96b0-a739379c4494'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Młoda marchewka z hummusem
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '416cad61-031d-43c8-bd2e-6576e5558952'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Miska z hummusem i pieczonymi warzywami
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'bfb6feb7-edb8-4776-9b4b-6dba810a2908'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pita z pastą z ciecierzycy i warzywami
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '412d73ff-c9b1-450c-9ff0-950845dae87a'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Falafel pieczony z sosem jogurtowym i pitą
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'f7a0851f-9915-47b7-9a75-0d12fee82ad7'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tabbouleh z kaszą bulgur, ogórkiem i miętą
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'ce32d12f-3207-4de5-91c4-0992f6fbee39'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Lahmacun, turecka pizza z mięsem
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '29b191de-de8f-45b8-bb33-6eeb6a04c0a7'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pasta z pieczonego bakłażana z pitą
UPDATE "Recipe" SET "cuisine" = 'MIDDLE_EASTERN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '67b535d3-866b-4e7d-8a84-7d8bfb17b2df'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kuskus z warzywami i ciecierzycą

-- FRENCH
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '73b9e066-e6e1-464b-bd9d-83bc42198dbe'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ratatouille z bagietką
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '3a34b703-3b76-435b-acc8-29d36ebc8665'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Zupa cebulowa z grzankami serowymi
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '1580ef36-ddae-4260-ba15-9dc862780a22'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ziemniaki zapiekane w śmietanie (gratin)
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '39c6d8e9-72fc-4aec-a807-804c71e591af'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Sałatka nicejska z jajkiem i fasolką
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '2fc3e422-e623-4ca1-8af7-8879efb082d3'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tarta z boczkiem i cebulą
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '4f2ad3c6-a3c6-4ef9-ac76-25bf3893f6a7'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tarta z porem i kozim serem
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '8b3639c5-a768-4b91-875b-1414d44855f8'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kurczak po prowansalsku z ziemniakami
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'fb492934-52e1-488c-a222-057a8faab89e'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Szparagi z jajkiem w koszulce i sosem holenderskim
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '734a0932-01b8-4f5d-9789-d1c886796068'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tosty francuskie z owocami
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'a4511cfd-a796-476a-81e3-bf8035503b2d'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tarta z truskawkami i kremem
UPDATE "Recipe" SET "cuisine" = 'FRENCH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'e8c66e0c-70fc-4d46-b4e5-351945e5d1f1'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tarta ze śliwkami i migdałami

-- ITALIAN
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '5dbe2cab-cc75-4c2b-8c90-6f8fd2568423'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Frittata z młodą cukinią i miętą
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '99bde099-9e37-44fc-9208-9db5a719b4dd'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Frittata z papryką i fetą
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'fc34b949-297d-4f5d-9117-199883a164f0'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Frittata z pieczonymi warzywami bez sera
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'd2686e3d-2468-4697-8b9a-45e396dd4980'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron ze szpinakiem i gorgonzolą
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'cb8fc995-c4c4-43eb-b768-91aa4fbee042'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron z soczewicą po bolońsku
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '5f51d7f8-2edd-4ec5-a3dd-3f88dbdd761c'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron z pesto z jarmużu i orzechami
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '307ca741-3931-42e2-ac1f-2df33980b93f'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Tiramisu fit ze skyrem
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'b85bb6ba-c1ff-48c5-b878-3ea2f704d1b8'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron z tuńczykiem i passatą pomidorową
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'd1033386-ab68-47de-9f9a-49955da23c72'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron z sosem pomidorowym i mielonym indykiem
UPDATE "Recipe" SET "cuisine" = 'ITALIAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'f90e5683-d07f-4aec-94b6-3afc9549f416'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Makaron z groszkiem i boczkiem

-- GREEK
UPDATE "Recipe" SET "cuisine" = 'GREEK', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'f2b0e3a1-f195-4ab4-9d06-d5e3535ac957'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Halloumi z pieczonymi warzywami
UPDATE "Recipe" SET "cuisine" = 'GREEK', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '735c7905-e3f0-413d-8069-97c3c31d2040'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Szaszłyki z halloumi i warzyw
UPDATE "Recipe" SET "cuisine" = 'GREEK', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '29fffa56-ef35-4cd0-a90e-a3ddc10a1db1'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pierożki z ciasta francuskiego ze szpinakiem i fetą

-- MEXICAN
UPDATE "Recipe" SET "cuisine" = 'MEXICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'fa7dd774-5e56-42f7-b2f7-efa22c5f702d'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Chili sin carne z fasolą i kukurydzą

-- AMERICAN
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '7c9d6a7f-a66a-40cb-8c29-3a683b59c6ea'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Burgery z ciecierzycy z frytkami z batatów
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'e7be2ec9-c251-4a2f-833d-c62e857602df'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Burgery z indyka z grilla
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'f27de0d2-8d7d-4b2a-a959-9775edf88bdb'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Żeberka BBQ z ziemniakami
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '4a91c3bf-ce07-4df2-b15d-2d26f31f1e5f'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Brownie z fasoli
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '2b86cf18-366a-4d93-9894-ee9f25557685'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Brownie z orzechami włoskimi
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'a378bd8c-3fbd-4e9b-a22b-538d1de1c37a'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ciastka z kawałkami czekolady
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '51bc2453-3e41-48bd-b32a-7fdb5862684e'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Chlebek bananowy z orzechami
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '41d568a7-8007-4d09-b6c9-ea6d03a15cd5'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Cynamonki drożdżowe z lukrem
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'a74ba550-e685-4219-8a7d-5385a39d4481'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Muffinki dyniowe
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '2684e3f2-c75d-4e80-aca3-f46921e386db'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ciasto marchewkowe z kremem serowym
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'fa04ca4e-c2a8-4aa7-a618-00fe9d197571'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Krążki cebulowe
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '0a069f45-231c-4601-b017-9be21ea8a7fc'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pieczone krążki cebulowe z ketchupem
UPDATE "Recipe" SET "cuisine" = 'AMERICAN', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'ad147ac4-b4b7-429f-a3a3-979812f455aa'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ryż z kiełbasą i papryką po kreolsku

-- POLISH
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'd053a80d-3fc0-4153-a2f6-7081012aa0bb'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Jajka w majonezie ze szczypiorkiem
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '010afa46-ca16-4a82-9c21-acfe7cc6c876'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kasza manna na mleku z sokiem malinowym
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '170900af-73fa-4b13-950c-6b225e662f09'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pasta z wędzonej makreli z twarożkiem
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'd9a3c510-663f-4d81-92e9-7ca15a277699'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Mintaj w sosie koperkowym z ziemniakami
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '40e4163d-9cca-49ec-8249-7a388fb2ea9d'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Jajka w sosie musztardowym z ziemniakami
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'eed3ff38-a491-47ed-9e4a-f5abde11935b'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Wątróbka drobiowa z cebulką, jabłkiem i ziemniakami
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '6276a5bd-551a-477f-80c6-ac5d5428b0c0'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pstrąg pieczony z koperkiem i ziemniakami
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '2daeae9c-528a-4af5-8a81-df08f8266565'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ciasto ucierane ze śliwkami
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'bb1b5226-75be-4e56-a97f-cbc293b380c4'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Ciasto z rabarbarem i kruszonką
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '55305435-cda7-43eb-b6e0-b8664ebbd49a'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Wiśniowiec, czyli ciasto kakaowe z wiśniami
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'a73203e2-2401-40c9-8f37-f81b5b19ba07'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Kokosanki
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '5cd3c899-3fed-4288-b316-b16588852ee5'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Rogaliki twarogowe z dżemem
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'f53b0816-0efb-4e4e-85b3-d95c5588af59'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Deser z galaretką, bitą śmietaną i owocami
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '25bf4a6a-df6f-4642-83c2-1c6f5e1bcb76'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Koreczki z serem, szynką i ogórkiem
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '83eb317e-3896-45d1-a00d-217eb1253895'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Klasyczne jajka faszerowane z musztardą
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'e7b08401-279b-49f6-8d0a-87f1a617d3bf'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Pieczarki w śmietanie z pieczywem
UPDATE "Recipe" SET "cuisine" = 'POLISH', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'b5d90918-ad87-437d-a690-7098311b9803'::uuid AND "isCatalog" = true AND "cuisine" = 'OTHER'; -- Domowy pasztet z indyka z pieczywem
