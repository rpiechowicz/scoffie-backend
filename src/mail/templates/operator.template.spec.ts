import { MailRenderer } from '../mail-renderer';
import { OPERATOR_MAIL_FIXTURES } from './mail-fixtures';
import { ctx } from './mail-kit';
import { formatMetric, metricChange } from './operator.template';

const c = ctx({ assetBase: 'https://a.test', site: 'https://s.test' });
const renderer = new MailRenderer();
const render = (template: string, payload: Record<string, unknown>) =>
  renderer.renderWith(
    c,
    template as Parameters<MailRenderer['renderWith']>[1],
    payload,
  );

describe('maile do operatora — każdy stan renderuje się do końca', () => {
  it.each(OPERATOR_MAIL_FIXTURES.map((f) => [f.label, f] as const))(
    '%s',
    (_label, fixture) => {
      const mail = render(
        fixture.template,
        fixture.payload as unknown as Record<string, unknown>,
      );
      expect([...mail.subject].length).toBeLessThanOrEqual(45);
      expect(mail.preheader.trim()).not.toBe('');
      expect(mail.html).toContain('<!DOCTYPE html>');
      for (const part of [mail.subject, mail.preheader, mail.html, mail.text]) {
        expect(part).not.toContain('undefined');
        expect(part).not.toContain('NaN');
        expect(part).not.toContain('[object Object]');
      }
      // Stopka operatora zamiast „dotyczy Twojego konta”.
      expect(mail.html).toContain('Wiadomość dla operatora Scoffie');
      expect(mail.text).toContain('Wiadomość dla operatora Scoffie');
      expect(mail.html).not.toContain('Twojego konta');
      // Tryb ciemny jak w pozostałych szablonach.
      expect(mail.html).toContain('@media (prefers-color-scheme:dark)');
      expect(mail.html).toContain('class="faint-link"');
      expect(mail.text).not.toMatch(/<\/?(b|div|table|a|p)\b/i);
      // Linki wyłącznie do panelu.
      const links = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.startsWith('https://dashboard.scoffie.app')).toBe(true);
      }
    },
  );

  it('alert prowadzi na ekran Alerty i escapuje treść', () => {
    const mail = render('OPS_ALERT', {
      severity: 'critical',
      title: '<b>x</b>',
      detail: 'a & b',
      firstAtIso: '2026-09-25T09:40:00.000Z',
      panelUrl: 'https://dashboard.scoffie.app',
    });
    expect(mail.html).toContain('href="https://dashboard.scoffie.app/alerts"');
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.subject.startsWith('Alert:')).toBe(true);
    // 9:40 UTC to 11:40 w Warszawie (czas letni).
    expect(mail.text).toContain('11:40');
  });

  it('raport pokazuje dobę po polsku, liczby i strzałki z kolorem', () => {
    const [, , report] = OPERATOR_MAIL_FIXTURES;
    const mail = render(
      report.template,
      report.payload as unknown as Record<string, unknown>,
    );
    expect(mail.subject).toBe('Scoffie wczoraj · 24 września');
    expect(mail.html).toContain('czwartek, 24 września');
    expect(mail.text).toContain('Nowe konta: 12 (▲ 3)');
    // Wzrost kosztu to zła wiadomość → klasa ostrzeżenia.
    expect(mail.html).toMatch(/class="warn-ink line"[^>]*>▲ 0,52 USD/);
    expect(mail.text).toContain('Tury asystenta: 184 (bez zmian)');
  });

  it('zły kształt danych raportu to wyjątek, nie mail z dziurą', () => {
    expect(() =>
      render('DAILY_REPORT', {
        day: '2026-09-24',
        panelUrl: 'x',
        sections: [],
      }),
    ).toThrow(/sections/);
    expect(() =>
      render('OPS_ALERT', {
        severity: 'loud',
        title: 't',
        detail: 'd',
        firstAtIso: '2026-09-25T09:40:00.000Z',
        panelUrl: 'x',
      }),
    ).toThrow(/severity/);
  });
});

describe('liczby raportu', () => {
  it('formatuje po polsku, bez twardych spacji', () => {
    expect(formatMetric(1249.5, 'pln')).toBe('1249,50 zł');
    expect(formatMetric(12345, 'count')).toBe('12 345');
    expect(formatMetric(3.4, 'usd')).toBe('3,40 USD');
  });

  it('kierunek i ton zmiany zależą od tego, co jest dobre', () => {
    const base = { label: 'x', format: 'count' as const };
    expect(
      metricChange({ ...base, value: 5, previous: 3, good: 'up' }),
    ).toEqual({
      label: '▲ 2',
      tone: 'ok',
    });
    expect(
      metricChange({ ...base, value: 5, previous: 3, good: 'down' }).tone,
    ).toBe('warn');
    expect(
      metricChange({ ...base, value: 1, previous: 3, good: 'neutral' }),
    ).toEqual({ label: '▼ 2', tone: 'neutral' });
    expect(
      metricChange({ ...base, value: 3, previous: 3, good: 'up' }),
    ).toEqual({
      label: 'bez zmian',
      tone: 'neutral',
    });
    expect(
      metricChange({ ...base, value: 3, previous: null, good: 'up' }),
    ).toEqual({
      label: '',
      tone: 'neutral',
    });
  });
});
