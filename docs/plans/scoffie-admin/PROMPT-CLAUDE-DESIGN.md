# Prompt do Claude Design — panel administratora Scoffie (24.09.2026)

Wklej wszystko spod kreski do Claude Design. Jeśli masz zrzuty ekranów
aplikacji iOS (Plan, Przepisy, Zakupy, Ustawienia — w obu motywach), dołącz
je, bo pomagają bardziej niż opis. Projektuj po kilka ekranów na raz:
najpierw **powłokę + Pulpit**, potem kolejne moduły w tym samym pliku,
żeby wszystko trzymało jeden styl.

---

Zaprojektuj panel administratora dla **Scoffie**, polskiej aplikacji iOS do
planowania posiłków dla gospodarstw domowych (tygodniowy plan, przepisy,
lista zakupów, asystent AI, subskrypcje Solo / We dwoje / Rodzina). Z panelu
korzysta jedna osoba, założyciel. Siedzi przy laptopie, ale **równie często
zagląda z iPhone'a**, więc każdy ekran musi być w pełni wygodny na 393 px
szerokości, a nie tylko „się mieścić”.

Całe UI po polsku. Kod: **React + TypeScript + Tailwind CSS v4, komponenty
w stylu shadcn/ui (Radix), ikony Lucide, wykresy Recharts**. Kolory tylko
przez zmienne CSS z tokenów poniżej, bez wpisanych na sztywno heksów
w komponentach.

## Charakter

Panel ma wyglądać jak brat aplikacji, nie jak generyczny szablon SaaS.
Aplikacja nazywa się stylistycznie „Cozy Kitchen”: ciepła, prawie czarna
kuchnia wieczorem (motyw ciemny, domyślny) i kremowy papier w dzień (jasny).
Ma być spokojnie, gęsto informacyjnie i elegancko: coś między Linear
a aplikacją Apple Fitness, ale w ciepłych barwach jedzenia. Żadnego
korporacyjnego szaro-niebieskiego.

## Tokeny (wiernie z aplikacji iOS)

Ciemny / jasny:

- tło strony: `#0C0806` / `#FBF5EA` + miękka radialna poświata terakoty
  u góry strony (terakota 12 % / 10 %, promień ok. 360 px, zanika do zera)
- tekst: `#FBF3E8` / `#1A1411`; drugorzędny: tekst × 58 % / × 66 %;
  wygaszony: tekst × 32 %
- **karta**: tło = tekst × 4 % / × 6 %, obrys 1 px = tekst × 6 % / × 12 %,
  **bez cienia**. Wszystkie karty wyglądają tak samo. **Żadnych białych
  kart w jasnym motywie.**
- pole / studzienka / pigułka: tekst × 8 % / × 5 %
- linia podziału: tekst × 12 % / × 18 %
- akcenty (ciemny / jasny):
  - terakota `#DB8452` / `#B6643C` — akcent główny, akcje, kalorie
  - szałwia `#87C2A5` / `#4C8766` — sukces, „zrobione”, węglowodany
  - indygo `#6573CA` / `#4B58AF` — informacja, białko
  - masło `#E8CF85` / `#A07828` — uwaga, tłuszcz
  - róż `#E09AA4` / `#B04E68`, morska `#6FB9CC` / `#287891`,
    lawenda `#B79BE0` / `#7E4FA0` — dodatkowe serie na wykresach
  - ember `#FE6171` / `#BF2D3E` — **tylko** błędy i alarmy
- tint akcentu (tło etykiet, miękkich przycisków, ikon): akcent × 16 % /
  × 10 %, a tekst lub ikona w pełnym kolorze akcentu

Typografia: `-apple-system, system-ui, "Inter", sans-serif` (na Apple to SF
Pro jak w aplikacji). Tytuł strony 30–32 px, font-weight 800, letter-spacing
−0,5 px. Nagłówki kart 15–17 px semibold, treść 14–15 px, podpisy 12–13 px
w kolorze drugorzędnym. Wszystkie liczby `tabular-nums`. Duże liczby na
kaflach KPI 28–34 px, bold.

Kształty: karty zaokrąglone 18 px, mniejsze kafle 14 px, arkusze i modale
24 px, przyciski, pigułki i przełączniki segmentowe jako pełne kapsuły.

Przyciski: domyślny to **miękka kapsuła**, czyli tło w tincie akcentu, tekst
i ikona w kolorze akcentu, bez gradientu i cienia. Pełne wypełnienie
terakotą tylko dla jednej głównej akcji na ekranie. Akcje niszczące
w tincie embera.

Szkło (backdrop-blur + półprzezroczyste tło) **tylko** na elementach
pływających: dolny pasek nawigacji na telefonie i przyklejony nagłówek przy
przewijaniu. Na niczym innym.

## Zasada treści

Każda informacja raz, w najmocniejszym miejscu. Bez zdań objaśniających,
w stylu „Tutaj zobaczysz…”. Ekran ma żyć dzięki kolorom akcentów, ikonom
w kolorowym tincie, etykietom-pigułkom z ikoną, miniaturom zdjęć dań i małym
wykresom (sparkline), a nie dzięki tekstowi. Nie może być ani szaro-pusty,
ani przegadany.

## Układ i RWD

- **Desktop (≥1024 px)**: lewy pasek boczny (logo Scoffie, sekcje, na dole
  admin + przełącznik motywu), zwijany do samych ikon. Treść z maksymalną
  szerokością ok. 1440 px. U góry globalne wyszukiwanie ⌘K (użytkownicy,
  domy, przepisy po nazwie, e-mailu lub id).
- **Telefon (393 px)**: pasek boczny znika. Na dole **pływająca kapsuła ze
  szkła** z 4–5 głównymi sekcjami i „Więcej”, jak pasek zakładek iOS.
  Tabele zamieniają się w **listy kart**, a szczegóły, filtry i akcje
  otwierają się w **arkuszu wysuwanym od dołu** z uchwytem. Główna akcja
  w zasięgu kciuka. Wykresy na pełną szerokość, przesuwane palcem.
- Stany: ładowanie (szkielety w kolorze karty, nie spinnery), pusto (ikona
  w tincie + jedno zdanie), błąd (ember).

## Ekrany (każdy w obu motywach i na obu szerokościach)

1. **Logowanie**: znak Scoffie na tle z poświatą. Jedna główna akcja
   „Zaloguj Face ID” (passkey; na Macu Touch ID), pod nią drugorzędne
   „Zaloguj przez Apple” i „Zaloguj przez Google”. Po Apple / Google drugi
   krok: 6 pól kodu z Google Authenticator. Obok „Użyj kodu odzyskiwania”.
2. **Pulpit**: rząd kafli KPI z trendem vs wczoraj / 7 dni i sparkline
   (Użytkownicy aktywni dziś, Nowi, MRR w zł, Aktywne subskrypcje, Koszt
   asystenta dziś vs dzienny budżet jako pierścień, Crash-free %). Pod
   spodem: wykres aktywności 30 dni, karta „Wymaga uwagi” (nowe zgłoszenia
   asystenta, maile FAILED, subskrypcje w łasce płatniczej, nieprzetworzone
   powiadomienia Apple) z liczbami na kolorowych etykietach, karta
   „Produkcja” (commit, wersja iOS w sklepie i w TestFlight, ostatnia kopia
   bazy z kropką statusu).
3. **Użytkownicy — lista**: wyszukiwanie, filtry w arkuszu (dostawca Apple /
   Google, kreator ukończony, ma subskrypcję, aktywny 7 dni) pokazane jako
   usuwalne pigułki nad listą. Wiersz: awatar z inicjałem w kolorze
   użytkownika, imię, e-mail (z oznaczeniem „ukryty e-mail Apple”),
   etykieta planu, ostatnia aktywność.
4. **Użytkownik — karta**: nagłówek z awatarem, imieniem i etykietami
   (plan, dostawca, „kreator ✓”). Sekcje jako karty: Gospodarstwa, Urządzenia
   (wersja aplikacji i iOS), Sesje (z akcją „Wyloguj zewsząd”), Zgody (oś
   czasu), Asystent (tury, koszt miesiąca), Subskrypcje, Maile. **Dane
   zdrowotne zakryte**: karta z rozmyciem i przyciskiem „Odsłoń” (po kliknięciu
   modal z polem „powód” i potwierdzeniem Face ID). Na dole strefa RODO:
   „Eksport danych”, „Usuń konto” (ember).
5. **Gospodarstwo — karta**: domownicy z rolami, zaproszenia, plan (włączone
   pory posiłków jako kolorowe pigułki), status Cookidoo, pula asystenta
   jako pasek „wykorzystane / limit”, akcje „Nadaj PRO” i „Resetuj licznik
   kosztu”.
6. **Asystent — rentowność**: przełącznik okresu (7 d / 30 d / miesiąc),
   kafle: przychód netto, koszt modelu, marża %, koszt prób. Wykres słupkowy
   przychód vs koszt dzień po dniu. Tabela „per subskrypcja” z marżą
   pokolorowaną (szałwia na plusie, ember pod kreską). Lejek propozycji
   asystenta (Proponowane → Zastosowane / Cofnięte / Wygasłe). Histogram
   p50 / p95 czasu tury.
7. **Zgłoszenia odpowiedzi**: kolejka kart (powód jako etykieta, komentarz,
   migawka odpowiedzi asystenta w studzience, model / koszt / czas).
   Akcje: „Rozpatrzone”, „Odrzuć”, „Zrób z tego test”.
8. **Subskrypcje**: MRR / ARR z wykresem, nowe / odnowienia / odejścia,
   lista „ryzyko odejścia” (wyłączone auto-odnowienie, łaska płatnicza),
   dziennik powiadomień Apple z nieudanymi na górze.
9. **Katalog — edytor przepisu**: duże zdjęcie dania (upload), tytuł,
   czas, trudność, porcje, pory. Składniki jako wiersze z ilością
   i jednostką. Obok, na telefonie pod spodem, **na żywo przeliczane makro**
   jako cztery kolorowe mierniki (kalorie terakota, białko indygo, tłuszcz
   masło, węglowodany szałwia) plus alergeny i tagi diet jako etykiety.
   Stan „Szkic / Opublikowany”, akcja „Publikuj”.

## Dane przykładowe

Realistyczne i polskie: imiona (Anna, Tomek, Magda…), gospodarstwa („Dom
Nowaków”), kwoty w zł (Solo 29,99 zł, We dwoje 39,99 zł, Rodzina 49,99 zł),
koszty modelu w $ z czterema miejscami po przecinku, daty po polsku
(„dziś 7:42”, „wczoraj”, „24 wrz”). Zdjęcia dań: ciepłe, z góry pod kątem,
na ciemnym tle.

## Czego nie robić

- białe karty, cienie pod kartami, gradienty na przyciskach,
- systemowa czerwień i chłodne szarości, generyczny niebieski „SaaS”,
- tekst objaśniający, powielanie tej samej liczby w kilku miejscach,
- tabele poziomo przewijane na telefonie (na telefonie zawsze karty),
- modal na pełen ekran tam, gdzie wystarczy arkusz od dołu.
