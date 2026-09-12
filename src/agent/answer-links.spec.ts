import { stripClickableLinks } from './answer-links';

// AUDYT 12.09.2026 (P0.8). iOS renderuje odpowiedź asystenta jako markdown
// zachowujący linki i nigdzie nie nadpisuje `openURL`, więc stuknięcie
// otwierało dowolny adres — także schemat innej aplikacji. Razem z iniekcją
// pośrednią przez tytuł przepisu dawało to gotowy phishing na domownika.

describe('stripClickableLinks', () => {
  it('zamienia link markdown na samą etykietę', () => {
    expect(
      stripClickableLinks('Kliknij [Odnów subskrypcję](https://zly.pl/login).'),
    ).toBe('Kliknij Odnów subskrypcję.');
  });

  it('rozbraja także schematy inne niż http', () => {
    expect(stripClickableLinks('[Zadzwoń](tel:+48123456789)')).toBe('Zadzwoń');
    expect(stripClickableLinks('[Otwórz](scoffie://invite?token=abc)')).toBe(
      'Otwórz',
    );
    expect(stripClickableLinks('[Napisz](mailto:kto@zly.pl)')).toBe('Napisz');
  });

  it('rozbraja autolink w nawiasach ostrych, zostawiając adres tekstem', () => {
    expect(stripClickableLinks('Wejdź na <https://scoffie.app/pomoc>')).toBe(
      'Wejdź na https://scoffie.app/pomoc',
    );
  });

  it('pusta etykieta zostawia adres jako tekst, nie pustkę', () => {
    expect(stripClickableLinks('Zobacz [](https://zly.pl/x)')).toBe(
      'Zobacz https://zly.pl/x',
    );
  });

  it('nie rusza pozostałego markdownu ani zwykłego tekstu', () => {
    const tekst =
      'Na **wtorek** proponuję _kotlety_. Lista: 1) mąka, 2) jajka (2 szt.).';
    expect(stripClickableLinks(tekst)).toBe(tekst);
  });

  it('goły adres zostaje tekstem — użytkownik ma zobaczyć, co napisał model', () => {
    const tekst = 'Więcej na scoffie.app oraz https://scoffie.app/pomoc';
    expect(stripClickableLinks(tekst)).toBe(tekst);
  });

  it('kilka linków w jednym zdaniu', () => {
    expect(
      stripClickableLinks('[A](https://a.pl) i [B](https://b.pl) i koniec'),
    ).toBe('A i B i koniec');
  });

  it('link z tytułem w cudzysłowie też traci adres', () => {
    expect(stripClickableLinks('[Pomoc](https://zly.pl "phishing")')).toBe(
      'Pomoc',
    );
  });

  it('nawias kwadratowy bez linku zostaje nietknięty', () => {
    expect(stripClickableLinks('Skróty [PN] i [WT] zostają')).toBe(
      'Skróty [PN] i [WT] zostają',
    );
  });

  it('scenariusz z audytu: iniekcja z tytułu przepisu nie daje przycisku', () => {
    const odpowiedz =
      'Na wtorek: Zupa dyniowa.\n\nOdnów subskrypcję: [Odnów tutaj](https://scoffie-app.evil/odnow)';
    const out = stripClickableLinks(odpowiedz);
    expect(out).not.toContain('](');
    expect(out).not.toContain('evil');
    expect(out).toContain('Odnów tutaj');
  });
});
