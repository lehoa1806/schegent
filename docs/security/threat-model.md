# Operator threat model

Schegent is a local VS Code extension that launches an autonomous CLI backend. Claude is the default runner; Claude and Agy include `--dangerously-skip-permissions`, so their approval prompts are off and the agent acts without asking. Codex instead includes `--sandbox workspace-write`, an OS-enforced filesystem bound that leaves `.git` read-only. Every adapter uses `shell: false`, but their permission postures differ.

<!-- Source: package.json -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

This catalog describes code-resident mitigations and residual risk. It does not promise isolation from an operator-authorized backend process, from a hostile prompt, or from an already compromised workstation.

<!-- Source: docs/concepts/unprompted-agent-not-contained.md -->
<!-- Source: src/runner/prompt-builder.ts -->

## Threat catalog

| Id | Threat | Primary mitigation | Source |
|---|---|---|---|
| [T1](#t1--secret-leakage-to-operator-visible-sinks) | Secret leakage to operator-visible sinks | One `SECRET_PATTERNS` set feeds `SanitizedLogger` sinks. | <!-- Source: src/lib/logger.ts --> |
| [T2](#t2--untrusted-webview-mutating-host-state) | Crafted webview IPC mutates host state | CSP, runtime payload validation, workspace trust, and primary-window gating. | <!-- Source: src/ui/sidebar/csp.ts --><!-- Source: src/contracts/runtime-validators.ts --><!-- Source: src/ui/sidebar/message-router.ts --> |
| [T3](#t3--audit-log-tampering-or-non-append-writes) | Audit evidence is truncated or rewritten | The host has one append/rotation writer, but no hash chain or tamper detector. | <!-- Source: src/audit/audit-log-writer.ts --> |
| [T4](#t4--workspace-path-leakage-into-the-structured-audit-log) | Local paths leak through structured evidence | Audit contracts use bounded identifiers, counts, and selection tuples instead of artifact paths. | <!-- Source: src/contracts/audit-events.ts --><!-- Source: src/contracts/sidebar-ipc/history-evidence.ts --> |
| [T5](#t5--concurrent-state-mutation-across-multiple-vs-code-windows) | Multiple VS Code windows mutate one workspace | Filesystem-backed fenced ownership plus primary-host gates. | <!-- Source: src/state/ownership-registry.ts --><!-- Source: src/ui/sidebar/message-router.ts --> |
| [T5b](#t5b--an-output-target-is-judged-once-then-written-later) | A confirmed output target is subverted between validation and the child's write | Every declared target's components are re-walked at dispatch; a refusal fails the Run with a named cause before the runner is called. | <!-- Source: src/services/dispatch-output-guard.ts --><!-- Source: src/lib/output-target-identity.ts --> |
| [T6](#t6--lease-leak-fail-deadly) | A stranded execution lease stalls a queue | Explicit releases and 15-second stale-lease reclamation. | <!-- Source: src/state/execution-lease.ts --><!-- Source: src/state/lock.ts --> |
| [T7](#t7--untrusted-workspace-executing-extension-capabilities) | An untrusted workspace triggers mutations or subprocess work | Mutating IPC fails closed on `workspace.isTrusted`; restricted activation avoids workspace-bound services. | <!-- Source: src/ui/sidebar/message-router.ts --><!-- Source: src/extension.ts --> |
| [T8](#t8--prompt-injection-via-spec-plan-task-or-instruction-content) | Repository or operator text instructs the model to act maliciously | No content analyzer is claimed; the operator controls what enters a run and grants run approval for declared high-impact effects. | <!-- Source: src/runner/prompt-builder.ts --><!-- Source: src/activation/git-approval.ts --> |
| [T9](#t9--phase-invocation-bypasses-evidence-or-redaction) | A Phase bypasses the common evidence path | `PhaseRunner` owns invocation, transcript, sanitization, and lifecycle audit hooks. | <!-- Source: src/controller/phase-runner.ts --><!-- Source: src/audit/raw-transcript-writer.ts --> |
| [T10](#t10--unredacted-local-diagnostics-leave-the-workspace) | Local evidence and diagnostics expose source, paths, or operator text | Private file modes, local placement, generated ignore rules, and separate bounded-retention policies reduce accidental exposure. | <!-- Source: src/audit/raw-transcript-writer.ts --><!-- Source: src/audit/verbose-diagnostic-writer.ts --><!-- Source: src/services/run-checkpoint-service.ts --><!-- Source: src/services/run-checkpoint-retention.ts --><!-- Source: src/audit/schegent-gitignore.ts --> |
| [T11](#t11--retrycondition-dsl-escape) | `retryCondition` becomes arbitrary code | A dedicated parser/evaluator accepts a closed expression language without `eval`, calls, member access, or I/O. | <!-- Source: src/lib/retry-condition.ts --> |
| [T12](#t12--fatal-signature-floor-weakening) | Settings remove or reorder built-in fatal signatures | The frozen built-in registry is scanned before additive operator patterns. | <!-- Source: src/lib/fatal-signature-registry.ts --><!-- Source: src/lib/incremental-fatal-scanner.ts --> |
| [T13](#t13--state-schema-invariant-violation) | Persisted run fields form an impossible state | `WorkspaceStateStore` validates pair invariants and initializes through forward migrators. | <!-- Source: src/state/workspace-state.ts --><!-- Source: src/state/workflow-run-migrator.ts --> |
| [T14](#t14--multi-queue-registry-races) | Queue capacity, promotion, or claims race | Separate workspace/queue capacity predicates and per-queue execution leases. | <!-- Source: src/services/auto-drain-coordinator.ts --><!-- Source: src/state/execution-lease.ts --> |
| [T15](#t15--phase-message-env-injection) | Phase sidecar values reach UI, prompt, or evidence unsanitized | Sidecar parsing applies size/path rules and sanitization before downstream use. | <!-- Source: src/controller/phase-sidecar-reader.ts --><!-- Source: src/lib/logger.ts --> |
| [T16](#t16--operator-fatal-signature-update-is-stale) | A cached operator signature misses a mid-run update | The effective signature set is resolved for each Phase invocation. | <!-- Source: src/controller/phase-runner.ts --><!-- Source: src/lib/fatal-signature-registry.ts --> |
| [T17](#t17--retired-out-of-host-wake-up-runner-returns) | A retired OS-scheduled runner regains workspace authority | Scheduling remains inside the extension host through queue schedule coordination and watchdog ticks. | <!-- Source: src/services/scheduled-start-coordinator.ts --><!-- Source: src/controller/schedule-watchdog.ts --> |
| [T18](#t18--vscode-namespace-leaks-into-headless-or-telemetry-code) | Host-only `vscode` imports contaminate host-free modules | Lint gates scan both namespaces. | <!-- Source: tests/lint/no-vscode-import-in-headless.test.ts --><!-- Source: tests/lint/no-vscode-import-in-telemetry.test.ts --> |
| [T19](#t19--runtime-log-forks-the-redaction-set) | Runtime logging adds a second sanitizer or raw filesystem writer | The runtime sink is a `SanitizedLogger` sink; direct syslog writers are lint-gated. | <!-- Source: src/lib/runtime-log/runtime-log-sink.ts --><!-- Source: tests/lint/no-direct-syslog-fs-writes.test.ts --> |
| [T20](#t20--phase-log-ipc-double-or-skipped-sanitization) | Live or historical Phase logs are double-sanitized or not sanitized | Reader and tail session project, bound, then sanitize at the host boundary; raw HTML interpolation is lint-gated. | <!-- Source: src/services/phase-log/phase-log-reader.ts --><!-- Source: src/services/phase-log/phase-log-tail-session.ts --><!-- Source: tests/lint/no-html-interpolation-in-activity-feed.test.ts --> |
| [T21](#t21--untrusted-stdout-names-local-files) | CLI output steers a read outside the run diagnostics tree | The host derives the expected sidecar and applies canonical-path containment before reading. | <!-- Source: src/controller/phase-sidecar-reader.ts --> |
| [T22](#t22--workflow-condition-acquires-an-evaluator) | Workflow branching grows a second expression engine | Conditions are structured operands plus closed operators, compared field-wise. | <!-- Source: src/contracts/workflow-definitions.ts --><!-- Source: src/services/workflow-execution/condition-evaluator.ts --> |
| [T23](#t23--operator-authored-value-escapes-its-declared-bound) | Identifiers or retry expressions reach bounded sinks without their owning bound | Each definition contract owns its maximum and validators/reporting sites reuse it. | <!-- Source: src/contracts/process-definitions.ts --><!-- Source: src/contracts/pipeline-definitions.ts --><!-- Source: src/contracts/workflow-definitions.ts --> |
| [T24](#t24--legacy-persisted-state-re-enters-the-runtime) | Old or newer persisted state violates current invariants | Forward-only initialization migrates old state and refuses a schema newer than the runtime. | <!-- Source: src/state/workspace-state.ts --><!-- Source: src/state/queue-state-migrator.ts --> |
| [T25](#t25--control-sentinel-carried-in-cli-output) | Model-controlled stdout carries apparent host control signals | Outcome parsing uses the trailing audit region; process termination uses the CLI harness result envelope. | <!-- Source: src/parser/audit-log-parser.ts --><!-- Source: src/parser/stdout-parser.ts --><!-- Source: src/runner/claude-cli.ts --> |

## The untrusted input classes

Six classes qualify as untrusted input. The controls common to all six are host-side validation, bounded values, centralized sanitization before operator-visible sinks, and explicit refusal rather than guessed repair.

| Input class | Boundary and handling |
|---|---|
| **Task, repository, and instruction text** | It becomes model prompt material. The host bounds structural request fields but does not claim to detect prompt injection. <!-- Source: src/services/run-request/run-request-validator.ts --><!-- Source: src/runner/prompt-builder.ts --> |
| **Process YAML** | A size-bounded closed YAML subset is scanned and parsed host-side; anchors, aliases, merge keys, and unknown document shapes are refused before catalog publication. <!-- Source: src/services/process-yaml/yaml-scanner.ts --><!-- Source: src/services/process-yaml/yaml-parser.ts --><!-- Source: src/services/process-yaml/preflight-service.ts --> |
| **Webview IPC** | `validateInboundMessage` checks the envelope and command payload before routing; invalid messages are dropped without handler dispatch. <!-- Source: src/contracts/runtime-validators.ts --><!-- Source: src/ui/sidebar/sidebar-view-provider.ts --> |
| **Persisted local state** | `initialize()` migrates supported old schemas and refuses a numeric schema newer than the runtime. <!-- Source: src/state/workspace-state.ts --><!-- Source: src/state/queue-state-migrator.ts --> |
| **CLI stdout** | [T25](#t25--control-sentinel-carried-in-cli-output): `src/parser/audit-log-parser.ts` computes the trailing region and `src/parser/stdout-parser.ts` consumes it. A degraded read is labelled `[constitution] token accepted without audit block`; an out-of-region token is reported and never acted on. Process control arms only on the harness envelope `{"type":"result"}` in `src/runner/claude-cli.ts`. <!-- Source: src/parser/audit-log-parser.ts --><!-- Source: src/parser/stdout-parser.ts --><!-- Source: src/runner/claude-cli.ts --> |
| **Local path claims** | Workspace-relative requests and derived artifact paths pass lexical or canonical path checks before host filesystem access. <!-- Source: src/services/run-request/run-request-validator.ts --><!-- Source: src/controller/phase-sidecar-reader.ts --> |

The controls common to all six reduce malformed-input and confused-deputy risk; they do not turn model-authored content into trusted content.

## What Schegent cannot prevent

- Claude and Agy run with approval prompts disabled, so they can act without asking under the operator's local permissions. `schegent.backend.runner` **defaults to `claude`**, so this is the default path, not an opt-in one — and as of FR-R3-056 **it is refused by default**: an uncontained backend does not run until `schegent.backend.allowUncontainedBackends` is set, and the refusal is enforced where the backend would be constructed rather than disclosed in prose. Disclosure alone changed informed consent, not reachability; this changes reachability. The decision, the shapes not chosen, and what remains outstanding are in [Agent capability posture](../architecture/agent-capability-posture.md). Codex's `workspace-write` sandbox is the only adapter-level filesystem bound documented by its argv. None of these facts make generated actions correct. <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/runner/codex-cli.ts --><!-- Source: src/runner/agy-cli.ts -->
- Prompt injection in repository files, task text, imported instructions, or prior output is not classified by the host. <!-- Source: src/runner/prompt-builder.ts -->
- A Phase outcome is self-certification **unless the Phase declares `hostVerification: 'exit-code'`** (FR-R3-058). By default, classification uses the model's own account of its work: a timed-out process whose output parsed clean is treated as success, and a non-zero exit alongside a clean termination token is logged and advanced. A Phase marked `exit-code` is judged on the process's exit status instead, and a clean token cannot override a non-zero exit or a timeout — so for a Phase that runs tests or claims a side effect, the agent whose work is judged is no longer the author of the evidence that advances it. The marking is opt-in, so an unmarked Phase behaves exactly as this paragraph described before. The bounded control sentinel prevents arbitrary content from becoming process control, but a well-formed model report can still be false. `resolveRunOutputs` checks whether a declared output exists; it does not prove correctness. Authors should mark verification Phases `exit-code` and, as before, write an independent verification Phase as described in [Custom Phases](../features/custom-phases.md). <!-- Source: src/parser/stdout-parser.ts --><!-- Source: src/services/run-driver.ts --><!-- Source: tests/lint/no-content-driven-process-control.test.ts -->
- Concurrent Runs share one checkout and can interleave edits. Lowering `schegent.queue.globalConcurrencyCap` to `1` narrows simultaneous execution but is not rollback or file locking. <!-- Source: src/services/auto-drain-coordinator.ts --><!-- Source: package.json -->
- Local raw transcripts are intentionally unredacted, and Claude verbose diagnostics are unredacted when enabled. Recovery checkpoints can contain an unredacted binary Git diff. These artifacts must remain local and unshared. <!-- Source: src/audit/raw-transcript-writer.ts --><!-- Source: src/audit/verbose-diagnostic-writer.ts --><!-- Source: src/services/run-checkpoint-service.ts -->
- The sanitized CLI transport log can still contain local paths, and a saved full Task description can retain sensitive operator text that does not match the sanitizer's secret patterns. <!-- Source: src/monitor/cli-transport-sink.ts --><!-- Source: src/services/history/history-description-store.ts --><!-- Source: src/lib/logger.ts -->
- Workspace-local audit evidence can be modified or deleted by an operator or backend process. Schegent neither hashes the log as a chain nor detects post-write tampering. <!-- Source: src/audit/audit-log-writer.ts -->
- The host does not implement an offline network guarantee for backend CLIs. <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/runner/codex-cli.ts --><!-- Source: src/runner/agy-cli.ts -->

**FR-R3-086 — a phase may narrow what its agent may do, and here is what that does NOT bound.**
A Phase definition may declare a capability set (`workspace-write`, `outside-workspace-write`,
`process-spawn`, `network`), frozen into the Run's plan snapshot. The host translates it into the
backend's own enforcement flags — `--disallowedTools` and `--permission-mode` for Claude, `--sandbox`
for Agy, `--sandbox` for Codex — so the backend's permission engine refuses at the attempt.

What it bounds and what it does not, in the same paragraph on purpose:

- **The host does not observe tool calls.** It hands the backend a narrowed authority and trusts the
  backend to apply it. That trust is the anchor of the whole mechanism, and nothing here verifies it.
- **`agy` can express only `process-spawn`.** Its CLI has a single `--sandbox` switch and no per-tool
  flag, so a phase withholding `network`, `workspace-write` or `outside-workspace-write` on that
  backend is **refused before it starts** rather than run unbounded. Refusing is the honest outcome; it
  is not a working one.
- **The default is unchanged.** A phase that declares no capability set spawns with exactly the argv it
  spawned with before this existed. `SEC-08` is not closed by this: narrowing is opt-in, per phase, and
  a fresh install still refuses its first uncontained run.
- **A narrowed phase cannot widen by being exported and re-imported.** The portable YAML format carries
  the declared set as a scalar, not a list, because that format's list convention reads an absent key as
  the empty list — for this field exactly backwards, since absent must mean the unbounded default and the
  empty set must mean nothing granted. A list-shaped key would have turned the most restrictive
  declaration into the least on a round trip that reports success. Both validators refuse an unknown or
  repeated member rather than dropping it, so a set is never silently narrowed either.
  <!-- Source: src/services/process-yaml/yaml-serializer.ts --><!-- Source: src/services/process-yaml/phase-yaml-validator.ts -->
- **This is not a mediated broker.** The broker — where the host would see each call rather than
  delegating — is recorded as the destination in
  [Agent capability posture](../architecture/agent-capability-posture.md), with the review's own 1–3
  month estimate and the expansion-freeze constraint that blocks its most plausible route.

A refusal is a Run-level outcome with a named cause and a declared `capability-refused` audit event,
distinguishable from a phase failure. A set the backend *can* enforce is recorded too, as
`capability-applied`: the bound itself lives in argv and argv is never written to the structured log, so
without that event a completed Run could not tell an operator whether its phase ran bounded. Both
payloads carry closed-union members and a phase index, nothing else. <!-- Source: src/services/capability-enforcement-plan.ts --><!-- Source: src/contracts/phase-capabilities.ts -->

## Threat anchors

### T1 — Secret leakage to operator-visible sinks

All operator-visible logger sinks receive text after the single code-resident redaction set. A new sink that bypasses `SanitizedLogger`, or a secret pattern duplicated elsewhere, breaks the mitigation.

<!-- Source: src/lib/logger.ts -->

### T2 — Untrusted webview mutating host state

The webview is not authoritative. Runtime validation precedes routing; the 46 metadata-classified mutations then require workspace trust and authoritative window primacy.

<!-- Source: src/contracts/runtime-validators.ts -->
<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->

### T3 — Audit-log tampering or non-append writes

The host's audit writer appends JSONL records and owns rotation; Task deletion records an event rather than asking that writer to erase earlier entries. This is an implementation write discipline, not an integrity guarantee. An operator or backend process with workspace access can modify or delete the file, and Schegent has no hash chain, signature, or post-write tamper detection. Ordinary appends also call `fs.appendFile` directly after directory creation; unlike rotation targets, that live-file append is not first passed through the canonical-path oracle, so a planted audit-log symlink remains a redirect risk.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/contracts/audit-events.ts -->

### T4 — Workspace path leakage into the structured audit log

Audit and evidence contracts favor identifiers, counts, hashes, and bounded tuples. Local artifact resolution stays host-side.

<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/services/history/history-evidence-service.ts -->

### T5 — Concurrent state mutation across multiple VS Code windows

The ownership registry persists a fenced record under `.schegent/ownership`; the router independently refuses guarded work from a secondary window. Activation elects before it recovers: every recovery installer is gated on the primacy result, and the resume path claims its queue's execution lease before marking work in flight (FR-R3-070).

The fence reaches the point of effect (FR-R3-077). Both commit points — the Run record and the queue record — take a **required** claim and verify it inside the same serialized link that performs the write, so a host whose lease was reclaimed while it was stalled is refused when it resumes and commits, by the fence rather than by a storage error. A call site that provably holds no lease says so by name, from a closed set, and the set is pinned by a test. Because the memento offers no conditional write, a reclaim landing between the verify and the update can still leave a record written by a superseded holder; the read side is the answer to that, declining a record stamped at a superseded generation and recording the decline as evidence rather than dropping it.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/ownership-claim.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->
<!-- Source: src/extension.ts -->

### T5a — A cloned checkout supplies its own containment boundary

The catalog and ownership stores judge containment against the trusted workspace root, never against a store directory the checkout itself supplies (FR-R3-069). A workspace arriving with `.schegent`, `.schegent/catalog`, or `.schegent/ownership` symlinked out of the workspace refuses — nothing is created, written, read, or arbitrated through the link — while a link that resolves inside the workspace is admitted. Store chains are created only through the safe-open anchor walk, which refuses a symlinked component by name.

FR-R3-078 and FR-R3-080 close the check-to-use window on the sinks that still had one: the raw transcript's end-write and promotion, the history description store, the phase-log readers and the phase sidecar reader now act on descriptors the walk produced rather than on a pathname re-resolved after a verdict, and the two hot append sinks hold the descriptor the walk proved instead of re-writing to a name. A refused write is reported as a refusal — distinctly from a failure — and reaches an operator as a phase-end warning rather than a log line nobody reads.

The residual is stated rather than implied: the walk `lstat`s each component and opens the leaf with `O_NOFOLLOW`, which closes the no-race hole and does not close the window between one component's `lstat` and the next syscall. Closing that needs a handle-relative walk, which needs a native binding; the migration ledger records it, with the sites where a `rename` cannot be made handle-relative at all.

<!-- Source: src/lib/catalog-fs-adapter.ts -->
<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/lib/safe-open.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->

### T5b — An output target is judged once, then written later

An operator names an output inside the workspace and confirms it; the target is frozen into the plan; the whole planning phase runs; the CLI then writes it. Request-time containment is lexical (`path.resolve`/`path.relative`, no `realpath`), so a parent component swapped for a symlink in that interval sends an "inside the workspace" write outside it — under the operator's full local authority, for the runners that are uncontained.

Every declared output target's component chain is re-walked at dispatch, immediately before the frozen plan reaches the runner (FR-R3-079). A refusal is a Run-level failure with a named cause recorded in evidence, raised before the runner is called, so the child never receives the target; the frozen plan is read and never rewritten. Collision identity is canonical, including for a target that does not exist yet, so two names for one file through a link are one claim rather than two.

The residual is the asymmetry FR-R3-032 established: re-walking at dispatch narrows the window to the interval between the walk and the child's write, and only the sandboxed runner closes that. The deliberate external-side-effect port keeps its own confirmation and is not turned into a refusal.

<!-- Source: src/services/dispatch-output-guard.ts -->
<!-- Source: src/lib/output-target-identity.ts -->
<!-- Source: src/services/run-driver.ts -->

### T6 — Lease leak fail-deadly

Execution leases heartbeat and become reclaimable only after the shared 15-second staleness threshold. Release sites remain explicit so a terminal transition, failed start, or shutdown cannot silently strand a claim.

<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/lock.ts -->

### T7 — Untrusted workspace executing extension capabilities

Mutating IPC fails closed when the trust callback is missing, throws, or returns anything but `true`. Workspace-bound activation is also separated from the restricted stage.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/extension.ts -->

### T8 — Prompt injection via spec, plan, task, or instruction content

The prompt composer deliberately transports operator-selected content. There is no prompt-injection detector in the ingress path; the operator's repository and approvals remain part of the security decision.

<!-- Source: src/runner/prompt-builder.ts -->
<!-- Source: src/services/run-request/run-request-validator.ts -->

### T9 — Phase invocation bypasses evidence or redaction

`PhaseRunner` is the execution seam. It creates lifecycle evidence, delegates raw transcript writes, and sanitizes projected diagnostics rather than asking adapters to do so.

<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->

### T10 — Unredacted local diagnostics leave the workspace

Schegent has several distinct local sensitive-data surfaces:

- Raw session transcripts are local and unredacted. Claude verbose diagnostics are optional and unredacted. Generated ignore rules reduce accidental commits but are not encryption or access control.
- Recovery checkpoints live under extension `globalStorage/checkpoints`. A checkpoint patch is `git diff --binary --no-ext-diff HEAD`, so it may contain source and secrets that were present in uncommitted changes. Run directories use mode `0700` and files use `0600`. Their separate retention policy is 14 days and 256 MiB, while protecting the ten most recent Run directories from the size bound; session-retention settings do not govern them.
- `.schegent/cli-transport.log` is sanitized through the shared secret patterns but deliberately retains paths found in backend output. `.schegent/history/<runId>.txt` stores the full sanitized Task description with mode `0600`; sanitization is pattern-based and is not a general data-classification guarantee. Since FR-R3-071 that text also reaches the sidebar on request (`CMD_RESOLVE_HISTORY_DESCRIPTION`), so the operator repeating a run edits what they actually wrote rather than an 80-character preview: the webview names a run id and never a path, the host resolves the sidecar through the single description resolver, and the command is read-only — outside `MUTATING_COMMANDS` and ungated by primacy, on the same terms as the evidence drill-down.

<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->
<!-- Source: src/audit/schegent-gitignore.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/lib/logger.ts -->

### T11 — retryCondition DSL escape

The retry evaluator tokenizes and evaluates a closed grammar without arbitrary JavaScript evaluation, function calls, member access, or I/O.

<!-- Source: src/lib/retry-condition.ts -->

### T12 — Fatal-signature floor weakening

Built-ins are frozen code data. Operator patterns are additive and cannot delete or move the built-in scan floor.

<!-- Source: src/lib/fatal-signature-registry.ts -->
<!-- Source: src/lib/incremental-fatal-scanner.ts -->

### T13 — State-schema invariant violation

Workspace state validates coupled pause/retry fields before persistence and uses forward-only normalizers for legacy Runs.

<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/state/workflow-run-migrator.ts -->

### T14 — Multi-queue registry races

Queue capacity and workspace capacity are distinct decisions. A per-queue execution lease identifies the current claimant and stale recovery window.

<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/state/execution-lease.ts -->

### T15 — Phase-message env injection

The host derives and checks the Phase sidecar location, bounds the read, parses the allowed records, and sanitizes values before prompt or UI projection.

<!-- Source: src/controller/phase-sidecar-reader.ts -->

### T16 — Operator fatal-signature update is stale

Effective signatures are resolved at invocation time instead of being frozen on a long-lived runner instance.

<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/lib/fatal-signature-registry.ts -->

### T17 — Retired out-of-host wake-up runner returns

Current scheduled-start recovery remains extension-host code: the coordinator persists queue intent and the watchdog asks the drain coordinator to retry. No external scheduler installer or daemon entry point exists in the production tree.

<!-- Source: src/services/scheduled-start-coordinator.ts -->
<!-- Source: src/controller/schedule-watchdog.ts -->

### T18 — vscode namespace leaks into headless or telemetry code

Host-free APIs must stay importable without VS Code. Dedicated lint tests reject direct or transitive namespace leakage in both source trees.

<!-- Source: tests/lint/no-vscode-import-in-headless.test.ts -->
<!-- Source: tests/lint/no-vscode-import-in-telemetry.test.ts -->

### T19 — Runtime log forks the redaction set

The runtime log implements the logger sink interface and receives already-sanitized entries. A source scan restricts direct syslog filesystem writes.

<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: tests/lint/no-direct-syslog-fs-writes.test.ts -->

### T20 — Phase-log IPC double or skipped sanitization

Historical reads and live tails share bounded projections and an injected sanitizer before data crosses to the webview. The activity feed cannot render operator data through Svelte raw-HTML interpolation.

<!-- Source: src/services/phase-log/phase-log-reader.ts -->
<!-- Source: src/services/phase-log/phase-log-tail-session.ts -->
<!-- Source: tests/lint/no-html-interpolation-in-activity-feed.test.ts -->

### T21 — Untrusted stdout names local files

The host computes the canonical expected `phase-message.env` path from run identity. An audit-reported path is not general file-read authority and must resolve to that location before fallback use.

<!-- Source: src/controller/phase-sidecar-reader.ts -->

### T22 — Workflow condition acquires an evaluator

Workflow conditions remain structured operands and a closed operator union. The comparison service reads fields; it does not execute expression text.

<!-- Source: src/contracts/workflow-definitions.ts -->
<!-- Source: src/services/workflow-execution/condition-evaluator.ts -->

### T23 — Operator-authored value escapes its declared bound

Phase, Pipeline, Workflow, port, and retry-expression bounds belong to their contract modules. Ingress and reporting must import those constants rather than declare private look-alike maxima.

<!-- Source: src/contracts/process-definitions.ts -->
<!-- Source: src/contracts/pipeline-definitions.ts -->
<!-- Source: src/contracts/workflow-definitions.ts -->
<!-- Source: tests/lint/retry-condition-bound-declared-once.test.ts -->

### T24 — Legacy persisted state re-enters the runtime

Initialization migrates known older schemas in order. A numeric schema above the running implementation is rejected with an update instruction instead of being guessed at; audit parsing preserves unknown evidence with warnings.

<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: src/parser/audit-log-parser.ts -->

### T25 — Control sentinel carried in CLI output

Outcome classification accepts a termination token only in the trailing region at or after the last complete audit block. An out-of-region token is logged and never acted on; if there is no complete block, acceptance is explicitly labelled `[constitution] token accepted without audit block`.

Process control is stronger: Claude grace termination arms on the parsed stream-json `{"type":"result"}` harness record, not on model-content substrings. The mechanism is pinned by `tests/lint/no-content-driven-process-control.test.ts`.

This does not make the model's evidence truthful. It separates a bounded control sentinel from the Phase's self-reported outcome, which remains subject to the limit documented above — **except where a Phase declares `hostVerification: 'exit-code'`, in which case the host's own exit status decides and the model's token cannot override it** (FR-R3-058). FR-R3-023 verified evidence *shape* and FR-R3-038 *disclosed* this self-certification; the marking is where it is now *enforced*.

<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: tests/lint/no-content-driven-process-control.test.ts -->
