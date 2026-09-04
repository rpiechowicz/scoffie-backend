import {
  acceptedTransactionEnvironments,
  parseAppleEnvironment,
  readAcceptSandbox,
  readAppleEnvironment,
} from './apple-environment';
import { billingEnvProblems } from './billing-env-problems';
import { readBillingEnv } from '../billing/billing-env';
import { subscriptionAlive } from './subscription-lifetime';

/**
 * ŚRODOWISKO APP STORE. Trzy rzeczy, na których stała cała ta luka:
 * literówka wybierała sandbox po cichu, pusta zmienna liczbowa dawała zero,
 * a wiersz zapisany przy złej konfiguracji dawał PRO na zawsze.
 */
describe('środowisko App Store', () => {
  const originals = { ...process.env };
  afterEach(() => {
    process.env = { ...originals };
  });

  describe('parseAppleEnvironment', () => {
    it('brak wartości = Sandbox (nie sprzedajemy jeszcze)', () => {
      expect(parseAppleEnvironment(undefined)).toBe('Sandbox');
      expect(parseAppleEnvironment('')).toBe('Sandbox');
      expect(parseAppleEnvironment('   ')).toBe('Sandbox');
    });

    it('wielkość liter nie ma znaczenia — „production" działa', () => {
      expect(parseAppleEnvironment('Production')).toBe('Production');
      expect(parseAppleEnvironment('production')).toBe('Production');
      expect(parseAppleEnvironment(' PRODUCTION ')).toBe('Production');
    });

    it('napis, którego nie rozpoznajemy, to `null` — czyli coś do zgłoszenia', () => {
      // To jest sedno: wcześniej „Prodution" po cichu znaczyło Sandbox.
      expect(parseAppleEnvironment('Prodution')).toBeNull();
      expect(parseAppleEnvironment('prod-eu')).toBeNull();
    });
  });

  it('literówka w APPLE_ENVIRONMENT jest ZGŁASZANA przy starcie', () => {
    const problems = billingEnvProblems({
      APPLE_ENVIRONMENT: 'Prodution',
      PURCHASE_IDENTITY_PEPPER: 'x'.repeat(40),
    } as NodeJS.ProcessEnv);
    expect(problems.join(' | ')).toContain('Prodution');
  });

  it('AI_TIER_OVERRIDE=PRO jest głośne NAWET przy wyłączonych zakupach', () => {
    const problems = billingEnvProblems({
      AI_TIER_OVERRIDE: 'PRO',
      PURCHASE_IDENTITY_PEPPER: 'x'.repeat(40),
    } as NodeJS.ProcessEnv);
    expect(problems.join(' | ')).toContain('za darmo');
  });

  it('„production" małą literą NIE jest już problemem na produkcji', () => {
    const problems = billingEnvProblems({
      NODE_ENV: 'production',
      BILLING_ENABLED: 'true',
      APPLE_ENVIRONMENT: 'production',
      APPLE_ISSUER_ID: 'i',
      APPLE_BILLING_KEY_ID: 'k',
      APPLE_BILLING_PRIVATE_KEY: 'p',
      PURCHASE_IDENTITY_PEPPER: 'x'.repeat(40),
    } as NodeJS.ProcessEnv);
    expect(problems.join(' | ')).not.toContain('APPLE_ENVIRONMENT');
  });

  describe('acceptedTransactionEnvironments', () => {
    it('na produkcji sandbox NIE wchodzi', () => {
      process.env.APPLE_ENVIRONMENT = 'Production';
      delete process.env.APPLE_ACCEPT_SANDBOX;
      expect(readAppleEnvironment()).toBe('Production');
      expect(readAcceptSandbox()).toBe(false);
      expect(acceptedTransactionEnvironments()).toEqual(['Production']);
    });

    it('poza produkcją sandbox wchodzi domyślnie', () => {
      process.env.APPLE_ENVIRONMENT = 'Sandbox';
      delete process.env.APPLE_ACCEPT_SANDBOX;
      expect(acceptedTransactionEnvironments()).toEqual(['Sandbox']);
    });

    it('jawna zgoda na produkcji dokłada sandbox (i tylko wtedy)', () => {
      process.env.APPLE_ENVIRONMENT = 'Production';
      process.env.APPLE_ACCEPT_SANDBOX = 'true';
      expect(acceptedTransactionEnvironments()).toEqual([
        'Production',
        'Sandbox',
      ]);
    });
  });

  describe('subskrypcja z niewłaściwego środowiska', () => {
    const zywa = {
      id: 'sub-1',
      provider: 'APPLE',
      productId: 'app.scoffie.pro.solo.monthly',
      status: 'ACTIVE',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      graceExpiresAt: null,
      neverExpires: false,
      revokedAt: null,
      messagesLimitSnapshot: 30,
      plansLimitSnapshot: 8,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    };
    const NOW = new Date('2026-09-15T00:00:00.000Z');

    it('wiersz z sandboxa NIE daje PRO na produkcji', () => {
      // Bez tego literówka w konfiguracji zostawiała po sobie wiersze
      // rozdające darmowe PRO na zawsze — poprawienie zmiennej ich nie ruszało.
      process.env.APPLE_ENVIRONMENT = 'Production';
      delete process.env.APPLE_ACCEPT_SANDBOX;
      expect(subscriptionAlive({ ...zywa, environment: 'Sandbox' }, NOW)).toBe(
        false,
      );
      expect(
        subscriptionAlive({ ...zywa, environment: 'Production' }, NOW),
      ).toBe(true);
    });

    it('nadanie ręczne bez środowiska liczy się zawsze', () => {
      process.env.APPLE_ENVIRONMENT = 'Production';
      expect(
        subscriptionAlive(
          { ...zywa, provider: 'MANUAL', environment: null },
          NOW,
        ),
      ).toBe(true);
    });

    it('blokada operatora ucina dostęp mimo żywej daty i braku zwrotu', () => {
      process.env.APPLE_ENVIRONMENT = 'Production';
      expect(
        subscriptionAlive(
          {
            ...zywa,
            environment: 'Production',
            operatorHoldAt: new Date('2026-09-10T00:00:00.000Z'),
          },
          NOW,
        ),
      ).toBe(false);
    });
  });

  describe('liczby z konfiguracji płatności', () => {
    it('PUSTA zmienna to brak wartości, nie zero', () => {
      // `Number('')` daje 0, a puste pole zostawia się w Railway jednym
      // kliknięciem. Limit czasu 0 ms = każde pytanie do Apple przerwane
      // natychmiast, czyli paywall, który nie potwierdza żadnego zakupu.
      process.env.APPLE_SERVER_API_TIMEOUT_MS = '';
      process.env.APPLE_RECONCILE_AFTER_HOURS = '   ';
      const env = readBillingEnv();
      expect(env.serverApiTimeoutMs).toBe(8000);
      expect(env.reconcileAfterHours).toBe(24);
    });

    it('jawne zero też nie przechodzi tam, gdzie zero nie ma sensu', () => {
      process.env.APPLE_SERVER_API_TIMEOUT_MS = '0';
      expect(readBillingEnv().serverApiTimeoutMs).toBe(8000);
    });

    it('sensowna wartość przechodzi', () => {
      process.env.APPLE_SERVER_API_TIMEOUT_MS = '2500';
      expect(readBillingEnv().serverApiTimeoutMs).toBe(2500);
    });
  });

  it('Chmura Rodzinna jest domyślnie WYŁĄCZONA', () => {
    delete process.env.APPLE_ACCEPT_FAMILY_SHARED;
    expect(readBillingEnv().acceptFamilyShared).toBe(false);
    process.env.APPLE_ACCEPT_FAMILY_SHARED = 'true';
    expect(readBillingEnv().acceptFamilyShared).toBe(true);
  });
});
