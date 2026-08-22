# Lint and type-aware rules

What lints this repository, which ESLint generation it runs on, why that
generation and not the next one, and what was deliberately left undone. Recorded
so the next upgrade starts from the constraint that decides it rather than
rediscovering the constraint.

This file exists because the previous arrangement looked fine from the script
table and was not. `lint:webview` ran `npm --prefix webview-ui run lint`, and the
webview's own `lint` was `svelte-check --tsconfig ./tsconfig.json` — a second copy
of its `typecheck`, which `verify:all` already ran as `typecheck:webview`. So the
webview lint gate was a duplicate type check: it cost time, it went green, and no
lint rule had ever read a `.svelte` file. Sixty `no-unnecessary-condition`
findings across twenty-five components were sitting behind a passing gate.

---

## The route: ESLint 9 flat config

**The deciding constraint was the Node floor, and it has since moved.**
When this route was chosen, [.nvmrc](../../.nvmrc) pinned `20.18.0` and ESLint 10
(10.9.0 at the time of writing) declared:

```
engines = { node: '^20.19.0 || ^22.13.0 || >=24' }
```

`20.18.0` satisfied none of those three ranges — it was two patch releases under
the first. That is why ESLint 9 was chosen, and the paragraphs below record the
reasoning as it stood.

The floor has now moved: `engines.node` is `^22 || ^24` and `.nvmrc` pins
`24.19.0`, which satisfies the `>=24` range — as does the `22.23.2` floor CI
also builds on, via `^22.13.0`. **ESLint 10 is therefore
available and still not adopted.** The reason is no longer a constraint but a
choice about diff shape, recorded under `TOOLCHAIN-1` below.

**Rejected — staying on ESLint 8 with `.eslintrc`.** The item that opened this
work offered it as the low-risk option, on the grounds that the existing
`eslintConfig` block in `package.json` already worked. It was rejected because
the version it would pin is out of support. The registry says so itself:

```
$ npm view eslint@8.57.1 deprecated
This version is no longer supported. Please see
https://eslint.org/version-support for other options.
```

Adding five devDependencies and a webview parser chain to a deprecated major, in
order to avoid a migration that would then be owed anyway, buys nothing but the
migration's interest.

**Chosen — ESLint 9, flat config.** It is the only generation that both runs on
the pinned Node floor and is supported. The installed set:

| Package | Range | Installed |
|---|---|---|
| `eslint` | `^9.39.5` | 9.39.5 |
| `@eslint/js` | `^9.39.5` | 9.39.5 |
| `typescript-eslint` | `^8.67.0` | 8.67.0 |
| `eslint-plugin-svelte` | `^3.23.0` | 3.23.0 |
| `globals` | `^14.0.0` | 14.0.0 |
| `svelte` | `^5.55.7` | 5.56.10 |

`typescript-eslint` replaces the separate `@typescript-eslint/eslint-plugin` and
`@typescript-eslint/parser` entries the eslintrc block used; it is the flat-config
entry point for both. `svelte` appears as a root devDependency because
`eslint-plugin-svelte`'s rules import the Svelte compiler, and linting the webview
from the repository root needs it resolvable there. It carries the same range as
[webview-ui/package.json](../../webview-ui/package.json) so the linter parses
against the compiler that builds, and
[tests/lint/svelte-version-parity.test.ts](../../tests/lint/svelte-version-parity.test.ts)
fails if the two ever diverge.

**Residual — ESLint 10, now unblocked.** Named `TOOLCHAIN-1` below. It was a
different item because its work is not lint work: the deciding change was the
Node floor, which touches `.nvmrc`, the CI setup steps, the `engines` field, and
the expectations of everyone with a local `nvm`. Folding it into a lint migration
would mean a diff where a broken CI runner and a new lint finding are
indistinguishable causes of the same red.

**That floor bump has since landed, on its own, for exactly that reason.**
`engines.node` is `^22 || ^24`; `.nvmrc` pins the active LTS `24.19.0`; every CI job
installs from `.nvmrc`, and one extra Linux job in
[ci.yml](../../.github/workflows/ci.yml) runs `verify:all` on the `22.23.2`
floor so the `^22` half of the declared range is not an unchecked claim. The bump deliberately
carried no ESLint change, so its red could only mean "the new runtime broke
something". `TOOLCHAIN-1` is now a plain dependency upgrade with no blocker in
front of it: bump `eslint` and `@eslint/js` to 10, re-measure the six
[eslint-baseline.json](../../tests/lint/eslint-baseline.json) counts in the same
change, and expect the ratchet to fail in the *falling* direction first.

---

## Where the configuration lives

There is no `eslint.config.mjs`. Both trees are configured from one module,
[scripts/lint-config.mjs](../../scripts/lint-config.mjs), and run through one
runner, [scripts/lint.mjs](../../scripts/lint.mjs):

| Command | Tree | Config export |
|---|---|---|
| `npm run lint` | repository root (`src`, `tests`, `scripts`, root tooling) | `hostConfig` |
| `npm run lint:webview` | `webview-ui` (`src`, incl. `.svelte`) | `createWebviewConfig()` |

The host export is a plain array; the webview export is an async function because
`eslint-plugin-svelte` must be imported dynamically. Each tree gets its own
`parserOptions.project`, so a type-aware rule in the webview reasons about the
webview's program and not the host's.

A single module rather than two config files, invoked through a runner rather than
by `eslint` directly, because the runner owns the baseline ratchet described
below — the same findings have to be counted the same way in both trees, and that
is one implementation, not a convention.

**Editor integration.** ESLint extensions look for `eslint.config.*` at the root
and will not find one, so editor squiggles are off by default. A one-line
`eslint.config.mjs` re-exporting `hostConfig` restores them and is deliberately
not committed; the gate of record is the command, and a second config file at the
root is a second thing to keep in step.

---

## Runtime cost

Measured on darwin, Node 20.18.0 (the `.nvmrc` pin at the time; the floor has
since moved to 24.19.0), warm `node_modules`, before and after the
change. Wall is `real`; CPU is `user + sys`.

| Command | Before | After |
|---|---|---|
| `npm run lint` (host) | 7.7 s wall / 10.3 s CPU | 16.3 s wall / 20.3 s CPU |
| `npm run lint:webview` | 6.0 s wall / 9.4 s CPU (`svelte-check`, linting nothing) | 11.5 s wall / 19.5 s CPU |

Net effect on `verify:all`: about **+14 s wall** — `+8.6` on the host and `+5.5`
on the webview, the latter measured against what the duplicate `svelte-check`
already cost rather than against zero. That is the "about +15 s" the plan
budgeted, confirmed.

**Why CPU is recorded beside wall.** Both figures show CPU above wall, so both
runs use more than one core. Wall time therefore describes this machine's core
count and this moment's load, and it moves when either changes; the CPU figure is
what a CI runner with fewer cores will converge toward, and it is what the bill is
drawn against. Recording only wall time is how a gate that costs 20 s of CPU gets
budgeted as 11 s of wall and then "mysteriously" doubles on a two-core runner.

---

## The baseline is a ratchet, not a waiver

Six rules report findings this migration did not fix. Their counts live in
[tests/lint/eslint-baseline.json](../../tests/lint/eslint-baseline.json), one
entry per rule, each with the deciding decision, a reference that resolves, and a
`reductionNote` saying how the count is meant to come down.

The runner compares actual to recorded and fails **in both directions**: a rise is
a regression, and a fall is a stale record. Counts, not site lists, because a list
would turn every unrelated edit into a merge conflict in a JSON file — which is
also why a regression message names the files it found and then tells you how to
diff the sites, rather than pretending it knows which of them are new.

The procedure for promoting a baselined rule to `error`, and the rules about
`eslint-disable` comments, are in
[CONTRIBUTING.md](../../CONTRIBUTING.md#lint-baselines-and-suppressions). They
live there because they are things a contributor does, not things this document
records.

---

## Deferred: two compiler strictness flags

[tsconfig.json](../../tsconfig.json) is unchanged by this work — `strict: true`
with `noImplicitAny`, `noImplicitReturns`, `noUnusedLocals` and
`noUnusedParameters`, and neither flag below. Both were measured, both were
deferred, and the price of each is recorded here so the deferral is a decision
with a number attached rather than an omission.

### `TOOLCHAIN-2` — `noUncheckedIndexedAccess`

**Measured cost: 1,176 errors.** Enabling it is a multi-week change of its own
shape: every index and every `Record` access becomes `T | undefined`, and the
correct fix differs site by site — a guard, a non-null assertion with a reason, or
a redesign of the container.

It is also the flag that governs the largest baseline entry.
`@typescript-eslint/no-unnecessary-condition` records 620 findings (346 host, 274
webview), and most of them are not dead code: they are checks against values the
compiler already types as non-nullable *because this flag is off*. Turning the
flag on removes the cause of that entry rather than editing its 620 sites, which
is why the entry's `reductionNote` points here instead of proposing a sweep.

**Acceptance for the follow-on item:** the flag on, `npm run typecheck` and
`typecheck:webview` green, and the `no-unnecessary-condition` baseline entry
re-measured — expected to fall sharply — in the same change.

### `TOOLCHAIN-3` — `exactOptionalPropertyTypes`

**Measured cost: 130 errors.** Small enough to look like it belongs in this
migration, which is exactly why it does not. This feature's diff already touches
every file the linter newly covers; folding 130 type errors into it would leave a
change where nobody can review either half. The two failures also read
identically at a glance — a rule newly reporting and a type newly narrowing both
show up as "a line I did not write is now red".

**Acceptance for the follow-on item:** the flag on, both typechecks green, and no
`?:` property silently widened to `| undefined` to make a site compile — that is
the change the flag exists to prevent.

### Why these carry `TOOLCHAIN-` names

Round 3's item numbering closed at `FR-R3-030`, so appending to it would extend a
set that has an exit condition. These three are named here, in the document that
defers them, so the deferral has an addressee that a future reader can grep for.
They are engineering items in this repository, not planning-envelope items.
