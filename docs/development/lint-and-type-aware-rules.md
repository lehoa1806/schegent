# Lint and type-aware rules

Schegent has separate compiler and ESLint passes for the host repository and the Svelte webview. Run the npm scripts rather than invoking ESLint directly: `scripts/lint.mjs` is the sole ESLint entry point and applies both error enforcement and the repository's warning-count ratchet.

## Commands

| Command | Scope |
|---|---|
| `npm run typecheck` | Root TypeScript project over `src/` and `tests/`, with no emit. |
| `npm run typecheck:tests` | The explicit test compiler project, with no emit. |
| `npm run typecheck:webview` | Svelte and TypeScript checking through the webview package. |
| `npm run lint` | Host pass over `src/`, `tests/`, `scripts/`, and root-level tooling files. |
| `npm run lint:webview` | Webview pass over `webview-ui/src/`, `webview-ui/tests/`, and webview root tooling files. |
| `node scripts/lint.mjs host --census` | Non-failing host rule-count inventory. |
| `node scripts/lint.mjs webview --sites` | Webview lint with individual sites for baselined findings. |

<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: scripts/lint.mjs -->
<!-- Source: tsconfig.json -->
<!-- Source: tsconfig.tests.json -->
<!-- Source: webview-ui/tsconfig.json -->

## Configuration shape

The project uses ESLint 9 with flat configuration supplied as importable objects from `scripts/lint-config.mjs`. The runner uses the ESLint Node API with automatic config discovery disabled, so there is intentionally no root `eslint.config.*` file.

The host pass applies type-aware rules to `src/**/*.ts` and `tests/**/*.ts` through the root TypeScript program. Root tooling and script files outside a TypeScript project still receive syntactic rules, while type-dependent rules are disabled for those files because no program can answer them.

The webview pass uses `svelte-eslint-parser`, delegates component scripts to the TypeScript ESLint parser, and binds both TypeScript and Svelte source to `webview-ui/tsconfig.json`. A positive lint probe verifies that `@typescript-eslint/no-floating-promises` can report inside a rune-using component; a clean control proves the probe is testing type information rather than a parse failure.

<!-- Source: package.json -->
<!-- Source: scripts/lint-config.mjs -->
<!-- Source: scripts/lint.mjs -->
<!-- Source: tests/lint/svelte-type-information-reaches-runes.test.ts -->

## Type-aware policy

These rules have one severity across each tree:

| Rule | Severity |
|---|---|
| `@typescript-eslint/no-floating-promises` | error |
| `@typescript-eslint/no-misused-promises` | error |
| `@typescript-eslint/await-thenable` | error |
| `@typescript-eslint/no-unnecessary-condition` | warning, count-bounded |

Unused-disable directives are errors. Empty catch blocks are syntactically allowed because a separate source-aware gate requires an explanatory comment. `_`-prefixed bindings are the declared convention for deliberately unused parameters and variables.

<!-- Source: scripts/lint-config.mjs -->
<!-- Source: tests/lint/empty-catch-declares-intent.test.ts -->

## Baseline ratchet

`tests/lint/eslint-baseline.json` records the approved nonzero counts for selected warning rules separately by tree, along with an owning decision and reduction note. The lint runner fails when a count rises above the record and also when it falls below the record: a reduction must update the baseline in the same change so later regressions cannot hide inside stale allowance.

Rules absent from the baseline are enforced normally; any error-severity finding fails. A separate test verifies that every baseline rule is still enabled at warning severity, its owner reference resolves, and the total number of suppression directives has not silently grown.

When fixing a baselined site:

1. Run the relevant lint command with `--sites` to identify current locations.
2. Make the behavior-aware fix and rerun the normal lint command.
3. Lower the corresponding count in `tests/lint/eslint-baseline.json` in the same change.
4. If the count reaches zero, remove the baseline entry; promote a deliberately baselined warning back to error only when all of its sites are cleared.

<!-- Source: scripts/lint.mjs -->
<!-- Source: tests/lint/eslint-baseline.json -->
<!-- Source: tests/lint/eslint-baseline.test.ts -->

## Verification perimeter

`npm run verify:all` executes all three typechecks and both lint trees before the host and webview test gates complete. Lint-policy tests themselves must not depend on undeclared external binaries; their file discovery uses Node and TypeScript APIs so the documented npm workflow remains portable across the CI matrix.

<!-- Source: package.json -->
<!-- Source: tests/lint/lint-gates-are-hermetic.test.ts -->
<!-- Source: .github/workflows/ci.yml -->
