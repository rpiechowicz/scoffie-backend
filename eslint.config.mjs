// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        project: './tsconfig.typecheck.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // Skrypty CommonJS (`scripts/*.js`, `scripts/lib/*.js`, `jest.config.js`):
    // nie ma ich w żadnym tsconfigu (allowJs wyłączone), więc bez reguł
    // typowanych, a `require` to ich natura. Hook lint-staged linuje *.js.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Testy, stuby, e2e — mocki i stuby są z natury „any-heavy"; nie blokujemy CI
    files: [
      '**/*.spec.ts',
      '**/*.spec-helper.ts',
      '**/*.e2e-spec.ts',
      '**/*.stub.ts',
      'test/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Asystent rozmawia z modelem: każda odpowiedź dostawcy i każdy argument
    // narzędzia to dane z zewnątrz o kształcie, którego TypeScript nie zna.
    // W reszcie repo `no-unsafe-*` są ostrzeżeniem (dług historyczny); tutaj
    // od pierwszego commita są błędem, żeby `any` nie wsiąkł w warstwę, która
    // woła serwisy domenowe i wydaje pieniądze.
    files: ['src/agent/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.spec-helper.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Panel administratora: każde żądanie niesie dane z zewnątrz (JWT bramki,
    // odpowiedzi WebAuthn, ciała akcji operatora) i każda akcja zmienia cudze
    // konto albo pieniądze — `any` nie ma tu prawa wsiąknąć, tak jak w
    // `src/agent/`.
    files: ['src/admin/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.spec-helper.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Granica modułu, jednokierunkowa: asystent woła domenę, domena nigdy nie
    // woła asystenta. Bez tej reguły pierwszy `import { AgentTurnsService }`
    // w serwisie planu zamieniłby flagę AI_ENABLED z przełącznika funkcji w
    // zależność całego backendu. Wyjątek ma tylko `AppModule` (rejestracja).
    //
    // To samo dla panelu administratora (ROADMAPA §1.6): `src/admin/` woła
    // domenę, obserwowalność i — wyłącznie do odczytu puli i zgłoszeń —
    // asystenta; NIC w aplikacji nie importuje `src/admin/`. Panel jest
    // wierzchołkiem grafu zależności, jak `AppModule`, dlatego sam jest
    // wyłączony z zakazu importu asystenta.
    files: ['src/**/*.ts'],
    ignores: ['src/agent/**', 'src/admin/**', 'src/app.module.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'jose',
              importNames: ['decodeJwt', 'decodeProtectedHeader'],
              message:
                'Odczyt tokenu bez weryfikacji podpisu. Użyj verifyAppleJws() z src/billing/apple-jws.verifier.ts.',
            },
          ],
          patterns: [
            {
              group: ['**/agent/*', '**/agent/**'],
              message:
                'src/agent/ jest modułem jednokierunkowym — domena nie może importować asystenta (rejestracja tylko w AppModule).',
            },
            {
              group: ['**/admin/*', '**/admin/**'],
              message:
                'src/admin/ jest modułem jednokierunkowym — nic w aplikacji nie importuje panelu administratora (rejestracja tylko w AppModule).',
            },
          ],
        },
      ],
    },
  },
  {
    // To samo ograniczenie dla miejsc wyłączonych z bloku wyżej. `jose` daje
    // `decodeJwt` i `decodeProtectedHeader`, które czytają treść tokenu BEZ
    // sprawdzenia podpisu — jedno takie wywołanie na ścieżce nadawania PRO
    // zamienia weryfikację zakupu w formalność. Podpisy sprawdza wyłącznie
    // `apple-jws.verifier.ts`, z łańcuchem do przypiętego korzenia Apple.
    files: ['src/agent/**/*.ts', 'src/app.module.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'jose',
              importNames: ['decodeJwt', 'decodeProtectedHeader'],
              message:
                'Odczyt tokenu bez weryfikacji podpisu. Użyj verifyAppleJws() z src/billing/apple-jws.verifier.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    // Panel: ten sam zakaz odczytu tokenu bez podpisu (tu stoi bramka
    // Cloudflare Access — `decodeJwt` zamiast `jwtVerify` otwierałby panel
    // każdemu, kto wklei dowolny JWT z właściwym `email`).
    files: ['src/admin/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'jose',
              importNames: ['decodeJwt', 'decodeProtectedHeader'],
              message:
                'Odczyt tokenu bez weryfikacji podpisu. Bramkę Access sprawdza wyłącznie AccessJwtVerifier (jwtVerify po JWKS).',
            },
          ],
        },
      ],
    },
  },
);
