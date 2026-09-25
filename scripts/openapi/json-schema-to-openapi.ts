/**
 * JSON Schema (draft-07, z `typescript-json-schema`) → schemat OpenAPI 3.0.
 *
 * Generatory klientów (openapi-generator dla Kotlina) czytają OpenAPI 3.0
 * pewniej niż 3.1, a 3.0 nie zna `type: [..., "null"]`, `const` ani krotek.
 * Tu jest jedyne miejsce, które te konstrukcje tłumaczy — reszta generatora
 * operuje już na gotowych schematach OpenAPI.
 */

export type Schema = Record<string, unknown>;

const DROP_KEYS = new Set([
  '$schema',
  'definitions',
  'propertyOrder',
  'defaultProperties',
  'typeof',
  '$id',
]);

/** `#/definitions/%24Enums.MealType` → `$Enums.MealType`. */
export function definitionNameFromRef(ref: string): string | null {
  const prefix = '#/definitions/';
  if (!ref.startsWith(prefix)) return null;
  return decodeURIComponent(ref.slice(prefix.length));
}

/**
 * Nazwa komponentu z nazwy definicji — albo `null`, gdy definicja nie ma
 * sensownej nazwy (typ anonimowy `{a:string;…}`, generyk `Omit<…>`) i ma
 * zostać wstawiona w miejscu użycia.
 */
export function componentNameFor(definition: string): string | null {
  const last = definition.split('.').pop() ?? definition;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(last) ? last : null;
}

/** `{type: "null"}` — albo już przetłumaczone `{nullable: true}`. */
function isNullSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const s = schema as Schema;
  const keys = Object.keys(s).filter((k) => k !== 'default');
  return (
    keys.length === 1 &&
    (s.type === 'null' || (keys[0] === 'nullable' && s.nullable === true))
  );
}

/** `nullable` obok `$ref` OpenAPI 3.0 ignoruje — stąd opakowanie w `allOf`. */
function withNullable(schema: Schema): Schema {
  if (typeof schema.$ref === 'string') {
    return { allOf: [{ $ref: schema.$ref }], nullable: true };
  }
  return { ...schema, nullable: true };
}

export function toOpenApiSchema(
  input: unknown,
  resolveRef: (ref: string) => Schema,
): Schema {
  if (typeof input !== 'object' || input === null) return {};
  const schema = input as Schema;

  if (typeof schema.$ref === 'string') {
    // Rodzeństwo `$ref` (opis, domyślna) OpenAPI 3.0 i tak pomija.
    return resolveRef(schema.$ref);
  }

  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_KEYS.has(key)) continue;
    switch (key) {
      case 'properties': {
        const props: Schema = {};
        for (const [name, prop] of Object.entries(value as Schema)) {
          props[name] = toOpenApiSchema(prop, resolveRef);
        }
        out.properties = props;
        break;
      }
      case 'items':
        out.items = Array.isArray(value)
          ? // Krotka — OpenAPI 3.0 jej nie zna; najbliżej jest lista „któregoś z”.
            { oneOf: value.map((item) => toOpenApiSchema(item, resolveRef)) }
          : toOpenApiSchema(value, resolveRef);
        break;
      case 'additionalProperties':
        out.additionalProperties =
          typeof value === 'boolean'
            ? value
            : toOpenApiSchema(value, resolveRef);
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
        out[key] = (value as unknown[]).map((item) =>
          toOpenApiSchema(item, resolveRef),
        );
        break;
      case 'const':
        out.enum = [value];
        break;
      default:
        out[key] = value;
    }
  }

  // `type: ["null", "string"]` → `type: string, nullable: true`.
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== 'null');
    const nullable = types.length !== (out.type as string[]).length;
    if (types.length === 1) {
      out.type = types[0];
    } else {
      delete out.type;
      const rest = { ...out };
      for (const k of Object.keys(out)) delete out[k];
      out.oneOf = types.map((type) => ({ ...rest, type }));
    }
    if (nullable) out.nullable = true;
  }

  // `anyOf: [X, {type: null}]` → X z `nullable`.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = out[key] as Schema[] | undefined;
    if (!variants) continue;
    const nonNull = variants.filter((v) => !isNullSchema(v));
    if (nonNull.length === variants.length) continue;
    if (nonNull.length === 1) {
      delete out[key];
      const merged = withNullable(nonNull[0]);
      return { ...merged, ...out, nullable: true };
    }
    out[key] = nonNull;
    out.nullable = true;
  }

  // Samo `null` (np. pole zawsze puste w jednej z gałęzi unii) — 3.0 nie ma
  // typu `null`, jest tylko `nullable`.
  if (out.type === 'null') {
    delete out.type;
    delete out.default;
    out.nullable = true;
  }

  // Przecięcie typów (`Prisma.XGetPayload` & `{ extra }`) jako `allOf` z samych
  // obiektów wstawionych w miejscu — jeden obiekt, bo generatory klientów
  // robią z `allOf` klasy złożone albo gubią pola.
  if (Array.isArray(out.allOf)) {
    const parts = out.allOf as Schema[];
    const plain = parts.every(
      (p) => p.type === 'object' && p.properties && !p.$ref && !p.nullable,
    );
    if (plain && parts.length > 1) {
      const properties: Schema = {};
      const required = new Set<string>();
      for (const part of parts) {
        Object.assign(properties, part.properties as Schema);
        for (const r of (part.required as string[] | undefined) ?? []) {
          required.add(r);
        }
      }
      delete out.allOf;
      out.type = 'object';
      out.properties = properties;
      if (required.size) out.required = [...required].sort();
    }
  }

  if (Array.isArray(out.enum) && out.enum.includes(null)) {
    out.enum = (out.enum as unknown[]).filter((v) => v !== null);
    out.nullable = true;
  }
  if (Array.isArray(out.enum) && !out.type) {
    const kinds = new Set((out.enum as unknown[]).map((v) => typeof v));
    if (kinds.size === 1) {
      const kind = [...kinds][0];
      if (kind === 'string' || kind === 'boolean') out.type = kind;
      if (kind === 'number') out.type = 'number';
    }
  }

  return out;
}
