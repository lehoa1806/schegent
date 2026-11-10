# Schegent documentation

Do not read this directory from top to bottom. Schegent's documentation serves
different audiences and most pages are task-specific references. Choose the
outcome you want, follow one course, and stop when that outcome is complete.

<!-- Source: ../README.md -->
<!-- Source: courses/use-schegent.md -->
<!-- Source: courses/develop-schegent.md -->

## Choose your path

| Your goal | Audience | Start here | You are done when |
|---|---|---|---|
| Run a process without learning the product internals | Operator or process user | [Course: Use Schegent](courses/use-schegent.md) | A Task is queued and you can follow its Run evidence. |
| Understand and change the product | Extension contributor | [Course: Develop Schegent](courses/develop-schegent.md) | A scoped change passes its relevant checks and is ready for review. |
| Maintain, package, or release the repository | Maintainer or release engineer | [Contributing](../CONTRIBUTING.md), then [Release process](../RELEASE.md) | The change or release has the required build, test, package, and provenance evidence. |
| Review trust, privacy, or security boundaries | Security reviewer or operator approving unattended use | [Threat model](security/threat-model.md), then [Security whitepaper](security/whitepaper.md) | The relevant threat, mitigation, residual risk, and backend authority are understood. |

The first two rows are the primary learning paths. Maintainer and security
documents are specialist branches, not additional chapters every reader must
complete.

## Path 1: use the project

The operator course is the short path if another person or team already owns
the process design. It covers only the necessary connections:

```text
VSIX + trusted workspace + authenticated backend CLI
                         |
process YAML -> Builder -> active catalog
operator input -> Queue Add work -> Queue -> backend CLI
backend result -> Run detail + History + Audit
```

Schegent has no hosted control plane, database, or HTTP API to configure. The
normal operator interfaces are VS Code **Settings**, dashboard **Builder**,
**Queues**, Add work, and task detail. Configuration is conditional: the default
Claude runner needs no Schegent setting when an authenticated `claude`
executable is already on `PATH`; other backends, executable locations, or
environment policies need their corresponding settings.

<!-- Source: ../package.json -->
<!-- Source: ../src/state/workspace-state.ts -->
<!-- Source: ../webview-ui/src/dashboard/routes.ts -->
<!-- Source: reference/settings.md -->

Follow [Course: Use Schegent](courses/use-schegent.md). After the first
successful Run, keep only these optional branches:

- [Product workflows](how-to/product-workflows.md) for normal Queue, Run, repeat, and audit tasks.
- [Command Palette reference](reference/commands.md) for exact command titles, guards, and operator results.
- [Backend operations](operations/backends.md) when selection, authentication, probing, or invocation fails.
- [Settings](reference/settings.md) when you need an exact setting, default, or reload rule.
- [Process YAML](operations/process-yaml.md) when you own import/export or process publication.
- [Core concepts](explanation/core-concepts.md) when you want the product model after using it.
- [Threat model](security/threat-model.md) before unattended or sensitive execution.

## Path 2: develop the project

The contributor course first establishes the build and governing rules, then
traces one request through the system:

```text
extension activation -> UI/IPC -> validation and frozen plan -> Queue
-> controller -> backend runner -> state/evidence -> UI projection
```

After that common spine, choose one branch—UI/IPC, catalog/YAML, Queue, Run
lifecycle, backend, ownership/state, security/evidence, or release. You should
not read the documents for unrelated branches.

<!-- Source: ../ARCHITECTURE.md -->
<!-- Source: ../src/extension.ts -->
<!-- Source: ../src/services/run-request/run-request-validator.ts -->
<!-- Source: ../src/services/auto-drain-coordinator.ts -->
<!-- Source: ../src/controller/workflow-controller.ts -->

Follow [Course: Develop Schegent](courses/develop-schegent.md). Its optional
branches route to the exact operations, reference, and source areas needed for
the intended change. Use these shared documents only at the point the course
asks for them:

- [Developer setup](tutorials/developer-setup.md) for a first checkout.
- [Contributing](../CONTRIBUTING.md) for repository gates and review policy.
- [Core concepts](explanation/core-concepts.md) and [Glossary](reference/glossary.md) for shared vocabulary.
- [Schegent Architecture](../ARCHITECTURE.md) for the production dependency map and invariants.
- [Developer workflows](how-to/developer-workflows.md) for focused and broad verification commands.

## How the documentation is organized

Document type describes when to read a page; it is not a required sequence.

| Type | Read it when | Examples |
|---|---|---|
| **Course** | You are new to an audience path and want a complete outcome. | Use Schegent; Develop Schegent. |
| **Tutorial** | You need one tightly guided setup or demonstration. | Developer setup; shipped Spec-kit pipeline. |
| **How-to** | You already know the goal and need a procedure. | Product workflows; developer workflows. |
| **Reference** | You need an exact contract, field, setting, event, or layout. | Commands; settings; API and CLI; file layout. |
| **Explanation** | You need the reason, model, or system relationship behind behavior. | Core concepts; architecture; domain model. |
| **Decision or operations record** | You are changing or reviewing that specific boundary. | Ownership fencing; release provenance; runtime logging. |

Historical decisions, deep operations notes, and feature-specific pages remain
available because maintainers need evidence and exact contracts. Their presence
does not make them onboarding material.

## How current a page is

Document *type* above says when to read a page. This says whether to believe its
present tense. The two are independent: a reference page and a runbook can each be
current or a record.

| Class | Marker | The test a page must pass to claim it |
|---|---|---|
| **Current authority** | none — this is the default | Every present-tense sentence is true of the tree at `HEAD`. A claim about what runs must match what an executable script actually does. |
| **Historical / terminal record** | `<!-- doc-class: record -->` | It describes something that ran, or was formally proposed, and no longer holds. It carries a dated withdrawal banner saying what went and when. It is never cited as present authority, and its observations are **not** rewritten to agree with today's tree — a recorded observation with a date is evidence, and correcting it is falsification. |
| **Proposal / decision with trigger** | `<!-- doc-class: proposal -->` | It describes a state that does not exist yet, or a decision not to build one. It names the trigger and the review date that would revisit it. |

One marker is machine-read, and only one: `tests/lint/current-control-claims.test.ts`
checks live pages against facts derived from the tree, and skips a page classified as
a **record**. It does not skip a proposal, because a proposal describes a state that
does not exist in the conditional voice that says so — `would`, `if`, `on approval` —
and a proposal written in the present indicative is making a claim, not a proposal.
Marking a page `proposal` therefore exempts it from nothing.

The prose banner is the half a reader sees; the marker is the half the gate sees, and
a record needs both. A page that keeps present-tense description of a retired control
must say why in the page itself — an unexplained exception is a defect, not an
exemption.

Which controls are current is not restated here, because restating it is how four
documents came to disagree. One generated table answers it:
[current release controls](release/current-release-controls.md).

## Complete index

Every page in this tree, so that none is reachable only by knowing it exists.
FR-R3-063 added this: the 2026-08-23 review found 21 of 53 pages with no inbound
link — in a tree it had itself inventoried — and a page nobody can arrive at also
drifts unnoticed, because the readers who would catch an error never get there.
The section lists every page under `docs/`, except a page that the exclusion list in
`tests/lint/doc-orphan-pages.test.ts` names with its reason, and that gate fails on a page that is
neither listed nor excluded.

### Courses

- [Use Schegent](courses/use-schegent.md)
- [Develop Schegent](courses/develop-schegent.md)

### Tutorials

- [Developer setup](tutorials/developer-setup.md)
- [Run the shipped Spec-kit pipeline](tutorials/user-quickstart.md)

### How-to

- [Feature guides](how-to/feature-guides.md)
- [Developer workflows](how-to/developer-workflows.md) — the build, test and verify commands, run from the repository root
- [Product workflows](how-to/product-workflows.md) — operator workflows that use only surfaces the extension host registers

### Concepts and explanation

- [Local-first, not offline](concepts/local-first-not-offline.md)
- [English-only is a product decision](concepts/english-only-not-localizable.md)
- [Domain model](explanation/domain-model.md)
- [Architecture](explanation/architecture.md) — the extension host, the webviews, Queues and Runs, and how they fit together
- [Core concepts](explanation/core-concepts.md) — the domain model as contracts, and where each part is persisted
- [Sessions, logs, and local evidence](concepts/sessions-and-logs.md) — the several things "session" means, and the privacy and durability of each local file
- [The agent runs unprompted](concepts/unprompted-agent-not-contained.md) — the accepted product-boundary decision of 2026-08-22
- [Workspace ownership and execution leases](concepts/workspace-lock.md) — the two lease families, and the question each one answers

### Operations

- [What Schegent keeps on this machine](operations/evidence-retention-disclosure.md) — every artifact
  retained locally, whether its content is redacted, and the bound on each, derived from the constants
  that enforce them rather than restated (FR-R3-085)

- [What stops an unattended run](operations/autonomy-bounds-disclosure.md) — every bound on
  autonomy in one table, including the per-run spend bound and which denomination applies to which
  backend, derived from the constants that enforce them (FR-R3-112)

- [Artifact lifecycle, storage and recovery](operations/artifact-lifecycle.md) — what Schegent may delete, why it kept something, and what an interrupted deletion or legacy catalog migration leaves behind
- [Backends](operations/backends.md)
- [Built-artifact route diagnosis](operations/built-artifact-route-diagnosis.md)
- [Configuration](operations/configuration.md)
- [Contract generation](operations/contract-generation.md)
- [Dashboard UI](operations/dashboard-ui.md)
- [Data retention and deletion](operations/data-retention-and-deletion.md)
- [Gate recording](operations/gate-recording.md) — **declared 2026-10-02**: what a `npm run gate:record` record is and is not, and the rule that binds a bot-proposed dependency change to one, with how to perform it; the recording cadence for every merge into `develop`, and `npm run gate:distance`, which reports how far the record is from `HEAD`
- [Inspect audit logs](operations/inspect-audit-logs.md)
- [Inspect raw transcripts](operations/inspect-raw-transcripts.md)
- [Interactive verification register](operations/interactive-verification-register.md) — **opened 2026-09-06**: the interactive dev-host evidence specs `067` and `068` still owe, who owes it, what would close it, and the date it is re-read on
- [Dependency advisory comparison](operations/dependency-advisory-comparison.md) — **declared 2026-10-30**: `npm run security:advisory-diff`, which tells whether a candidate commit introduced or worsened a dependency advisory against an explicit base commit; report-only, not part of `npm run gate`, and it leaves `npm run security:audit` as it was
- [Licenses](operations/licenses.md)
- [Concurrent-run resource measurement](operations/concurrent-run-resource-measurement.md)
- [Concurrent-run isolation measurement](operations/concurrent-run-isolation-measurement.md) — attribution outcomes at concurrency 1/2/4/8, and the recommended cap of 2
- [Large-workspace resource measurement](operations/large-workspace-resource-measurement.md) — **measured 2026-08-27**: resident/retained, descriptors and Git behaviour at concurrency 1/2/4/8 on 2,000 tracked files, plus activation percentiles and the release-claim floor they establish
- [Webview snapshot cost, render cost and persisted-state growth](operations/webview-snapshot-cost-measurement.md) — **measured 2026-10-31**: what the state snapshot costs the host and the webview per workload, how many snapshots a hidden sidebar is sent, how persisted records grow, the adoption decision against a threshold declared first, and the retention options that are documented and not implemented
- [Transport-sink descriptor measurement](operations/transport-descriptor-measurement.md) — **measured 2026-08-28**: the sink's own append-handle count across 200 build/teardown cycles, 200 repoint/rotation cycles and 2,000 sustained records, and how it relates to the flat process-wide delta the large-workspace record reports
- [Live-canary cadence](operations/live-canary-cadence.md) — **declared 2026-08-27**: when the live backend canary must run, who owns it, and the cost bound. A live run was made on 2026-10-19; the dated deferral stays open until the operator's review
- [Merge-gate observation](operations/merge-gate-observation.md)
- [Multi-queue concurrency](operations/multi-queue-concurrency.md)
- [Phase and task management](operations/phase-task-management.md) — the Phase controls, what each refusal means, and what Disable and Enable now say when the host refuses them (FR-R5-F19)
- [Platform observation record](operations/platform-observation-record.md)
- [Process YAML](operations/process-yaml.md)
- [Recovery from an interrupted run](operations/recovery-checkpoints.md)
- [Workflow control flow, repetition, and backend recovery](operations/workflow-control-recovery.md) — candidate recovery blocks, scoped child-Workflow `Repeat`, sequential `ForEach`, durable availability monitoring, and workspace handover (`FR-R5-F35`)
- [Production workflow integration and support boundary matrix](operations/production-workflow-integration-matrix.md) — entry-point wiring census, production collaborator composition, seven-category refusal taxonomy, eight-checkpoint recovery, and F08/F01-B seams (`FR-R6-F01`)
- [Shared memory and storage contracts](operations/shared-memory-storage-contracts.md) — C1 field dictionary, current-record mappings, C2 single-authority inventory, 15-feature consumer mapping, C4 retention inventory, and acceptance fixtures (`FR-R6-F02`)
- [Runtime resource budgets and qualification](operations/runtime-resource-budgets.md) — runtime resource inventory, FR-015 common queue and query bounds, registered qualification targets, current-store migration baselines, and pending joint qualification (`FR-R6-F03`)
- [SQLite application store and structured-state migration](operations/sqlite-application-store.md) — `node:sqlite` engine qualification, `STRICT` 78-table operational and domain schema, seven `BEGIN IMMEDIATE` transaction units, bounded writer queue and WAL checkpoint policy, seven-stage migration and quarantine pipeline, and online backup/restore verification (`FR-R6-F04`)
- [Usage and metrics accounting](operations/usage-accounting.md) — how a usage or cost total is built and how far to trust it: completeness and coverage, reported and estimated cost lanes, currencies and credits, unattributed and historical observations, corrections and revisions, the legacy epoch, gaps, and limits (`FR-R6-F06`)
- [Live-log delivery](operations/live-log-delivery.md) — what the live phase-log view can drop and how it reports it: byte bounds, the ten coverage-gap reasons, the six delivery counters, resumable cursors, and the segment index (`FR-R6-F07`)
- [Recovery handoff](operations/recovery-handoff.md) — what a recovery handoff protects and why it refuses a delivery: states, pin purposes, the seven resolution reasons, the redelivery refusal order, explanation bounds, future versions, legacy records and the prune fail-safe (`FR-R6-F08`)
- [Release notes](operations/release-notes.md)
- [Release provenance observation](operations/release-provenance-observation.md)
- [Retry contract](operations/retry-contract.md) — **written 2026-10-28**: which failures retry, pause or fail, where each delay comes from, where automatic attempts stop, and how the watchdog handles them, and what Resume, Restart, Skip and a row Retry each do to a failed run
- [Runtime log](operations/runtime-log.md)
- [Single-task queue migration](operations/single-task-queue-migration.md)
- [Trust scopes](operations/trust-scopes.md)
- [VSIX allowlist derivation](operations/vsix-allowlist-derivation.md)
- [Workspace Trust](operations/workspace-trust.md) — what stays available, what refuses, and what granting trust runs, in a window VS Code has not trusted
- [Running Schegent on a repository you do not trust](operations/untrusted-repositories.md) — owns the rule; the threat model and the quickstart link here
- [Counts the round-3 documents assert](operations/asserted-counts-sweep.md) — what was examined, and why the mechanism is the size it is (FR-R3-067)
- [Duplicate-authority detection: the threshold measurements](operations/duplicate-authority-threshold-measurement.md) — the measurements behind the threshold (FR-R3-066)
- [Lazy-route wait budget](operations/lazy-route-wait-budget.md) — the sweep, and what was observed (FR-R3-068)
- [Visual gate preflight observations](operations/visual-gate-preflight-observations.md) — the recorded observations behind the preflight (FR-R3-065)

### Architecture and decisions

- [Agent capability posture](architecture/agent-capability-posture.md) — **decided, shipped 2026-08-24** (shape 3: uncontained backends refused by default, `schegent.backend.uncontainedBackends` is the opt-in, per backend since FR-R3-125)
- [Backend containment qualification](architecture/backend-containment-qualification.md) — **qualified 2026-08-27**: what OS-enforced containment is actually available per backend and platform, and why Agy's `--sandbox` is available and not requested by default
- [English-only is a product decision](concepts/english-only-not-localizable.md) — **decided 2026-08-22, re-taken 2026-10-21: English only** (1,122 distinct user-visible strings measured; what would reopen it, and its review date)
- [HostServices facade removal](architecture/host-services-facade-removal.md) — **decided 2026-08-29: deleted** (a nine-member host facade no installed extension could reach; two of its members had no caller at either end, and `tests/lint/adapter-module-reachability.test.ts` now fails the next one)
- [Native binding decision](architecture/native-binding-decision.md) — **decided 2026-08-25: no** (the `openat`, `renameat`, Job Object and reparse-tag residuals are permanent stated limits)
- [Local queue parallelism ratification](architecture/local-queue-parallelism-ratification.md)
- [Per-Run execution isolation decision](architecture/run-isolation-decision.md) — **shape accepted 2026-08-27: per-Run Git worktree; implementation gated** (§9 carries the entry conditions and the 2026-11-27 review trigger)
- [Remote multi-user expansion gate](architecture/remote-multi-user-expansion-gate.md)
- [Webview dead surface removal](architecture/webview-dead-surface-removal.md) — **decided 2026-08-29: deleted** (ten Svelte components, 1,685 lines, each measured unreachable from both bundle entry points; the gate that allowlisted them is retired and `tests/lint/svelte-surface-reachability.test.ts` now needs an owner and an expiry date for any new exemption)
- [Workspace ownership fencing](architecture/workspace-ownership-fencing.md)
- [The composition root, decided](architecture/composition-root-extraction.md) — **decided 2026-08-27** (FR-R3-119)
- [Distribution posture](architecture/distribution-posture.md) — **decided 2026-08-27** (FR-R3-120)
- [Durability of the evidence writes](architecture/durability-decision.md) — **decided 2026-08-26, extended 2026-10-31** (FR-R3-111, FR-R4-F07)
- [Declined: an encrypted evidence store](architecture/evidence-encryption-declination.md) — **declined 2026-08-27, with a reversal trigger** (FR-R3-127)
- [The phase verdict default](architecture/phase-verdict-default.md) — **decided 2026-08-27** (FR-R3-117)

### Development

- [Absent-field assertion classification](development/absent-field-classification.md) — how an
  absent-field assertion is judged against a payload contract, how a contradiction is resolved, and
  what the gate that produces the register does not read (FR-R3-167)
- [Coverage measurements](development/coverage-measurements.md)
- [Gate integrity measurements](development/gate-integrity-measurements.md) — the vacuity detector's
  false-negative rate, the zero-offender enumeration, the product-versus-suite coverage split, and the
  re-verified webview dead-code classification (FR-R3-088)
- [IPC validator fuzz: the hazard map](development/ipc-fuzz-hazard-map.md) — which of the six
  adversarial input classes the example suite already drives at `validateInboundMessage`, the two
  construction notes that decide whether a generated case is real or inert, and what the property
  deliberately does not cover (FR-R3-168)
- [Lint and type-aware rules](development/lint-and-type-aware-rules.md)
- [Parser and timing coverage inventory](development/parser-and-timing-coverage-inventory.md) — which
  seeded tests guard each parser and settings boundary, which tests wait on a real timer, and which
  control the clock, each count with the command that reproduces it and an owner for every gap
  (FR-R4-F12)
- [Section references are checked by `docs:check`](development/section-reference-check.md) —
  **decided 2026-10-20**: in live documents, a link fragment or `§` marker naming a section of
  another file must name a heading that file has. The rule was fixed before the count, and the count
  it rests on was ten live failures against a threshold of ten, corrected the same day from a first
  count of nine. The page also gives what the check leaves out and what would reopen the decision
  (FR-R3-184)
- [Size-gate entry condition](development/size-gate-entry-condition.md) — **decided 2026-10-01**:
  every `src/` file of 1,000 lines or more carries a ceiling or a waiver in the size gate's table. The
  measured distribution, each rejected threshold with the count it would have captured, and what
  would move it (FR-R3-183)
- [Spec Kit template provenance](development/template-provenance.md) — which templates the artifact
  criteria were derived from, at which hashes, what state each is in, and the upstream revision that is
  still pending qualification (FR-R4-F12)
- [The devcontainer question](development/devcontainer-declination.md) — **declined 2026-08-28** (FR-R3-132)
- [Lint gate census](development/lint-gate-census.md) — one line per gate, generated, with the current dated count
- [Verification tiers](development/verification-tiers.md) — three tiers, cheapest first, and what each one does not establish (FR-R3-132)

### Release

- [Current release controls](release/current-release-controls.md) — what actually runs today, derived
  from the tree rather than written down. The single present-tense authority; four pages used to answer
  this question independently and all four were wrong (FR-R3-138)
- [Canary credentials: an itemized request](release/canary-credential-request.md) — what *a* scheduled
  backend canary would need to run a live phase, per credential, with the cost of a leak. A record: the
  schedule it was written for went with the workflows on 2026-08-26 (FR-R3-084, FR-R3-099)
- [Assistive-technology matrix](release/accessibility-at-matrix.md) — what real screen-reader testing
  has been done per platform, and where the honest answer is **untested** (FR-R3-091)
- [Held major dependency upgrades](release/held-major-upgrades.md) — the deliberate holds, why each is
  held, and when it was last re-examined. A held upgrade with no review date is indistinguishable from a
  forgotten one (FR-R3-090).
- [Advisory dispositions](release/advisory-dispositions.md) — the tracked list of recorded decisions about
  dependency advisories: what each field means, the `rationale` release preparation requires, and what
  a disposition does not do. `accepted` is a label, not a waiver (FR-R4-F09).
- [Qualification matrix](release/qualification-matrix.md) — Node 22 and 24 on macOS, Linux and Windows:
  each cell is either observed, with the five facts of an observation, or `unobserved` with its
  prerequisite. Never a bare "passed" (FR-R4-F09).
- [Node 22 floor record](release/node-floor-record.md) — the last run of the plain-Node toolchain on
  the declared Node 22 floor, its failures, and what that run does not show. It is not a
  qualification cell (FR-R5-F21).
- [GitHub Actions: terminal record](release/actions-terminal-record.md) — retired by operator decision on 2026-08-26 (FR-R3-099)
- [Backend qualification log](release/backend-qualification-log.md) — whether the canary has ever produced a result, and what it said
- [Withdrawn CI-dependent controls](release/withdrawn-ci-controls.md) — what each control was, and what replaced it (FR-R3-099)

### Reference

- [Reference documents](reference/README.md) — what is authoritative for what
- [API and command reference](reference/api-and-cli.md) — every command surface the extension ships
- [Audit events](reference/audit-events.md) — the structured audit record and its event types
- [Command Palette reference](reference/commands.md) — the manifest-parity index of every contributed command
- [File layout](reference/file-layout.md) — where durable state lives
- [Glossary](reference/glossary.md) — the vocabularies for authored, queued and running work
- [Settings reference](reference/settings.md) — every `schegent.*` setting
- [System configuration](reference/system-config.md) — how configuration reaches the product
- [Composable Workflow YAML grammar](reference/workflow-yaml-grammar.md) — canonical key ordering, closed field sets, and validation boundaries for `kind: Workflow` documents (`FR-R5-F04`)
- [Workflow execution runtime](workflow-execution-runtime.md) — frozen transitive closure execution, occurrence identity, scoped bindings, routing and handoff semantics (`FR-R5-F02`)

### Security

- [Operator threat model](security/threat-model.md) — the threat catalog, with each mitigation and its residual risk
- [Security white paper](security/whitepaper.md) — how the extension coordinates local CLI processes, and the limits of what it does about them
- [CSP supply-chain policy](security/csp-supply-chain-record.md) — what it decided, and what enforces it
- [Prototype-rebuild census](security/prototype-rebuild-census.md) — every place that rebuilds an object by copying enumerated keys

### Features

- [Custom Phases and Pipelines](features/custom-phases.md) — the empty catalog, and how definitions are imported or authored
- [Process YAML exchange format](features/phase-yaml-exchange.md) — portable YAML for Phase, Workflow and ModelCatalog

### Other

- [Asset report](ASSET_REPORT.md)
- [Workflow control flow acceptance verification report](verification/workflow-control-acceptance.md) — 36-criterion acceptance matrix (`AC-01`–`AC-36`), integrated prerequisite commits (`F23`–`F34`), schema compatibility, and measured bounds (`FR-R5-F35`)

## Current onboarding constraints

These constraints explain why the courses include explicit stop-and-check
steps:

- Schegent ships an empty active catalog. Operators need a reviewed process
  YAML package or must author and publish definitions before launching work.
- The engineering-preview VSIX route is a local `npm run build`, then
  `npm run package`, from a checkout installed by the canonical sequence in
  [Prepare a checkout](../CONTRIBUTING.md#prepare-a-checkout). The package step
  refuses when the module graphs the build writes are absent. No tag or GitHub
  Release publishes a VSIX; [RELEASE.md](../RELEASE.md) says what a release is.
- The bundled Spec-kit example is a real, Git-mutating development workflow,
  not a harmless first-run sample. Use it only in a disposable checkout after
  review.
- Sensitive contributor changes are governed by the hard rules in
  `docs/hard-rules.md` in the planning envelope, one directory above this
  checkout; read the rows of its index that your change touches. `../AGENTS.md`
  orients you and points at it. A standalone execution-repository clone does
  not contain either parent file, so contributors must obtain the planning
  envelope instead of guessing at the rules.

<!-- Source: ../src/config/pipeline-config.ts -->
<!-- Source: ../RELEASE.md -->
<!-- Source: ../examples/speckit-new-feature.workflow.yaml -->
<!-- Source: ../AGENTS.md -->
<!-- Source: ../../AGENTS.md -->

Return to the [project README](../README.md) for the product overview.
