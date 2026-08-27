# Releasing Schegent

**A release is entirely local, and produces a VSIX.** A maintainer chooses the version, commits it,
runs the attested gate under observation, and packages. Nothing publishes, nothing is attested by a
third party, and no GitHub Release is created — because **GitHub Actions was retired on 2026-08-26,
for budget, by operator decision**, and all eight workflow files are deleted from this tree.
<!-- Source: docs/release/actions-terminal-record.md -->
<!-- Source: package.json -->

> **This document described the old process until 2026-08-27.** It told a maintainer to push a
> `v<version>` tag and wait for Actions to verify, package, attest and publish. That machine no
> longer exists: pushing such a tag today does nothing at all, silently. `FR-R3-099` deleted the
> workflows and recorded what they were; this document was rewritten a day late, which is itself an
> instance of the class that item exists to close — a procedure describing a product that changed
> underneath it. What it claimed is preserved below under [What a release no longer
> does](#what-a-release-no-longer-does), because a maintainer who remembers the old process needs to
> know which parts are gone rather than merely to stop finding them.

## Breaking changes not yet released

### FR-R3-117 — a Phase is judged on its exit status by default (2026-08-27)

**What changed.** `hostVerification` used to resolve to `'model-token'` when a Phase
declared nothing: the Phase advanced on the model's own account of its work, so a
non-zero exit alongside a clean termination token was logged and advanced, and a
timed-out process whose buffered output parsed clean was treated as success.

It now resolves to **`'exit-code'`** for any Phase whose resolved `sideEffects` is
other than `'none'`, or which produces a declared output. Such a Phase does not advance
on a non-zero exit or a timeout, whatever its output says.

**How wide this is.** `sideEffects` itself resolves to `'workspace'` when omitted, so
**most existing Phases are affected**. A Phase is unaffected only if it explicitly
declares `sideEffects: 'none'`.

**What an operator must do to keep the old behaviour.** Add the opt-out to the Phase:

```yaml
spec:
  hostVerification: model-token
```

That is the only way to get self-report on a Phase that touches anything. It is worth
taking deliberately for a Phase that legitimately exits non-zero — a linter used as a
probe, a diff check that reports difference by exit code — and worth not taking
otherwise.

**Persisted plans are not retargeted.** `STATE_SCHEMA_VERSION` moves 13 → 14 and
`migrateV13ToV14()` stamps each existing plan snapshot with the verdict basis it was
frozen under, which is the OLD one. A Run created before the upgrade keeps the meaning
its operator approved; the new default applies to plans frozen after it.

**Where to look.** The decision, the two shapes not taken, and why shape 3
(unconditional) is the recorded destination:
[`docs/architecture/phase-verdict-default.md`](docs/architecture/phase-verdict-default.md).

**New evidence.** `phase-end` now carries `verdictBasis` (`exit-code` or `model-token`),
so a completed Run's evidence answers which basis judged each Phase. Additive —
`AUDIT_SCHEMA_VERSION` is unchanged at 3.

## Release boundary

The boundary is `npm run release`, which is `release:preflight && package`. It refuses to package
unless **three** local bindings all answer at the current commit:

1. **A gate attestation** naming `HEAD` over a clean tree (`FR-R3-095`, widened by `FR-R3-100`).
2. **A backend qualification record** that is fresh, taken against the installed CLI versions, and
   not older than the last change under `src/runner/`, `src/parser/` or
   `src/contracts/backend-kinds.ts` (`FR-R3-104`).
3. **Manifest and tag agreement** — the six version sites across the four manifests agree, and any
   `v*` tag on `HEAD` agrees with them (`FR-R3-120`). Two disagreeing `v*` tags refuse as ambiguous
   rather than picking one.
<!-- Source: package.json -->
<!-- Source: scripts/require-local-gate.mjs -->

Neither is independent verification. Both describe **one machine, one platform, once** — see
[`docs/architecture/release-posture-engineering-preview.md`](../docs/architecture/release-posture-engineering-preview.md).
A version tag may still be created for human bookkeeping; it triggers nothing.

## 1. Choose and record the version

Keep these four files aligned:

- `package.json`
- `package-lock.json`
- `webview-ui/package.json`
- `webview-ui/package-lock.json`

The documentation gate compares the two manifest versions, and both lockfiles record their package tree's version. One non-tagging way to update each manifest and lockfile pair is:

```bash
npm version <version> --no-git-tag-version
npm --prefix webview-ui version <version> --no-git-tag-version
```

Replace `<version>` with the exact version string without a leading `v`. Review all four resulting
diffs. **`release:preflight` now checks this** (`FR-R3-120`): it refuses when the six version sites
across those four files disagree, or when a `v*` tag on `HEAD` disagrees with them, and it names
every disagreeing site rather than the first. This restores locally what the retired tag job did.
Untagged commits are checked too — mutual drift is introduced on an ordinary commit, not on the
tag.
<!-- Source: package.json -->
<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: webview-ui/package-lock.json -->
<!-- Source: scripts/check-docs.mjs -->
<!-- Source: docs/release/actions-terminal-record.md -->

Update [operator-visible release notes](docs/operations/release-notes.md) without inferring changes
from a version number. Nothing generates or links this document; a reader finds it because you told
them where it is.
<!-- Source: docs/release/actions-terminal-record.md -->

Commit the version and release-note changes before attesting the gate: the attestation names a
commit and refuses a dirty tree, so an uncommitted version bump cannot be part of what was verified.
The repository has no release-preparation script and no automated version bump.
<!-- Source: package.json -->
<!-- Source: docs/release/actions-terminal-record.md -->

## 2. Run the attested gate

Run the one aggregate gate from the repository root:

```bash
npm run gate
```

`gate` is `contracts:check && docs:check && security:secrets && security:actions && license:check`
followed by `ci`. It is the **whole** verification surface: before `FR-R3-100` the attested command
was `ci` alone, which omitted those five checks, so a release could be attested past a failing secret
scan. Running `verify:all` or `ci` on their own is still useful while working; neither is what the
release binding reads.
<!-- Source: package.json -->

There is no remote gate, weekly or otherwise. The **Full gate** workflow this section described ran
weekly for fourteen weeks and was red every time, unread; its runs are recorded in
[the terminal record](docs/release/actions-terminal-record.md) and the binding that consumed them in
[the withdrawal record](docs/release/withdrawn-ci-controls.md).

> **This binding is withdrawn, 2026-08-26, and the reason it was kept was false.** `S14` and
> FR-R3-095 recorded that *"this project does not run GitHub Actions"*, so `full-gate.yml` produced no
> runs and the binding had no records to read. **That was wrong, and wrong in the more damaging
> direction.** The principal review checked the live API and found **185 runs since 2026-05-18** —
> `full-gate.yml` weekly for 14 weeks, all red; `ci.yml` red at the then-current `HEAD` with the
> Windows leg failing; CodeQL green at `HEAD`; `backend-canary.yml` green on the same day its own
> header said it does not run. Runs existed **at the current commit**, and nothing anywhere consumed
> one of them. A conclusion about the remote, written without checking the remote, is this round's
> signature defect turned on the audit itself.
>
> The operator has since decided the question: **Actions are retired, entirely, for budget**
> (`FR-R3-099`). So the premise FR-R3-095 §5 kept this binding under — *"for a process this project
> may adopt"* — is decided against, and `require-full-gate.mjs` and `release.yml` are **deleted**
> rather than left inert. What they were is recorded in
> [withdrawn CI controls](docs/release/withdrawn-ci-controls.md); the fourteen weeks of unread signal
> are read once in [the terminal record](docs/release/actions-terminal-record.md).
>
> **The binding that operates is the local one in §2a, and it is now the only one.** It is not a
> substitute for the matrix, the Node floor, code scanning or dependency review — and those are not
> pending, they are **gone**, with no local equivalent for code scanning at all. Single-platform,
> single-machine verification is a permanent stated limit of this project, not a state awaiting a
> push.
<!-- Source: docs/release/withdrawn-ci-controls.md -->
<!-- Source: docs/features/round_3/DONE_95_FR-R3-095_a_release_gate_that_exists.md -->


## 2a. Bind the release to a gate result for THIS commit (local path)

Running the gates is not the same as having evidence that they ran, and until FR-R3-095 the local release path had neither a script nor a binding — `npm run package` would package any tree at all.

```bash
npm run gate:record      # runs `npm run gate` under observation and records the result
npm run release          # refuses unless a recorded PASS names HEAD over a clean tree
```

`gate:record` **spawns** the gate and records the exit code it observed, at the commit, on the platform, with the tree confirmed clean before and after. The writer sits outside the thing the record vouches for, so it cannot record a pass it did not see — a gate step that wrote its own attestation would prove only that the step ran. A red run is recorded too, so a failure leaves anti-evidence instead of leaving an older commit's pass as the newest record anyone finds.

`release` runs the check and then packages. It refuses, naming which of six causes applies, when: the tree is dirty, no record exists, the record names another commit, it records a different command, it records a failing gate, or it is a version this checker does not read. The record is untracked — it describes one machine's observation of one tree, and a committed one would travel to a clone that never earned it.

**The command name is part of the evidence.** `GATE_COMMAND` moved from `npm run ci` to
`npm run gate` when `FR-R3-100` widened the perimeter, and the check is an exact string match. Every
attestation recorded under the narrower command is therefore **refused** rather than silently
honoured — the rename is what makes the widening retroactive.

### 2b. The second binding: backend qualification (FR-R3-104)

`release:preflight` also refuses when the three backend CLIs have not been qualified against a live
turn recently enough:

```bash
npm run canary           # spends three live turns; writes .backend-qualification.json
```

It refuses when the record is absent, unreadable, undated, older than the declared freshness bound,
taken against a different CLI version than the one installed, or taken before a change under
`src/runner/`, `src/parser/` or `src/contracts/backend-kinds.ts`. The bound and the reasoning for its
value live beside the constant; the operator-facing statement of it is in
[the qualification log](docs/release/backend-qualification-log.md), derived from that constant rather
than restated.

**Why it is here and not in `npm run gate`.** A live turn costs the operator's own subscription
quota. Gating every gate run would charge a turn per run, and a gate people cannot afford is a gate
people disable. A release is a deliberate act with a person present.

`SCHEGENT_RELEASE_UNQUALIFIED=1` overrides the refusal. Taking it prints `RELEASING UNQUALIFIED` and
points at the log, where the unqualified release must be recorded with its date and reason.
<!-- Source: scripts/backend-qualification.mjs -->
<!-- Source: scripts/require-local-gate.mjs -->

### What the attested gate covers

This list is **derived from the script chain, not typed beside it** (FR-R3-100, FR-017).
`scripts/check-gate-coverage-parity.mjs` computes the transitive closure of `npm run gate` over
`package.json` and refuses when this block and the chain disagree — in **both** directions, because a
stage the document claims and the chain does not reach is worse than one it forgets. Regenerate with
`node scripts/check-gate-coverage-parity.mjs --write`.

Before this item the binding named `npm run ci`, which did **not** run the secret scan, the
workflow-pin check, the license check, the docs check or `contracts:check`. A release could therefore
be attested past a failing secret scan. `GATE_COMMAND` now names `npm run gate`, which runs those five
and then `ci`; the host coverage floors moved inside it too, by `ci` running `test:coverage` rather
than `test:host`.

<!-- BEGIN DERIVED: gate-coverage -->

<!-- Generated by scripts/check-gate-coverage-parity.mjs. Do not edit by hand. -->

`npm run gate` reaches **22** checks that do work of their own:

- `a11y` — `node scripts/check-playwright-browser.mjs && npm run build:webview && playwright test --config playwright.a11y.config.ts`
- `build:host` — `node esbuild.config.mjs`
- `build:webview` — `npm --prefix webview-ui run build`
- `contracts:check` — `node scripts/generate-contract-schemas.mjs --check`
- `docs:check` — `node scripts/check-docs.mjs && node scripts/check-doc-links.mjs && node scripts/check-gate-coverage-parity.mjs`
- `license:check` — `node scripts/check-licenses.mjs`
- `lint` — `node scripts/lint.mjs host`
- `lint:webview` — `node scripts/lint.mjs webview`
- `package:smoke` — `node scripts/package-vsix-smoke.mjs`
- `security:actions` — `node scripts/check-workflow-pins.mjs`
- `security:secrets` — `node scripts/scan-secrets.mjs`
- `test:coverage` — `vitest run --coverage`
- `test:e2e` — `vitest run --config vitest.e2e.config.ts`
- `test:evals` — `vitest run --config vitest.evals.config.ts --reporter=verbose`
- `test:integration` — `npm run build && npm run test:integration:compile && node ./out/tests/integration/runTest.js`
- `test:integration:compile` — `tsc -p tsconfig.integration.json`
- `test:perf` — `vitest run --config vitest.perf.config.ts`
- `test:visual` — `node scripts/check-playwright-browser.mjs && npm run build:webview && playwright test --config playwright.config.ts`
- `test:webview:coverage` — `npm --prefix webview-ui run test:coverage`
- `typecheck` — `tsc --noEmit`
- `typecheck:tests` — `tsc -p tsconfig.tests.json --noEmit`
- `typecheck:webview` — `npm --prefix webview-ui run typecheck`

<!-- END DERIVED: gate-coverage -->

**Wall-clock and coverage, measured 2026-08-26.** The host suite under coverage measures
**89.47 / 88.03 / 91.37 / 89.47** (statements / branches / functions / lines) against declared floors
of 80 / 75 / 80 / 80 — so the floors are a real control with roughly nine to thirteen points of
headroom, which is why FR-R3-100 enforced them rather than taking its other option of deleting them.
A threshold breach makes the run exit non-zero: verified by raising a floor above actual coverage and
observing the refusal, not assumed from the configuration.

The instrumented host suite takes about **2m10s** against roughly **35s** uninstrumented, and the five
folded checks add a few seconds between them; none of them builds the webview, so the build count is
unchanged at five. **No stage was dropped to protect any of these figures.**

One honest caveat, recorded rather than discovered later: two consecutive instrumented runs disagreed,
with seven timing-sensitive tests failing on the first and none on the second. The failures are
assertions about exact debounce coalescing after wall-clock sleeps — the load-sensitivity class
`FR-R3-114` row 3 files — so an instrumented gate is more likely to need a re-run than the
uninstrumented one was. The measurement is in `specs/156-round-3-close/baselines.md`.

**Still not covered, stated rather than implied.** `npm run security:audit` queries the npm registry,
so it is operator-invoked and outside the gate: a gate that fails for want of a network is a gate
people learn to bypass. `npm run selftest:install` performs a real network install and is outside for
the same reason. Both are named in `SECURITY.md` and `CONTRIBUTING.md` with the occasion to run them.

**What this is not.** A local attestation is not tamper-evident against the operator whose machine wrote it: anyone who can run the release can also edit the file it reads. It reduces the risk of releasing a commit whose gate never ran, or whose gate ran on a different tree. It is not a substitute for independent verification, and the success message says so along with the single platform the gate ran on.
<!-- Source: scripts/gate-attestation.mjs -->
<!-- Source: scripts/record-gate-run.mjs -->
<!-- Source: package.json -->

## 3. Package the extension

`npm run package` is `npm run sbom && vsce package --no-dependencies`. It emits
`schegent-sbom.cdx.json` (CycloneDX 1.5) beside the VSIX **and packages it inside**, because a
recipient is handed one file and an SBOM on the builder's disk describes the artifact to nobody
(`FR-R3-120`). Its strongest statement is the short one: this extension declares **zero runtime
dependencies**, and the SBOM now says so verifiably rather than by assertion. What it asserts and
what it does not — it reads the lockfiles and has not opened the archive — is stated in the
document's own metadata.
<!-- Source: scripts/generate-sbom.mjs -->

```bash
npm run release          # release:preflight, then package
```

The packaging policy requires exactly one VSIX, a closed entry allowlist, safe archive paths, at most
2 MiB compressed, and at most 5 MiB uncompressed. It includes the extension manifest, license, root
README/RELEASE/SECURITY documents, branding assets, built host/webview files, and every file in
`examples/`; `.vscodeignore` excludes source, tests, implementation docs, maps, local state, and the
repository's own tooling configuration.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .vscodeignore -->

The build does not set `NODE_ENV=production`, so `esbuild.config.mjs` takes its non-production branch
for the host bundle; source maps are emitted and then excluded from the VSIX. Do not describe the
packaged artifact as minified.
<!-- Source: esbuild.config.mjs -->
<!-- Source: .vscodeignore -->

## 4. Tag, if you want the bookkeeping

```bash
git tag -a v<version> -m "v<version>"
```

Both occurrences of `<version>` must equal `package.json`'s version without the `v` prefix. **The tag
triggers nothing.** It is a marker for humans reading history. Pushing it is an outward action on a
remote; this workspace has never pushed, and nothing in the tree depends on the tag existing.

The repository encodes no signing requirement for Git tags. If maintainers require signed tags
operationally, that policy lives outside this repository.

## 5. What a release no longer does

Everything in this section was performed by GitHub Actions and is **gone**. It is listed so a
maintainer who remembers the old process knows what is missing rather than assuming it still happens
silently. What each withdrawn thing *was* is recorded in
[the withdrawal record](docs/release/withdrawn-ci-controls.md); what its runs produced is in
[the terminal record](docs/release/actions-terminal-record.md).

| No longer happens | What it was | Local substitute |
|---|---|---|
| A durable GitHub Release | Created by the tag job, containing the VSIX, SBOM and checksums | **None.** The VSIX exists only on the machine that packaged it |
| Build provenance attestation | GitHub OIDC attestation over the VSIX and SBOM, verifiable with `gh attestation verify --signer-workflow` | **None.** A consumer cannot verify who built a Schegent VSIX |
| `schegent-sbom.cdx.json` | `npm sbom --sbom-format cyclonedx` in the tag job | Run it by hand if an SBOM is needed; nothing generates one |
| `SHA256SUMS` | `sha256sum` over the VSIX and SBOM | Run it by hand |
| A three-OS verification matrix | `ci.yml` on ubuntu, macOS and Windows | **None.** Single-platform is now a permanent stated limit, not a pending state |
| A weekly whole-tree gate | `full-gate.yml`, run weekly, red for fourteen weeks unread | `npm run gate`, run deliberately and attested at a commit |
| Code scanning | CodeQL | **None.** Recorded in `SECURITY.md` |
| A scheduled backend canary | `backend-canary.yml` | `npm run canary`, on the declared local cadence that gates the release path |

**The honest summary**: a Schegent release today is a locally-verified, locally-attested VSIX on one
platform. It carries less assurance than the retired process claimed and more than the retired
process delivered, because that process was red and unread for fourteen weeks while every document
here said it was not running at all.

## 6. Verify what you built

There is no published artifact and no third-party attestation to check. What can be checked locally:

```bash
npm run release:preflight   # both bindings, without packaging
npm run audit:verify        # the audit log's hash chain, if you are verifying an operator's evidence
```

Install or smoke-test the VSIX in a second VS Code host before handing it to anyone. `package:smoke`
exercises the build before packaging; it does not install the final archive.
<!-- Source: scripts/package-vsix-smoke.mjs -->

### The performance claims a release may make (`FR-R3-130`, 2026-08-27)

Two figures are measured and dated, and a release may cite them **as written and no further**:

| Claim | Floor | Source |
|---|---|---|
| The workspace-scaling part of activation completes in **under 100 ms at p95** on a workspace of ~2,000 tracked files | measured 45 ms p95, ~2× headroom | [large-workspace resource measurement](docs/operations/large-workspace-resource-measurement.md) §5a |
| Concurrency does not slow the working tree: `git status` is **flat at 23–27 ms** from cap 1 to cap 8 with up to 64 MiB of stream output held | measured, all four levels | same record, §4 |

**What a release may NOT claim from them**: activation end to end (that is the extension-host chain
under its own 5 s budget), a cold cache, a network or remote filesystem, or any platform other than
darwin/arm64 — Windows and Linux remain in the declared `unverified` tier
([platform observation record](docs/operations/platform-observation-record.md)).

**And the cost an operator should be told, not claimed away**: buffers retain what they accept,
roughly 1:1, below the per-stream cap. The 0.66× compression discount an earlier record credits does
not apply at a few MiB per stream. The product warns about this at the point the cap is set; a release
note that implied a discount would be undoing that warning.
<!-- Source: docs/operations/large-workspace-resource-measurement.md -->

## 7. Marketplace publication is manual and unspecified

No npm script runs `vsce publish`, `ovsx publish`, or another Marketplace deployment command. No
Marketplace token name or credential procedure is checked in. `npm run package` creates a VSIX only.

A maintainer must use the externally governed publisher account and procedure; this document cannot
supply an exact publish command or credential name from repository evidence.
<!-- Source: package.json -->

## Failure and rerun policy

- A refusal from `release:preflight` names exactly which binding failed and why. Fix the cause; do
  not package around it.
- A dirty tree cannot be attested. Commit or stash first — a record that describes a tree nobody can
  reconstruct is worse than no record, because it reads as evidence.
- A red gate is recorded too. That is deliberate: a failure leaves anti-evidence rather than leaving
  an older commit's pass as the newest record anyone finds.
- Do not silently retag. A tag names a commit; cut a new version instead.
