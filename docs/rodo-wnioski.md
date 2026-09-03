# Wnioski RODO — dostęp, przenoszenie, usunięcie

Termin ustawowy: **miesiąc** od wpływu wniosku (art. 12 ust. 3), z możliwością
przedłużenia o dwa miesiące przy skomplikowanych sprawach — o przedłużeniu
trzeba poinformować w pierwszym miesiącu. W praktyce celujemy w tydzień.

## Skąd przychodzą wnioski

| Kanał                             | Co robi osoba                                   | Co robimy my      |
| --------------------------------- | ----------------------------------------------- | ----------------- |
| Aplikacja (docelowo)              | Ustawienia → „Pobierz moje dane" / „Usuń konto" | nic — działa samo |
| E-mail na adres z polityki        | pisze z adresu konta                            | procedura poniżej |
| Apple / Google (formularz sklepu) | prośba przekazana przez sklep                   | jak e-mail        |

## 1. Weryfikacja tożsamości (zawsze)

Wysyłamy dane **tylko na adres e-mail przypisany do konta**. Jeśli wniosek
przyszedł z innego adresu, prosimy o napisanie z adresu konta albo o
zrobienie tego w aplikacji. Nigdy nie wysyłamy paczki na „proszę na ten inny
adres" — art. 12 ust. 6 pozwala żądać dodatkowej weryfikacji.

## 2. Dostęp i przenoszenie (art. 15 i 20)

Jedna paczka JSON obsługuje oba prawa. Składa ją ten sam kod, którego używa
telefon (`GET /me/export`), więc z konsoli i z aplikacji wychodzi to samo.

```bash
railway ssh --service Backend -- sh -c 'cd /app && pnpm rodo:export -- adres@example.com /tmp/dane.json'
railway ssh --service Backend -- sh -c 'cat /tmp/dane.json' > dane.json
railway ssh --service Backend -- sh -c 'rm /tmp/dane.json'
```

Gdy skrypt zgłosi kilka kont z tym samym e-mailem (Google + Apple), pytamy
osobę, którym logowaniem się posługuje, i uruchamiamy po id.

Plik wysyłamy zaszyfrowanym archiwum (hasło osobnym kanałem, np. SMS) albo
przez link wygasający. Po wysyłce kasujemy lokalną kopię.

Co jest w paczce: profil i sylwetka, preferencje żywieniowe, historia zgód,
gospodarstwa (nazwa i rola — bez danych innych domowników), własne przepisy,
posiłki zaplanowane i zjedzone, kroki, rozmowy z asystentem i zgłoszenia
odpowiedzi, urządzenia (bez tokenów), połączenia Cookidoo (bez haseł).

Czego w niej nie ma i dlaczego: tokeny i hasła (klucze, nie dane o osobie),
dane pozostałych domowników (art. 15 ust. 4), księga kosztów asystenta
(liczona per gospodarstwo, bez treści).

## 3. Usunięcie (art. 17)

Osoba robi to sama w aplikacji (Ustawienia → Usuń konto). Na wniosek
mailowy, po weryfikacji jak wyżej, wykonujemy to samo, co robi aplikacja —
kasowanie konta przez serwis, nie ręczne `DELETE` w bazie, bo tylko serwis
zna reguły (przepisy z katalogu przechodzą na bota importu, gospodarstwo
zostaje domownikom, wspólne plany nie znikają):

```bash
railway ssh --service Backend -- sh -c 'cd /app && pnpm accounts:delete -- adres@example.com'        # tylko pokazuje konto
railway ssh --service Backend -- sh -c 'cd /app && pnpm accounts:delete -- adres@example.com --yes'  # kasuje
```

Co zostaje po usunięciu i na jakiej podstawie (art. 17 ust. 3):

- kopie zapasowe bazy — do 30 dni, potem nadpisane (uzasadniony interes,
  bezpieczeństwo danych);
- wpisy w księdze kosztów asystenta bez powiązania z osobą (`AiUsage`
  z `turnId = null`) — rozliczenia;
- przepisy dodane do wspólnego katalogu — przechodzą na konto bota bez
  śladu autora.

Odpowiadamy osobie potwierdzeniem usunięcia i informacją o kopiach zapasowych.

## 4. Sprzeciw wobec przetwarzania przez asystenta

Cofnięcie zgody na asystenta to zdarzenie `REVOKED` (`POST /me/consents`) —
w aplikacji w Ustawieniach, na wniosek mailowy zapisujemy je tym samym
wywołaniem. Od tej chwili dane tej osoby nie trafiają do modelu (filtr
w prompcie), a jej rozmowy znikają w cyklu retencji (90 dni) albo na
żądanie od razu (`DELETE /agent/conversations/:id`).

## 5. Rejestr wniosków

Każdy wniosek notujemy (data wpływu, rodzaj, data odpowiedzi, kto obsłużył)
w prywatnym arkuszu administratora — bez kopiowania treści danych. To dowód
dotrzymania terminu, gdyby osoba złożyła skargę do UODO.
