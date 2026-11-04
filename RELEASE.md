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
`migrateRunVerdictBasis()` stamps each frozen Phase of an existing Run with the verdict
basis it was frozen under, which is the OLD one. A Run created before the upgrade keeps
the meaning its operator approved; the new default applies to plans frozen after it.

The step runs on **every** initialize, before the version is stamped, and it is keyed on
what each frozen Phase records rather than on the version number. That is why it also
repairs a workspace that an earlier 0.2 build stamped 14 without migrating: its Phases
still lack `hostVerification`, and the step finds and fixes them. A second run finds
nothing to change. A Phase that carries a provenance but no value is one no build ever
froze; it keeps the policy this version already applies to it, written explicitly, and the
Run is named once in a warning. Cancel it and start it again to run under a plan frozen
now.

**Where to look.** The decision, the two shapes not taken, and why shape 3
(unconditional) is the recorded destination:
[`docs/architecture/phase-verdict-default.md`](docs/architecture/phase-verdict-default.md).

**New evidence.** `phase-end` now carries `verdictBasis` (`exit-code` or `model-token`),
so a completed Run's evidence answers which basis judged each Phase. Additive —
`AUDIT_SCHEMA_VERSION` is unchanged at 3.

### FR-R4-F02 — bounded unattended recovery and spending (2026-10-28)

**What changed.** Unattended recovery and the spend bound are now bounded by what they can
verify, and the operator is told where each limit came from.

- **The window status indicator reflects credit polling only.** A delayed retry no longer
  drives it: delayed retries run on the retry coordinator's own timer, and the credit
  watchdog polls credits and nothing else.
- **State schema v15** adds the credit-pause record: each Run carries `creditPause` (an
  explicit `null` when it is not paused for credits) and the watchdog record carries the last
  poll outcome. The step runs once on open, is idempotent, and is forward-only: a workspace
  written by this version is refused by an older one.
- **Credit polling stops after 24 hours** for a Run paused for credits, with one notice and a
  **Resume** control on the Run. The poll resumes a Run only on a status that states recovery;
  negated, quoted or unclear text no longer counts as healthy.
- **An unattended resume never restarts a failed or manually paused Run,** and never takes more
  of the concurrency cap than the cap allows. A queue's elapsed delayed retry no longer waits
  behind a sibling Run's resume.
- **Spend bounds now read recorded usage.** The audit writer has recorded usage nested under
  `metrics` since 2026-08-02, and the spend bound read only the flat keys until now, so in that
  period a configured bound never paused a Run. Spend that cannot be measured, or whose history
  is incomplete after a restart, is reported once per Run and unit and is never read as within
  budget.
- **Each in-flight Run shows its effective limits** and which layer each came from.

**Where to look.** [`docs/operations/retry-contract.md`](docs/operations/retry-contract.md) for
the retry and watchdog behaviour, and
[`docs/operations/autonomy-bounds-disclosure.md`](docs/operations/autonomy-bounds-disclosure.md)
for the spend bound, the restart replay and where each limit comes from.

**New evidence.** None: `AUDIT_SCHEMA_VERSION` is unchanged at 3 and no event type is added.

### FR-R5-F07 — Unified Phase + Composable Workflow model (2026-11-03)

**What changed.** Process definitions are now unified around two kinds: **Phase** (one reusable
agent action) and **Workflow** (a reusable process whose nodes reference Phases or child
Workflows). `Pipeline` is retired as a product/domain resource kind, authoring tab, launch
route, and Process YAML exchange kind (`kind: Pipeline` is refused with `unsupported-kind`).

- **Composable Workflows and explicit public interfaces (`FR-R5-F01`, `260`).** A Workflow node
  targets either `phaseId` or `workflowId`. Workflows declare explicit public `inputs` and
  `outputs` with internal `bindings`, and dependency validation enforces acyclic inclusion
  (`MAX_WORKFLOW_NESTING_DEPTH = 8`, `MAX_WORKFLOW_CLOSURE_DEFINITIONS = 64`,
  `MAX_WORKFLOW_EXPANDED_NODES = 256`).
- **Frozen closure execution and hierarchical call stack (`FR-R5-F02`, `261`).** Launching a
  Workflow freezes the transitive `FrozenWorkflowClosure` before root admission and executes
  each root or child invocation in its own `WorkflowInvocationFrame` with deterministic entry,
  automatic/manual handoffs, and parent return.
- **Invocation-scoped controls and restart reconciliation (`FR-R5-F03`, `262`).** Pause, resume,
  cancel, retry, and manual continuation address a specific `(queueId, rootRunId, invocationId)`
  with compare-and-set `expectedRevision` checks and per-queue FIFO serialization. Host startup
  reconciles composable runs from durable completion evidence and flags interrupted attempts
  with uncertain external effects (`effect-uncertain-interrupted`) rather than replaying them
  automatically.
- **Transitive Process YAML exchange (`FR-R5-F04`, `263`).** `include-closure` export emits a
  dependency-ordered multi-document YAML bundle of all referenced Phases and child Workflows;
  import validates the complete candidate overlay before writing.
- **Unified authoring and launch/run visibility (`FR-R5-F05`/`FR-R5-F06`, `264`/`265`).** The
  Builder exposes `Phases` and `Workflows` tabs with breadcrumb child drill-down and a direct
  `Launch in Runs` handoff. The Runs surface launches any published Workflow and renders the
  hierarchical invocation tree with per-occurrence state, handoff controls, and primary-window
  action gating.
- **Shipped Workflow examples (`FR-R5-F07`, `266`).** All shipped examples under `examples/`
  are authored as `kind: Workflow` packages (`speckit-new-feature.workflow.yaml`,
  `speckit-bugfix.workflow.yaml`, `example-two-node.workflow.yaml`,
  `example-nested-delivery.workflow.yaml`) and remain excluded from the packaged VSIX.

**Where to look.** [`docs/how-to/product-workflows.md`](docs/how-to/product-workflows.md) and
[`docs/how-to/developer-workflows.md`](docs/how-to/developer-workflows.md).

**New evidence.** Invocation and node-path lineage (`rootWorkflowRunId`, `invocationId`,
`parentInvocationId`, `nodePath`, `attemptNumber`) are recorded in runtime state and audit
metadata; `AUDIT_SCHEMA_VERSION` remains 3.

## Release boundary

The boundary is `npm run release`, which is `release:preflight && node scripts/prepare-release.mjs`
(`FR-R4-F09`). It refuses to prepare a candidate unless **three** local bindings all answer at the
current commit:

1. **A gate attestation** naming `HEAD` over a clean tree, at the current schema version, whose
   recorded argument vector witnesses the command it names (`FR-R3-095`, widened by `FR-R3-100`,
   made truthful by `FR-R3-135`).
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
`npm run release` (`scripts/prepare-release.mjs`, section 3) prepares the candidate from a committed
tree, but it only reads the version it finds in `package.json` and refuses one that is not a release
version; it never writes it. The version bump and the release notes stay hand edits.
<!-- Source: package.json -->
<!-- Source: scripts/prepare-release.mjs -->
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

`release` runs the check and then prepares the candidate (§3). The check refuses, naming which of **ten** causes applies, when: the tree is dirty, no record exists, the record is at a superseded schema version, its version is absent or unparseable, it records a different command, its recorded argument vector does not witness the command it names, it names another commit, it says the tree was dirty when the gate ran, it records a failing gate, or its observation (the declared Node, the workspace envelope, and each tree's lockfile and install state) is missing or malformed. Only a missing or malformed observation refuses; no value in a complete one does, so a Node that differs from the pinned one, an absent envelope and an install difference are carried into the release record, not refused. The record is untracked — it describes one machine's observation of one tree, and a committed one would travel to a clone that never earned it.

**The command name was not evidence, and FR-R3-135 is why this section says so.** `GATE_COMMAND`
moved from `npm run ci` to `npm run gate` when `FR-R3-100` widened the perimeter, and the exact-string
refusal below is real — but the same commit that moved the name left the recorder's argument vector
at `['run', 'ci']`. For the **~32 hours** between `d0b7f2cc` (2026-08-27 00:15 +0700) and this item,
the recorder announced `npm run gate`, serialized `npm run gate`, and **spawned `npm run ci`**. A
record written in that window is internally consistent and describes a run that never observed the
secret scan, the workflow-pin check, the license check, the docs check or `contracts:check`. Exactly
one such record exists on the machine that wrote it, and the run it describes is the one recorded in
[the posture record](../docs/architecture/release-posture-engineering-preview.md), corrected there by
this item.

The window was short, and that is luck rather than a control: the defect was found by a read of the
code, not by the gate, and nothing in the suite could have found it. What follows is the structural
part.

Two things changed as a result:

- **The name is derived, not stated.** There is one editable authority — `GATE_COMMAND_SPEC` in
  `scripts/gate-attestation.mjs` — carrying the argument vector the recorder passes to `npm`.
  `GATE_COMMAND` is that vector rendered. A label that disagrees with what runs is now unwritable
  rather than merely untested, and the same authority supplies the entry point for the derived
  coverage inventory below, which had been deriving the closure of a command no attestation had
  observed.
- **The record carries its own witness.** Every attestation now states `commandArgv` — the vector
  that was actually spawned — and `commandExecutable`. The release check refuses when the label is
  not that vector's rendering, and refuses again when the vector is not this gate's vector
  element-wise. Both are needed: rendering alone accepts `["run gate"]`, one argument containing a
  space, which reads correctly and runs nothing of the kind. A strong name over a weak vector is
  now a refusal rather than a pass.

The attestation schema therefore went to **version 2** with this item, and every version-1 record is
refused **by version rather than by name**, whatever its label says. Not as a precaution against an
indistinguishable minority — it is the exact set: the label `npm run gate` and the wrong vector
arrived in the same commit and never coexisted with a correct one, so a version-1 record naming
`npm run gate` is necessarily a record of a `ci` run. Version-1 records naming `npm run ci` are
honest records of `ci`, and those the `wrong-command` refusal already rejects by name. The remedy is
one gate run. The rename is what made FR-R3-100's widening retroactive; the version is what makes
this one retroactive.

**The current version is 3.** `FR-R4-F09` raised it to add four fields that say what was observed:
`nodeDeclared` and `nodeMatchesDeclared` (the Node the repository declares, and whether the Node that
ran is it), `envelope` (whether the workspace envelope was present) and `trees` (each dependency
tree's lockfile and install state), written by `scripts/gate-observation.mjs`. A version-2 record is
refused by version for the opposite reason to a version-1 one: it is honest and says too little. The
remedy is again one gate run, not an upgrade of the old record.

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

**Naming it was not sufficient, and this block was affected from the other side.** Until FR-R3-135
the parity check derived its closure from the script name `gate` while the recorder spawned
`npm run ci`, so the list below accurately described a command no attestation had ever observed —
the document was right about the chain and the chain was not what ran. The entry point is now taken
from the same `GATE_COMMAND_SPEC` the recorder spawns, so a future change to what the gate *is* moves
this list and the recorded argument vector together. The list did not change on that repoint,
because the derivation had always been sound; its subject had not.

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
<!-- Source: scripts/gate-recorder.mjs -->
<!-- Source: scripts/record-gate-run.mjs -->
<!-- Source: package.json -->

## 3. Prepare the release candidate

`npm run release` builds, packages **once**, inspects those exact bytes, and writes a record that
names them (`FR-R4-F09`). It tags, publishes and uploads nothing, and no step in it could. It is the
only path that produces a candidate.

```bash
# 1. Capture the advisories for both trees. This needs the registry; it is the only network step.
mkdir -p .release/advisories
npm run security:advisory-diff -- capture --tree root --commit HEAD \
  --out .release/advisories/root-$(date -u +%F).capture.json
npm run security:advisory-diff -- capture --tree webview-ui --commit HEAD \
  --out .release/advisories/webview-ui-$(date -u +%F).capture.json

# 2. Record the gate on this commit (about 4 to 12 minutes).
npm run gate:record

# 3. Prepare the candidate. The preflight runs first and reads the gate record.
npm run release -- \
  --advisory-capture root=.release/advisories/root-<date>.capture.json \
  --advisory-capture webview-ui=.release/advisories/webview-ui-<date>.capture.json
```

**What the driver does, in order.** It reads the tree and refuses a dirty one or one git cannot name.
It checks the advisory evidence, before any build work (below). It then **removes every existing
output** (`dist/`, the root `schegent-sbom.cdx.json`, and `.release/staging/` and the same-named
candidate and record), runs `npm run build`, checks the build identity that build stamped into both
module graphs, runs `npm run sbom` over that build, packages once into `.release/staging/`, and
inspects the bytes it just wrote: the archive policy, then that the SBOM inside the archive lists
the same files with the same SHA-256 digests, then that the SBOM's bundled set equals the one
re-derived from this run's graphs. It re-reads the tree, and only then renames the file to
`.release/schegent-<version>.vsix` and writes `.release/schegent-<version>.release.json`, owner-only,
exclusively. The record's digest is the digest of the bytes that passed inspection. Output is never
reused, so a `dist/` copied in from another tree, output touched after the build, or output built
before a configuration change cannot become the candidate, and the mtime freshness check is not
consulted. A refusal prints `prepare-release: REFUSED (<reason>)`, names the remedy, writes no
record, and leaves a failed staging file under its staging name, which is never a candidate.
Every outcome ends with `Nothing was tagged, published or uploaded.`

**Advisory evidence.** The driver reads feature 249's captures and runs no audit itself. It refuses a
capture that is incomplete or unavailable (the audit gave no report), one made for a lockfile other
than the one HEAD holds, one observed after the preparation time, and one **more than seven days
old** (exactly seven days is accepted), and it refuses a disposition list it cannot use. Each finding
is then listed by its advisory id and URL with its severity, whether the package is in the shipped
code, and its disposition verdict. A finding with no covering disposition is reported, not refused.
The list is [`docs/release/advisory-dispositions.json`](docs/release/advisory-dispositions.md),
changed only in a reviewed commit.
<!-- Source: scripts/release-candidate.mjs -->
<!-- Source: scripts/prepare-release.mjs -->
<!-- Source: scripts/release-advisory.mjs -->

`npm run package` is `npm run sbom && vsce package --no-dependencies`. It is **local-trial packaging**
of the current `dist/`: it inspects nothing, produces no candidate and no record, and its output must
not be handed to anyone as a release. It still emits `schegent-sbom.cdx.json` (CycloneDX 1.5) beside
the VSIX **and packages it inside** (`FR-R3-120`), and since `FR-R4-F09` it refuses to when the module
graphs the build writes are absent or do not match `dist/`. The SBOM lists bundled third-party code
(Svelte today) as shipping, beside **zero declared runtime dependencies**. What it asserts and what
it does not (the bundlers' module graphs and the lockfiles, and not the archive's own bytes, which
the separate check above compares) is stated in the document's own metadata.
<!-- Source: scripts/generate-sbom.mjs -->

The packaging policy requires exactly one VSIX, a closed entry allowlist, safe archive paths, at most
2 MiB compressed, and at most 5 MiB uncompressed. It includes the extension manifest, license, root
README/RELEASE/SECURITY documents, branding assets, built host/webview files, and every file in
`examples/`; `.vscodeignore` excludes source, tests, implementation docs, maps, local state, the
module graphs under `dist/module-graph/`, `.release/`, and the repository's own tooling
configuration.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .vscodeignore -->

The build does not set `NODE_ENV=production`, so `esbuild.config.mjs` takes its non-production branch
for the host bundle; source maps are emitted and then excluded from the VSIX. The host bundle is
therefore not minified; the webview half is always minified, because `vite build` minifies whatever
`NODE_ENV` is. The mode that ran is recorded in the bundle (`host.build` of a diagnostics bundle),
in the SBOM and in the release record, so an operator who builds with `NODE_ENV=production` is not
refused and is not mistaken for a default build. Do not describe the packaged host bundle as
minified.
<!-- Source: esbuild.config.mjs -->
<!-- Source: .vscodeignore -->

### Install and qualify the exact candidate

A candidate is only qualified once the build that is running is the build the record names
(`FR-R4-F09`, `FR-035`). Nothing in this repository can do that for you, because it needs your IDE.

1. **Install the exact file** the record names, over any earlier install:

   ```bash
   <your IDE's command line> --install-extension .release/schegent-<version>.vsix --force
   ```

2. **Reload the window.** A window that was already active keeps running the build it loaded, so an
   install alone proves nothing about the running extension.
3. **Create a diagnostics bundle**: run "Schegent: Create Diagnostics Bundle". Its `host` item carries
   a `build` object: the commit, whether the tree was dirty, and the mode the host bundle was built
   in. Compare:
   - `host.build.commit` with the record's `source.commit` (they must be equal);
   - `host.build.mode` with the record's `build.mode`;
   - the file's digest, `shasum -a 256 .release/schegent-<version>.vsix`, with the record's
     `candidate.sha256`.

   A build made outside a checkout, or by a tool that did not stamp it, shows `unknown` for all
   three fields. That is the honest answer, and it is a mismatch with a record that names a commit.
4. **Record the outcome** in [the qualification matrix](docs/release/qualification-matrix.md), with
   the five facts an observation has. An install on a platform the gate has not run on is its own
   observation and fills only its own cell.

<!-- Source: src/lib/build-identity.ts -->
<!-- Source: src/services/diagnostics-bundle/bundle-collect.ts -->
<!-- Source: scripts/release-candidate.mjs -->

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
[the terminal record](docs/release/actions-terminal-record.md); and what exists *now* is derived
from the tree into [current release controls](docs/release/current-release-controls.md), which is
the single present-tense authority the table below must not contradict.

| No longer happens | What it was | Local substitute |
|---|---|---|
| A durable GitHub Release | Created by the tag job, containing the VSIX, SBOM and checksums | **None.** The VSIX exists only on the machine that packaged it |
| Build provenance attestation | GitHub OIDC attestation over the VSIX and SBOM, verifiable with `gh attestation verify --signer-workflow` | **None.** A consumer cannot verify who built a Schegent VSIX |
| `schegent-sbom.cdx.json` | `npm sbom --sbom-format cyclonedx` in the tag job | **Replaced, and improved.** `npm run release` writes the SBOM from the build's own module graphs and packages it inside the VSIX, and checks the archive's copy against the code beside it — which the tag job never did. `npm run package` is local-trial packaging and inspects nothing |
| `SHA256SUMS` | `sha256sum` over the VSIX and SBOM | **Partly replaced.** `npm run release` writes a local release record naming the candidate's SHA-256 and the SBOM's, computed by `scripts/release-digest.mjs`. There is no `SHA256SUMS` file and nothing publishes the digest, so a recipient has to be handed it |
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

The chain detects a break in the retained log. It does not prevent the same OS user from rewriting the log and recomputing the chain; [the threat model](docs/security/threat-model.md#t3--audit-log-tampering-or-non-append-writes) states what is and is not covered.

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

### The manual accessibility pass a release must run (`FR-R3-131`, 2026-08-28)

The automated scan (`npm run a11y`) and the pixel snapshots both pass over a rendered tree and
neither of them asserts that an operator can *finish anything*. A screenshot proves the pixels did
not move; it cannot express whether the focus order makes the surface usable. So one manual pass,
per route, keyboard only, before a hand-off:

| Check | What counts as a pass |
|---|---|
| Task completion | Enqueue a run, follow it, pause it, resume it and read one phase verdict — mouse untouched |
| Focus order | Tab moves through each route in the order the surface reads in; focus is always visible; no control is reachable only by mouse |
| Escape route | `Esc` leaves every modal, and focus returns to the control that opened it |

A failure here is a release blocker only if it removes the last keyboard path to a task; anything
else is filed as an item and named in the release notes. Record the result — the routes you walked
and the ones you did not — the same way the assistive-technology matrix records its rows.
<!-- Source: docs/release/accessibility-at-matrix.md -->

### The accessibility claims a release may NOT make (`FR-R3-131`, 2026-08-28)

**No conformance claim**, and it is written as four sentences rather than one list because the gate
below reads a negation as governing only the clause it sits in — prose that satisfies the rule is
prose a reader cannot misparse either. A release may not say the product conforms to WCAG 2.1
Level AA. It may not say the product is compliant with WCAG 2.1 Level AA. It may not say the product
meets WCAG 2.1 Level AA. It may not publish an accessibility conformance report. As of 2026-08-28
the automated scan is clean — 0 findings over **24** surface/theme combinations, covering **both**
shipped webviews, with the 30 baselined contrast violations fixed at the colour source rather than
re-accepted — and that is **not conformance**. AA is not a contrast ratio: every row of the
[assistive-technology matrix](docs/release/accessibility-at-matrix.md) is still **UNTESTED**, so
nobody has established that a screen-reader user can complete a single task.

**What lifts the prohibition**, both halves, not either:

1. the automated scan clean and its baseline empty — **done**, and gated shrink-only by
   `repo/tests/lint/a11y-baseline-shrinks.test.ts`; and
2. the macOS/VoiceOver rows of the matrix executed and dated — **not done**, reviewed on or before
   2026-11-27, procedure written out in that document.

**What a release MAY say**, and this is the distinction the gate enforces: that the product is
*built against* WCAG 2.1 Level AA, that the automated scan covers every shipped route and theme, and
that it currently reports no findings — each with the scan's own qualifier attached. `PRODUCT.md` and
`docs/prd-metrics-dashboard.md` state the level as a **target**, which is required:
`repo/tests/lint/a11y-policy-parity.test.ts` pins those statements so the scan's tag set cannot drift
from the level the product aims at. Those statements are not the claim being forbidden here. A target
says what the work is measured against; a conformance claim says the measurement came back clean from
an evaluation nobody has performed.

`repo/tests/lint/at-matrix-honesty.test.ts` fails if a conformance assertion appears in a release
document while any matrix row is untested.
<!-- Source: docs/release/accessibility-at-matrix.md -->

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
