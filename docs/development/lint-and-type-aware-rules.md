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

## Indexed reads, and the one form that satisfies both gates

Two gates type-check `src/` and `tests/`, and they do it under different compiler settings. The same
line can therefore satisfy one and fail the other, and this is the place authors meet that — in both
directions.

`npm run lint` runs its type-aware rules through the root TypeScript program exactly as
`tsconfig.json` configures it. There, `map[id]` is typed `T`. A guard after it is a check against a
value the compiler has already promised is present, so `@typescript-eslint/no-unnecessary-condition`
reports it — and that rule is count-bounded, so one new finding fails the run.

`tests/lint/compiler-strictness-ratchet.test.ts` type-checks the same files with
`noUncheckedIndexedAccess` layered on top. There, `map[id]` is typed `T | undefined`, so using it
without a guard is a type error — and that gate is a pinned ratchet, so one new site fails it too.

**Write the guard and the lint fails. Delete the guard and the ratchet fails.** Both gates run in
`npm run gate`.

### Use the bounds-checked accessor when the result will be guarded

```ts
const first = phases.at(0);
if (first === undefined) return 'none';
return first;
```

`Array.prototype.at` is declared to return `T | undefined` whatever `noUncheckedIndexedAccess` is set
to. The guard is necessary under **both** settings: the linter does not read it as dead code, and the
compiler does not read its absence as an error. This exact shape was run against both gates in one
tree state and both were green — the reasoning was checked rather than assumed.

Bracket indexing stays correct wherever the result is used without a guard, and wherever the key is a
literal into a tuple or another type the compiler already knows is total. The rule is about the
guard, not about the bracket.

### Why the two settings differ, and why that is not a bug

`noUncheckedIndexedAccess` is deliberately not enabled in `tsconfig.json`. It is *measured* there
instead, by the strictness ratchet, alongside its sibling `exactOptionalPropertyTypes` under the same
mechanism: the count is pinned, growth is refused, and the flag graduates into the build when its
count reaches zero. Turning it on in one change is the bulk refactor `AGENTS.md`'s work-style rule
bans.

So the lint pass checks the settings the build uses today, and the ratchet checks the settings the
build is moving toward. Both are correct about their own subject. An author writing one line meets
both at once, which is why the convention above exists rather than a preference.

The live diagnostic count and its pin are printed by the ratchet when it fails, and are not restated
here. That file owns them.

### Decision — deliberately not aligned, 2026-09-14 (FR-R3-176)

**Decision.** The two gates are **not** aligned, and the disagreement stays. `noUncheckedIndexedAccess`
is not enabled in `tsconfig.json`; the ratchet's pin is not lowered, raised or removed; and
`@typescript-eslint/no-unnecessary-condition` is not suppressed — not per site, not per directory,
not globally. The remedy shipped instead is the convention above: authors are told which form
satisfies both gates, rather than one gate being switched off so the other can be obeyed.

**Measurement.** The cost of aligning is the live `noUncheckedIndexedAccess` diagnostic count across
`src/` and `tests/`. `tests/lint/compiler-strictness-ratchet.test.ts` owns that number, pins it, and
prints it on failure; run that file to read it. Measured on 2026-09-14 it stood **equal to its pin**,
which is that gate's own definition of a ratchet still ratcheting. The population the convention
addresses is separate and larger: **586 index-then-guard sites** across `src/` and `tests/`, of which
495 use bracket indexing and 91 already use the accessor, and of which **136 are in `src/`**. Method,
coverage and error bars are in `specs/213-claims-nothing-verifies/decisions.md` section M9, in the
planning envelope above this repository — including that 38% of the bracket sites are `expect(...)`
assertion ergonomics rather than load-bearing guards, which is why the `src/` figure is the one to
weigh. That path is written out rather than linked because it does not resolve in a standalone
`repo/` checkout.

**Reason.** Alignment has exactly two forms and both cost more than the disagreement does. Enabling
the flag means rewriting every site the live count names, in one change, to satisfy a compiler
option — the bulk refactor the ratchet was built to avoid, with near-zero review value and non-zero
risk. Disabling `no-unnecessary-condition`, or baselining it away, removes the only pressure holding its
recorded host count where it is — `tests/lint/eslint-baseline.json` owns that count and fails in both
directions — and it would silence the rule across both trees to resolve a conflict that arises in one
narrow shape. Meanwhile the disagreement is **entirely avoidable per line**: the
accessor form satisfies both, costs one character more than the bracket, and 91 sites already use it.
A documented convention buys the whole benefit of alignment at none of its price. What was actually
missing was never the alignment — it was that nothing said so anywhere an author would look.

**Revisit condition.** Reopen when the ratchet's `noUncheckedIndexedAccess` count reaches zero, at
which point the flag graduates into `tsconfig.json` and the disagreement dissolves on its own — the
two gates would then be checking the same settings and this section should be deleted rather than
maintained. Reopen early if `no-unnecessary-condition`'s host count rises for a reason traced to this
conflict, because that would mean the convention is not being read and the cost has moved.

<!-- Source: tsconfig.json -->
<!-- Source: tests/lint/compiler-strictness-ratchet.test.ts -->
<!-- Source: tests/lint/eslint-baseline.json -->
<!-- Source: tests/integration/cap-one-parity.test.ts -->

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
<!-- Source: ../release/actions-terminal-record.md -->
