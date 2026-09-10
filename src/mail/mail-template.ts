/**
 * Kontrakt między wyzwalaczem a szablonem: identyfikatory maili i kształt
 * danych, które każdy z nich dostaje.
 *
 * ZASADA: w `payload` siedzi WYŁĄCZNIE to, co naprawdę widać w treści.
 * Wiersz skrzynki nadawczej przeżywa skasowanie konta i leży w bazie 30 dni,
 * więc każde nadmiarowe pole to dane osobowe trzymane bez powodu.
 *
 * DATY IDĄ JAKO ISO, nie jako gotowy tekst. Formatowanie („14 października")
 * jest jedno, siedzi w rendererze i tam się je testuje — inaczej każdy
 * wyzwalacz formatowałby po swojemu, a mail wysłany z opóźnieniem pokazywałby
 * datę policzoną w innej strefie niż ta, w której naprawdę wyszedł.
 */

export const MAIL_TEMPLATE_IDS = [
  /** A — po ukończeniu onboardingu. */
  'WELCOME',
  /** B — po przyjęciu zaproszenia do cudzego gospodarstwa. */
  'HOUSEHOLD_JOINED',
  /** C1 — wyczerpana pula próbna (jedna na życie osoby). */
  'AI_TRIAL_EXHAUSTED',
  /** C2 — wyczerpana pula w opłaconym planie. */
  'AI_QUOTA_EXHAUSTED',
  /** D — nieudana płatność, subskrypcja w okresie łaski. */
  'SUBSCRIPTION_GRACE',
  /** E — subskrypcja wygasła albo została cofnięta. */
  'SUBSCRIPTION_EXPIRED',
  /** F — konto usunięte. Wychodzi PO transakcji kasującej. */
  'ACCOUNT_DELETED',
  /** G — nowa wersja regulaminu lub polityki prywatności. */
  'LEGAL_UPDATE',
] as const;

export type MailTemplateId = (typeof MAIL_TEMPLATE_IDS)[number];

export function isMailTemplateId(value: string): value is MailTemplateId {
  return (MAIL_TEMPLATE_IDS as readonly string[]).includes(value);
}

/** A — jedyne, co wiemy na pewno, to nazwa wyświetlana wybrana w aplikacji. */
export type WelcomePayload = {
  displayName: string;
  /** Z `AI_TRIAL_MESSAGES` / `AI_TRIAL_PLANS` — nie na sztywno w treści,
   *  bo obie wartości są zmienną środowiskową i już raz się zmieniły. */
  trialMessages: number;
  trialPlans: number;
};

/** B — karta gospodarstwa: nazwa i domownicy z ich kolorem awatara. */
export type HouseholdJoinedPayload = {
  householdName: string;
  /** Kolor kółka bierze się z `User.avatarColor`, nie z pozycji na liście —
   *  dzięki temu domownik ma w mailu ten sam kolor, co na chipie w aplikacji. */
  members: { name: string; avatarColor: number | null }[];
};

/**
 * C1 — wyczerpana pula próbna.
 *
 * `exhausted` jest OBOWIĄZKOWE, bo wyzwalacz to alternatywa: wiadomości
 * i zapisy planu to dwa niezależne liczniki i dwa różne błędy
 * (`AI_QUOTA_EXCEEDED` vs `AI_PLAN_QUOTA_EXCEEDED`). Bez tego pola mail
 * twierdziłby, że skończyło się wszystko, także komu skończył się jeden
 * licznik — a to nieprawdziwa liczba pokazana po to, żeby sprzedać plan.
 */
export type AiTrialExhaustedPayload = {
  exhausted: 'messages' | 'plans';
  messagesUsed: number;
  messagesLimit: number;
  plansUsed: number;
  plansLimit: number;
};

/**
 * C2 — wyczerpana pula w opłaconym planie.
 *
 * Pula NIE jest osobista: licznik wisi na zakresie `sub:<id>`, czyli na jednej
 * umowie wspólnej dla całego gospodarstwa. Adresatem jest ten, kto akurat
 * uderzył w limit — może nim być domownik, który niczego nie opłaca i dla
 * którego przycisk „Zmień plan" byłby martwy. Stąd `isPayer` i `payerName`:
 * mail ma dwa warianty, a nie jeden udający, że pula należy do odbiorcy.
 */
export type AiQuotaExhaustedPayload = {
  exhausted: 'messages' | 'plans';
  planName: string;
  isPayer: boolean;
  payerName: string | null;
  messagesUsed: number;
  messagesLimit: number;
  plansUsed: number;
  plansLimit: number;
  /** Kiedy pula wraca. ISO; `null`, gdy Apple nie podało daty odnowienia. */
  renewsAtIso: string | null;
  /** `false` = odnawianie wyłączone, więc pula NIE wróci. */
  renews: boolean;
};

/**
 * D — okres łaski.
 *
 * Bez ceny: model `Subscription` nie przechowuje żadnej kwoty ani waluty,
 * a jedyne źródło (`SUBSCRIPTION_PRODUCTS.pricePln`) jest w komentarzu wprost
 * opisane jako materiał pomocniczy, nie prawda o rachunku. W mailu
 * o NIEUDANEJ PŁATNOŚCI zmyślona kwota jest gorsza niż jej brak.
 */
export type SubscriptionGracePayload = {
  planName: string;
  /** Koniec okresu łaski. ISO; `null`, gdy Apple go nie przysłało —
   *  wtedy szablon mówi „przez najbliższe dni" zamiast zmyślać datę. */
  graceEndsAtIso: string | null;
};

/** E — koniec subskrypcji. */
export type SubscriptionExpiredPayload = {
  planName: string;
  expiredAtIso: string | null;
  /** `true`, gdy Apple cofnęło zakup (zwrot pieniędzy). Inny powód wymaga
   *  innego zdania — „skończyła się" byłoby przy zwrocie nieprawdą. */
  revoked: boolean;
};

/** F — pożegnanie. */
export type AccountDeletedPayload = {
  /** Adres pokazany w treści jako potwierdzenie, którego konta dotyczy mail. */
  email: string;
  deletedAtIso: string;
  /** Czy po tej osobie został dom z innymi domownikami. Gdy nie — gospodarstwo
   *  poszło razem z kontem i zdanie „domownicy mają to dalej" byłoby fałszem. */
  householdRemains: boolean;
  /** Ile przepisów zostało w gospodarstwie (autorstwo przeszło na bota
   *  katalogu). Zero znaczy, że nie ma o czym pisać. */
  keptRecipes: number;
  /** Czy na tożsamości wisi żywa subskrypcja. Jeśli tak, mail MUSI powiedzieć,
   *  że usunięcie konta jej nie zatrzymuje — Apple pobierze kolejną opłatę. */
  hasLiveSubscription: boolean;
};

/** G — zmiana dokumentów. */
export type LegalUpdatePayload = {
  effectiveDateIso: string;
  /** Wersja dokumentów z `LEGAL_DOCUMENT_VERSIONS`, np. `2026-10-01`. */
  version: string;
  /** Czy zmiana wymaga ponownej zgody (podniesione minimum). Decyduje
   *  o zdaniu „dalsze korzystanie oznacza akceptację" — przy wymaganej
   *  zgodzie to zdanie byłoby nieprawdziwe. */
  requiresConsent: boolean;
  /** 2–5 punktów streszczenia, pisanych ręcznie przy publikacji wersji. */
  changes: { title: string; body: string }[];
};

export type MailPayloads = {
  WELCOME: WelcomePayload;
  HOUSEHOLD_JOINED: HouseholdJoinedPayload;
  AI_TRIAL_EXHAUSTED: AiTrialExhaustedPayload;
  AI_QUOTA_EXHAUSTED: AiQuotaExhaustedPayload;
  SUBSCRIPTION_GRACE: SubscriptionGracePayload;
  SUBSCRIPTION_EXPIRED: SubscriptionExpiredPayload;
  ACCOUNT_DELETED: AccountDeletedPayload;
  LEGAL_UPDATE: LegalUpdatePayload;
};

/** Gotowa wiadomość — cztery części, które idą do dostawcy. */
export type RenderedMail = {
  /** Najwyżej 45 znaków; dłuższe ucina renderer, nie klient pocztowy. */
  subject: string;
  /** ~90 znaków ukrytego podglądu na liście wiadomości. */
  preheader: string;
  html: string;
  /** Wersja czysto tekstowa — część klientów pokaże tylko ją. */
  text: string;
};
