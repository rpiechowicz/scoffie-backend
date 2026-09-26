import { AGENT_TOOLS } from './agent-tools';

/**
 * Kontrakty narzędzi po Etapie 6.1 — bez modelu. Nie sprawdzamy
 * „inteligencji" modelu, tylko to, czy schemat i opis JEDNOZNACZNIE prowadzą
 * do właściwego narzędzia, a narzędzie samo niesie logikę domeny (model nie
 * podaje liczb, których nie powinien liczyć).
 */
function tool(name: string) {
  const found = AGENT_TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`brak narzędzia ${name}`);
  const schema = found.input_schema as unknown as {
    properties: Record<
      string,
      { type?: string; description?: string; items?: unknown }
    >;
    required?: string[];
  };
  return { description: found.description, schema };
}

describe('kontrakty narzędzi (Etap 6.1)', () => {
  it('g4: build_meal_plan ma cel dnia z prośby — wymagany, 0 = profil', () => {
    const { schema } = tool('build_meal_plan');
    expect(schema.properties.day_kcal_target?.type).toBe('integer');
    expect(schema.required).toContain('day_kcal_target');
    expect(schema.properties.day_kcal_target?.description).toMatch(
      /0 = cel z profilu/,
    );
  });

  it('g8: podział dania — bez liczbowych porcji od modelu, [] = cały dom, opis obejmuje rozdzielenie posiłku', () => {
    const { schema, description } = tool('propose_household_split');
    const items = schema.properties.portions?.items as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(items.properties).sort()).toEqual(['note', 'user_id']);
    expect(schema.properties.portions?.description).toMatch(/\[\] = cały dom/);
    expect(description).toMatch(/ROZDZIELIĆ/);
    expect(description).toMatch(/liczy\s+serwer/);
  });

  it('g8/g13: suggest_meals nie jest drogą do rozdzielania posiłku ani zmiany dania; „pokaż inne" = to samo narzędzie', () => {
    const { description } = tool('suggest_meals');
    expect(description).toMatch(/propose_household_split/);
    expect(description).toMatch(/replace_plan_item/);
    expect(description).toMatch(/Pokaż inne/);
  });

  it('g9: limit czasu w planie i podmianie jest TWARDY', () => {
    for (const name of ['build_meal_plan', 'replace_plan_item']) {
      expect(
        tool(name).schema.properties.max_prep_minutes?.description,
      ).toMatch(/TWARDY/);
    }
  });

  it('g11: update_recipe nie każe kopiować przepisu katalogowego — serwer sam wyjaśnia', () => {
    const { description, schema } = tool('update_recipe');
    expect(description).toMatch(/tylko do odczytu/);
    expect(description).not.toMatch(/zrób własną kopię przez create_recipe/);
    expect(schema.properties.recipe_id?.description).toMatch(/indeks katalogu/);
  });
});
