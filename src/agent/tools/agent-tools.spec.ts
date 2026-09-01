import { AGENT_TOOL_NAMES, AGENT_TOOLS } from './agent-tools';

/**
 * Strażnik kontraktu narzędzi.
 *
 * Schemat narzędzia to nie dokumentacja — to jedyna bariera między tym, co
 * model wymyśli, a naszym kodem. `strict: true` działa TYLKO wtedy, gdy każdy
 * obiekt w schemacie (także zagnieżdżony) ma `additionalProperties: false`
 * i komplet `required`; jedno przeoczenie po cichu wyłącza gwarancję dla
 * całej gałęzi.
 */
type JsonObject = Record<string, unknown>;

const isObjectSchema = (value: unknown): value is JsonObject =>
  typeof value === 'object' &&
  value !== null &&
  (value as JsonObject).type === 'object';

/** Wszystkie schematy obiektowe w drzewie — łącznie z `items` tablic. */
function collectObjectSchemas(node: unknown, found: JsonObject[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectObjectSchemas(child, found);
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;
  if (isObjectSchema(node)) found.push(node);
  for (const value of Object.values(node as JsonObject)) {
    collectObjectSchemas(value, found);
  }
  return found;
}

describe('AGENT_TOOLS', () => {
  it('nazwy są unikalne', () => {
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOL_NAMES.length);
  });

  it.each(AGENT_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s: kontrakt schematu',
    (_name, tool) => {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.strict).toBe(true);

      // Opis steruje wyborem narzędzia — pusty albo jednozdaniowy placeholder
      // znaczy, że model będzie zgadywał, kiedy po nie sięgnąć.
      expect(tool.description.length).toBeGreaterThan(60);

      for (const schema of collectObjectSchemas(tool.input_schema)) {
        expect(schema.additionalProperties).toBe(false);
        expect(Array.isArray(schema.required)).toBe(true);

        const properties = (schema.properties ?? {}) as JsonObject;
        for (const key of schema.required as string[]) {
          // `required` wskazujące pole spoza `properties` to schemat, którego
          // nie da się spełnić — model dostawałby błąd przy każdej próbie.
          expect(Object.keys(properties)).toContain(key);
        }
      }
    },
  );

  it('narzędzia zapisujące plan mają dry-run', () => {
    const apply = AGENT_TOOLS.find((tool) => tool.name === 'apply_week_plan');
    expect(apply?.input_schema.properties).toHaveProperty('dry_run');
  });

  it('żadne narzędzie nie ma POLA na wartości odżywcze', () => {
    // Makra liczy serwer ze składników. Pole na nie w schemacie byłoby
    // zaproszeniem do wpisania liczb, których nikt nie sprawdzi. Sprawdzamy
    // nazwy pól, nie opisy — w opisach o kaloriach mówimy celowo.
    const fieldNames = AGENT_TOOLS.flatMap((tool) =>
      collectObjectSchemas(tool.input_schema).flatMap((schema) =>
        Object.keys((schema.properties ?? {}) as JsonObject),
      ),
    );
    // Zakotwiczone na początku nazwy: `only_with_nutrition` to FILTR wyszukiwania,
    // a nie miejsce na wpisanie liczby.
    expect(fieldNames).not.toContainEqual(
      expect.stringMatching(/^(kcal|nutrition|protein|carbs|fat|fiber)/i),
    );
  });

  it('schematy nie używają słów kluczowych, których tryb ścisły nie przyjmuje', () => {
    // Sprawdzone na żywym API: przy `strict: true` `minimum`/`maximum` na
    // `integer` kończy się `invalid_request_error`. Granice liczbowe piszemy
    // w opisie, a pilnuje ich i tak walidacja DTO po naszej stronie.
    const unsupported = [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minItems',
      'maxItems',
      'minLength',
      'maxLength',
      'pattern',
      'format',
    ];
    const serialized = JSON.stringify(AGENT_TOOLS);
    for (const keyword of unsupported) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
  });

  it('narzędzia tworzące przepis wymagają składników', () => {
    const create = AGENT_TOOLS.find((tool) => tool.name === 'create_recipe');
    expect(create?.input_schema.required).toContain('ingredients');
  });

  // Limit API, na który nie ma obejścia: przy `strict: true` Anthropic
  // kompiluje ze schematów gramatykę i odmawia, gdy pól nieobowiązkowych
  // jest więcej niż 24 — CAŁA odpowiedź to wtedy 400, jeszcze zanim model
  // cokolwiek zobaczy. Dwa razy niebezpieczne, bo żaden test tego nie łapie:
  // dostawca `stub` schematów nie waliduje, więc suita jest zielona, a tura
  // pada dopiero u użytkownika. Trzymamy zapas, żeby kolejna karta nie
  // zatrzymała się na tej ścianie.
  it('pól nieobowiązkowych mieści się w limicie schematów (24)', () => {
    type Schema = {
      properties?: Record<string, Schema>;
      required?: string[];
      items?: Schema;
    };

    const countOptional = (schema: Schema | undefined): number => {
      if (!schema) return 0;
      let total = 0;
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        for (const [name, child] of Object.entries(schema.properties)) {
          if (!required.has(name)) total += 1;
          total += countOptional(child);
        }
      }
      if (schema.items) total += countOptional(schema.items);
      return total;
    };

    const total = AGENT_TOOLS.reduce(
      (sum, tool) => sum + countOptional(tool.input_schema as Schema),
      0,
    );
    expect(total).toBeLessThanOrEqual(24);
  });
});
