/**
 * `pnpm openapi` — specyfikacja OpenAPI (`openapi/openapi.json`) i spis zdarzeń
 * Socket.IO (`openapi/SOCKET-EVENTS.md`), z których generujemy klientów
 * (Kotlin dla Androida, docelowo kontrola iOS).
 *
 * `pnpm openapi:check` — to samo bez zapisu; kod wyjścia 1, gdy commitowane
 * pliki są nieaktualne. Tak pilnuje tego CI.
 *
 * BEZ BAZY I BEZ SEKRETÓW. `AppModule` wstaje w trybie `preview` — Nest składa
 * graf modułów i trasy, ale nie tworzy ani jednego providera, więc Prisma nie
 * łączy się z bazą, a serwisy z fail-fastem na brak klucza nie startują.
 *
 * SKĄD SCHEMATY:
 *  - WEJŚCIE (ciała, query, parametry) — `@nestjs/swagger` z metadanymi
 *    wtyczki CLI (introspekcja DTO + class-validator + komentarze). Wtyczka
 *    biegnie TUTAJ (`PluginMetadataGenerator`), a nie w `nest build`:
 *    produkcja nie wystawia Swaggera, więc metadane w `dist/` byłyby balastem.
 *  - WYJŚCIE (odpowiedzi REST i ack socketów) — z TYPÓW TypeScriptu, które
 *    metody naprawdę zwracają (`Awaited<ReturnType<…>>` przez
 *    `typescript-json-schema`). Kontrolery zwracają wyniki serwisów, a nie
 *    klasy DTO, więc `@ApiOkResponse` pisane ręcznie rozjeżdżałyby się
 *    z kodem po cichu. Typ wywnioskowany przez kompilator się nie rozjedzie,
 *    a zmianę kontraktu łapie `openapi:check`.
 *
 * Swagger UI nie jest wystawiany NIGDZIE (także poza produkcją) — plik jest
 * jedynym produktem. Kontrolery wewnętrzne (panel admina, `/ops`, webhooki)
 * mają `@ApiExcludeController()`: to nie jest API aplikacji.
 */
import { NestFactory, NestContainer } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ReadonlyVisitor } from '@nestjs/swagger/plugin';
import { PluginMetadataGenerator } from '@nestjs/cli/lib/compiler/plugins/plugin-metadata-generator';
import * as TJS from 'typescript-json-schema';
import * as ts from 'typescript';
import * as prettier from 'prettier';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join, relative, resolve } from 'path';
import { AppModule } from '../../src/app.module';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import {
  Schema,
  componentNameFor,
  definitionNameFromRef,
  toOpenApiSchema,
} from './json-schema-to-openapi';

const ROOT = resolve(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const CACHE = join(ROOT, '.openapi-cache');
const OUT_DIR = join(ROOT, 'openapi');
const OUT_SPEC = join(OUT_DIR, 'openapi.json');
const OUT_EVENTS = join(OUT_DIR, 'SOCKET-EVENTS.md');
const CHECK = process.argv.includes('--check');

/** Prefiks aliasów w pliku sond — żeby nie zderzyć się z typami z `src/`. */
const PROBE_PREFIX = 'OA__';
const FIX_SUFFIX = '__Fix';

const posix = (p: string) => p.split('\\').join('/');
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** `recipes:findAll` → `RecipesFindAll`. */
const pascalFromEvent = (event: string) =>
  event
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(upperFirst)
    .join('');
const operationIdFor = (controllerKey: string, methodKey: string) =>
  lowerFirst(controllerKey.replace(/Controller$/, '')) + upperFirst(methodKey);

// ---------------------------------------------------------------------------
// 1. Metadane wtyczki @nestjs/swagger (DTO wejścia)
// ---------------------------------------------------------------------------

function loadPluginMetadata(): () => Promise<Record<string, any>> {
  mkdirSync(CACHE, { recursive: true });
  const quiet = console.log;
  console.log = () => undefined; // generator melduje postęp na stdout
  try {
    new PluginMetadataGenerator().generate({
      visitors: [
        new ReadonlyVisitor({
          introspectComments: true,
          classValidatorShim: true,
          pathToSource: SRC,
        }),
      ],
      outputDir: CACHE,
      filename: 'metadata.ts',
      watch: false,
      tsconfigPath: 'tsconfig.build.json',
      printDiagnostics: false,
    });
  } finally {
    console.log = quiet;
  }
  // Plik importuje klasy przez `import("./…")` względem `pathToSource`
  // (src), a leży w `.openapi-cache`; do tego `import()` w CommonJS pod
  // ts-node poszedłby do natywnego loadera ESM, który nie zna TypeScriptu.
  // Stąd `require` ze ścieżką od `src/` — te same moduły co w `AppModule`.
  const file = join(CACHE, 'metadata.ts');
  const fixed = readFileSync(file, 'utf8').replace(
    /import\("([^"]+)"\)/g,
    (_m, literal: string) => {
      // Ścieżka bywa z ucieczkami (`Rafał`) — najpierw odkoduj literał.
      const spec = JSON.parse(`"${literal}"`) as string;
      const target = spec.startsWith('./') ? `../src/${spec.slice(2)}` : spec;
      return `Promise.resolve(require(${JSON.stringify(target)}))`;
    },
  );
  writeFileSync(file, fixed);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(file) as {
    default: () => Promise<Record<string, any>>;
  };
  return mod.default;
}

// ---------------------------------------------------------------------------
// 2. Źródła: kontrolery i gatewaye (AST bez typów)
// ---------------------------------------------------------------------------

type ClassSource = { name: string; file: string; methods: Set<string> };
type WsHandler = {
  event: string;
  gateway: string;
  method: string;
  file: string;
  line: number;
  payloadIndex: number | null;
  payloadType: string | null;
};

function listFiles(dir: string, suffix: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, suffix, acc);
    else if (entry.name.endsWith(suffix)) acc.push(full);
  }
  return acc.sort();
}

function decoratorsOf(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function decoratorCall(
  d: ts.Decorator,
): { name: string; args: readonly ts.Expression[] } | null {
  if (!ts.isCallExpression(d.expression)) return null;
  const callee = d.expression.expression;
  if (!ts.isIdentifier(callee)) return null;
  return { name: callee.text, args: d.expression.arguments };
}

function scanClasses(files: string[]): {
  classes: Map<string, ClassSource>;
  wsHandlers: WsHandler[];
} {
  const classes = new Map<string, ClassSource>();
  const wsHandlers: WsHandler[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sf.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      const exported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) return;
      const name = node.name.text;
      const methods = new Set<string>();
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name))
          continue;
        methods.add(member.name.text);
        for (const d of decoratorsOf(member)) {
          const call = decoratorCall(d);
          if (call?.name !== 'SubscribeMessage') continue;
          const arg = call.args[0];
          if (!arg || !ts.isStringLiteralLike(arg)) {
            throw new Error(
              `${relative(ROOT, file)}: @SubscribeMessage bez literału — generator nie zna nazwy zdarzenia`,
            );
          }
          let payloadIndex: number | null = null;
          let payloadType: string | null = null;
          member.parameters.forEach((param, index) => {
            const isBody = decoratorsOf(param).some(
              (pd) => decoratorCall(pd)?.name === 'MessageBody',
            );
            if (isBody) {
              payloadIndex = index;
              payloadType = param.type?.getText(sf) ?? null;
            }
          });
          wsHandlers.push({
            event: arg.text,
            gateway: name,
            method: member.name.text,
            file,
            line:
              sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1,
            payloadIndex,
            payloadType,
          });
        }
      }
      if (classes.has(name)) {
        throw new Error(`Dwie klasy ${name} — generator nie rozróżni tras`);
      }
      classes.set(name, { name, file, methods });
    });
  }
  return { classes, wsHandlers };
}

// ---------------------------------------------------------------------------
// 3. Dokument Nest/Swagger (bez bazy)
// ---------------------------------------------------------------------------

type RouteInfo = { controller: string; method: string; bearer: boolean };

function guardsOf(target: object): unknown[] {
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, target);
  return Array.isArray(guards) ? guards : [];
}

/** Tyle z obiektów OpenAPI, ile generator dotyka. */
type Media = { schema?: Schema; example?: unknown };
type Response = { description?: string; content?: Record<string, Media> };
type Operation = {
  operationId: string;
  responses?: Record<string, Response>;
  security?: Record<string, string[]>[];
};

async function buildNestDocument(): Promise<{
  document: OpenAPIObject;
  routes: Map<string, RouteInfo>;
}> {
  const metadata = loadPluginMetadata();
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  await SwaggerModule.loadPluginMetadata(metadata);

  const config = new DocumentBuilder()
    .setTitle('Scoffie API')
    .setDescription(
      'REST aplikacji Scoffie. Większość domeny (gospodarstwa, przepisy, plan ' +
        'tygodnia, zakupy) jedzie Socket.IO — zdarzenia opisuje ' +
        '`openapi/SOCKET-EVENTS.md`, a ich koperty i odpowiedzi są w ' +
        '`components.schemas` jako `Ws*Payload` / `Ws*Data`.\n\n' +
        'Plik jest GENEROWANY (`pnpm openapi`) — nie edytuj ręcznie.',
    )
    .setVersion('1.0')
    .addServer('https://api.scoffie.app', 'Produkcja')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: operationIdFor,
  });

  const routes = new Map<string, RouteInfo>();
  const container = (app as unknown as { container: NestContainer }).container;
  for (const module of container.getModules().values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype as (new (...a: any[]) => any) | null;
      if (!metatype) continue;
      const classGuards = guardsOf(metatype);
      for (const method of Object.getOwnPropertyNames(metatype.prototype)) {
        if (method === 'constructor') continue;
        const handler = (metatype.prototype as Record<string, unknown>)[method];
        if (typeof handler !== 'function') continue;
        const methodGuards = guardsOf(handler);
        routes.set(operationIdFor(metatype.name, method), {
          controller: metatype.name,
          method,
          bearer: [...classGuards, ...methodGuards].includes(JwtAuthGuard),
        });
      }
    }
  }
  await app.close();
  return { document, routes };
}

// ---------------------------------------------------------------------------
// 4. Typy odpowiedzi z kompilatora
// ---------------------------------------------------------------------------

type Probe = { alias: string; expr: string };

function writeProbeFile(
  classes: Map<string, ClassSource>,
  probes: Probe[],
): string {
  const used = new Set(
    probes.flatMap((p) =>
      [...p.expr.matchAll(/\b([A-Z]\w+)\['/g)].map((m) => m[1]),
    ),
  );
  const imports = [...used].sort().map((name) => {
    const cls = classes.get(name);
    if (!cls) throw new Error(`Brak klasy ${name}`);
    const spec = posix(relative(CACHE, cls.file)).replace(/\.ts$/, '');
    return `import type { ${name} } from '${spec}';`;
  });
  const body = [
    '/* eslint-disable */',
    '// Plik sond generatora OpenAPI — tworzony przy każdym biegu.',
    ...imports,
    "import type { HttpErrorBody } from '../src/common/error-contract';",
    "import type { WsError } from '../src/common/ws-response';",
    'type WsData<T> = [Extract<T, { ok: true }>] extends [never]',
    '  ? T',
    '  : Extract<T, { ok: true }> extends { data: infer D }',
    '    ? D',
    '    : never;',
    // Opakowanie `{ value }`: typ `void` jako KORZEŃ wywraca generator, a jako
    // pole po prostu znika — i tak poznajemy odpowiedź bez treści.
    'type NoContent = { readonly __noContent: true };',
    'type Box<T> = {',
    '  value: [T] extends [never] ? NoContent : [T] extends [void] ? NoContent : T;',
    '};',
    `export type ${PROBE_PREFIX}ErrorResponse = Box<HttpErrorBody>;`,
    `export type ${PROBE_PREFIX}WsError = Box<WsError>;`,
    // Zapas dla typów, których generator nie strawi (`never[]` z `[]`):
    // ta sama struktura, `never` → dowolny JSON. Używany tylko po porażce,
    // bo rozwinięty typ traci nazwy komponentów.
    'type Fix<T> = [T] extends [never]',
    '  ? unknown',
    '  : T extends Date',
    '    ? T',
    '    : T extends readonly (infer U)[]',
    '      ? Fix<U>[]',
    '      : T extends object',
    '        ? { [K in keyof T]: Fix<T[K]> }',
    '        : T;',
    ...probes.flatMap((p) => [
      `export type ${PROBE_PREFIX}${p.alias} = Box<${p.expr}>;`,
      `export type ${PROBE_PREFIX}${p.alias}${FIX_SUFFIX} = Box<Fix<${p.expr}>>;`,
    ]),
    '',
  ].join('\n');
  const file = join(CACHE, 'types.ts');
  writeFileSync(file, body);
  return file;
}

/** Rejestr komponentów: nazwy, kolizje, typy anonimowe. */
class ComponentRegistry {
  private readonly converted = new Map<string, Schema>(); // definicja → {$ref}|inline
  private readonly inlining = new Set<string>();
  private readonly byFingerprint = new Map<string, Schema>();
  private anon = 0;
  readonly warnings: string[] = [];

  constructor(
    private readonly schemas: Record<string, Schema>,
    private readonly definitions: Record<string, unknown>,
    private readonly swaggerOwned: Set<string>,
  ) {}

  private freeName(wanted: string): string {
    if (!this.schemas[wanted]) return wanted;
    let i = 2;
    while (this.schemas[`${wanted}${i}`]) i++;
    this.warnings.push(`kolizja nazwy ${wanted} → ${wanted}${i}`);
    return `${wanted}${i}`;
  }

  add(wanted: string, schema: Schema): Schema {
    const name = this.freeName(wanted);
    this.schemas[name] = schema;
    return { $ref: `#/components/schemas/${name}` };
  }

  convert(schema: unknown): Schema {
    return toOpenApiSchema(schema, (ref) => this.resolve(ref));
  }

  private resolve(ref: string): Schema {
    const def = definitionNameFromRef(ref);
    if (def === null) return {};
    const done = this.converted.get(def);
    if (done) return done;
    // JSON Prismy (`JsonValue` i spółka) to rekurencyjna unia prymitywów —
    // dla klienta i tak „dowolny JSON”.
    if (/(^|\.)(Input)?Json(Value|Object|Array)$/.test(def)) {
      return { description: 'Dowolny JSON' };
    }
    const nice = componentNameFor(def);
    if (nice && this.swaggerOwned.has(nice)) {
      // DTO opisane już przez Swaggera (z walidacją) — lepsze niż z typu.
      const ref$ = { $ref: `#/components/schemas/${nice}` };
      this.converted.set(def, ref$);
      return ref$;
    }
    const body = this.definitions[def];
    if (nice) {
      // Ten sam typ pod dwiema ścieżkami (`$Enums.MealType` i `MealType`
      // z Prismy) — jeden komponent, nie `MealType2`.
      const fingerprint = JSON.stringify(stripDescriptions(body));
      const twin = this.byFingerprint.get(`${nice}\u0000${fingerprint}`);
      if (twin) {
        this.converted.set(def, twin);
        return twin;
      }
      const name = this.freeName(nice);
      this.byFingerprint.set(`${nice}\u0000${fingerprint}`, {
        $ref: `#/components/schemas/${name}`,
      });
      const ref$ = { $ref: `#/components/schemas/${name}` };
      this.converted.set(def, ref$);
      this.schemas[name] = {}; // zajęte przed rekurencją
      this.schemas[name] = this.convert(body);
      return ref$;
    }
    if (this.inlining.has(def)) {
      // Anonimowy typ rekurencyjny — musi dostać nazwę.
      const name = this.freeName(`Anonymous${++this.anon}`);
      const ref$ = { $ref: `#/components/schemas/${name}` };
      this.converted.set(def, ref$);
      this.schemas[name] = this.convert(body);
      return ref$;
    }
    this.inlining.add(def);
    try {
      return this.convert(body);
    } finally {
      this.inlining.delete(def);
    }
  }
}

function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== 'description')
      .map(([k, v]) => [k, stripDescriptions(v)]),
  );
}

function isMeaningful(schema: Schema | undefined): boolean {
  if (!schema) return false;
  if (schema.$ref || schema.allOf || schema.oneOf || schema.anyOf) return true;
  if (schema.type === 'array') return isMeaningful(schema.items as Schema);
  if (schema.type === 'object') return !!schema.properties;
  return typeof schema.type === 'string';
}

/** Odpowiedź jako komponent, gdy to obiekt (klient dostaje nazwaną klasę). */
function namedResponse(
  registry: ComponentRegistry,
  name: string,
  schema: Schema,
): Schema {
  if (schema.$ref) return schema;
  if (schema.type === 'object' && schema.properties) {
    return registry.add(name, schema);
  }
  const items = schema.items as Schema | undefined;
  if (schema.type === 'array' && items?.type === 'object' && items.properties) {
    return { ...schema, items: registry.add(`${name}Item`, items) };
  }
  return schema;
}

// ---------------------------------------------------------------------------
// 5. Zdarzenia serwer → klient (emit/broadcast) z typami
// ---------------------------------------------------------------------------

type ServerEvent = { event: string; file: string; line: number; body: string };

function scanServerEvents(program: ts.Program): ServerEvent[] {
  const checker = program.getTypeChecker();
  const out: ServerEvent[] = [];
  for (const sf of program.getSourceFiles()) {
    const file = sf.fileName;
    if (!posix(resolve(file)).startsWith(posix(SRC) + '/')) continue;
    if (/\.(spec|spec-helper|stub)\.ts$/.test(file)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let eventArg: ts.Expression | undefined;
        let bodyArg: ts.Expression | undefined;
        if (ts.isIdentifier(callee) && callee.text === 'broadcastToHousehold') {
          eventArg = node.arguments[2];
          bodyArg = node.arguments[3];
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'emit'
        ) {
          eventArg = node.arguments[0];
          bodyArg = node.arguments[1];
        }
        if (eventArg) {
          const t = checker.getTypeAtLocation(eventArg);
          if (t.isStringLiteral()) {
            const bodyType = bodyArg
              ? checker.typeToString(
                  checker.getTypeAtLocation(bodyArg),
                  undefined,
                  ts.TypeFormatFlags.NoTruncation,
                )
              : '—';
            out.push({
              event: t.value,
              file,
              line:
                sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              body: bodyType.replace(/\s+/g, ' '),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out.sort(
    (a, b) =>
      a.event.localeCompare(b.event) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

// ---------------------------------------------------------------------------
// 6. Składanie
// ---------------------------------------------------------------------------

function summarize(
  schema: Schema | undefined,
  schemas: Record<string, Schema>,
): string {
  if (!schema) return '—';
  if (schema.$ref) {
    const name = (schema.$ref as string).split('/').pop()!;
    const target = schemas[name];
    const keys = target?.properties
      ? Object.keys(target.properties as Schema)
      : [];
    const shown = keys.slice(0, 6).join(', ');
    return `\`${name}\`${keys.length ? ` {${shown}${keys.length > 6 ? ', …' : ''}}` : ''}`;
  }
  if (schema.type === 'array')
    return `lista ${summarize(schema.items as Schema, schemas)}`;
  if (schema.properties) {
    return `{${Object.keys(schema.properties as Schema).join(', ')}}`;
  }
  if (schema.nullable && schema.allOf) {
    return `${summarize((schema.allOf as Schema[])[0], schemas)} | null`;
  }
  const variants = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (variants) {
    return `jeden z: ${variants.map((v) => summarize(v, schemas)).join(' / ')}`;
  }
  if (schema.allOf) {
    return (schema.allOf as Schema[])
      .map((v) => summarize(v, schemas))
      .join(' & ');
  }
  if (typeof schema.type === 'string') {
    return `\`${schema.type}${schema.nullable ? ' | null' : ''}\``;
  }
  return 'dowolny JSON';
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|');
}

async function main(): Promise<void> {
  const controllerFiles = listFiles(SRC, '.controller.ts');
  const gatewayFiles = listFiles(SRC, '.gateway.ts');
  const { classes, wsHandlers } = scanClasses([
    ...controllerFiles,
    ...gatewayFiles,
  ]);

  const { document, routes } = await buildNestDocument();
  const schemas = (document.components!.schemas ??= {}) as Record<
    string,
    Schema
  >;
  const swaggerOwned = new Set(Object.keys(schemas));

  // --- sondy typów ---
  type OpRef = {
    path: string;
    verb: string;
    op: Operation;
    info: RouteInfo;
  };
  const ops: OpRef[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [verb, value] of Object.entries(
      item as Record<string, unknown>,
    )) {
      const op = value as Operation | undefined;
      if (!op || typeof op !== 'object' || !op.operationId) continue;
      const info = routes.get(op.operationId);
      if (!info) throw new Error(`Nieznana operacja ${op.operationId}`);
      ops.push({ path, verb, op, info });
    }
  }
  const probes: Probe[] = [];
  for (const { op, info } of ops) {
    probes.push({
      alias: `${upperFirst(op.operationId)}Response`,
      expr: `Awaited<ReturnType<${info.controller}['${info.method}']>>`,
    });
  }
  for (const h of wsHandlers) {
    const base = `Ws${pascalFromEvent(h.event)}`;
    if (h.payloadIndex !== null) {
      probes.push({
        alias: `${base}Payload`,
        expr: `NonNullable<Parameters<${h.gateway}['${h.method}']>[${h.payloadIndex}]>`,
      });
    }
    probes.push({
      alias: `${base}Data`,
      expr: `WsData<Awaited<ReturnType<${h.gateway}['${h.method}']>>>`,
    });
  }
  const probeFile = writeProbeFile(classes, probes);

  const srcFiles = listFiles(SRC, '.ts').filter(
    (f) => !/\.(spec|spec-helper|stub)\.ts$/.test(f),
  );
  const program = TJS.programFromConfig(join(ROOT, 'tsconfig.json'), [
    probeFile,
    ...srcFiles,
  ]);
  const generator = TJS.buildGenerator(program, {
    required: true,
    ref: true,
    aliasRef: false,
    topRef: false,
    noExtraProps: false,
    strictNullChecks: true,
    ignoreErrors: true,
    constAsEnum: false,
  });
  if (!generator) throw new Error('typescript-json-schema: brak generatora');

  const names = ['ErrorResponse', 'WsError', ...probes.map((p) => p.alias)].map(
    (n) => PROBE_PREFIX + n,
  );
  const warn = console.warn;
  const log = console.log;
  console.warn = () => undefined; // „unknown initializer for property …”
  console.log = () => undefined;
  // Każdy typ osobno: jeden nieobsługiwany (np. `never[]` z pustej tablicy)
  // nie może wywrócić całej specyfikacji — trafia na listę „bez typu”.
  const definitions: Record<string, unknown> = {};
  const failed = new Map<string, string>();
  try {
    for (const name of names) {
      let lastError: unknown;
      for (const candidate of [name, `${name}${FIX_SUFFIX}`]) {
        try {
          const schema = generator.getSchemaForSymbol(candidate, true);
          const { definitions: nested, ...root } = schema;
          Object.assign(definitions, nested ?? {});
          definitions[name] = root;
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError !== undefined) {
        failed.set(
          name,
          lastError instanceof Error
            ? lastError.message
            : JSON.stringify(lastError),
        );
      }
    }
  } finally {
    console.warn = warn;
    console.log = log;
  }
  const registry = new ComponentRegistry(schemas, definitions, swaggerOwned);
  const probeSchema = (alias: string): Schema => {
    const box = definitions[PROBE_PREFIX + alias] as
      | { properties?: Record<string, unknown> }
      | undefined;
    const value = box?.properties?.value as
      | { properties?: Record<string, unknown> }
      | undefined;
    if (value === undefined) return {};
    if (value.properties?.__noContent) return { 'x-no-content': true };
    return registry.convert(value);
  };

  const reason = (alias: string) => {
    const why = failed.get(PROBE_PREFIX + alias);
    return why ? ` — ${why}` : '';
  };

  const errorRef = registry.add('ErrorResponse', probeSchema('ErrorResponse'));
  registry.add('WsError', probeSchema('WsError'));

  // --- REST ---
  const untyped: string[] = [];
  for (const { path, verb, op, info } of ops) {
    const alias = `${upperFirst(op.operationId)}Response`;
    const derived = probeSchema(alias);
    const responses = (op.responses ??= {});
    const okKey =
      Object.keys(responses).find((k) => /^2\d\d$/.test(k)) ??
      (verb === 'post' ? '201' : '200');
    const ok = (responses[okKey] ??= { description: '' });
    const media = ok.content?.['application/json'];
    const explicit = media?.schema;
    if (derived['x-no-content']) {
      // Metoda nic nie zwraca — odpowiedź bez treści.
      delete ok.content;
    } else if (!isMeaningful(explicit)) {
      if (isMeaningful(derived)) {
        const example = explicit?.example;
        ok.content = {
          'application/json': {
            schema: namedResponse(registry, alias, derived),
            ...(example !== undefined ? { example } : {}),
          },
        };
      } else {
        untyped.push(
          `${verb.toUpperCase()} ${path} (${info.controller}.${info.method})${reason(alias)}`,
        );
      }
    }
    if (!ok.description) ok.description = 'OK';
    responses.default = {
      description: 'Błąd: `{code, message, details?, requestId}`',
      content: { 'application/json': { schema: errorRef } },
    };
    if (info.bearer) op.security = [{ bearer: [] }];
    else delete op.security;
  }

  // --- WebSocket ---
  type WsRow = WsHandler & { payload?: Schema; data?: Schema };
  const wsRows: WsRow[] = [];
  for (const h of wsHandlers) {
    const base = `Ws${pascalFromEvent(h.event)}`;
    const row: WsRow = { ...h };
    if (h.payloadIndex !== null) {
      const payload = probeSchema(`${base}Payload`);
      row.payload = namedResponse(registry, `${base}Payload`, payload);
    }
    const data = probeSchema(`${base}Data`);
    if (isMeaningful(data)) {
      row.data = namedResponse(registry, `${base}Data`, data);
    } else if (!data['x-no-content']) {
      untyped.push(
        `WS ${h.event} (${h.gateway}.${h.method})${reason(`${base}Data`)}`,
      );
    }
    wsRows.push(row);
  }

  // Deterministyczna kolejność komponentów.
  document.components!.schemas = Object.fromEntries(
    Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)),
  );

  const serverEvents = scanServerEvents(program);

  // --- zapis ---
  const specText = await prettier.format(JSON.stringify(document), {
    parser: 'json',
  });
  const md = renderEventsMd(
    wsRows,
    serverEvents,
    document.components!.schemas as Record<string, Schema>,
  );
  const mdText = await prettier.format(md, {
    parser: 'markdown',
    ...(await prettier.resolveConfig(OUT_EVENTS)),
  });

  const restCount = ops.length;
  const summary = `REST: ${restCount} operacji, WS: ${wsHandlers.length} zdarzeń klient→serwer, ${new Set(serverEvents.map((e) => e.event)).size} serwer→klient, komponentów: ${Object.keys(document.components!.schemas).length}`;

  if (CHECK) {
    const stale: string[] = [];
    for (const [file, text] of [
      [OUT_SPEC, specText],
      [OUT_EVENTS, mdText],
    ] as const) {
      const current = existsSync(file)
        ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
        : null;
      if (current !== text) stale.push(posix(relative(ROOT, file)));
    }
    if (stale.length) {
      console.error(
        `Nieaktualne: ${stale.join(', ')}. Uruchom \`pnpm openapi\` i dołącz zmiany do commita.`,
      );
      process.exit(1);
    }
    console.log(`OpenAPI aktualne. ${summary}`);
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_SPEC, specText);
    writeFileSync(OUT_EVENTS, mdText);
    console.log(`Zapisano ${posix(relative(ROOT, OUT_SPEC))}. ${summary}`);
  }
  for (const w of registry.warnings) console.warn(`uwaga: ${w}`);
  if (untyped.length) {
    console.warn(`Bez typu odpowiedzi (${untyped.length}):`);
    for (const u of untyped) console.warn(`  - ${u}`);
  }
}

function renderEventsMd(
  rows: (WsHandler & { payload?: Schema; data?: Schema })[],
  serverEvents: ServerEvent[],
  schemas: Record<string, Schema>,
): string {
  const loc = (file: string, line: number) =>
    `\`${posix(relative(ROOT, file))}:${line}\``;
  const lines: string[] = [
    '# Zdarzenia Socket.IO',
    '',
    '<!-- GENEROWANE przez `pnpm openapi` (scripts/openapi/generate-openapi.ts) — nie edytuj ręcznie. -->',
    '',
    'Uwierzytelnienie: JWT w handshake (`auth: { token }` albo nagłówek `Authorization: Bearer`).',
    'Każde zdarzenie klient→serwer odpowiada ackiem w kopercie',
    '`{ ok: true, data }` albo `{ ok: false, code, message, error, status, details?, requestId }`',
    '(schemat `WsError`). Kolumny „Koperta” i „data” wskazują schematy z `components.schemas`',
    'w `openapi/openapi.json` — z nich generuje się modele klienta.',
    '',
    `## Klient → serwer (${rows.length})`,
    '',
    '| Zdarzenie | Koperta (wejście) | `data` w acku | Handler |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of [...rows].sort((a, b) => a.event.localeCompare(b.event))) {
    const payload = r.payload
      ? summarize(r.payload, schemas) +
        (r.payloadType &&
        !((r.payload.$ref as string | undefined) ?? '').endsWith(
          `/${r.payloadType}`,
        )
          ? ` (klasa \`${r.payloadType}\`)`
          : '')
      : '—';
    lines.push(
      `| \`${r.event}\` | ${mdEscape(payload)} | ${mdEscape(summarize(r.data, schemas))} | \`${r.gateway}.${r.method}\` ${loc(r.file, r.line)} |`,
    );
  }
  lines.push(
    '',
    `## Serwer → klient (${new Set(serverEvents.map((e) => e.event)).size} zdarzeń, ${serverEvents.length} miejsc wysyłki)`,
    '',
    'Zdarzenia domowe idą do pokoju `household:<id>` (`broadcastToHousehold`).',
    'Kształt ciała to typ TypeScriptu w miejscu wysyłki.',
    '',
    '| Zdarzenie | Ciało | Miejsce |',
    '| --- | --- | --- |',
  );
  for (const e of serverEvents) {
    lines.push(
      `| \`${e.event}\` | \`${mdEscape(e.body)}\` | ${loc(e.file, e.line)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
