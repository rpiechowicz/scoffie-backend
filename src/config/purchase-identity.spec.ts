import {
  hasRealPurchaseIdentityPepper,
  identityHashEquals,
  purchaseIdentityHash,
  purchaseIdentityHashForUser,
  subscriptionScopeId,
  trialScopeId,
} from './purchase-identity';

/**
 * Tożsamość zakupowa ma jedno zadanie: przeżyć skasowanie konta. Testy
 * pilnują dokładnie tego — że ten sam człowiek dostaje ten sam hasz, że różni
 * ludzie nie zlewają się w jedno i że zakres puli próbnej nie ma nic wspólnego
 * z gospodarstwem.
 */
describe('purchaseIdentityHash', () => {
  const originalPepper = process.env.PURCHASE_IDENTITY_PEPPER;
  afterEach(() => {
    if (originalPepper === undefined)
      delete process.env.PURCHASE_IDENTITY_PEPPER;
    else process.env.PURCHASE_IDENTITY_PEPPER = originalPepper;
  });

  it('ten sam identyfikator Apple daje ten sam hasz — konto może zniknąć', () => {
    process.env.PURCHASE_IDENTITY_PEPPER = 'pieprz-testowy';
    const first = purchaseIdentityHash('APPLE', '000111.abcdef.2222');
    const afterDeleteAndSignUpAgain = purchaseIdentityHash(
      'APPLE',
      '000111.abcdef.2222',
    );
    expect(first).toBe(afterDeleteAndSignUpAgain);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('nie da się z hasza odtworzyć identyfikatora Apple', () => {
    process.env.PURCHASE_IDENTITY_PEPPER = 'pieprz-testowy';
    const hash = purchaseIdentityHash('APPLE', '000111.abcdef.2222');
    expect(hash).not.toContain('000111');
    expect(hash).not.toContain('abcdef');
  });

  it('różni ludzie i różni dostawcy nie zlewają się w jedną tożsamość', () => {
    process.env.PURCHASE_IDENTITY_PEPPER = 'pieprz-testowy';
    const a = purchaseIdentityHash('APPLE', 'sub-1');
    const b = purchaseIdentityHash('APPLE', 'sub-2');
    const sameSubOtherProvider = purchaseIdentityHash('GOOGLE', 'sub-1');
    expect(a).not.toBe(b);
    expect(a).not.toBe(sameSubOtherProvider);
  });

  it('zmiana pieprzu przestawia WSZYSTKIE hasze — dlatego jest nierotowalny', () => {
    process.env.PURCHASE_IDENTITY_PEPPER = 'pierwszy';
    const before = purchaseIdentityHash('APPLE', 'sub-1');
    process.env.PURCHASE_IDENTITY_PEPPER = 'drugi';
    expect(purchaseIdentityHash('APPLE', 'sub-1')).not.toBe(before);
  });

  it('brak identyfikatora daje `null`, a nie hasz z pustego napisu', () => {
    expect(purchaseIdentityHash('APPLE', null)).toBeNull();
    expect(purchaseIdentityHash('APPLE', '   ')).toBeNull();
    expect(purchaseIdentityHashForUser({})).toBeNull();
  });

  it('Apple ma pierwszeństwo przed Google — to Apple jest bramką zakupu', () => {
    process.env.PURCHASE_IDENTITY_PEPPER = 'pieprz-testowy';
    const both = purchaseIdentityHashForUser({
      appleSub: 'sub-apple',
      googleId: 'id-google',
    });
    expect(both).toBe(purchaseIdentityHash('APPLE', 'sub-apple'));
  });

  it('brak zmiennej środowiskowej daje działający, ale rozpoznawalny pieprz', () => {
    delete process.env.PURCHASE_IDENTITY_PEPPER;
    expect(hasRealPurchaseIdentityPepper()).toBe(false);
    // Aplikacja MA wstać bez tej zmiennej — brak startu psuje więcej niż
    // przewidywalny pieprz.
    expect(purchaseIdentityHash('APPLE', 'sub-1')).toMatch(/^[0-9a-f]{64}$/);
    process.env.PURCHASE_IDENTITY_PEPPER = 'cokolwiek-prawdziwego';
    expect(hasRealPurchaseIdentityPepper()).toBe(true);
  });
});

describe('zakresy licznika', () => {
  it('pula próbna wisi na OSOBIE, nie na gospodarstwie', () => {
    // To jest cała obrona przed „wyjdź z domu → załóż nowy → świeża próba".
    const hash = 'a'.repeat(64);
    expect(trialScopeId(hash, 'user-1')).toBe(`trial:${hash}`);
    expect(trialScopeId(hash, 'user-2')).toBe(`trial:${hash}`);
  });

  it('bez hasza zakres siada na koncie i sam się naprawia po zalogowaniu', () => {
    expect(trialScopeId(null, 'user-1')).toBe('trial:user:user-1');
  });

  it('pula PRO wisi na UMOWIE — przeprowadzka jej nie odnawia', () => {
    expect(subscriptionScopeId('sub-uuid')).toBe('sub:sub-uuid');
  });

  it('zakresy nie mogą kolidować z UUID gospodarstwa ani z `global`', () => {
    const hash = 'a'.repeat(64);
    for (const scope of [trialScopeId(hash, 'u'), subscriptionScopeId('s')]) {
      expect(scope).toContain(':');
      expect(scope).not.toBe('global');
      expect(scope).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe('identityHashEquals', () => {
  it('porównuje równe i odrzuca różne oraz puste', () => {
    const hash = 'a'.repeat(64);
    expect(identityHashEquals(hash, hash)).toBe(true);
    expect(identityHashEquals(hash, 'b'.repeat(64))).toBe(false);
    expect(identityHashEquals(hash, null)).toBe(false);
    expect(identityHashEquals(null, null)).toBe(false);
    // Różna długość nie może rzucać wyjątkiem z `timingSafeEqual`.
    expect(identityHashEquals(hash, 'krótkie')).toBe(false);
  });
});
