/**
 * Kit e-mailowy Scoffie — paleta, typografia i wspólne klocki.
 *
 * Port projektu z Claude Design (`docs/plans/powiadomienia-mailowe/design/`)
 * na TypeScript. Każdy klocek zwraca gotowy `<tr>` z tabelą i stylami inline:
 * bez flexa, grida, pozycjonowania i JS-a, bo poczta ich nie zna.
 *
 * Klasy (`.card`, `.surface`, `.ink`, `.soft`, `.line`, `.btn`, `.warn`, `.m1`…)
 * istnieją WYŁĄCZNIE po to, żeby blok trybu ciemnego mógł wymusić tło i kolor.
 * Element z twardym kolorem, ale bez klasy, zostanie jasny na ciemnej karcie —
 * to najczęstszy błąd w mailach i pilnuje go `mail-kit.spec.ts`.
 *
 * CZEGO TU NIE MA I DLACZEGO:
 * — nie ładujemy webfontów. Google Fonts w mailu to żądanie do obcego serwera
 *   z każdej skrzynki, a strona świadomie hostuje fonty u siebie właśnie po to,
 *   żeby tego uniknąć. Nazwy krojów zostają w rodzinach (gdy ktoś ma je
 *   lokalnie, zobaczy je), ale projekt jest rysowany pod Georgię i system-ui.
 */

/**
 * Ucieczka HTML. KAŻDA wartość od użytkownika przechodzi przez to miejsce.
 *
 * Typ jest wąski celowo: `unknown` przepuściłby obiekt, a ten wylądowałby
 * w mailu jako „[object Object]”.
 */
export function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type MailPalette = {
  canvas: string;
  card: string;
  surface: string;
  ink: string;
  soft: string;
  faint: string;
  line: string;
  terra: string;
  btn: string;
  btnInk: string;
  sage: string;
  honey: string;
  warnBg: string;
  warnLine: string;
  warnInk: string;
  okBg: string;
  okLine: string;
};

export const PAL: { light: MailPalette; dark: MailPalette } = {
  light: {
    canvas: '#F4EDE1',
    card: '#FBF7F0',
    surface: '#FFFDF8',
    ink: '#2A211C',
    soft: '#6B5B4E',
    faint: '#7F6B5B',
    line: '#E8DDCD',
    terra: '#C4633F',
    // Przyciemniona terakota: #C4633F z papierowym tekstem nie wyrabia 4,5:1.
    btn: '#A94F30',
    btnInk: '#FFFDF8',
    sage: '#527052',
    honey: '#B77A22',
    warnBg: '#FAEBD6',
    warnLine: '#E0BE8E',
    warnInk: '#8A4416',
    okBg: '#EEF2E9',
    okLine: '#CDD9C6',
  },
  dark: {
    canvas: '#14100E',
    card: '#191411',
    surface: '#221A16',
    ink: '#F2E9DC',
    soft: '#B7A594',
    faint: '#9E8B7B',
    line: '#33271F',
    terra: '#E07C55',
    btn: '#E07C55',
    btnInk: '#191411',
    sage: '#8FAE8B',
    honey: '#F0BC6A',
    warnBg: '#2C1F14',
    warnLine: '#5A4224',
    warnInk: '#F0BC6A',
    okBg: '#1B2119',
    okLine: '#37432F',
  },
};

/**
 * Kolory kółek domowników — DOKŁADNIE pierwsze przystanki gradientów awatara
 * z aplikacji (`ProfileAvatar.gradientPairs`, wariant jasny), w tej samej
 * kolejności. Indeks to `User.avatarColor` przydzielony przez serwer.
 *
 * DLACZEGO NIE PO KOLEJNOŚCI NA LIŚCIE, jak w makiecie. Kolor jest trwałą
 * cechą konta — ta sama osoba ma go w profilu, na chipie w planie i tutaj.
 * Kolorowanie po pozycji dawało kółka, których adresat nigdy nie widział
 * na ekranie, i przestawiało je wszystkim po dołączeniu kolejnej osoby.
 *
 * Powtórzenia (0, 5 i 8 to ta sama terakota) są odziedziczone po aplikacji:
 * tam odróżnia je DRUGI przystanek gradientu, którego płaskie kółko w mailu
 * nie ma. Lepsze wierne powtórzenie niż wymyślony kolor.
 */
export const MEMBER_COLORS: readonly string[] = [
  '#B6643C', // terracotta
  '#4C8766', // sage
  '#4B58AF', // indigo
  '#A07828', // butter
  '#4C8766', // sage
  '#B6643C', // terracotta
  '#4B58AF', // indigo
  '#A07828', // butter
  '#B6643C', // terracottaDeep (w jasnym = terracotta)
  '#2D3569', // indigo × 0,60
  '#2B4C39', // sage × 0,56
  '#784228', // terracotta × 0,66
];

const FONT_HEAD = "'Fraunces',Georgia,'Times New Roman',serif";
const FONT_BODY =
  "'Nunito',system-ui,-apple-system,'Segoe UI',Arial,sans-serif";

export type MailCtx = {
  p: MailPalette;
  /** Szerokość kolumny w px — 600 w wysyłce, 320 w podglądzie brzegowym. */
  w: number;
  pad: number;
  fh: string;
  ff: string;
  /** Skąd lecą obrazki (znak w nagłówku). */
  assetBase: string;
  /** Adres strony — linki w treści i w stopce. */
  site: string;
};

export function ctx(o?: {
  w?: number;
  assetBase?: string;
  site?: string;
}): MailCtx {
  const w = o?.w ?? 600;
  return {
    p: PAL.light,
    w,
    pad: w < 420 ? 20 : 32,
    fh: FONT_HEAD,
    ff: FONT_BODY,
    assetBase: (o?.assetBase ?? 'https://scoffie.app').replace(/\/+$/, ''),
    site: (o?.site ?? 'https://scoffie.app').replace(/\/+$/, ''),
  };
}

export const row = (c: MailCtx, inner: string, pt: number, pb = 0): string =>
  `<tr><td class="pad" style="padding:${pt}px ${c.pad}px ${pb}px;">${inner}</td></tr>`;

export const rule = (c: MailCtx): string =>
  row(
    c,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="line" style="border-top:1px solid ${c.p.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`,
    0,
  );

/* ── 1. Nagłówek ─────────────────────────────────────────────────────────── */

/**
 * Znak, opcjonalnie z nazwą. Nazwa jest TEKSTEM, więc nagłówek broni się
 * przy zablokowanych obrazkach — a to stan domyślny w Outlooku i w części
 * konfiguracji Gmaila.
 *
 * `<picture>` podaje wariant na ciemne tło: Apple Mail i iOS Mail go wezmą,
 * reszta zignoruje `<source>` i zostanie przy `<img>`. Gmail nie zna
 * `<picture>`, ale jasny znak jest terakotą na przezroczystym tle, więc czyta
 * się na obu tłach — wariant ciemny tylko go rozjaśnia.
 */
export function head(c: MailCtx, o?: { name?: boolean }): string {
  const p = c.p;
  const light = `${c.assetBase}/email/scoffie-mark.png`;
  const dark = `${c.assetBase}/email/scoffie-mark-dark.png`;
  const img =
    `<picture><source srcset="${dark}" media="(prefers-color-scheme: dark)">` +
    `<img src="${light}" width="44" height="44" alt="Scoffie" style="display:block;width:44px;height:44px;border:0;outline:none;text-decoration:none;"></picture>`;
  const wordmark =
    o?.name === false
      ? ''
      : `<td valign="middle" style="padding-left:12px;"><span class="ink" style="font:800 25px/28px ${c.ff};letter-spacing:-.5px;color:${p.ink};">Scoffie</span></td>`;
  return row(
    c,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">${img}</td>${wordmark}</tr></table>`,
    32,
  );
}

/* ── 2. Stopka ───────────────────────────────────────────────────────────── */

/**
 * Bez „wypisz się": to wiadomości o koncie, nie newsletter. Zamiast tego
 * jedno zdanie, dlaczego mail przyszedł — i ono jest per szablon.
 */
export function foot(c: MailCtx, o: { reason: string }): string {
  const p = c.p;
  const L = (href: string, t: string) =>
    `<a href="${href}" style="display:inline-block;padding:11px 0;font:700 14px/22px ${c.ff};color:${p.terra};text-decoration:underline;">${t}</a>`;
  const dot = `<span class="faint" style="font:400 14px/22px ${c.ff};color:${p.faint};padding:0 8px;">·</span>`;
  return (
    rule(c) +
    row(
      c,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>
${L(`${c.site}/terms/`, 'Regulamin')}${dot}${L(`${c.site}/privacy/`, 'Polityka prywatności')}${dot}${L(`${c.site}/support/`, 'Pomoc')}
</td></tr><tr><td class="soft" style="padding-top:6px;font:400 13px/20px ${c.ff};color:${p.soft};">
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${o.reason}
</td></tr><tr><td class="faint" style="padding-top:10px;font:400 13px/20px ${c.ff};color:${p.faint};">
Scoffie · <a class="faint-link" href="${c.site}" style="color:${p.faint};text-decoration:underline;">scoffie.app</a>
</td></tr></table>`,
      18,
      34,
    )
  );
}

/* ── 3. Przyciski ────────────────────────────────────────────────────────── */

/**
 * „Bulletproof button": tło i wymiary siedzą na KOMÓRCE, nie na `<a>`.
 *
 * Silnik Worda (Outlook na Windows) nie stosuje `padding` ani `min-width` do
 * elementu inline — przycisk zapadłby się do wysokości linii tekstu, a obszar
 * dotyku zniknął. Stąd padding na `<td>` plus `mso-padding-alt` i warunkowy
 * VML, który rysuje zaokrąglony prostokąt tylko w Outlooku.
 */
export function btn(
  c: MailCtx,
  o: {
    label: string;
    href: string;
    kind?: 'primary' | 'secondary';
    /** `false` = bez wiersza „albo wpisz w przeglądarce". */
    plain?: boolean;
    pt?: number;
  },
): string {
  const p = c.p;
  const sec = o.kind === 'secondary';
  const full = c.w < 420;
  const bg = sec ? p.card : p.btn;
  const ink = sec ? p.ink : p.btnInk;
  const border = sec ? `border:2px solid ${p.line};` : '';
  const href = esc(o.href);

  const vml =
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:52px;v-text-anchor:middle;width:260px;" arcsize="27%" stroke="f" fillcolor="${bg}">` +
    `<w:anchorlock/><center style="color:${ink};font-family:Arial,sans-serif;font-size:17px;font-weight:bold;">${esc(o.label)}</center>` +
    `</v:roundrect><![endif]-->`;

  const cell =
    `${vml}<!--[if !mso]><!--><table role="presentation" class="btn${sec ? ' btn-sec' : ''}" ${full ? 'width="100%" ' : ''}cellpadding="0" cellspacing="0" border="0"${full ? ' style="width:100%;"' : ''}><tr>` +
    `<td align="center" bgcolor="${bg}" style="background:${bg};border-radius:14px;padding:15px 30px;mso-padding-alt:15px 30px;${border}">` +
    `<a href="${href}" style="display:${full ? 'block' : 'inline-block'};min-width:180px;font:700 17px/22px ${c.ff};color:${ink};text-decoration:none;text-align:center;">${esc(o.label)}</a>` +
    `</td></tr></table><!--<![endif]-->`;

  const back =
    o.plain === false
      ? ''
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr><td class="soft" style="font:400 14px/22px ${c.ff};color:${p.soft};">
albo wpisz w przeglądarce: <a href="${href}" style="color:${p.terra};text-decoration:underline;">${esc(o.href.replace(/^https?:\/\//, ''))}</a></td></tr></table>`;

  return row(c, cell + back, o.pt ?? 26);
}

/* ── 4. Klucz — wartość ──────────────────────────────────────────────────── */

/** Wartości MUSZĄ być już zescapowane przez wołającego (bywają pogrubione). */
export function kv(
  c: MailCtx,
  rows: [string, string][],
  o?: { title?: string; pt?: number },
): string {
  const p = c.p;
  // `class="… line"` na obu komórkach: bez tego kreski rozdzielające zostają
  // jasne na ciemnej karcie i tabela wygląda jak surowy arkusz.
  const body = rows
    .map(
      ([k, val], i) => `<tr>
<td class="soft line" width="46%" valign="top" style="padding:${i ? 11 : 0}px 12px 11px 0;${i ? `border-top:1px solid ${p.line};` : ''}font:400 15px/22px ${c.ff};color:${p.soft};">${k}</td>
<td class="ink line" valign="top" align="right" style="padding:${i ? 11 : 0}px 0 11px;${i ? `border-top:1px solid ${p.line};` : ''}font:700 15px/22px ${c.ff};color:${p.ink};word-break:break-word;">${val}</td>
</tr>`,
    )
    .join('');
  const title = o?.title
    ? `<tr><td colspan="2" class="faint" style="padding-bottom:12px;font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};">${esc(o.title)}</td></tr>`
    : '';
  return row(
    c,
    `<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.surface}" style="background:${p.surface};border:1px solid ${p.line};border-radius:16px;">
<tr><td style="padding:18px 20px 7px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${title}${body}</table></td></tr></table>`,
    o?.pt ?? 22,
  );
}

/* ── 5. Karta gospodarstwa ───────────────────────────────────────────────── */

/**
 * Inicjały jak w aplikacji (`HouseholdMemberStyle.initials`): dwa człony →
 * dwie pierwsze litery, jeden człon → dwie pierwsze litery tego członu.
 *
 * UWAGA: w iOS są DWIE implementacje inicjałów i różnią się między sobą
 * (`ProfileAvatar.initials(for:)` z Ustawień daje z „Ania" jedną literę).
 * Bierzemy tę z kółek domowników, bo to ten sam kontekst co karta w mailu.
 */
export function initials(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed === '') return '?';
  const words = trimmed.split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length >= 2) {
    return ([...words[0]][0] + [...words[1]][0]).toUpperCase();
  }
  // `[...]`, nie `slice`: emoji i litery spoza BMP to dwie jednostki kodowe,
  // a `"👩‍🍳".slice(0,2)` tnie w środku pary zastępczej i daje krzaki.
  return [...trimmed].slice(0, 2).join('').toUpperCase();
}

/**
 * Polska odmiana rzeczownika po liczbie. Reguła pełna, nie „do pięciu":
 * liczba domowników nie jest niczym ograniczona, a „22 osób" boli.
 */
export function plural(
  n: number,
  one: string,
  few: string,
  many: string,
): string {
  if (n === 1) return one;
  const last = n % 10;
  const lastTwo = n % 100;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

export type MailMember = { name: string; avatarColor: number | null };

export function house(
  c: MailCtx,
  o: { name: string; members: MailMember[]; pt?: number },
): string {
  const p = c.p;
  const dots = o.members
    .map((m, i) => {
      const index =
        m.avatarColor === null || !Number.isFinite(m.avatarColor)
          ? i % MEMBER_COLORS.length
          : Math.abs(m.avatarColor) % MEMBER_COLORS.length;
      const bg = MEMBER_COLORS[index];
      return `<span class="m${index + 1}" style="display:inline-block;width:44px;height:44px;border-radius:22px;background:${bg};color:#FFFDF8;font:800 15px/44px ${c.ff};text-align:center;margin:0 8px 8px 0;">${esc(initials(m.name))}</span>`;
    })
    .join('');
  const count = o.members.length;
  const names = o.members.map((m) => m.name).join(', ');
  return row(
    c,
    `<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.surface}" style="background:${p.surface};border:1px solid ${p.line};border-radius:16px;">
<tr><td style="padding:20px 20px 14px;">
<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};padding-bottom:6px;">Gospodarstwo</div>
<div class="ink" style="font:500 21px/27px ${c.fh};color:${p.ink};word-break:break-word;">${esc(o.name)}</div>
<div class="soft" style="font:400 14px/21px ${c.ff};color:${p.soft};padding-top:4px;word-break:break-word;">${count} ${plural(count, 'osoba', 'osoby', 'osób')} · ${esc(names)}</div>
<div style="padding-top:14px;font-size:0;line-height:0;">${dots}</div>
</td></tr></table>`,
    o.pt ?? 22,
  );
}

/* ── 6. Blok uwagi ───────────────────────────────────────────────────────── */

export function warn(
  c: MailCtx,
  o: { title: string; body: string; tone?: 'warn' | 'ok'; pt?: number },
): string {
  const p = c.p;
  const ok = o.tone === 'ok';
  const tone = ok
    ? { bg: p.okBg, bd: p.okLine, ink: p.sage }
    : { bg: p.warnBg, bd: p.warnLine, ink: p.warnInk };
  // Klasa tytułu zależy od tonu: wspólny `.warn-ink` przemalowałby w trybie
  // ciemnym blok pozytywny na kolor ostrzeżenia, czyli dałby sprzeczny sygnał.
  return row(
    c,
    `<table role="presentation" class="${ok ? 'ok' : 'warn'}" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${tone.bg}" style="background:${tone.bg};border:1px solid ${tone.bd};border-radius:16px;">
<tr><td style="padding:18px 20px;">
<div class="${ok ? 'ok-ink' : 'warn-ink'}" style="font:700 16px/23px ${c.ff};color:${tone.ink};">${o.title}</div>
<div class="ink" style="font:400 15px/24px ${c.ff};color:${p.ink};padding-top:5px;">${o.body}</div>
</td></tr></table>`,
    o.pt ?? 22,
  );
}

/* ── 7. Kroki ────────────────────────────────────────────────────────────── */

export function steps(
  c: MailCtx,
  o: { title?: string; items: { t: string; d: string }[]; pt?: number },
): string {
  const p = c.p;
  const body = o.items
    .map(
      (s, i) => `<tr>
<td width="40" valign="top" style="padding:${i ? 16 : 0}px 12px 0 0;"><span class="honey" style="font:500 30px/32px ${c.fh};color:${p.honey};">${i + 1}</span></td>
<td valign="top" style="padding:${i ? 16 : 0}px 0 0;">
<div class="ink" style="font:700 16px/23px ${c.ff};color:${p.ink};">${s.t}</div>
<div class="soft" style="font:400 15px/23px ${c.ff};color:${p.soft};padding-top:2px;">${s.d}</div>
</td></tr>`,
    )
    .join('');
  return row(
    c,
    `<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};padding-bottom:14px;">${esc(o.title ?? 'Co dalej')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>`,
    o.pt ?? 30,
  );
}

/* ── 8. Zestawienie planów ───────────────────────────────────────────────── */

export type MailPlan = {
  name: string;
  price: string;
  messages: number;
  plans: number;
  current?: boolean;
};

/** 600 px nie mieści trzech kolumn czytelnie, więc plany idą jedna pod drugą. */
export function plans(
  c: MailCtx,
  o: { items: MailPlan[]; title?: string; pt?: number },
): string {
  const p = c.p;
  const cards = o.items
    .map((pl) => {
      const cur = pl.current === true;
      // Ramka bieżącego planu jest terakotowa, więc NIE dostaje klasy `line` —
      // reguła ciemna przemalowałaby wyróżnienie na zwykłą kreskę.
      const frame = cur ? p.terra : p.line;
      return `<tr><td style="padding-bottom:10px;">
<table role="presentation" class="surface${cur ? '' : ' line'}" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.surface}" style="background:${p.surface};border:1px solid ${frame};border-radius:14px;">
<tr><td style="padding:15px 18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="ink" valign="middle" style="font:500 19px/25px ${c.fh};color:${p.ink};">${esc(pl.name)}${cur ? `<span class="soft" style="font:700 12px/16px ${c.ff};color:${p.soft};letter-spacing:.06em;text-transform:uppercase;"> &nbsp;wasz plan</span>` : ''}</td>
<td class="ink" valign="middle" align="right" width="110" style="font:700 16px/25px ${c.ff};color:${p.ink};white-space:nowrap;">${esc(pl.price)}</td>
</tr><tr><td class="soft" colspan="2" style="padding-top:3px;font:400 14px/21px ${c.ff};color:${p.soft};">${pl.messages} ${plural(pl.messages, 'wiadomość', 'wiadomości', 'wiadomości')} asystenta · ${pl.plans} ${plural(pl.plans, 'zapis', 'zapisy', 'zapisów')} planu</td></tr></table>
</td></tr></table></td></tr>`;
    })
    .join('');
  return row(
    c,
    `<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};padding-bottom:14px;">${esc(o.title ?? 'Plany')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cards}</table>
<div class="soft" style="font:400 14px/21px ${c.ff};color:${p.soft};padding-top:4px;">Płaci jedna osoba, a pula jest wspólna dla całego gospodarstwa.</div>`,
    o.pt ?? 30,
  );
}

/* ── Typografia treści ───────────────────────────────────────────────────── */

export const h1 = (c: MailCtx, t: string, o?: { pt?: number }): string =>
  row(
    c,
    `<h1 class="h1 ink" style="margin:0;font:500 ${c.w < 420 ? '26px/32px' : '30px/37px'} ${c.fh};letter-spacing:-.4px;color:${c.p.ink};">${t}</h1>`,
    o?.pt ?? 26,
  );

export const p = (
  c: MailCtx,
  t: string,
  o?: { small?: boolean; soft?: boolean; pt?: number },
): string =>
  row(
    c,
    `<p class="${o?.soft ? 'soft' : 'ink'}" style="margin:0;font:400 ${o?.small ? '15px/24px' : '16px/26px'} ${c.ff};color:${o?.soft ? c.p.soft : c.p.ink};">${t}</p>`,
    o?.pt ?? 14,
  );

export const lead = (c: MailCtx, t: string): string =>
  row(
    c,
    `<p class="soft" style="margin:0;font:400 18px/28px ${c.ff};color:${c.p.soft};">${t}</p>`,
    12,
  );

/** Pogrubienie wewnątrz akapitu — osobno, bo `esc()` zjadłoby znaczniki. */
export const b = (t: string): string =>
  `<b style="font-weight:700;">${esc(t)}</b>`;

/* ── Lista ───────────────────────────────────────────────────────────────── */

export function list(
  c: MailCtx,
  o: {
    title?: string;
    items: string[];
    tone?: 'terra' | 'ok' | 'off';
    pt?: number;
  },
): string {
  const pal = c.p;
  const tone = o.tone ?? 'terra';
  const col = tone === 'off' ? pal.faint : tone === 'ok' ? pal.sage : pal.terra;
  // Znacznik ma własną klasę per ton — bez niej w trybie ciemnym sage na
  // #191411 jest praktycznie niewidoczny, a to listy, które mają uspokajać.
  const items = o.items
    .map(
      (it, i) => `<tr>
<td width="18" valign="top" style="padding:${i ? 9 : 0}px 10px 0 0;"><div class="dot-${tone}" style="width:8px;height:8px;background:${col};border-radius:2px;margin-top:8px;font-size:0;line-height:0;">&nbsp;</div></td>
<td class="ink" valign="top" style="padding:${i ? 9 : 0}px 0 0;font:400 16px/25px ${c.ff};color:${pal.ink};">${it}</td></tr>`,
    )
    .join('');
  const title = o.title
    ? `<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${pal.faint};padding-bottom:12px;">${esc(o.title)}</div>`
    : '';
  return row(
    c,
    title +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>`,
    o.pt ?? 24,
  );
}

export function panel(c: MailCtx, o: { html: string; pt?: number }): string {
  const pal = c.p;
  return row(
    c,
    `<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${pal.surface}" style="background:${pal.surface};border:1px solid ${pal.line};border-radius:16px;">
<tr><td style="padding:18px 20px;">${o.html}</td></tr></table>`,
    o.pt ?? 22,
  );
}

export const textLink = (
  c: MailCtx,
  o: { label: string; href: string; pt?: number },
): string =>
  row(
    c,
    `<a href="${esc(o.href)}" style="display:inline-block;padding:11px 0;font:700 16px/22px ${c.ff};color:${c.p.terra};text-decoration:underline;">${esc(o.label)}</a>`,
    o.pt ?? 20,
  );

/* ── Tryb ciemny ─────────────────────────────────────────────────────────── */

/**
 * Elementy, które MUSZĄ dostać wymuszone tło albo kolor. Apple Mail, iOS Mail
 * i Outlook.com same odwracają barwy — bez tych reguł papierowe tło robi się
 * sine, a ciemny tekst zostaje ciemny na ciemnym.
 */
const DARK_RULES: [string, string][] = (() => {
  const D = PAL.dark;
  const base: [string, string][] = [
    ['.bg', `background:${D.canvas}!important`],
    ['.card', `background:${D.card}!important`],
    ['.surface', `background:${D.surface}!important`],
    ['.ink,.h1', `color:${D.ink}!important`],
    ['.soft', `color:${D.soft}!important`],
    ['.faint', `color:${D.faint}!important`],
    ['.honey', `color:${D.honey}!important`],
    ['.line', `border-color:${D.line}!important`],
    [
      '.warn',
      `background:${D.warnBg}!important;border-color:${D.warnLine}!important`,
    ],
    ['.warn-ink', `color:${D.warnInk}!important`],
    [
      '.ok',
      `background:${D.okBg}!important;border-color:${D.okLine}!important`,
    ],
    ['.ok-ink', `color:${D.sage}!important`],
    ['.dot-terra', `background:${D.terra}!important`],
    ['.dot-ok', `background:${D.sage}!important`],
    ['.dot-off', `background:${D.faint}!important`],
    ['.btn td', `background:${D.btn}!important`],
    ['.btn a', `color:${D.btnInk}!important`],
    [
      '.btn-sec td',
      `background:${D.card}!important;border-color:${D.line}!important`,
    ],
    ['.btn-sec a', `color:${D.ink}!important`],
    ['a', `color:${D.terra}!important`],
    // Selektor klasowy bije samo `a`, mimo że oba mają !important — dzięki
    // temu jedyny celowo wyciszony link w stopce zostaje wyciszony.
    ['.faint-link', `color:${D.faint}!important`],
  ];
  return base;
})();

const darkCss = (prefix: string): string =>
  DARK_RULES.map(
    ([sel, decl]) =>
      (prefix
        ? sel
            .split(',')
            .map((x) => `${prefix} ${x}`)
            .join(',')
        : sel) + `{${decl}}`,
  ).join('\n');

/* ── Koperta ─────────────────────────────────────────────────────────────── */

/**
 * Wypełniacz preheadera. Bez niego klient pocztowy dokleja do podglądu
 * początek treści („Cześć, Marta…"), bo preheadery mają poniżej 100 znaków,
 * a Gmail i Apple Mail ciągną 100–140. Znaki są niewidoczne i nie łamią linii.
 */
const PREHEADER_FILLER = '&#847;&zwnj;&nbsp;'.repeat(60);

export function wrap(c: MailCtx, preheader: string, rows: string): string {
  const pal = c.p;
  const pre = `<div style="display:none;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${pal.card};">${esc(preheader)}${PREHEADER_FILLER}</div>`;
  return `${pre}<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${pal.canvas}" style="background:${pal.canvas};width:100%;">
<tr><td align="center" style="padding:24px 0 40px;">
<table role="presentation" class="w card line" width="${c.w}" cellpadding="0" cellspacing="0" border="0" bgcolor="${pal.card}" style="width:${c.w}px;max-width:${c.w}px;background:${pal.card};border:1px solid ${pal.line};border-radius:20px;">
${rows}
</table></td></tr></table>`;
}

/** Pełny dokument gotowy do wysyłki. */
export function doc(
  c: MailCtx,
  o: { subject: string; preheader: string; body: string },
): string {
  const L = PAL.light;
  return `<!DOCTYPE html>
<html lang="pl" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(o.subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
html,body{margin:0!important;padding:0!important;width:100%!important}
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0;mso-table-rspace:0}
table{border-collapse:collapse}
img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
a{color:${L.btn}}
/* Word traktuje interlinie ze skrotu font: jako minimum i dokłada wlasny
   odstep — bez tego cala pionowa rytmika rozjezdza sie w Outlooku. */
td,div,p,a,span,h1{mso-line-height-rule:exactly}
@media only screen and (max-width:620px){
.w{width:100%!important;max-width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important}
.pad{padding-left:20px!important;padding-right:20px!important}
.h1{font-size:26px!important;line-height:32px!important}
.btn{width:100%!important}
.btn a{display:block!important;text-align:center!important}
}
@media (prefers-color-scheme:dark){
${darkCss('')}
}
${darkCss('[data-ogsc]')}
</style>
</head>
<body style="margin:0;padding:0;background:${L.canvas};">
${wrap(c, o.preheader, o.body)}
</body>
</html>`;
}
