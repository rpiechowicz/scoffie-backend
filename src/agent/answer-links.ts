/**
 * Odpowiedź modelu bez klikalnych adresów.
 *
 * AUDYT 12.09.2026 (P0.8). iOS parsuje odpowiedź asystenta jako markdown
 * zachowujący linki (`AttributedString(markdown:)` z
 * `.inlineOnlyPreservingWhitespace`) i renderuje je jako dotykalne, a w całej
 * aplikacji nie ma nadpisania `openURL` — stuknięcie otwiera DOWOLNY adres,
 * także schemat innej aplikacji. W połączeniu z iniekcją pośrednią przez
 * tytuły przepisów gospodarstwa domownik mógł doprowadzić do tego, że
 * asystent pokaże innemu domownikowi „Odnów subskrypcję" z linkiem na swoją
 * stronę.
 *
 * Poprawka jest po obu stronach — klient zdejmuje atrybut linku, a serwer
 * w ogóle takiej składni nie zapisuje. Serwerowa jest ważniejsza z dwóch
 * powodów: działa dla KAŻDEGO klienta (także starego buildu, który już jest
 * u ludzi i którego nie da się zaktualizować) i zostawia ślad w bazie
 * zgodny z tym, co widzi użytkownik.
 *
 * Etykieta ZOSTAJE, adres znika. Kasowanie całego zdania byłoby gorsze:
 * odpowiedź traciłaby sens, a użytkownik nie wiedziałby dlaczego.
 */

/** `[etykieta](adres)` — z etykietą bez zagnieżdżonych nawiasów kwadratowych. */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(\s*([^)\s]*)[^)]*\)/g;

/** `<https://…>` — autolink CommonMark. */
const ANGLE_AUTOLINK = /<((?:https?|mailto|tel):[^>\s]+)>/gi;

/**
 * Zamienia linki markdown na samą etykietę i rozbraja autolinki w nawiasach
 * ostrych. Zwykły adres wpisany gołym tekstem zostaje tekstem — Foundation
 * nie robi z niego linku, a użytkownik ma prawo zobaczyć, co asystent napisał.
 */
export function stripClickableLinks(text: string): string {
  return text
    .replace(MARKDOWN_LINK, (_match, label: string, url: string) => {
      const clean = label.trim();
      // `[](https://zly.pl)` — pusta etykieta nie może zostawić pustki po
      // sobie, bo zdanie straciłoby sens; zostaje sam adres jako TEKST.
      if (clean) return clean;
      return url.trim();
    })
    .replace(ANGLE_AUTOLINK, (_match, url: string) => url);
}
