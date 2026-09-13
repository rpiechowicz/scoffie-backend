import { PATH_METADATA } from '@nestjs/common/constants';
import { BillingOpsController } from '../billing/billing-ops.controller';
import { OpsController } from './ops.controller';
import { OpsTokenGuard } from './ops-token.guard';

/**
 * Czy KAŻDA trasa operatorska naprawdę ma na sobie bramkę.
 *
 * `ops-token.guard.spec.ts` sprawdza, że bramka poprawnie porównuje token.
 * To jest inne pytanie — czy ktoś ją w ogóle założył. Różnica ma znaczenie,
 * bo za tymi trasami stoi nadanie PRO (`POST /ops/households/:id/tier`,
 * `POST /ops/billing/grant`) i zerowanie licznika kosztu
 * (`POST /ops/billing/households/:id/cost-reset`). Zapomniany dekorator na
 * nowej trasie to nie „brak metryki" — to darmowy plan płatny dla każdego,
 * kto zna adres, i nie widać tego w żadnym teście bramki samej w sobie.
 *
 * Test czyta metadane Nesta, a nie listę tras przepisaną ręcznie: trasa
 * dopisana za pół roku jest sprawdzona bez niczyjej pamięci.
 *
 * `OpsController` trzyma bramkę PER TRASĘ (bo `/ops/health` musi zostać
 * publiczny dla sondy Railway), `BillingOpsController` — na całym
 * kontrolerze. Obie formy są tu poprawne, więc test uznaje jedną albo drugą.
 */

/** Trasy świadomie publiczne — z powodem. Wszystko inne musi mieć bramkę. */
const PUBLIC_ON_PURPOSE: Record<string, string> = {
  health:
    'sonda żywotności Railway pyta bez nagłówka; 403 wyglądałoby jak padnięty serwis i wywróciłoby deploy',
};

type Route = { controller: string; handler: string; path: string };

/** Nazwy metod-handlerów kontrolera (te z `@Get`/`@Post`/… mają PATH). */
function routesOf(controller: new (...args: never[]) => unknown): Route[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .filter((name) => typeof prototype[name] === 'function')
    .filter(
      (name) =>
        Reflect.getMetadata(PATH_METADATA, prototype[name] as object) !==
        undefined,
    )
    .map((name) => ({
      controller: controller.name,
      handler: name,
      path: String(
        Reflect.getMetadata(PATH_METADATA, prototype[name] as object),
      ),
    }));
}

/** Bramki z metody ORAZ z kontrolera — Nest stosuje jedne i drugie. */
function guardsFor(
  controller: new (...args: never[]) => unknown,
  handler: string,
): unknown[] {
  const onClass: unknown[] =
    (Reflect.getMetadata('__guards__', controller) as unknown[]) ?? [];
  const onMethod: unknown[] =
    (Reflect.getMetadata(
      '__guards__',
      (controller.prototype as Record<string, unknown>)[handler] as object,
    ) as unknown[]) ?? [];
  return [...onClass, ...onMethod];
}

const CONTROLLERS = [OpsController, BillingOpsController] as const;

describe('trasy operatorskie są za bramką OPS_TOKEN', () => {
  const routes = CONTROLLERS.flatMap((controller) =>
    routesOf(controller).map((route) => ({ controller, route })),
  );

  it('reflektor widzi trasy obu kontrolerów (inaczej test jest pustą pętlą)', () => {
    // Bez tego zmiana w metadanych Nesta (albo literówka w kluczu) zamienia
    // wszystkie asercje niżej w zero iteracji — test zielony, bramek nie ma.
    const paths = routes.map(({ route }) => route.path);
    expect(routes.length).toBeGreaterThanOrEqual(13);
    expect(paths).toContain('households/:id/tier');
    expect(paths).toContain('grant');
    expect(paths).toContain('health');
  });

  it.each(
    routes.map(
      ({ controller, route }) =>
        [
          `${route.controller}.${route.handler} (${route.path})`,
          controller,
          route,
        ] as const,
    ),
  )('%s', (_label, controller, route) => {
    const reason = PUBLIC_ON_PURPOSE[route.path];
    const guards = guardsFor(controller, route.handler);
    const guarded = guards.includes(OpsTokenGuard);

    if (reason) {
      // Trasa z listy wyjątków ma być publiczna — gdyby ktoś dołożył jej
      // bramkę, sonda Railway przestałaby działać i o tym też chcemy wiedzieć.
      expect(guarded).toBe(false);
      return;
    }
    expect(guarded).toBe(true);
  });
});
