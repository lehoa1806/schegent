// ESLint flat configuration for the whole repository — host, tests, build
// tooling, and the webview.
//
// Route (FR-034, recorded in full in docs/development/lint-and-type-aware-rules.md):
// ESLint 9 + flat config. ESLint 10 requires Node ^20.19.0 || ^22.13.0 || >=24 and
// .nvmrc pins 20.18.0, so it cannot run here; ESLint 8 is end-of-life. The .nvmrc
// bump that would unblock ESLint 10 is a separate item.
//
// Placement (plan D16): the configuration lives here, as two named exports, rather
// than at a root `eslint.config.mjs`. scripts/lint.mjs is the only thing that
// invokes ESLint and it drives the Node API, so it needs the configs as importable
// objects to lint both trees from one entry point (plan D7) — an auto-discovered
// root config would be redundant for every gate. Run the linter through
// `npm run lint` and `npm run lint:webview`, never through the eslint CLI, so the
// baseline comparison in tests/lint/eslint-baseline.json is applied in the same
// pass that enforces the errors.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const WEBVIEW_ROOT = path.join(REPO_ROOT, 'webview-ui');

// Carried over verbatim from the `eslintConfig` block this module replaces. Each
// entry keeps the reason it exists, so a later reader can retire one on purpose
// rather than by accident (FR-027, FR-028).
const RELAXATIONS = {
  // The extension logs through vscode's output channel in production and through
  // console in scripts and tests; there is no browser console to pollute.
  'no-console': 'off',
  // An empty catch is permitted by ESLint only because the real requirement — that
  // it carry a comment saying why the error is discarded — is enforced by
  // tests/lint/empty-catch-declares-intent.test.ts, which can read comments.
  // ESLint cannot express "empty, but commented"; that gate can (FR-023).
  'no-empty': ['error', { allowEmptyCatch: true }],
  // `any` appears at the vscode API boundary and in test doubles, where the
  // alternative is a cast chain that hides more than it documents.
  '@typescript-eslint/no-explicit-any': 'off',
  // `_`-prefixed bindings are this repo's marker for a deliberately unused
  // parameter, which the vscode API's callback shapes force in several places.
  '@typescript-eslint/no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
  ],
  // Non-null assertions are used where a structural invariant is asserted by a
  // gate rather than by the type system.
  '@typescript-eslint/no-non-null-assertion': 'off'
};

// The four rules FR-R3-026 exists to enable. The async trio is at `error` with its
// backlog cleared in this feature; no-unnecessary-condition is at `warn` and its
// count is bounded by the baseline rather than by this file (FR-008, FR-010).
//
// One severity per rule in every tree. A rule that is an error in `src` and a
// warning in `tests` is two rules sharing a name, which is the defect class this
// whole change exists to remove — so no block below may soften any of the four for
// a subset of files (FR-010a).
const TYPE_AWARE = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-unnecessary-condition': 'warn'
};

// The same four, switched off. Not a softening: these rules cannot run at all
// without a TypeScript program, and the blocks that use this are the files that
// belong to no tsconfig. Turning them off there is what makes such a file lint
// under the syntactic rule set instead of raising a configuration error (FR-011).
const TYPE_AWARE_UNAVAILABLE = Object.fromEntries(
  Object.keys(TYPE_AWARE).map(rule => [rule, 'off'])
);

// Options that keep already-correct code correct under rules the typescript-eslint
// major turned on. Each is a deliberate declaration the rule misreads, not a
// finding being suppressed (FR-032).
const MAJOR_RULE_OPTIONS = {
  // All 7 findings are `interface XCommand extends CommandBase<typeof CMD_X> {}` in
  // src/contracts/sidebar-ipc.ts — how a payload-free command gets its own nominal
  // type inside the discriminated union. Rewriting them to `Record<string, never>`
  // would change the contract's shape and break the union's exhaustiveness, so the
  // rule gets the option it ships for exactly this pattern.
  '@typescript-eslint/no-empty-object-type': [
    'error',
    { allowInterfaces: 'with-single-extends' }
  ]
};

// Webview-only rule options. Same standard as MAJOR_RULE_OPTIONS: a deliberate
// declaration the rule misreads, resolved at the configuration site rather than by
// rewriting correct code (FR-032).
const SVELTE_RULE_OPTIONS = {
  // A prop whose type is an object shared with the parent is legitimately consumed
  // by both ends. src/components/settings/general/GeneralSettingFieldRow.svelte
  // takes a `spec: FieldSpec` and reads most of it, but `spec.ipcKey` is read by
  // the parent (GeneralSettingsTab.svelte's `ipcKeyFor`) — the field is that
  // component's contract, not this one's dead code. Descending into a prop's
  // object type reports the parent's fields against the child, so the rule keeps
  // checking top-level props and stops checking nested ones.
  'svelte/no-unused-props': ['error', { allowUnusedNestedProperties: true }]
};

// The three rules whose 22 findings are baselined rather than fixed, because every
// fix changes runtime behaviour — what is reactive, and how the DOM is reused
// across an `each` (FR-031, plan D9). `svelte.configs.recommended` ships them at
// `error`, and a rule at `error` with a live baseline entry is a contradiction the
// FR-017 gate is built to catch: severity is what separates "enforced at zero"
// from "bounded and being paid down". So they sit at `warn` while the baseline
// bounds them, exactly as no-unnecessary-condition (620) and no-unused-vars (12)
// do. Promoting one back to `error` means clearing its count and deleting its
// baseline entry in the same change — the procedure in
// docs/development/lint-and-type-aware-rules.md.
const BASELINED_SVELTE_RULES = {
  'svelte/prefer-svelte-reactivity': 'warn',
  'svelte/require-each-key': 'warn',
  'svelte/prefer-writable-derived': 'warn'
};

// Carried over from `eslintConfig.ignorePatterns`: 7 of the 10, dropping exactly
// `webview-ui/`, `*.mjs` and `*.config.js` and adding none (FR-005, SC-008).
//
// `webview-ui/` is absent by design rather than by oversight: the webview is no
// longer excluded from linting, it is linted by its own pass over its own tsconfig
// (see webviewConfig). scripts/lint.mjs scopes each pass by path, so the host pass
// never sees a webview file and needs no ignore entry to avoid one.
const CARRIED_IGNORES = [
  'dist/**',
  'node_modules/**',
  'out/**',
  '.specify/**',
  'specs/**',
  'docs/**',
  '.claude/**'
];

/**
 * parserOptions for a type-aware block, bound to one tree's TypeScript program.
 *
 * The host `tsconfig.json` includes `src` and `tests`, so one project covers both;
 * the webview has its own covering `src`. Only files inside those includes may be
 * matched by a block using this — see TYPE_AWARE_UNAVAILABLE for the rest.
 *
 * @param {string} rootDir absolute path to the directory holding the tsconfig
 * @returns {{project: string[], tsconfigRootDir: string, extraFileExtensions: string[]}}
 */
function program(rootDir) {
  return {
    project: ['tsconfig.json'],
    tsconfigRootDir: rootDir,
    // Required for the webview, where `.svelte` modules are imported from `.ts`;
    // inert for the host, which has none.
    extraFileExtensions: ['.svelte']
  };
}

// TypeScript outside any tsconfig: root-level tooling (vitest.config.ts,
// playwright.config.ts, vite.config.ts) and scripts/*.d.mts. `.mts` and `.cts`
// appear here and never in a type-aware block — scripts/check-vsix-smoke.d.mts and
// check-build-freshness.d.mts belong to no project, and a type-aware rule reaching
// them would fail to resolve rather than report (FR-011, T708).
const UNPROJECTED_TS = ['*.ts', 'scripts/**/*.ts', '**/*.mts', '**/*.cts'];

// Plain-JS build tooling and fixtures: in no tsconfig, so no type-aware rule can
// reach them either. Flat config lints these by default where the old `*.mjs` and
// `*.config.js` ignores did not, which is what brings scripts/*.mjs,
// esbuild.config.mjs, webview-ui/svelte.config.js and
// webview-ui/tests/tooling/*.mjs under the linter for the first time (FR-004).
const PLAIN_JS_RULES = {
  ...RELAXATIONS,
  ...TYPE_AWARE_UNAVAILABLE,
  // The `^_` convention is a TypeScript one; the base rule has no view of the
  // project's types and reports differently on the same code.
  '@typescript-eslint/no-unused-vars': 'off',
  // tests/e2e/fixtures/fake-claude/index.js is a CommonJS CLI stub that node
  // launches directly, so `require` is the only correct form there. The one
  // remaining directive for this rule sits at its single TypeScript call site,
  // tests/integration/index.ts:17 (FR-032, plan D6).
  '@typescript-eslint/no-require-imports': 'off'
};

// An `eslint-disable` that suppresses nothing is a comment claiming a rule fires
// where it does not, and 66 of this repository's 70 were exactly that. `error`
// rather than the flat-config default of `warn`, so the count cannot drift back up
// behind a wall of warnings nobody reads (FR-020, plan D10).
const LINTER_OPTIONS = {
  linterOptions: { reportUnusedDisableDirectives: 'error' }
};

/** @type {import('eslint').Linter.Config[]} */
export const hostConfig = [
  { ignores: CARRIED_IGNORES },
  LINTER_OPTIONS,
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: program(REPO_ROOT),
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: { ...RELAXATIONS, ...MAJOR_RULE_OPTIONS, ...TYPE_AWARE }
  },
  {
    files: UNPROJECTED_TS,
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: { ...RELAXATIONS, ...MAJOR_RULE_OPTIONS, ...TYPE_AWARE_UNAVAILABLE }
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: PLAIN_JS_RULES
  },
  {
    // The root package.json declares no `type`, so `.js` in this tree is
    // CommonJS — two CLI stubs node launches directly, tests/e2e/fixtures/
    // fake-claude/index.js and tests/fixtures/mock-claude/index.js. Declaring
    // `globals.node` here is what replaced the `/* eslint-env node */` comment
    // the first of them carried: flat config no longer honours that comment, and
    // ESLint 10 will reject it outright (FR-022).
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: PLAIN_JS_RULES
  }
];

/**
 * The webview's configuration, built on demand.
 *
 * `eslint-plugin-svelte`'s recommended set eagerly loads every rule module, and
 * several of those import the Svelte compiler — so merely importing the plugin
 * requires `svelte` to be resolvable. Keeping the import dynamic means
 * `npm run lint` over the host tree never loads the webview's toolchain, and a
 * broken Svelte install cannot take the host gate down with it.
 *
 * `svelte` is a root devDependency carrying the same range as
 * `webview-ui/package.json` so the parser parses against the same compiler that
 * builds; tests/lint/svelte-version-parity.test.ts holds the two together.
 *
 * @returns {Promise<import('eslint').Linter.Config[]>}
 */
export async function createWebviewConfig() {
  const [{ default: svelte }, { default: svelteParser }] = await Promise.all([
    import('eslint-plugin-svelte'),
    import('svelte-eslint-parser')
  ]);

  return [
    { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
    LINTER_OPTIONS,
    js.configs.recommended,
    ...tseslint.configs.recommended,
    ...svelte.configs.recommended,
    {
      // Tree-wide, not scoped to `src/**/*.svelte`, so that every file in this tree
      // carries one severity for these rules. Scoping them to components left them
      // at the recommended set's `error` for plain `.ts` — and a rule sitting at
      // `error` in one file and `warn` in the next is both the split severity FR-010a
      // forbids and a contradiction of the baseline entry that bounds it
      // (tests/lint/eslint-baseline.test.ts, FR-017). These rules only ever report on
      // Svelte syntax, so declaring them for `.ts` costs nothing and says one thing.
      rules: { ...SVELTE_RULE_OPTIONS, ...BASELINED_SVELTE_RULES }
    },
    {
      files: ['src/**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: program(WEBVIEW_ROOT),
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { ...globals.browser }
      },
      rules: { ...RELAXATIONS, ...MAJOR_RULE_OPTIONS, ...TYPE_AWARE }
    },
    {
      // Type information reaches inside rune-using components through this parser
      // chain — svelte-eslint-parser delegating to tseslint.parser, bound to the
      // webview's own program. tests/lint/svelte-type-information-reaches-runes.test.ts
      // asserts it still does, so an upgrade that silently loses type information
      // reads as red rather than as a clean tree (FR-012, SC-006).
      files: ['src/**/*.svelte', 'src/**/*.svelte.ts'],
      rules: { ...RELAXATIONS, ...MAJOR_RULE_OPTIONS, ...TYPE_AWARE },
      languageOptions: {
        parser: svelteParser,
        parserOptions: { parser: tseslint.parser, ...program(WEBVIEW_ROOT) },
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { ...globals.browser }
      }
    },
    {
      // vite.config.ts and vitest.config.ts: the webview tsconfig includes only
      // `src`, so these belong to no project.
      files: UNPROJECTED_TS,
      languageOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { ...globals.node }
      },
      rules: { ...RELAXATIONS, ...MAJOR_RULE_OPTIONS, ...TYPE_AWARE_UNAVAILABLE }
    },
    {
      // webview-ui/package.json declares `"type": "module"`, so unlike the host
      // tree `.js` here is ESM. svelte.config.js is the one such file, and it is
      // linted for the first time by this feature (FR-004).
      files: ['**/*.mjs', '**/*.js'],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { ...globals.node }
      },
      rules: PLAIN_JS_RULES
    },
    {
      files: ['**/*.cjs'],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'commonjs',
        globals: { ...globals.node }
      },
      rules: PLAIN_JS_RULES
    }
  ];
}
