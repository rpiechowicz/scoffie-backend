import { MailRenderer } from './mail-renderer';
import { MAIL_FIXTURES } from './templates/mail-fixtures';
import { ctx } from './templates/mail-kit';

const c = ctx({ assetBase: 'https://a.test', site: 'https://s.test' });
const renderer = new MailRenderer();

const render = (template: string, payload: Record<string, unknown>) =>
  renderer.renderWith(
    c,
    template as Parameters<MailRenderer['renderWith']>[1],
    payload,
  );

describe('każdy stan renderuje się do końca', () => {
  it.each(MAIL_FIXTURES.map((f) => [f.label, f] as const))(
    '%s',
    (_label, fixture) => {
      const mail = render(
        fixture.template,
        fixture.payload as unknown as Record<string, unknown>,
      );

      expect([...mail.subject].length).toBeLessThanOrEqual(45);
      expect(mail.subject.trim()).not.toBe('');
      expect(mail.preheader.trim()).not.toBe('');
      expect(mail.html).toContain('<!DOCTYPE html>');
      expect(mail.text.trim()).not.toBe('');

      // Dziura w danych wychodzi w mailu jako „undefined” albo goły
      // placeholder — obie rzeczy widzi odbiorca, więc żadna nie ma prawa
      // przejść przez test.
      for (const part of [mail.subject, mail.preheader, mail.html, mail.text]) {
        expect(part).not.toContain('undefined');
        expect(part).not.toContain('{{');
        expect(part).not.toContain('NaN');
        expect(part).not.toContain('[object Object]');
      }

      // Stopka i jej powód są obowiązkowe: to jedyne zdanie tłumaczące,
      // dlaczego ta wiadomość w ogóle przyszła.
      expect(mail.html).toContain('To wiadomość dotycząca Twojego konta');
      expect(mail.text).toContain('To wiadomość dotycząca Twojego konta');
    },
  );

  it('wersja tekstowa nie zawiera znaczników HTML', () => {
    for (const fixture of MAIL_FIXTURES) {
      const mail = render(
        fixture.template,
        fixture.payload as unknown as Record<string, unknown>,
      );
      expect(mail.text).not.toMatch(/<\/?(b|div|table|a|p)\b/i);
    }
  });
});

describe('adresy w treści', () => {
  it('wszystkie linki prowadzą pod skonfigurowaną domenę albo do App Store', () => {
    const dozwolone = [/^https:\/\/s\.test\//, /^https:\/\/apps\.apple\.com\//];
    for (const fixture of MAIL_FIXTURES) {
      const mail = render(
        fixture.template,
        fixture.payload as unknown as Record<string, unknown>,
      );
      const linki = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(linki.length).toBeGreaterThan(0);
      for (const link of linki) {
        expect(
          dozwolone.some((wzorzec) => wzorzec.test(link)) ||
            link === 'https://s.test',
        ).toBe(true);
      }
    }
  });

  it('obrazek leci z bazy zasobów, nie z adresu strony', () => {
    const mail = render('WELCOME', {
      displayName: 'Ala',
      trialMessages: 5,
      trialPlans: 1,
    });
    expect(mail.html).toContain('https://a.test/email/scoffie-mark.png');
    // Bez `<picture>`: iOS Mail pokazywał z niego pustą ramkę (11.09.2026).
    expect(mail.html).not.toContain('<picture');
    expect(mail.html).not.toContain('srcset=');
  });
});

describe('warianty, które muszą się różnić', () => {
  it('C2 do płatnika ma przycisk zmiany planu, do domownika — nie', () => {
    const wspolne = {
      exhausted: 'messages',
      planName: 'Solo',
      messagesUsed: 30,
      messagesLimit: 30,
      plansUsed: 1,
      plansLimit: 8,
      renewsAtIso: '2026-10-14T00:00:00.000Z',
      renews: true,
    };
    const platnik = render('AI_QUOTA_EXHAUSTED', {
      ...wspolne,
      isPayer: true,
      payerName: 'Marta',
    });
    const domownik = render('AI_QUOTA_EXHAUSTED', {
      ...wspolne,
      isPayer: false,
      payerName: 'Marta',
    });

    expect(platnik.html).toContain('apps.apple.com/account/subscriptions');
    expect(domownik.html).not.toContain('apps.apple.com/account/subscriptions');
    // Domownik ma się dowiedzieć, że pula nie jest jego i kto ją opłaca.
    expect(domownik.html).toContain('Marta');
    expect(domownik.text).toContain('Nie musisz nic robić');
  });

  it('C2 bez odnawiania nie obiecuje powrotu puli', () => {
    const mail = render('AI_QUOTA_EXHAUSTED', {
      exhausted: 'messages',
      planName: 'Solo',
      isPayer: true,
      payerName: null,
      messagesUsed: 30,
      messagesLimit: 30,
      plansUsed: 1,
      plansLimit: 8,
      renewsAtIso: null,
      renews: false,
    });
    expect(mail.subject).toBe('Pula asystenta się skończyła');
    expect(mail.html).toContain('wróci dopiero po ponownym włączeniu planu');
  });

  it('C1 rozróżnia, który licznik się skończył', () => {
    const wspolne = {
      messagesUsed: 5,
      messagesLimit: 5,
      plansUsed: 0,
      plansLimit: 1,
    };
    const wiadomosci = render('AI_TRIAL_EXHAUSTED', {
      ...wspolne,
      exhausted: 'messages',
    });
    const plany = render('AI_TRIAL_EXHAUSTED', {
      ...wspolne,
      exhausted: 'plans',
      messagesUsed: 1,
      plansUsed: 1,
    });
    expect(wiadomosci.subject).not.toBe(plany.subject);
    expect(plany.html).toContain('Rozmawiać z asystentem możesz dalej');
  });

  it('D bez daty łaski nie zmyśla terminu', () => {
    const bezDaty = render('SUBSCRIPTION_GRACE', {
      planName: 'Solo',
      graceEndsAtIso: null,
    });
    expect(bezDaty.html).toContain('przez najbliższe dni');
    expect(bezDaty.html).not.toMatch(/do \d+ \w+/);

    const zDatą = render('SUBSCRIPTION_GRACE', {
      planName: 'Solo',
      graceEndsAtIso: '2026-09-17T00:00:00.000Z',
    });
    expect(zDatą.html).toContain('17 września');
  });

  it('D nie podaje ceny — backend jej nie zna', () => {
    const mail = render('SUBSCRIPTION_GRACE', {
      planName: 'Solo',
      graceEndsAtIso: null,
    });
    // Wzorzec kwoty, nie samo „zł" — to drugie siedzi w słowie „zgłosił".
    expect(mail.html).not.toMatch(/\d+,\d\d\s*zł/);
    expect(mail.text).not.toMatch(/\d+,\d\d\s*zł/);
  });

  it('E rozróżnia wygaśnięcie od zwrotu pieniędzy', () => {
    const wygasla = render('SUBSCRIPTION_EXPIRED', {
      planName: 'Solo',
      expiredAtIso: '2026-09-03T00:00:00.000Z',
      revoked: false,
    });
    const cofnieta = render('SUBSCRIPTION_EXPIRED', {
      planName: 'Solo',
      expiredAtIso: '2026-09-03T00:00:00.000Z',
      revoked: true,
    });
    expect(wygasla.subject).not.toBe(cofnieta.subject);
    expect(cofnieta.html).toContain('zwróciło opłatę');
  });

  it('E nie używa słowa PRO — użytkownik go nigdzie nie widzi', () => {
    const mail = render('SUBSCRIPTION_EXPIRED', {
      planName: 'Solo',
      expiredAtIso: null,
      revoked: false,
    });
    expect(mail.subject).not.toContain('PRO');
    expect(mail.html).not.toContain('PRO ');
    expect(mail.text).not.toContain('PRO ');
  });

  it('F mówi prawdę o przepisach w każdym z trzech przypadków', () => {
    const zDomem = render('ACCOUNT_DELETED', {
      email: 'a@b.pl',
      deletedAtIso: '2026-09-10T20:00:00.000Z',
      householdRemains: true,
      keptRecipes: 12,
      hasLiveSubscription: false,
    });
    expect(zDomem.html).toContain('12 przepisów');
    // Żadnej mechaniki „pod maską" — użytkownik nie musi wiedzieć o botach ani autorstwie.
    expect(zDomem.html).not.toContain('autorstwo');
    expect(zDomem.html).not.toContain('pseudonim');

    const zDomemBezPrzepisow = render('ACCOUNT_DELETED', {
      email: 'a@b.pl',
      deletedAtIso: '2026-09-10T20:00:00.000Z',
      householdRemains: true,
      keptRecipes: 0,
      hasLiveSubscription: false,
    });
    expect(zDomemBezPrzepisow.html).not.toContain('0 przepisów');

    const samotny = render('ACCOUNT_DELETED', {
      email: 'a@b.pl',
      deletedAtIso: '2026-09-10T20:00:00.000Z',
      householdRemains: false,
      keptRecipes: 0,
      hasLiveSubscription: false,
    });
    expect(samotny.html).toContain('Dom zniknął razem z kontem');
  });

  it('F ostrzega o subskrypcji TYLKO wtedy, gdy jest żywa', () => {
    const zSubskrypcja = render('ACCOUNT_DELETED', {
      email: 'a@b.pl',
      deletedAtIso: '2026-09-10T20:00:00.000Z',
      householdRemains: true,
      keptRecipes: 1,
      hasLiveSubscription: true,
    });
    expect(zSubskrypcja.html).toContain('Subskrypcja nie kończy się razem');
    expect(zSubskrypcja.text).toContain('Wyłącz odnawianie');

    const bez = render('ACCOUNT_DELETED', {
      email: 'a@b.pl',
      deletedAtIso: '2026-09-10T20:00:00.000Z',
      householdRemains: true,
      keptRecipes: 1,
      hasLiveSubscription: false,
    });
    expect(bez.html).not.toContain('Subskrypcja nie kończy się razem');
  });

  it('G przy zmianie istotnej nie mówi, że wystarczy dalej korzystać', () => {
    const zwykla = render('LEGAL_UPDATE', {
      effectiveDateIso: '2026-10-01T00:00:00.000Z',
      version: '2026-10-01',
      requiresConsent: false,
      changes: [{ title: 'A', body: 'B' }],
    });
    const istotna = render('LEGAL_UPDATE', {
      effectiveDateIso: '2026-10-01T00:00:00.000Z',
      version: '2026-10-01',
      requiresConsent: true,
      changes: [{ title: 'A', body: 'B' }],
    });
    expect(zwykla.html).toContain('oznacza akceptację nowej wersji');
    expect(istotna.html).not.toContain('oznacza akceptację nowej wersji');
    expect(istotna.html).toContain('poprosimy Cię w aplikacji');
  });

  it('B z długą nazwą domu ma temat bez nazwy zamiast nazwy uciętej w połowie', () => {
    const mail = render('HOUSEHOLD_JOINED', {
      householdName:
        'Gospodarstwo Rodziny Wroniewicz-Kowalskich przy Wiśniowej',
      members: [{ name: 'Ala', avatarColor: 0 }],
    });
    expect(mail.subject).toBe('Witaj w nowym gospodarstwie');
    // Sama nazwa nadal jest w treści — ucinamy tylko temat.
    expect(mail.html).toContain('Wroniewicz-Kowalskich');
  });
});

describe('daty', () => {
  it('formatują się po polsku i w polskiej strefie', () => {
    // 00:30 UTC to w Warszawie już następny dzień — data w mailu ma zgadzać
    // się z tym, co widzi użytkownik, nie z UTC.
    const mail = render('AI_QUOTA_EXHAUSTED', {
      exhausted: 'messages',
      planName: 'Solo',
      isPayer: true,
      payerName: null,
      messagesUsed: 30,
      messagesLimit: 30,
      plansUsed: 1,
      plansLimit: 8,
      renewsAtIso: '2026-10-13T23:30:00.000Z',
      renews: true,
    });
    expect(mail.subject).toBe('Asystent wraca 14 października');
  });
});

describe('sprawdzanie danych', () => {
  it('brak wymaganego pola kończy się czytelnym błędem, nie dziurą w mailu', () => {
    expect(() =>
      render('WELCOME', { trialMessages: 5, trialPlans: 1 }),
    ).toThrow(/displayName/);
    expect(() =>
      render('HOUSEHOLD_JOINED', { householdName: 'Dom', members: [] }),
    ).toThrow(/members/);
    expect(() =>
      render('AI_TRIAL_EXHAUSTED', {
        exhausted: 'wszystko',
        messagesUsed: 1,
        messagesLimit: 5,
        plansUsed: 0,
        plansLimit: 1,
      }),
    ).toThrow(/messages/);
  });

  it('domownik bez nazwy jest wskazany po indeksie', () => {
    expect(() =>
      render('HOUSEHOLD_JOINED', {
        householdName: 'Dom',
        members: [{ name: 'Ala' }, { avatarColor: 1 }],
      }),
    ).toThrow(/domownik 1/);
  });
});
