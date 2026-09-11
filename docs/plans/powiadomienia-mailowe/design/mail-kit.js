/* Scoffie — kit e-mailowy. Paleta, typografia i wspólne klocki.
   Każdy klocek zwraca gotowy <tr> z tabelą i stylami inline (bez flexa, grida, JS).
   Klasy (.card, .surface, .ink, .soft, .line, .btn, .warn, .m1…m6) istnieją tylko po to,
   by media query prefers-color-scheme mogła wymusić tło i kolor w trybie ciemnym. */
const MK = (function () {
const PAL = {
  light: { canvas:'#F4EDE1', card:'#FBF7F0', surface:'#FFFDF8', ink:'#2A211C', soft:'#6B5B4E', faint:'#7F6B5B', line:'#E8DDCD',
    terra:'#C4633F', btn:'#A94F30', btnInk:'#FFFDF8', sage:'#527052', honey:'#B77A22',
    warnBg:'#FAEBD6', warnLine:'#E0BE8E', warnInk:'#8A4416', okBg:'#EEF2E9', okLine:'#CDD9C6', hlBg:'#F6E2C8', hlLine:'#DCBB8A' },
  dark: { canvas:'#14100E', card:'#191411', surface:'#221A16', ink:'#F2E9DC', soft:'#B7A594', faint:'#9E8B7B', line:'#33271F',
    terra:'#E07C55', btn:'#E07C55', btnInk:'#191411', sage:'#8FAE8B', honey:'#F0BC6A',
    warnBg:'#2C1F14', warnLine:'#5A4224', warnInk:'#F0BC6A', okBg:'#1B2119', okLine:'#37432F', hlBg:'#3B2A18', hlLine:'#5C4527' }
};
/* Indeks gradientu domownika = indeks koloru. Sześć wyraźnie różnych, wszystkie z ciepłej rodziny. */
const MEM = {
  light: ['#C4633F','#B77A22','#5E7F5C','#5B6CA8','#9C5A6E','#3F7A80'],
  dark:  ['#E08A63','#DFA84E','#93B08F','#8B99D6','#CE93A4','#7FB1B8']
};
const HOST = 'https://scoffie.app';
const FH_B = "'Fraunces',Georgia,'Times New Roman',serif", FH_F = "Georgia,'Times New Roman',serif";
const FB_B = "'Nunito',system-ui,-apple-system,'Segoe UI',Arial,sans-serif", FB_F = "system-ui,-apple-system,'Segoe UI',Arial,sans-serif";

function ctx(o) {
  o = o || {};
  const mode = o.mode || 'light', w = o.w || 600;
  return { mode, p: PAL[mode], w, pad: w < 420 ? 20 : 32, imgs: o.imgs !== false, hl: !!o.hl, tpl: !!o.tpl,
    fh: o.fallbackFonts ? FH_F : FH_B, ff: o.fallbackFonts ? FB_F : FB_B,
    mem: MEM[mode], memInk: mode === 'dark' ? '#191411' : '#FFFDF8' };
}
/* Zmienna do podstawienia. W eksporcie HTML zostaje {{nazwa}}, w podglądzie wartość (opcjonalnie podświetlona). */
function v(c, name, val) {
  if (c.tpl) return '{{' + name + '}}';
  if (!c.hl) return val;
  return `<span style="background:${c.p.hlBg};border-bottom:1px dotted ${c.p.hlLine};">${val}</span>`;
}
const row = (c, inner, pt, pb) => `<tr><td class="pad" style="padding:${pt}px ${c.pad}px ${pb}px;">${inner}</td></tr>`;
const sp = h => `<tr><td style="font-size:0;line-height:0;height:${h}px;">&nbsp;</td></tr>`;
const rule = c => row(c, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="line" style="border-top:1px solid ${c.p.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`, 0, 0);

/* 1. Nagłówek — znak sam albo znak z nazwą. Nazwa jest tekstem, więc nagłówek żyje bez obrazków. */
function head(c, o) {
  o = o || {};
  const p = c.p, src = (c.tpl ? HOST + '/email/' : 'email/img/') + (c.mode === 'dark' && !c.tpl ? 'scoffie-mark-dark.png' : 'scoffie-mark.png');
  const mark = c.imgs
    ? `<img src="${src}" width="44" height="44" alt="Scoffie" style="display:block;width:44px;height:44px;border:0;outline:none;text-decoration:none;">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="line" width="44" height="44" align="center" valign="middle" style="width:44px;height:44px;border:1px dashed ${p.line};font:700 10px/12px ${c.ff};color:${p.faint};">Scoffie</td></tr></table>`;
  const wordmark = o.name === false ? '' : `<td valign="middle" style="padding-left:12px;"><span class="ink" style="font:800 25px/28px ${c.ff};letter-spacing:-.5px;color:${p.ink};">Scoffie</span></td>`;
  return row(c, `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">${mark}</td>${wordmark}</tr></table>`, 32, 0);
}
/* 2. Stopka transakcyjna — bez „wypisz się”, z jednym zdaniem, dlaczego mail przyszedł. */
function foot(c, o) {
  const p = c.p, L = (href, t) => `<a href="${href}" style="display:inline-block;padding:11px 0;font:700 14px/22px ${c.ff};color:${p.terra};text-decoration:underline;">${t}</a>`;
  return rule(c) + row(c, `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>
${L(HOST + '/terms/', 'Regulamin')}<span class="faint" style="font:400 14px/22px ${c.ff};color:${p.faint};padding:0 8px;">·</span>${L(HOST + '/privacy/', 'Polityka prywatności')}<span class="faint" style="font:400 14px/22px ${c.ff};color:${p.faint};padding:0 8px;">·</span>${L(HOST + '/support/', 'Pomoc')}
</td></tr><tr><td class="soft" style="padding-top:6px;font:400 13px/20px ${c.ff};color:${p.soft};">
To wiadomość dotycząca Twojego konta w Scoffie. Dostajesz ją, ${o.reason}
</td></tr><tr><td class="faint" style="padding-top:10px;font:400 13px/20px ${c.ff};color:${p.faint};">
Scoffie · <a href="${HOST}" style="color:${p.faint};text-decoration:underline;">scoffie.app</a>
</td></tr></table>`, 18, 34);
}
/* 3. Przyciski — tabela z tłem komórki, nigdy <button>. Wysokość 52 px, więc obszar dotyku ma zapas. */
function btn(c, o) {
  const p = c.p, sec = o.kind === 'secondary', full = c.w < 420;
  const bg = sec ? p.card : p.btn, ink = sec ? p.ink : p.btnInk, bd = sec ? `border:2px solid ${p.line};` : '';
  const cell = `<table role="presentation" class="btn${sec ? ' btn-sec' : ''}" ${full ? 'width="100%" ' : ''}cellpadding="0" cellspacing="0" border="0"${full ? ' style="width:100%;"' : ''}><tr>
<td align="center" bgcolor="${bg}" style="background:${bg};border-radius:14px;${bd}">
<a href="${o.href}" style="display:${full ? 'block' : 'inline-block'};min-width:180px;padding:15px 30px;font:700 17px/22px ${c.ff};color:${ink};text-decoration:none;border-radius:14px;text-align:center;">${o.label}</a>
</td></tr></table>`;
  const back = o.plain === false ? '' : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr><td class="soft" style="font:400 14px/22px ${c.ff};color:${p.soft};">
albo wpisz w przeglądarce: <a href="${o.href}" style="color:${p.terra};text-decoration:underline;">${o.href.replace(/^https?:\/\//, '')}</a></td></tr></table>`;
  return row(c, cell + back, o.pt == null ? 26 : o.pt, 0);
}
/* 4. Klucz — wartość. Dane planu: nazwa, cena, limity, data odnowienia. */
function kv(c, rows, o) {
  o = o || {};
  const p = c.p;
  const body = rows.map(([k, val], i) => `<tr>
<td class="soft" width="46%" valign="top" style="padding:${i ? 11 : 0}px 12px 11px 0;${i ? `border-top:1px solid ${p.line};` : ''}font:400 15px/22px ${c.ff};color:${p.soft};">${k}</td>
<td class="ink" valign="top" align="right" style="padding:${i ? 11 : 0}px 0 11px;${i ? `border-top:1px solid ${p.line};` : ''}font:700 15px/22px ${c.ff};color:${p.ink};word-break:break-word;">${val}</td>
</tr>`).join('');
  const title = o.title ? `<tr><td colspan="2" class="faint" style="padding-bottom:12px;font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};">${o.title}</td></tr>` : '';
  return row(c, `<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.surface}" style="background:${p.surface};border:1px solid ${p.line};border-radius:16px;">
<tr><td style="padding:18px 20px 7px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${title}${body}</table></td></tr></table>`, o.pt == null ? 22 : o.pt, 0);
}
/* 5. Karta gospodarstwa — inicjały w kółkach, kolor z indeksu gradientu. Kółka zawijają się przy 320 px. */
function initials(name) {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter('pl', { granularity: 'grapheme' }).segment(name.trim()), s => s.segment)
    : Array.from(name.trim());
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && /\p{L}/u.test(words[0]) && /\p{L}/u.test(words[1])) return (words[0][0] + words[1][0]).toUpperCase();
  const one = seg.filter(s => s !== ' ');
  return /\p{L}|\p{N}/u.test(one[0] || '') ? one.slice(0, 2).join('').toUpperCase() : (one[0] || '?');
}
function house(c, o) {
  const p = c.p;
  const dots = o.members.map((m, i) => {
    const bg = c.mem[i % c.mem.length];
    return `<span class="m${(i % 6) + 1}" style="display:inline-block;width:44px;height:44px;border-radius:22px;background:${bg};color:${c.memInk};font:800 15px/44px ${c.ff};text-align:center;margin:0 8px 8px 0;">${initials(m)}</span>`;
  }).join('');
  const names = o.members.join(', ');
  return row(c, `<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.surface}" style="background:${p.surface};border:1px solid ${p.line};border-radius:16px;">
<tr><td style="padding:20px 20px 14px;">
<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};padding-bottom:6px;">Gospodarstwo</div>
<div class="ink" style="font:500 21px/27px ${c.fh};color:${p.ink};word-break:break-word;">${v(c, 'nazwa_gospodarstwa', o.name)}</div>
<div class="soft" style="font:400 14px/21px ${c.ff};color:${p.soft};padding-top:4px;">${v(c, 'liczba_domownikow', o.members.length)} ${o.members.length === 1 ? 'osoba' : (o.members.length < 5 ? 'osoby' : 'osób')} · ${v(c, 'lista_domownikow', names)}</div>
<div style="padding-top:14px;font-size:0;line-height:0;">${dots}</div>
</td></tr></table>`, o.pt == null ? 22 : o.pt, 0);
}
/* 6. Blok ostrzegawczy — nieudana płatność, wyczerpany limit. Tinta + rama, bez lewej belki i bez strachu. */
function warn(c, o) {
  const p = c.p, tone = o.tone === 'ok' ? { bg: p.okBg, bd: p.okLine, ink: p.sage } : { bg: p.warnBg, bd: p.warnLine, ink: p.warnInk };
  return row(c, `<table role="presentation" class="${o.tone === 'ok' ? 'ok' : 'warn'}" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${tone.bg}" style="background:${tone.bg};border:1px solid ${tone.bd};border-radius:16px;">
<tr><td style="padding:18px 20px;">
<div class="warn-ink" style="font:700 16px/23px ${c.ff};color:${tone.ink};">${o.title}</div>
<div class="ink" style="font:400 15px/24px ${c.ff};color:${p.ink};padding-top:5px;">${o.body}</div>
</td></tr></table>`, o.pt == null ? 22 : o.pt, 0);
}
/* 7. Co dalej — 2–3 ponumerowane kroki. Numer w Fraunces, nie w kółku, nie emoji. */
function steps(c, o) {
  const p = c.p;
  const body = o.items.map((s, i) => `<tr>
<td width="40" valign="top" style="padding:${i ? 16 : 0}px 12px 0 0;"><span style="font:500 30px/32px ${c.fh};color:${p.honey};">${i + 1}</span></td>
<td valign="top" style="padding:${i ? 16 : 0}px 0 0;">
<div class="ink" style="font:700 16px/23px ${c.ff};color:${p.ink};">${s.t}</div>
<div class="soft" style="font:400 15px/23px ${c.ff};color:${p.soft};padding-top:2px;">${s.d}</div>
</td></tr>`).join('');
  return row(c, `<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};padding-bottom:14px;">${o.title || 'Co dalej'}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>`, o.pt == null ? 30 : o.pt, 0);
}
/* 8. Trzy plany w jednej kolumnie — 600 px nie mieści trzech obok siebie czytelnie. */
const PLANS = [
  { id: 'solo', name: 'Solo', price: '29,99 zł/mc', msg: '30 wiadomości asystenta', plans: '8 planów tygodnia' },
  { id: 'duo', name: 'We dwoje', price: '39,99 zł/mc', msg: '50 wiadomości asystenta', plans: '12 planów tygodnia' },
  { id: 'family', name: 'Rodzina', price: '49,99 zł/mc', msg: '75 wiadomości asystenta', plans: '18 planów tygodnia' }
];
function plans(c, o) {
  o = o || {};
  const p = c.p;
  const cards = PLANS.map(pl => {
    const cur = o.current === pl.id;
    return `<tr><td style="padding-bottom:10px;">
<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.surface}" style="background:${p.surface};border:1px solid ${cur ? p.terra : p.line};border-radius:14px;">
<tr><td style="padding:15px 18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="ink" valign="middle" style="font:500 19px/25px ${c.fh};color:${p.ink};">${pl.name}${cur ? `<span class="soft" style="font:700 12px/16px ${c.ff};color:${p.soft};letter-spacing:.06em;text-transform:uppercase;"> &nbsp;twój plan</span>` : ''}</td>
<td class="ink" valign="middle" align="right" width="110" style="font:700 16px/25px ${c.ff};color:${p.ink};white-space:nowrap;">${pl.price}</td>
</tr><tr><td class="soft" colspan="2" style="padding-top:3px;font:400 14px/21px ${c.ff};color:${p.soft};">${pl.msg} · ${pl.plans}</td></tr></table>
</td></tr></table></td></tr>`;
  }).join('');
  return row(c, `<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};padding-bottom:14px;">${o.title || 'Plany'}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cards}</table>
<div class="soft" style="font:400 14px/21px ${c.ff};color:${p.soft};padding-top:4px;">Subskrypcja należy do jednej osoby, a PRO działa u wszystkich w gospodarstwie.</div>`, o.pt == null ? 30 : o.pt, 0);
}
/* Typografia treści */
const h1 = (c, t, o) => row(c, `<h1 class="h1 ink" style="margin:0;font:500 ${c.w < 420 ? '26px/32px' : '30px/37px'} ${c.fh};letter-spacing:-.4px;color:${c.p.ink};">${t}</h1>`, (o && o.pt) || 26, 0);
const p_ = (c, t, o) => { o = o || {}; const s = o.small ? '15px/24px' : '16px/26px'; return row(c, `<p style="margin:0;font:400 ${s} ${c.ff};color:${o.soft ? c.p.soft : c.p.ink};" class="${o.soft ? 'soft' : 'ink'}">${t}</p>`, o.pt == null ? 14 : o.pt, 0); };
const lead = (c, t) => row(c, `<p class="soft" style="margin:0;font:400 18px/28px ${c.ff};color:${c.p.soft};">${t}</p>`, 12, 0);
/* Lista z kwadratowym znacznikiem — bez emoji jako ikon sekcji */
function list(c, o) {
  const p = c.p, col = o.tone === 'off' ? p.faint : (o.tone === 'ok' ? p.sage : p.terra);
  const items = o.items.map((it, i) => `<tr>
<td width="18" valign="top" style="padding:${i ? 9 : 0}px 10px 0 0;"><div style="width:8px;height:8px;background:${col};border-radius:2px;margin-top:8px;font-size:0;line-height:0;">&nbsp;</div></td>
<td valign="top" style="padding:${i ? 9 : 0}px 0 0;font:400 16px/25px ${c.ff};color:${p.ink};" class="ink">${it}</td></tr>`).join('');
  const title = o.title ? `<div class="faint" style="font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${p.faint};padding-bottom:12px;">${o.title}</div>` : '';
  return row(c, title + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>`, o.pt == null ? 24 : o.pt, 0);
}
/* Panel z ramką — używany do „co przestaje działać / co zostaje” */
function panel(c, o) {
  const p = c.p;
  return row(c, `<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.surface}" style="background:${p.surface};border:1px solid ${p.line};border-radius:16px;">
<tr><td style="padding:18px 20px;">${o.html}</td></tr></table>`, o.pt == null ? 22 : o.pt, 0);
}
const textLink = (c, o) => row(c, `<a href="${o.href}" style="display:inline-block;padding:11px 0;font:700 16px/22px ${c.ff};color:${c.p.terra};text-decoration:underline;">${o.label}</a>`, o.pt == null ? 20 : o.pt, 0);

/* Koperta: preheader + wyśrodkowana kolumna 600 px na papierowym tle */
function wrap(c, preheader, rows) {
  const p = c.p;
  const pre = `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${p.card};">${preheader}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>`;
  return `${pre}<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.canvas}" style="background:${p.canvas};width:100%;">
<tr><td align="center" style="padding:24px 0 40px;">
<table role="presentation" class="w card line" width="${c.w}" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.card}" style="width:${c.w}px;max-width:${c.w}px;background:${p.card};border:1px solid ${p.line};border-radius:20px;">
${rows}
</table></td></tr></table>`;
}
/* Reguły trybu ciemnego — elementy, które MUSZĄ mieć wymuszone tło albo kolor.
   Generujemy z nich dwa bloki: prefers-color-scheme (Apple Mail, iOS, Gmail app)
   i [data-ogsc] (Outlook.com, który przepisuje selektory). */
const DARK = (D => [
  ['.bg', `background:${D.canvas}!important`],
  ['.card', `background:${D.card}!important`],
  ['.surface', `background:${D.surface}!important`],
  ['.ink,.h1', `color:${D.ink}!important`],
  ['.soft', `color:${D.soft}!important`],
  ['.faint', `color:${D.faint}!important`],
  ['.line', `border-color:${D.line}!important`],
  ['.warn', `background:${D.warnBg}!important;border-color:${D.warnLine}!important`],
  ['.warn-ink', `color:${D.warnInk}!important`],
  ['.ok', `background:${D.okBg}!important;border-color:${D.okLine}!important`],
  ['.btn td', `background:${D.btn}!important`],
  ['.btn a', `color:${D.btnInk}!important`],
  ['.btn-sec td', `background:${D.card}!important;border-color:${D.line}!important`],
  ['.btn-sec a', `color:${D.ink}!important`],
  ['a', `color:${D.terra}!important`]
].concat(MEM.dark.map((col, i) => ['.m' + (i + 1), `background:${col}!important;color:${D.btnInk}!important`])))(PAL.dark);
const darkCss = pre => DARK.map(([s, d]) => (pre ? s.split(',').map(x => pre + ' ' + x).join(',') : s) + '{' + d + '}').join('\n');

/* Pełny dokument do wklejenia w system wysyłkowy */
function doc(t, d) {
  const c = ctx({ tpl: true }), L = PAL.light;
  const body = t.body(c, d || {});
  return `<!DOCTYPE html>
<html lang="pl" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${t.subject}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
html,body{margin:0!important;padding:0!important;width:100%!important}
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0;mso-table-rspace:0}
table{border-collapse:collapse}
img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
a{color:${L.btn}}
@media only screen and (max-width:620px){
.w{width:100%!important;max-width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important}
.pad{padding-left:20px!important;padding-right:20px!important}
.h1{font-size:26px!important;line-height:32px!important}
.btn{width:100%!important}
.btn a{display:block!important;text-align:center!important}
}
/* tło i tekst muszą być wymuszone — inaczej Apple Mail i Outlook odwrócą je same i papier zrobi się siny */
@media (prefers-color-scheme:dark){
${darkCss('')}
}
${darkCss('[data-ogsc]')}
</style>
</head>
<body style="margin:0;padding:0;background:${L.canvas};">
${wrap(c, t.preheader, body)}
</body>
</html>`;
}
return { PAL, MEM, PLANS, HOST, DARK, ctx, v, row, sp, rule, head, foot, btn, kv, house, warn, steps, plans, h1, p: p_, lead, list, panel, textLink, wrap, doc, initials };
})();
window.MK = MK;
