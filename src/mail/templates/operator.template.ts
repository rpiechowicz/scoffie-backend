import {
  MailCtx,
  btn,
  doc,
  esc,
  h1,
  head,
  kv,
  lead,
  opsFoot,
  p,
  row,
  warn,
} from './mail-kit';
import { clipSubject, formatDay } from './mail-format';
import {
  DailyReportMetric,
  DailyReportPayload,
  OpsAlertPayload,
  RenderedMail,
} from '../mail-template';

/**
 * Maile do OPERATORA: alert z centrum alertów i raport „Scoffie wczoraj”.
 * Ten sam kit co maile do osób (papier, terakota, tryb ciemny), ale inna
 * stopka (`opsFoot`) i linki do panelu zamiast do strony.
 */

const ZONE = 'Europe/Warsaw';

const DATE_TIME = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: ZONE,
});

const WEEKDAY_DAY = new Intl.DateTimeFormat('pl-PL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: ZONE,
});

const COUNT = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
const USD = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PLN = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Liczba w formacie metryki. Spacje twarde z `Intl` zamieniamy na zwykłe — tekstowa wersja maila ma być czytelna w każdym kliencie. */
export function formatMetric(
  value: number,
  format: DailyReportMetric['format'],
): string {
  const text =
    format === 'usd'
      ? USD.format(value)
      : format === 'pln'
        ? PLN.format(value)
        : COUNT.format(value);
  return text.replace(/[\u00a0\u202f]/g, ' ');
}

export type MetricChange = {
  /** `▲ 3`, `▼ 1,20 zł`, `bez zmian`; pusty, gdy nie ma z czym porównać. */
  label: string;
  tone: 'ok' | 'warn' | 'neutral';
};

/** Zmiana wobec dnia wcześniej: kierunek, różnica i czy to dobra wiadomość. */
export function metricChange(metric: DailyReportMetric): MetricChange {
  if (metric.previous === null) return { label: '', tone: 'neutral' };
  const delta = metric.value - metric.previous;
  // Pieniądze porównujemy w groszach/centach — 0,004 różnicy to „bez zmian”.
  const epsilon = metric.format === 'count' ? 0.5 : 0.005;
  if (Math.abs(delta) < epsilon) return { label: 'bez zmian', tone: 'neutral' };
  const up = delta > 0;
  const tone =
    metric.good === 'neutral'
      ? 'neutral'
      : (metric.good === 'up') === up
        ? 'ok'
        : 'warn';
  return {
    label: `${up ? '▲' : '▼'} ${formatMetric(Math.abs(delta), metric.format)}`,
    tone,
  };
}

/* ── alert ──────────────────────────────────────────────────────────────── */

export function renderOpsAlert(c: MailCtx, d: OpsAlertPayload): RenderedMail {
  const critical = d.severity === 'critical';
  const subject = clipSubject(`${critical ? 'Alert' : 'Uwaga'}: ${d.title}`);
  const preheader = d.detail.slice(0, 90);
  const since = DATE_TIME.format(new Date(d.firstAtIso));
  const alertsUrl = `${d.panelUrl}/alerts`;

  const body =
    head(c) +
    h1(c, esc(d.title)) +
    warn(c, {
      title: critical ? 'Krytyczne' : 'Ostrzeżenie',
      body: esc(d.detail),
      pt: 18,
    }) +
    kv(
      c,
      [
        ['Od', esc(since)],
        ['Waga', critical ? 'krytyczny' : 'ostrzeżenie'],
      ],
      { pt: 18 },
    ) +
    p(
      c,
      'Kolejny mail o tym samym problemie przyjdzie najwcześniej jutro. Gdy problem zniknie, alert zamknie się sam.',
      { soft: true, small: true, pt: 18 },
    ) +
    btn(c, { label: 'Otwórz alerty', href: alertsUrl, plain: false }) +
    opsFoot(c, { panelUrl: d.panelUrl });

  const text = `${d.title}

${critical ? 'Krytyczne' : 'Ostrzeżenie'}: ${d.detail}

Od: ${since}

Kolejny mail o tym samym problemie przyjdzie najwcześniej jutro. Gdy problem zniknie, alert zamknie się sam.

Alerty w panelu: ${alertsUrl}

--
Wiadomość dla operatora Scoffie, nie dla użytkowników.`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}

/* ── raport dzienny ─────────────────────────────────────────────────────── */

function metricsBlock(
  c: MailCtx,
  title: string,
  metrics: DailyReportMetric[],
): string {
  const pal = c.p;
  const body = metrics
    .map((m, i) => {
      const change = metricChange(m);
      const border = i ? `border-top:1px solid ${pal.line};` : '';
      const pad = `padding:${i ? 11 : 0}px`;
      const toneClass =
        change.tone === 'ok'
          ? 'ok-ink'
          : change.tone === 'warn'
            ? 'warn-ink'
            : 'soft';
      const toneColor =
        change.tone === 'ok'
          ? pal.sage
          : change.tone === 'warn'
            ? pal.warnInk
            : pal.soft;
      return `<tr>
<td class="soft line" valign="top" style="${pad} 12px 11px 0;${border}font:400 15px/22px ${c.ff};color:${pal.soft};">${esc(m.label)}</td>
<td class="ink line" valign="top" align="right" style="${pad} 0 11px;${border}font:700 15px/22px ${c.ff};color:${pal.ink};white-space:nowrap;">${esc(formatMetric(m.value, m.format))}</td>
<td class="${toneClass} line" valign="top" align="right" width="96" style="${pad} 0 11px 12px;${border}font:700 13px/22px ${c.ff};color:${toneColor};white-space:nowrap;">${esc(change.label)}</td>
</tr>`;
    })
    .join('');
  return row(
    c,
    `<table role="presentation" class="surface line" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${pal.surface}" style="background:${pal.surface};border:1px solid ${pal.line};border-radius:16px;">
<tr><td style="padding:18px 20px 7px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td colspan="3" class="faint" style="padding-bottom:12px;font:700 12px/16px ${c.ff};letter-spacing:.09em;text-transform:uppercase;color:${pal.faint};">${esc(title)}</td></tr>
${body}</table></td></tr></table>`,
    18,
  );
}

/** „czwartek, 24 września” dla klucza doby `YYYY-MM-DD`. */
function dayLabel(day: string): string {
  // Południe UTC leży w tej samej dobie warszawskiej o każdej porze roku.
  return WEEKDAY_DAY.format(new Date(`${day}T12:00:00.000Z`));
}

export function renderDailyReport(
  c: MailCtx,
  d: DailyReportPayload,
): RenderedMail {
  const label = dayLabel(d.day);
  const short = formatDay(`${d.day}T12:00:00.000Z`) ?? d.day;
  const subject = clipSubject(`Scoffie wczoraj · ${short}`);
  const headline = d.sections
    .flatMap((s) => s.metrics)
    .slice(0, 3)
    .map((m) => `${m.label}: ${formatMetric(m.value, m.format)}`)
    .join(' · ');
  const preheader = headline || `Raport za ${label}.`;

  const body =
    head(c) +
    h1(c, 'Scoffie wczoraj') +
    lead(c, `${esc(label)} — w porównaniu z dniem wcześniej.`) +
    d.sections.map((s) => metricsBlock(c, s.title, s.metrics)).join('') +
    d.notes
      .map((n) =>
        warn(c, {
          title: n.tone === 'ok' ? 'W porządku' : 'Do sprawdzenia',
          body: esc(n.text),
          tone: n.tone === 'ok' ? 'ok' : 'warn',
          pt: 18,
        }),
      )
      .join('') +
    btn(c, { label: 'Otwórz panel', href: d.panelUrl, plain: false }) +
    opsFoot(c, { panelUrl: d.panelUrl });

  const sectionText = d.sections
    .map(
      (s) =>
        `${s.title.toUpperCase()}\n` +
        s.metrics
          .map((m) => {
            const change = metricChange(m).label;
            return `${m.label}: ${formatMetric(m.value, m.format)}${change ? ` (${change})` : ''}`;
          })
          .join('\n'),
    )
    .join('\n\n');
  const notesText = d.notes
    .map(
      (n) => `${n.tone === 'ok' ? 'W porządku' : 'Do sprawdzenia'}: ${n.text}`,
    )
    .join('\n');

  const text = `Scoffie wczoraj — ${label}, w porównaniu z dniem wcześniej.

${sectionText}
${notesText ? `\n${notesText}\n` : ''}
Panel: ${d.panelUrl}

--
Wiadomość dla operatora Scoffie, nie dla użytkowników.`;

  return {
    subject,
    preheader,
    html: doc(c, { subject, preheader, body }),
    text,
  };
}
