/**
 * Produkty subskrypcji z App Store → limity gospodarstwa.
 *
 * JEDNO ŹRÓDŁO PRAWDY dla trzech miejsc, które muszą mówić to samo:
 * paywall w aplikacji, opis produktu w App Store Connect i kwoty na serwerze.
 * Apple wymaga (3.1.2(c)), żeby przed zakupem podać KONKRETNE ilości — a
 * liczba na paywallu staje się obietnicą, więc nie może się rozjechać z tym,
 * co egzekwuje `AiUsageCountersService`.
 *
 * DLACZEGO NAZWY OD WIELKOŚCI DOMU, A NIE OD LICZB. Rachunek z
 * `cennik-i-limity-2026-09.md` §13 mówi, że dodatkowy domownik kosztuje
 * +$0,05 miesięcznie (0,7 % przychodu netto) — więc cena za wielkość domu
 * sprzedaje ZUŻYCIE, nie koszt. Pięć osób wyczerpie pulę szybciej niż jedna,
 * i to jest cała różnica.
 *
 * DLACZEGO NIE LICZYMY MIEJSC. `seats` jest ETYKIETĄ dla klienta, nie bramką
 * w kodzie: „osoba" ma dwie niesprawiedliwe definicje (członkostwo vs zgoda),
 * bramka na miejscach zniechęcałaby do dodania alergicznego dziecka jako
 * domownika (a wtedy twarda bramka alergenowa przestaje je widzieć), a
 * wyczerpana pula egzekwuje się sama — dom pięcioosobowy na planie Solo
 * skończy wiadomości w tydzień i zobaczy ekran „Zwiększ limit". To lepszy
 * moment na sprzedaż niż komunikat „nie możesz zaprosić żony".
 */
export type SubscriptionProduct = {
  /** Nazwa pokazywana na paywallu. */
  name: string;
  /** Etykieta wielkości domu — NIE jest egzekwowana. */
  seatsLabel: string;
  /** Cena w PLN wyłącznie do tekstów pomocniczych; prawdę mówi App Store. */
  pricePln: number;
  messagesPerMonth: number;
  plansPerMonth: number;
};

/**
 * Identyfikatory muszą być identyczne z App Store Connect. Zmiana limitu tutaj
 * = jednoczesna zmiana opisu produktu i paywalla; podnosić wolno w każdej
 * chwili, obniżać obecnym subskrybentom — NIE (to zmiana warunków umowy
 * w trakcie jej trwania).
 *
 * SKĄD TE LICZBY (decyzja 3.09.2026, rachunek w `cennik-i-limity-2026-09.md`):
 *
 * Limity są policzone na STAN DOCELOWY, czyli ciepły cache wspólnego
 * prefiksu — bo tylko taki limit da się utrzymać na zawsze. Przy pełnym
 * wykorzystaniu i ciepłym cache zostaje 63 % (Solo), 54 % (We dwoje) i 44 %
 * (Rodzina) przychodu netto. Zimny cache pierwszych tygodni jest stanem
 * przejściowym: kosztuje kilkanaście dolarów łącznie, a nie na użytkownika.
 *
 * Zapas nad realnym zużyciem jest celowy. Zmierzone scenariusze: jedna osoba
 * planująca raz w tygodniu ~14 wiadomości, para intensywnie ~40, rodzina
 * czteroosobowa ~48, rodzina bardzo intensywnie ~70. Każdy plan ma nad tym
 * zapas, więc nikt nie uderzy w limit w połowie miesiąca.
 *
 * Zapisy planu są hojne, bo NIC nie kosztują: zatwierdzenie propozycji to
 * kliknięcie, bez wywołania modelu (`agent-proposals.service.ts` nie zna
 * dostawcy). Ten licznik jest dźwignią produktową, nie kosztową, i ma nigdy
 * nie skończyć się przed wiadomościami.
 */
export const SUBSCRIPTION_PRODUCTS: Readonly<
  Record<string, SubscriptionProduct>
> = {
  'app.scoffie.pro.solo.monthly': {
    name: 'Solo',
    seatsLabel: '1 osoba',
    pricePln: 29.99,
    messagesPerMonth: 30,
    plansPerMonth: 8,
  },
  'app.scoffie.pro.duet.monthly': {
    name: 'We dwoje',
    seatsLabel: '2 osoby',
    pricePln: 39.99,
    messagesPerMonth: 50,
    plansPerMonth: 12,
  },
  'app.scoffie.pro.family.monthly': {
    name: 'Rodzina',
    seatsLabel: '3 osoby i więcej',
    pricePln: 49.99,
    messagesPerMonth: 75,
    plansPerMonth: 18,
  },
};

/**
 * Limity dla `productId` z transakcji.
 *
 * Nieznany produkt (nowy SKU wypuszczony w App Store przed deployem serwera)
 * NIE może zablokować opłaconej subskrypcji ani dać nieskończonego limitu —
 * dostaje limity z `AI_LIMIT_*`, czyli dokładnie to, co gospodarstwa PRO
 * miały do tej pory.
 */
export function productLimits(
  productId: string | null | undefined,
  fallback: { messagesPerMonth: number; plansPerMonth: number },
): { messagesPerMonth: number; plansPerMonth: number; product: string | null } {
  const product = productId ? SUBSCRIPTION_PRODUCTS[productId] : undefined;
  if (!product) {
    return { ...fallback, product: null };
  }
  return {
    messagesPerMonth: product.messagesPerMonth,
    plansPerMonth: product.plansPerMonth,
    product: product.name,
  };
}
