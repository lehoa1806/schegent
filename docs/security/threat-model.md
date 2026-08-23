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

- Claude and Agy run with approval prompts disabled, so they can act without asking under the operator's local permissions. Codex's `workspace-write` sandbox is the only adapter-level filesystem bound documented by its argv. None of these facts make generated actions correct. <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/runner/codex-cli.ts --><!-- Source: src/runner/agy-cli.ts -->
- Prompt injection in repository files, task text, imported instructions, or prior output is not classified by the host. <!-- Source: src/runner/prompt-builder.ts -->
- A Phase outcome is self-certification: classification uses the model's own account of its work. The bounded control sentinel prevents arbitrary content from becoming process control, but a well-formed model report can still be false. `resolveRunOutputs` checks whether a declared output exists; it does not prove correctness. Authors must write an independent verification Phase as described in [Custom Phases](../features/custom-phases.md). <!-- Source: src/parser/stdout-parser.ts --><!-- Source: src/services/run-driver.ts --><!-- Source: tests/lint/no-content-driven-process-control.test.ts -->
- Concurrent Runs share one checkout and can interleave edits. Lowering `schegent.queue.globalConcurrencyCap` to `1` narrows simultaneous execution but is not rollback or file locking. <!-- Source: src/services/auto-drain-coordinator.ts --><!-- Source: package.json -->
- Local raw transcripts are intentionally unredacted, and Claude verbose diagnostics are unredacted when enabled. Recovery checkpoints can contain an unredacted binary Git diff. These artifacts must remain local and unshared. <!-- Source: src/audit/raw-transcript-writer.ts --><!-- Source: src/audit/verbose-diagnostic-writer.ts --><!-- Source: src/services/run-checkpoint-service.ts -->
- The sanitized CLI transport log can still contain local paths, and a saved full Task description can retain sensitive operator text that does not match the sanitizer's secret patterns. <!-- Source: src/monitor/cli-transport-sink.ts --><!-- Source: src/services/history/history-description-store.ts --><!-- Source: src/lib/logger.ts -->
- Workspace-local audit evidence can be modified or deleted by an operator or backend process. Schegent neither hashes the log as a chain nor detects post-write tampering. <!-- Source: src/audit/audit-log-writer.ts -->
- The host does not implement an offline network guarantee for backend CLIs. <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/runner/codex-cli.ts --><!-- Source: src/runner/agy-cli.ts -->

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

The ownership registry persists a fenced record under `.schegent/ownership`; the router independently refuses guarded work from a secondary window.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->

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
- `.schegent/cli-transport.log` is sanitized through the shared secret patterns but deliberately retains paths found in backend output. `.schegent/history/<runId>.txt` stores the full sanitized Task description with mode `0600`; sanitization is pattern-based and is not a general data-classification guarantee.

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

This does not make the model's evidence truthful. It separates a bounded control sentinel from the Phase's self-reported outcome, which remains subject to the limit documented above.

<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: tests/lint/no-content-driven-process-control.test.ts -->
