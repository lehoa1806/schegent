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
operator input -> Runs -> Queue -> backend CLI
backend result -> Run detail + History + Audit
```

Schegent has no hosted control plane, database, or HTTP API to configure. The
normal operator interfaces are VS Code **Settings**, dashboard **Builder**,
**Runs**, **Queues**, and Run detail. Configuration is conditional: the default
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
`tests/lint/doc-orphan-pages.test.ts` now fails on an unindexed page.

### Courses

- [Use Schegent](courses/use-schegent.md)
- [Develop Schegent](courses/develop-schegent.md)

### Tutorials

- [Developer setup](tutorials/developer-setup.md)
- [Run the shipped Spec-kit pipeline](tutorials/user-quickstart.md)

### How-to

- [Feature guides](how-to/feature-guides.md)

### Concepts and explanation

- [Local-first, not offline](concepts/local-first-not-offline.md)
- [Domain model](explanation/domain-model.md)

### Operations

- [What Schegent keeps on this machine](operations/evidence-retention-disclosure.md) — every artifact
  retained locally, whether its content is redacted, and the bound on each, derived from the constants
  that enforce them rather than restated (FR-R3-085)

- [What stops an unattended run](operations/autonomy-bounds-disclosure.md) — every bound on
  autonomy in one table, including the per-run spend bound and which denomination applies to which
  backend, derived from the constants that enforce them (FR-R3-112)

- [Backends](operations/backends.md)
- [Built-artifact route diagnosis](operations/built-artifact-route-diagnosis.md)
- [Configuration](operations/configuration.md)
- [Contract generation](operations/contract-generation.md)
- [Dashboard UI](operations/dashboard-ui.md)
- [Data retention and deletion](operations/data-retention-and-deletion.md)
- [Inspect audit logs](operations/inspect-audit-logs.md)
- [Inspect raw transcripts](operations/inspect-raw-transcripts.md)
- [Licenses](operations/licenses.md)
- [Concurrent-run resource measurement](operations/concurrent-run-resource-measurement.md)
- [Concurrent-run isolation measurement](operations/concurrent-run-isolation-measurement.md) — attribution outcomes at concurrency 1/2/4/8, and the recommended cap of 2
- [Large-workspace resource measurement](operations/large-workspace-resource-measurement.md) — **measured 2026-08-27**: resident/retained, descriptors and Git behaviour at concurrency 1/2/4/8 on 2,000 tracked files, plus activation percentiles and the release-claim floor they establish
- [Transport-sink descriptor measurement](operations/transport-descriptor-measurement.md) — **measured 2026-08-28**: the sink's own append-handle count across 200 build/teardown cycles, 200 repoint/rotation cycles and 2,000 sustained records, and how it relates to the flat process-wide delta the large-workspace record reports
- [Live-canary cadence](operations/live-canary-cadence.md) — **declared 2026-08-27**: when the live backend canary must run, who owns it, and the cost bound. The first run under it is owed, with its trigger
- [Merge-gate observation](operations/merge-gate-observation.md)
- [Multi-queue concurrency](operations/multi-queue-concurrency.md)
- [Phase and task management](operations/phase-task-management.md)
- [Platform observation record](operations/platform-observation-record.md)
- [Process YAML](operations/process-yaml.md)
- [Recovery from an interrupted run](operations/recovery-checkpoints.md)
- [Release notes](operations/release-notes.md)
- [Release provenance observation](operations/release-provenance-observation.md)
- [Runtime log](operations/runtime-log.md)
- [Single-task queue migration](operations/single-task-queue-migration.md)
- [Trust scopes](operations/trust-scopes.md)
- [VSIX allowlist derivation](operations/vsix-allowlist-derivation.md)
- [Workspace Trust](operations/workspace-trust.md) — what stays available, what refuses, and what granting trust runs, in a window VS Code has not trusted

### Architecture and decisions

- [Agent capability posture](architecture/agent-capability-posture.md) — **decided, shipped 2026-08-24** (shape 3: uncontained backends refused by default, `schegent.backend.uncontainedBackends` is the opt-in, per backend since FR-R3-125)
- [Backend containment qualification](architecture/backend-containment-qualification.md) — **qualified 2026-08-27**: what OS-enforced containment is actually available per backend and platform, and why Agy's `--sandbox` is available and not requested
- [Native binding decision](architecture/native-binding-decision.md) — **decided 2026-08-25: no** (the `openat`, `renameat`, Job Object and reparse-tag residuals are permanent stated limits)
- [Local queue parallelism ratification](architecture/local-queue-parallelism-ratification.md)
- [Per-Run execution isolation decision](architecture/run-isolation-decision.md) — **shape accepted 2026-08-27: per-Run Git worktree; implementation gated** (§9 carries the entry conditions and the 2026-11-27 review trigger)
- [Remote multi-user expansion gate](architecture/remote-multi-user-expansion-gate.md)
- [Workspace ownership fencing](architecture/workspace-ownership-fencing.md)

### Development

- [Coverage measurements](development/coverage-measurements.md)
- [Gate integrity measurements](development/gate-integrity-measurements.md) — the vacuity detector's
  false-negative rate, the zero-offender enumeration, the product-versus-suite coverage split, and the
  re-verified webview dead-code classification (FR-R3-088)
- [Lint and type-aware rules](development/lint-and-type-aware-rules.md)

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

### Other

- [Asset report](ASSET_REPORT.md)

## Current onboarding constraints

These constraints explain why the courses include explicit stop-and-check
steps:

- Schegent ships an empty active catalog. Operators need a reviewed process
  YAML package or must author and publish definitions before launching work.
- Tagged GitHub Releases are the durable VSIX route; a source build is the
  fallback when a suitable release artifact is unavailable.
- The bundled Spec-kit example is a real, Git-mutating development workflow,
  not a harmless first-run sample. Use it only in a disposable checkout after
  review.
- Sensitive contributor changes are governed by the workspace-level
  `../AGENTS.md`. A standalone execution-repository clone may not contain that
  parent file, so contributors must obtain it instead of guessing at its
  invariants.

<!-- Source: ../src/config/pipeline-config.ts -->
<!-- Source: ../RELEASE.md -->
<!-- Source: ../examples/speckit-new-feature.pipeline.yaml -->
<!-- Source: ../AGENTS.md -->
<!-- Source: ../../AGENTS.md -->

Return to the [project README](../README.md) for the product overview.
