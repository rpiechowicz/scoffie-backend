/**
 * Formatowanie wartości w treści maila. Jedno miejsce, bo inaczej każdy
 * wyzwalacz robiłby to po swojemu, a mail wysłany z opóźnieniem pokazywałby
 * datę policzoną w innej strefie niż ta, w której naprawdę wyszedł.
 */

/**
 * Strefa na sztywno, nie z `UserPreference.timeZone`.
 *
 * Data w mailu („PRO działa do 17 września") ma się zgadzać z tym, co widzi
 * użytkownik w aplikacji i co mówi Apple, a nie z tym, gdzie akurat jest
 * telefon. Aplikacja jest polska, ceny są w złotych, wsparcie odpowiada po
 * polsku — jedna strefa jest tu uczciwsza niż data skaczące o dzień, gdy ktoś
 * czyta maila na wakacjach.
 */
const ZONE = 'Europe/Warsaw';

const DAY_MONTH = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'long',
  timeZone: ZONE,
});

const DAY_MONTH_YEAR = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: ZONE,
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** „14 października". `null`, gdy daty nie ma — szablon MUSI mieć wtedy wariant. */
export function formatDay(iso: string | null | undefined): string | null {
  const date = parse(iso);
  return date ? DAY_MONTH.format(date) : null;
}

/** „10 września 2026" — tam, gdzie rok ma znaczenie (potwierdzenie usunięcia). */
export function formatDayYear(iso: string | null | undefined): string | null {
  const date = parse(iso);
  return date ? DAY_MONTH_YEAR.format(date) : null;
}

/**
 * Temat wiadomości. Limit 45 znaków jest projektowy, nie techniczny: dłuższy
 * i tak zostanie ucięty przez skrzynkę, tylko w losowym miejscu i bez
 * wielokropka. Ucinamy po całych znakach, nie po jednostkach kodowych —
 * nazwa gospodarstwa potrafi mieć emoji.
 */
export function clipSubject(subject: string, max = 45): string {
  const chars = [...subject];
  if (chars.length <= max) return subject;
  return (
    chars
      .slice(0, max - 1)
      .join('')
      .trimEnd() + '…'
  );
}

/** Cena z `SUBSCRIPTION_PRODUCTS` w polskiej notacji: „29,99 zł/mc". */
export function formatPrice(pricePln: number): string {
  return `${pricePln.toFixed(2).replace('.', ',')} zł/mc`;
}
