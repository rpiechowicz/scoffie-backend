import {
  MEMBER_COLORS,
  b,
  ctx,
  doc,
  esc,
  house,
  initials,
  list,
  plural,
} from './mail-kit';
import { MAIL_FIXTURES } from './mail-fixtures';
import { MailRenderer } from '../mail-renderer';

const c = ctx({ assetBase: 'https://a.test', site: 'https://s.test' });

describe('esc', () => {
  it('zamyka drogę znacznikom z nazwy podanej przez użytkownika', () => {
    expect(esc('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(esc('Dom "U nas" & spółka')).toBe(
      'Dom &quot;U nas&quot; &amp; spółka',
    );
  });

  it('pusta wartość nie robi z siebie napisu „undefined”', () => {
    expect(esc(undefined)).toBe('');
    expect(esc(null)).toBe('');
  });
});

describe('initials', () => {
  // Parytet z `HouseholdMemberStyle.initials` w iOS — to ten sam kontekst
  // (kółka domowników), więc inicjały muszą się zgadzać z tym, co człowiek
  // widzi na ekranie. Uwaga: `ProfileAvatar.initials` z Ustawień działa
  // INACZEJ (jedna litera z jednego członu) i to nie jest ten wzorzec.
  it('dwa człony → pierwsze litery obu', () => {
    expect(initials('Rafał Piechowicz')).toBe('RP');
    expect(initials('  marta   wrona  ')).toBe('MW');
  });

  it('jeden człon → dwie pierwsze litery', () => {
    expect(initials('Ania')).toBe('AN');
    expect(initials('Kuba')).toBe('KU');
  });

  it('emoji nie rozpada się na krzaki', () => {
    // `"🐙".slice(0,2)` tnie w środku pary zastępczej — stąd `[...]`.
    expect(initials('🐙')).toBe('🐙');
    expect(initials('🐙🍜')).toBe('🐙🍜');
  });

  it('pusta nazwa daje znak zapytania, nie pustkę', () => {
    expect(initials('   ')).toBe('?');
  });
});

describe('plural', () => {
  it('odmienia po polsku, także powyżej dziesięciu', () => {
    const osoby = (n: number) => `${n} ${plural(n, 'osoba', 'osoby', 'osób')}`;
    expect(osoby(1)).toBe('1 osoba');
    expect(osoby(2)).toBe('2 osoby');
    expect(osoby(5)).toBe('5 osób');
    expect(osoby(12)).toBe('12 osób');
    expect(osoby(13)).toBe('13 osób');
    expect(osoby(14)).toBe('14 osób');
    expect(osoby(22)).toBe('22 osoby');
    expect(osoby(25)).toBe('25 osób');
    expect(osoby(102)).toBe('102 osoby');
    expect(osoby(112)).toBe('112 osób');
  });
});

describe('karta gospodarstwa', () => {
  it('kolor kółka bierze się z avatarColor, nie z pozycji na liście', () => {
    const html = house(c, {
      name: 'Dom',
      members: [
        { name: 'Ala', avatarColor: 3 },
        { name: 'Ola', avatarColor: 0 },
      ],
    });
    // Pierwsza osoba ma indeks 3 → czwarty kolor, druga indeks 0 → pierwszy.
    expect(html).toContain(MEMBER_COLORS[3]);
    expect(html).toContain(MEMBER_COLORS[0]);
    expect(html.indexOf(MEMBER_COLORS[3])).toBeLessThan(html.indexOf(`>OL<`));
  });

  it('brak koloru spada na pozycję, zamiast wywracać render', () => {
    const html = house(c, {
      name: 'Dom',
      members: [{ name: 'Ala', avatarColor: null }],
    });
    expect(html).toContain(MEMBER_COLORS[0]);
  });

  it('nazwa domu ze znacznikiem nie ucieka do HTML-a', () => {
    const html = house(c, {
      name: '<b>Dom</b>',
      members: [{ name: 'Ala', avatarColor: 0 }],
    });
    expect(html).toContain('&lt;b&gt;Dom&lt;/b&gt;');
    expect(html).not.toContain('<b>Dom</b>');
  });
});

describe('tryb ciemny', () => {
  /**
   * Najczęstszy błąd w mailu: element z twardym kolorem, ale bez klasy —
   * reguła ciemna go nie dotknie i zostanie jasny na ciemnej karcie. Test
   * sprawdza, że każdy taki element w KAŻDYM szablonie ma swoją klasę.
   */
  const renderer = new MailRenderer();
  const wszystkie = MAIL_FIXTURES.map((f) =>
    renderer.renderWith(
      c,
      f.template,
      f.payload as unknown as Record<string, unknown>,
    ),
  );

  it('każdy szablon niesie oba bloki reguł: media query i wariant Outlooka', () => {
    for (const mail of wszystkie) {
      expect(mail.html).toContain('@media (prefers-color-scheme:dark)');
      expect(mail.html).toContain('[data-ogsc]');
    }
  });

  it('znacznik listy ma klasę tonu, a nie samo tło', () => {
    const html = list(c, { items: ['a'], tone: 'ok' });
    expect(html).toContain('class="dot-ok"');
  });

  it('numer kroku ma klasę honey', () => {
    const [welcome] = wszystkie;
    expect(welcome.html).toContain('class="honey"');
  });

  it('kreski w tabeli klucz–wartość mają klasę line', () => {
    // Szablon z blokiem klucz–wartość o co najmniej dwóch wierszach: dopiero
    // drugi wiersz rysuje kreskę, więc tylko tam widać, czy ma klasę.
    const mail = renderer.renderWith(c, 'SUBSCRIPTION_GRACE', {
      planName: 'Solo',
      graceEndsAtIso: '2026-09-17T00:00:00.000Z',
    });
    expect(mail.html).toContain('class="soft line"');
    expect(mail.html).toContain('class="ink line"');
  });

  it('wyciszony link w stopce ma własną klasę, żeby nie rozjaśniła go reguła dla a', () => {
    for (const mail of wszystkie) {
      expect(mail.html).toContain('class="faint-link"');
    }
  });
});

describe('dokument', () => {
  it('ma preheader z wypełniaczem — inaczej podgląd doklei początek treści', () => {
    const html = doc(c, {
      subject: 'Temat',
      preheader: 'Krótki podgląd',
      body: '',
    });
    expect(html).toContain('Krótki podgląd');
    // Wypełniacz: bez niego skrzynka dociąga ~100 znaków z treści maila.
    expect(html.split('&#847;').length - 1).toBeGreaterThan(50);
    expect(html).toContain('mso-hide:all');
  });

  it('reguła interlinii dla Worda jest na miejscu', () => {
    const html = doc(c, { subject: 'x', preheader: 'y', body: '' });
    expect(html).toContain('mso-line-height-rule:exactly');
  });

  it('przycisk ma wymiary na komórce, nie na linku — inaczej zapada się w Outlooku', () => {
    const renderer = new MailRenderer();
    const welcome = renderer.renderWith(c, 'WELCOME', {
      displayName: 'Ala',
      trialMessages: 5,
      trialPlans: 1,
    });
    expect(welcome.html).toContain('mso-padding-alt:15px 30px');
    expect(welcome.html).toContain('v:roundrect');
  });
});

describe('b()', () => {
  it('pogrubia i po drodze escapuje', () => {
    expect(b('<x>')).toBe('<b style="font-weight:700;">&lt;x&gt;</b>');
  });
});
