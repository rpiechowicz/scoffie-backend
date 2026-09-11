import { MailOutboxService } from './mail-outbox.service';
import { PrismaService } from '../prisma/prisma.service';

type Klient = {
  mailSuppression: { findUnique: jest.Mock };
  mailMessage: { createMany: jest.Mock };
};

const klient = (): Klient => ({
  mailSuppression: { findUnique: jest.fn().mockResolvedValue(null) },
  mailMessage: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
});

const wejscie = {
  template: 'WELCOME' as const,
  dedupeKey: 'welcome:u1',
  to: 'Kto@Example.PL',
  userId: 'u1',
  payload: { displayName: 'Ala', trialMessages: 5, trialPlans: 1 },
};

describe('MailOutboxService', () => {
  const poprzednie = { ...process.env };

  beforeEach(() => {
    process.env.MAIL_ENABLED = 'true';
  });

  afterEach(() => {
    process.env = { ...poprzednie };
    jest.restoreAllMocks();
  });

  const build = (c: Klient) =>
    new MailOutboxService(c as unknown as PrismaService);

  it('kolejkuje maila i zachowuje wielkość liter w adresie', async () => {
    const c = klient();
    const wynik = await build(c).enqueue(c as never, wejscie);

    expect(wynik).toBe('QUEUED');
    const dane = c.mailMessage.createMany.mock.calls[0][0];
    expect(dane.skipDuplicates).toBe(true);
    expect(dane.data[0].to).toBe('Kto@Example.PL');
    // Do porównań z listą wykluczeń idzie postać znormalizowana.
    expect(c.mailSuppression.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'kto@example.pl' } }),
    );
  });

  it('wyłączona poczta nie kolejkuje NIC — także po włączeniu nie ma zaległości', async () => {
    process.env.MAIL_ENABLED = 'false';
    const c = klient();
    const wynik = await build(c).enqueue(c as never, wejscie);

    expect(wynik).toBe('MAIL_DISABLED');
    expect(c.mailMessage.createMany).not.toHaveBeenCalled();
  });

  it('konto bez adresu jest pomijane, a nie traktowane jak błąd', async () => {
    const c = klient();
    const wynik = await build(c).enqueue(c as never, { ...wejscie, to: null });

    expect(wynik).toBe('NO_ADDRESS');
    expect(c.mailMessage.createMany).not.toHaveBeenCalled();
    // Brak adresu to normalny stan przy Sign in with Apple — nie pytamy
    // nawet o listę wykluczeń.
    expect(c.mailSuppression.findUnique).not.toHaveBeenCalled();
  });

  it('adres z listy wykluczeń nie trafia do kolejki', async () => {
    const c = klient();
    c.mailSuppression.findUnique.mockResolvedValue({ email: 'kto@example.pl' });

    const wynik = await build(c).enqueue(c as never, wejscie);

    expect(wynik).toBe('SUPPRESSED');
    expect(c.mailMessage.createMany).not.toHaveBeenCalled();
  });

  it('adres, który nie wygląda na adres, odpada bez pytania dostawcy', async () => {
    const c = klient();
    const wynik = await build(c).enqueue(c as never, {
      ...wejscie,
      to: 'to nie jest adres',
    });
    expect(wynik).toBe('INVALID_ADDRESS');
  });

  it('drugie zdarzenie z tym samym kluczem NIE tworzy drugiego maila', async () => {
    const c = klient();
    c.mailMessage.createMany.mockResolvedValue({ count: 0 });

    const wynik = await build(c).enqueue(c as never, wejscie);

    // `ON CONFLICT DO NOTHING`, nie wyjątek: w Postgresie naruszenie unikatu
    // unieważnia CAŁĄ transakcję, a pożegnanie kolejkuje się w środku
    // transakcji kasującej konto.
    expect(wynik).toBe('DUPLICATE');
  });

  it('awaria bazy nie wywraca operacji, którą mail miał tylko opisać', async () => {
    const c = klient();
    c.mailMessage.createMany.mockRejectedValue(new Error('padło'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(build(c).enqueue(c as never, wejscie)).resolves.toBeDefined();
  });
});
