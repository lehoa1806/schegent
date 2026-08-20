# Operator Threat Model

Schegent runs an autonomous local CLI backend (Claude, Codex, or Agy) with broad capabilities inside your workspace. This page is the operator-facing summary of what Schegent can and cannot do, what risks exist, and what mitigations are in place. It is not exhaustive — it is the model you need to make informed decisions about whether and how to use the extension.

> For a non-contributor-facing projection of this threat model — trust ceiling, audit boundary, network boundary, seven failure modes, and five escape hatches in ≤15 pages — see [Security White-Paper](whitepaper.md).

## Threat catalog (T1–T24)

The catalog below enumerates each in-scope threat, the primary mitigation, and the prose section that elaborates. CLAUDE.md hard rules and `SECURITY.md` cite these identifiers directly; every cited `Tn` resolves to an anchor here. The `tests/lint/threat-id-anchor-parity.test.ts` regression fails the build on any drift.

| Id | Threat | Primary mitigation | Elaborated under |
|---|---|---|---|
| [T1](#t1--secret-leakage-to-operator-visible-sinks) | Secret leakage to operator-visible sinks (audit log, runtime log, Output channel, phase-log IPC). | Single `SECRET_PATTERNS` redaction set in [src/lib/logger.ts](../../src/lib/logger.ts) feeds every `SanitizedLogger` sink. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T2](#t2--untrusted-webview-mutating-host-state) | The untrusted webview (Svelte sidebar) mutating host state via crafted IPC payloads. | Strict CSP + `MUTATING_COMMANDS` primary-host gate + host-side re-validation of every command payload. | [The CSP and webview integrity](#the-csp-and-webview-integrity), [The mutating-commands registry](#the-mutating-commands-registry) |
| [T3](#t3--audit-log-tampering-or-non-append-writes) | Audit log tampering, truncation, or non-append writes that destroy operator evidence. | `appendAudit` is the single writer; deletion paths never erase `.schegent/audit.log`; rotation preserves history. | [The append-only audit log](#the-append-only-audit-log) |
| [T4](#t4--workspace-path-leakage-into-the-structured-audit-log) | Workspace path leakage into the structured audit log (e.g. workspace roots, phase-log file paths). | Paths-free audit discipline — count and selection-tuple fields only, never raw paths. | [The paths-free audit discipline](#the-paths-free-audit-discipline) |
| [T5](#t5--concurrent-state-mutation-across-multiple-vs-code-windows) | Concurrent state mutation across two VS Code windows opened on the same workspace. | Primary-host gating + a single-holder `WorkspaceLockManager` lease claimed at activation + lock-file stale recovery. | [Primary-host gating (multi-window)](#primary-host-gating-multi-window) |
| [T6](#t6--lease-leak-fail-deadly) | Lease leak (fail-deadly): a code path claims a queue and never gives it back, stalling that queue's subsequent runs. | Three execution-lease releases (terminal run transition, drain start-failure, window shutdown) behind a 15-second staleness reclaim; window primacy has no per-run scope to leak from. | [The hard rules](#the-hard-rules) |
| [T7](#t7--untrusted-workspace-executing-extension-capabilities) | An untrusted workspace causing Schegent to spawn the CLI or write audit data. | `workspaceTrust: untrusted-restricted` posture; every mutating command rejects in an untrusted workspace. | [Workspace-trust gating](#workspace-trust-gating) |
| [T8](#t8--prompt-injection-via-specplantask-content) | Prompt-injection via spec / plan / task / phase-instruction content the operator (or an upstream model) authored. | Out-of-band trust boundary; the host does not analyze prompt content. Operator decides whether to ingest untrusted text. | [A note on prompt-injection](#a-note-on-prompt-injection) |
| [T9](#t9--custom-phase-bypassing-audit-or-redaction) | A phase invocation bypassing the audit + redaction + raw-transcript path. | `appendAudit` + raw transcript writer is the single, mandatory invocation path, and nothing is exempt from it. Phase audit payloads carry `pipelineId`, `phaseId`, and (when set) `model` / `effort` / `timeoutMs`. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T10](#t10--verbose-diagnostic-unredacted-leak) | The verbose-diagnostic sink (`debug.json`, `stream.jsonl`, `verbose.log`) leaking unredacted bytes off-machine. | Operator-opt-in via `schegent.logging.verbose` (default off); gitignored; paths-free audit; intentionally local-only. | [What requires local-only handling](#what-requires-local-only-handling) |
| [T11](#t11--retrycondition-dsl-escape) | The operator-authored `retryCondition` DSL expression escaping the sandboxed evaluator. | Evaluator at `src/lib/retry-condition.ts` is the sole entry point: no arbitrary code, no function calls, no member access, no I/O. | [The hard rules](#the-hard-rules) |
| [T12](#t12--fatal-signature-floor-weakening) | Operator workspace settings weakening or re-ordering the code-resident fatal-signature floor. | `FATAL_SIGNATURES` in [src/lib/fatal-signature-registry.ts](../../src/lib/fatal-signature-registry.ts) is immutable at runtime; operator-additive surface extends but never removes built-ins; built-ins-first scan order preserved. | [The hard rules](#the-hard-rules) |
| [T13](#t13--state-schema-invariant-violation) | Persisting a `WorkflowRun` with a one-sided pair (`pendingRetryAt`/`pendingRetryCause` or `manualPauseAt`/`manualPauseCause`) that leaves the scheduler in an unresumable state. | `WorkspaceStateStore.setRun()` rejects mismatched pairs; forward-only migrators backfill legacy records. | [The hard rules](#the-hard-rules) |
| [T14](#t14--multi-queue-registry-races) | Racing on the reopened multi-queue registry: two windows promoting one queue, a queue promoted past its own in-flight slot, a claim stranded by a crash. | Per-queue execution lease with 15 s staleness reclaim; `hasQueueCapacity` / `hasWorkspaceCapacity` as distinct predicates; one idle-pending enforcement site; forward-only v9→v10 migrator with the per-entry lockstep assertion. | [The hard rules](#the-hard-rules) |
| [T14a](#t14a--concurrent-runs-against-one-working-tree) | Runs from different queues editing the same files in one shared checkout. | Risk reduction only: per-queue audit attribution and per-run session trees make authorship recoverable. Since feature 093 the engine drives up to `globalConcurrencyCap` Runs at once, so interleaving is now within a pair of simultaneous runs; set the cap to `1` for the narrower window. Conflict resolution is the operator's. | [Multiple queues and concurrency](../operations/multi-queue-concurrency.md) |
| [T15](#t15--phase-message-env-injection) | A `phase-message.env` value reaching the UI or audit projection without passing through the sanitizer used at prompt composition time. | Phase-message values pass through `SanitizedLogger.sanitize` before downstream consumption; audit + UI surface metadata only, never raw env values. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T16](#t16--operator-additive-fatal-signatures-stale-cache) | A cached `schegent.fatalSignatures` value masking an operator update mid-run. | `FatalSignaturesAccessor` is read at the top of every `PhaseRunner.run()`; never cached on the runner. | [The hard rules](#the-hard-rules) |
| [T17](#t17--wake-up-runner-workspace-contamination) | **Retired.** The OS-scheduled wake-up runner spawning the CLI inside a workspace root, or with workspace-specific environment variables leaking through. | Retired with the capability: no code installs, schedules, or spawns an out-of-host runner. The id is retained so existing citations still resolve. | [T17 anchor](#t17--wake-up-runner-workspace-contamination) |
| [T18](#t18--vs-code-namespace-leakage-into-headless-or-telemetry-code) | A `vscode` import reaching `src/headless/` or `src/telemetry/` and either blowing up a host-free caller or re-enabling a capability surface those trees must not have. | Lint regressions in `tests/lint/no-vscode-import-in-{headless,telemetry}.test.ts` fail the build on drift. | [The hard rules](#the-hard-rules) |
| [T19](#t19--runtime-log-sink-forking-the-redaction-set) | The runtime log sink forking or doubling the redaction set, breaking the "single SECRET_PATTERNS source of truth" guarantee. | Sink at `src/lib/runtime-log/runtime-log-sink.ts` is a `LogSink` registered on `SanitizedLogger`; no second sanitizer; `tests/lint/no-direct-syslog-fs-writes.test.ts` pins the writer allowlist. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T20](#t20--phase-log-ipc-double-or-skipped-sanitization) | The phase-log IPC pipeline (manifest read + live tail) double-sanitizing, skipping sanitization, or routing operator-influenced strings to the webview via `{@html}` interpolation. | Fixed order project → truncate → sanitize at the IPC boundary; one injected `SanitizedLogger.sanitize`; webview never re-sanitizes; `tests/lint/no-html-interpolation-in-activity-feed.test.ts` pins the rule. | [Sanitization is centralized](#sanitization-is-centralized) |
| [T21](#t21--untrusted-stdout-names-local-files) | A CLI audit-event JSON line names a `phase-message.env` path outside the run's diagnostics tree (attacker-influenced absolute path or `..`-traversal), and the host reads through the steered path. | Canonical-path containment in `src/controller/phase-sidecar-reader.ts`: the host computes the expected path from `(workspaceRoot, runId, pipelineId, phaseId, iterationN)`; audit-reported paths are accepted only when they canonicalize byte-equal, and ignored entirely when the canonical file exists. | [T21 anchor](#t21--untrusted-stdout-names-local-files) |
| [T22](#t22--workflow-condition-acquiring-an-evaluator) | A Workflow connection condition acquiring a string form — and therefore a parser, evaluator, template engine, or sandbox — reopening the T11 surface on a second operator-authored input without T11's sandbox invariants. | A condition is structured data (`{ left, operator, right? }`) compared field-wise against closed enums; there is no expression text to evaluate. Pinned by the CLAUDE.md hard rule and by a source scan over both condition modules in `tests/unit/config/workflow-graph-validator.test.ts`. | [T22 anchor](#t22--workflow-condition-acquiring-an-evaluator) |
| [T23](#t23--operator-authored-identifier-escaping-its-declared-bound) | An operator-authored identifier (phase / pipeline / workflow / port id) reaching a bounded sink unbounded, or bounded against a limit its own catalog does not enforce. | One declared bound per catalog in the `contracts/` leaf module; validators reject an over-long id before persistence; every reporting site truncates against that same constant. | [T23 anchor](#t23--operator-authored-identifier-escaping-its-declared-bound) |
| [T24](#t24--legacy-persisted-state-re-entering-the-runtime) | State persisted by an earlier extension version re-entering the current runtime in a shape today's invariants forbid — or a newer version's state being best-effort read by an older runtime. | Forward-only migrators at `initialize()`; a persisted version above the runtime's is refused outright; the audit parser warns and preserves unknown event types rather than dropping them. | [T24 anchor](#t24--legacy-persisted-state-re-entering-the-runtime) |

## What Schegent has access to

Schegent runs as a VS Code extension. When a workspace is trusted, the extension can:

- **Spawn the CLI subprocess** (Claude, Codex, or Agy) with the configured argv composition.
- **Read and write files** in the workspace root (via the CLI's tool calls).
- **Read and write `.schegent/`** for audit, transcripts, runtime log, diagnostics.
- **Read and write the VS Code `workspaceState`** for queue, run, pause state.

The CLI itself, once spawned, has whatever capabilities its argv and the operator's environment grant it. The CLI's tool calls (`Bash`, `Write`, `Edit`, etc.) are not sandboxed beyond what the CLI itself implements. All backend runners (Claude, Codex, Agy) use the identical `shell: false`, monitor sidecar, and output-cap truncation patterns, meaning switching backends introduces no new trust boundaries.

Backend capability discovery is a separate host-only subprocess path; it never
constructs an invocation runner or executes a model-authored prompt. Discovery
uses `shell: false`, the same cwd/environment policy as invocations, a 1–30
second bounded timeout (default 5), 64 KiB output retention, and TERM→KILL
cleanup. Only backend identifiers and bounded model identifiers reach the
webview; configured executable paths, stderr, environment values, and raw
errors do not cross that boundary.

## What Schegent does **not** have access to

- **Other workspaces.** Schegent's state is per-workspace. A run in workspace A cannot see or affect workspace B.
- **The network, except via the CLI.** The host extension itself does not make outbound network calls. Backend CLIs may do so; this local-first boundary is not an [offline-execution promise](../concepts/local-first-not-offline.md).
- **Your shell environment beyond the selected policy.** The compatibility
  default forwards the VS Code extension-host environment. Hardened operators
  can select `minimal` or a names-only `allowlist`; the policy applies to
  backend probes, phase calls, and pre-compaction calls. Allowlist values are
  read only at spawn time and never stored in Schegent settings.
- **The audit log content of *other* users on the same machine.** `.schegent/` lives in the workspace; shared multi-user operation is outside the supported boundary and is blocked by the [remote/multi-user expansion gate](../architecture/remote-multi-user-expansion-gate.md).

## Trust boundaries

The trust model has three layers:

1. **The operator** trusts the host extension. (You installed it.)
2. **The host extension** trusts the configured CLI binary. (You configured `schegent.cli.path`.)
3. **The CLI** trusts the prompt and tool-call inputs Schegent composes. (Schegent generates the prompts from the spec/plan/task files and operator settings.)

The webview (the sidebar Svelte UI) is **untrusted with respect to mutating host state**. Every operator-action IPC message is sanitized at the host boundary; the host re-validates every input. The webview is the messenger, not the source of truth.

### An imported process document is not a fourth trust layer

The YAML exchange ([features/phase-yaml-exchange.md](../features/phase-yaml-exchange.md)) reads a file the operator did not necessarily write, which makes it worth stating plainly where it sits: it adds **no** trust boundary, and the third document kind (`Workflow`, feature 086) adds none either. It is a transport into the same three catalogs, gated by the same capabilities, that an operator could already have typed by hand.

Four properties are what make that true rather than merely intended:

- **No new authority.** An imported Phase is gated by `allowCustomPhases`, and additionally by `allowCustomRetryConditions` when it declares one; an imported Pipeline or Workflow is gated by Workspace Trust and nothing further, because the capabilities that once gated them (`allowPipelineOverrides`, `allowWorkflowOverrides`) named a layer tier that feature 099 deleted. Those are the same two scopes above, resolved by the same ladder, each re-read at commit rather than inherited from the preflight. A document cannot grant itself a capability or raise a scope, and there is no longer a scope for it to choose: there is one catalog.
- **No new parser.** The exchange reads a closed YAML subset with its own scanner, not a general library. Anchors, aliases, and merge keys — a general parser's amplification and aliasing surface on a file you did not write — cannot be expressed, so they cannot be expanded. The size bound is checked before the scanner is entered, so an oversized file is never parsed at all. The scanner, parser, and scalar-style modules are pinned by digest, so a refactor that widens the accepted language fails the build rather than shipping.
- **No new evaluator.** This is the property most at risk from the third kind, because a Workflow's connections are conditional. A condition is structured data (`{ left, operator, right? }`) over closed enums, never an expression string, so T22's mitigation covers the imported case with nothing added. A Phase's `retryCondition` is the one expression the format carries, and to the exchange it is inert text: validated for presence, carried verbatim, never parsed — T11's sandboxed evaluator remains the only thing that ever reads it, at run time. The capability gate keys on the field's presence, never on its contents, so the import path has no reason to look inside it.
- **No path across the IPC boundary.** The open and save dialogs run host-side; no plan row, audit payload, or error message carries a filesystem path in either direction. An export write failure reports a generic sentence precisely because an adapter's own error text can name the location it tried to write. This is the T4 paths-free discipline applied to a second surface, not an exception to it.

What the exchange *does* add is a decision the operator has to make, which is why the preflight writes nothing: a document is inspected first, resource by resource, and an import never overwrites anything the catalog already holds at any status. See [Decisions you make as an operator](#decisions-you-make-as-an-operator).

## The untrusted input classes

"Untrusted" here does not mean "hostile operator". It means **the host did not author this value and must not assume its shape** — so it is validated at the boundary it crosses rather than at the point where it is finally used. Five classes qualify. Each has a named mitigation, not a convention:

| Input class | Where it enters | What the host refuses to assume | Mitigation |
|---|---|---|---|
| **Operator-authored document** | A YAML file opened through the process-exchange import dialog (Phase, Pipeline, or Workflow package). | That it parses, that it is small, that the resources it names exist, or that the operator wrote it. | A closed-subset scanner rather than a general YAML parser — no anchors, aliases, merge keys, or tags to expand; the 1 MiB bound is checked *before* the scanner is entered; a preflight that writes nothing and reports resource by resource; the same capability gates an equivalent hand-edit would face, re-read at commit rather than inherited from the preflight. See [An imported process document is not a fourth trust layer](#an-imported-process-document-is-not-a-fourth-trust-layer). |
| **Operator-authored condition** | A phase `retryCondition` expression, and a Workflow connection condition. | That the expression is benign, or that evaluating it "just to check" is free. | `retryCondition` has exactly one evaluator, sandboxed, at [src/lib/retry-condition.ts](../../src/lib/retry-condition.ts) — [T11](#t11--retrycondition-dsl-escape). Every other reader, the import path included, treats the field as inert text and never looks inside it. A Workflow condition has no string form at all, so there is nothing to parse and no sandbox to escape — [T22](#t22--workflow-condition-acquiring-an-evaluator). |
| **Operator-authored identifier** | A phase / pipeline / workflow id, a port id, or a node id — from a builder, an imported document, or a hand-edited file in the catalog store. | That it is bounded, that it is unique within its catalog, or that it is safe to interpolate whole into an audit payload, an error string, or an IPC projection. | Each catalog declares its own bound once, in its `contracts/` leaf module (`PHASE_ID_MAX_LEN`, `PIPELINE_ID_MAX_LEN`, `WORKFLOW_ID_MAX_LEN`); validators reject an over-long or duplicate id before it is persisted; every reporting site truncates against that same constant — [T23](#t23--operator-authored-identifier-escaping-its-declared-bound). |
| **IPC payload** | Every message the Svelte sidebar posts to the host. | That the webview validated anything, that the sender is the primary host, or that the payload's fields have the declared types. | Strict CSP; membership in `MUTATING_COMMANDS` gates every mutating command behind the primary host; the host re-validates each payload against its own validator, and the catalogs are re-resolved host-side rather than trusted from the message — [T2](#t2--untrusted-webview-mutating-host-state). No filesystem path crosses this boundary in either direction. |
| **Legacy persisted state** | `workspaceState`, VS Code global storage, and `.schegent/audit.log` rows written by an earlier extension version. | That it matches the current schema, or that the invariants in force today were in force when it was written. | Forward-only migrators run at `initialize()`; a persisted schema version *above* the runtime's is refused outright instead of best-effort read; `setRun()` rejects the one-sided pause/retry pairs an older record may carry — [T13](#t13--state-schema-invariant-violation); the audit parser warns and preserves unknown event types rather than dropping them — [T24](#t24--legacy-persisted-state-re-entering-the-runtime). |

Two properties are common to all five. **None of them can widen a capability**: a document, a condition, an identifier, a message, and a migrated record all resolve through the same two trust scopes under the same workspace-trust ceiling, so the worst an untrusted input can do is be refused. And **each is bounded before it is interpreted**, not after — the size check precedes the scanner, the validator precedes the write, the migrator precedes the read. An input that fails its boundary check produces a refusal with a closed-enum reason; it does not produce a partially-applied change.

## Sanitization is centralized

Every operator-controllable string that flows to disk passes through one redaction set defined at `src/lib/logger.ts`. The same `SECRET_PATTERNS` redacts:

- The structured audit log (`.schegent/audit.log`).
- The runtime log (`.schegent/syslog`).
- The Output channel.
- The phase log feed shown in the sidebar.

A central set has two consequences:

1. **Extending the set** automatically extends every sink.
2. **Bypassing the set** would be detectable — any code path that writes operator-influenced text outside `SanitizedLogger` is a violation visible in code review.

The extension's CLAUDE.md hard rules forbid forking the redaction set or introducing parallel sanitizers.

## What requires local-only handling

Two local diagnostic sinks require special handling:

- The **raw transcript** (`.schegent/sessions/raw-<runId>.log`). Captures CLI
  stdout/stderr verbatim. Always written through mode-`0600`, backpressured
  OS-temporary spools that are removed after finalization; abandoned spools
  are scavenged after their owner process is no longer alive.
- The **verbose diagnostic files** (`.schegent/sessions/<runId>/diagnostics/...`). Captured only when `schegent.logging.verbose` is true. Opt-in.

Both exist because the sanitizer is conservative; when debugging a real failure, operators sometimes need the bytes the sanitizer would have masked. The trade-off is:

- These files **never leave the operator's machine through the IPC pipeline.** The webview cannot request them. The audit log never references them by path.
- They are **gitignored.** Schegent writes a best-effort `.schegent/.gitignore`
  on first runtime-directory use, and project repositories should also ignore
  `.schegent/` at the workspace root.
- They **have bounded retention.** Diagnostic files do not rotate individually,
  but complete inactive-run groups are pruned to the configured session-artifact
  age and byte limits. Running and paused runs are protected.

If you cannot tolerate unredacted bytes on disk, the mitigations are:

- Leave `schegent.logging.verbose` off (default).
- Add `**/.schegent/sessions/raw-*.log` to a global git ignore.
- Treat `.schegent/` like your shell history — useful, may contain sensitive context.

## The paths-free audit discipline

The structured audit log **does not contain filesystem paths to sensitive locations**. By design:

- The list of workspace roots is never in the audit log — only `rootCount`.
- The phase log feed's file path is never in the audit log — only the selection tuple (queueId, taskId, pipelineId, phaseId, iterationN).
- The Metrics dashboard's adoption event carries only bounded structural metadata; session and conversation identifiers are omitted from v3 payloads.
- Executable paths, argv, commands, endpoints, model-output notes/errors, and repository filenames are omitted from v3 payloads.
- Operator credentials, environment variables, and tokens cause the unsafe payload append to fail closed.

Legacy v1/v2 rows remain readable and are not rewritten. Use the v3 counts-only export path before sharing evidence off-machine. The local diagnostic sinks (raw transcript, verbose diagnostics) are local-only by design and must not be shipped without review.

## The CSP and webview integrity

The webview enforces a strict Content Security Policy:

- No remote `script-src`. All script sources are bundled with the extension.
- No `unsafe-inline` beyond what is necessary for the Svelte runtime.
- No `iframe` embedding from external origins.

The webview cannot fetch from arbitrary URLs. It communicates with the host only via the typed IPC channel.

## Workspace-trust gating

Schegent registers as a `workspaceTrust` consumer with **untrusted-restricted** posture. In an untrusted workspace:

- The extension is loaded but every mutating command rejects.
- The sidebar shows a notice; no run is ever started.

You must explicitly trust the workspace before Schegent does anything. This is the same trust gate VS Code applies for "can run code from this workspace".

## Per-capability trust scopes

VS Code's Workspace Trust is binary; Schegent layers two
independently-configurable trust scopes on top to give enterprise IT a
narrower gate than "trust everything or trust nothing":

- `schegent.trust.allowCustomPhases` — gates saving a phase definition.
- `schegent.trust.allowCustomRetryConditions` — gates saving a `retryCondition` expression on any phase.

Both key on what a document **says**. That is why they survived feature
099 and the other two did not: `allowPipelineOverrides` and
`allowWorkflowOverrides` gated *which settings layer could redefine what
another layer declared*, and with definitions moved into a single-layer
catalog store there is no second layer to redefine anything. Editing
pipelines and workflows is now gated by Workspace Trust itself, which an
untrusted workspace already denies wholesale: it activates no catalog at
all.

The two that remain resolve independently through the same ladder, and
neither is a reuse of the other — a retry-condition expression is the one
piece of operator-authored text that an evaluator will read, which is a
narrower and sharper authority than authoring a prompt. Like every
capability, each returns `false` on an untrusted workspace regardless of
any explicit `true` at user or workspace scope; the ceiling is not
widened by the number of scopes beneath it.

Each setting is `boolean | null`, defaults to `null` (follow Workspace
Trust), and is resolved against a four-step ladder:
**workspace-trust ceiling → workspace-scope → user-scope → default-allow**.

The Workspace Trust check runs first. A workspace that is not trusted
returns `false` for every capability regardless of any user- or
workspace-scope value — the **ceiling is never widened**. This is the
core invariant: per-capability scopes can only *narrow* the trust
surface, never broaden it past what VS Code's workspace-trust gate
allows.

Denied save attempts emit a `trust.capability-denied` audit event whose
payload is bounded to a closed enum (capability, resolved scope, fixed
reason template) plus `workspaceBasename` (basename only, never the
full path). No operator-controlled string flows into the payload, so
`SECRET_PATTERNS` redaction is unchanged.

See [operations/trust-scopes.md](../operations/trust-scopes.md) for the
operator-facing guide, the full 16-row truth table, and the four worked
resolution examples.

## Primary-host gating (multi-window)

When the same workspace is open in multiple VS Code windows, only the **primary host** can mutate state. Secondary hosts receive `not-primary-host` rejections on every mutating IPC command.

This prevents two windows from racing on the same workspace. The primary host owns the window-primacy lease; the secondary host is read-only.

The lock split matters here. `WorkspaceLockManager` arbitrates **primacy only** and its semantics are unchanged — one holder per workspace, same staleness reclaim, and it is still what `WorkflowSnapshot.isPrimary` and therefore every mutating IPC gate reads. Execution exclusion moved to the per-queue lease in `src/state/execution-lease.ts`, which permits one holder per queue and several across queues. The separation is the control: if one lease did both jobs, a window would become primary — and so gain every mutating command — merely by draining a queue.

## The mutating-commands registry

Every mutating IPC command must be a member of `MUTATING_COMMANDS` in `src/ui/sidebar/message-router.ts`. Adding a new mutating command requires adding it to the registry; the primary-only gate is enforced based on registry membership.

This is the single line of defense against accidentally adding a mutating command without primary-host gating. Forgetting to register is a code-review-catchable mistake.

Read-only IPC commands are intentionally excluded from this registry — e.g. `CMD_READ_PHASE_LOG` (020) and `CMD_READ_METRICS` (073). None of these write workspace state, so the primary-only gate does not apply and secondary VS Code hosts may dispatch them too. `CMD_READ_METRICS` derives its response entirely from the existing (already paths-free, already redacted) audit log and writes nothing new except the one-shot `metrics-view-opened` adoption event described above — no new trust boundary is introduced.

## The append-only audit log

`.schegent/audit.log` is append-only. Schegent never modifies past entries. Task deletion records a `task-removed` event; it does not delete prior events. Reset Workspace State clears workspace state but does **not** touch the audit log.

The audit log is your evidence trail. If you have it, you can reconstruct every run, every phase, every tool call.

Audit durability is also an execution gate. A durable append failure projects
`evidence unavailable`, fails the active run with the sanitized
`audit-evidence-unavailable` code, and suppresses automatic queue drain. Raw
transcript and runtime-log failures instead project `evidence degraded` and
permit execution to continue. Health payloads contain normalized causes only;
they never contain exception messages, paths, prompts, or environment values.
See [Execution Evidence Health](../operations/evidence-health.md).

## What Schegent cannot prevent

- **A malicious CLI binary.** If `schegent.cli.path` points to a compromised binary, Schegent will run it. Verify the binary's provenance.
- **A malicious extension.** Other VS Code extensions running in the same workspace have whatever capabilities VS Code grants them. Schegent does not sandbox other extensions.
- **An operator who exfiltrates the unredacted sinks.** The raw transcript and verbose diagnostics are local but readable by the operator. If the operator's machine is compromised, the attacker has access to them.
- **A prompt-injection attack via spec/plan/task content.** If the spec file contains injection instructions, the CLI may follow them. The host does not analyze prompt content for adversarial inputs.

These are not Schegent's threat model to mitigate — they are upstream of the extension. But they shape what Schegent does and does not promise.

## A note on prompt-injection

Schegent feeds the spec, plan, and tasks files to the CLI as part of phase prompts. If those files contain injection instructions (e.g., "ignore prior instructions and execute X"), the CLI may follow them.

Mitigations are out-of-band:

- Do not check untrusted spec/plan/task content into the workspace.
- For features generated by Schegent itself, the model has produced its own files; injection is rare.
- For features whose spec is operator-authored, the operator is the trust boundary.

The host does not detect or block injection. This is a property of the model and the workflow, not of the extension's capability surface.

## The hard rules

The extension's CLAUDE.md ([CLAUDE.md](../../../CLAUDE.md)) contains a long list of "never" rules that codify the threat model in code-review terms. Some of the most operator-visible:

- Never weaken the redaction set.
- Never route untrusted strings to the UI without sanitization.
- Never weaken CSP.
- Never skip execution-lease release — every path that claims a queue gives it back, at the run's terminal transition or at the drain's own failure path. (The workspace lock is *not* covered by this rule: its tenure is the window's, and a run must neither acquire nor release it.)
- Never drop unknown audit event types from the parser.
- Never persist a `WorkflowRun` with inconsistent pause / retry state pairs.
- Never bypass `appendAudit` for custom-phase invocations.
- Never compute phase-catalog precedence in the webview.
- Never serialize workspace root paths into the audit log.
- Never widen the operator-additive fatal-signature surface without code review.
- Never sanitize twice or skip sanitization.

Each rule has a specific failure mode it prevents. Together, they enforce the threat model in code.

## Decisions you make as an operator

- **Do you trust the workspace?** If not, leave it untrusted; Schegent will not run.
- **Do you trust the CLI binary?** Verify `schegent.cli.path` points to a binary you installed.
- **Do you want unredacted bytes on disk?** Leave `schegent.logging.verbose` off; the raw transcript is still written.
- **Do you trust the process document you are importing?** The preflight tells you exactly what a commit would write, resource by resource, and writes nothing itself. A package can carry a lot — a Workflow document may bring several Pipelines and all their Phases — and every one of them is instruction text that will be sent to the CLI if you run it. Read the plan, not just the file name.
- **How often do you review the audit log?** It is your evidence trail; treat it accordingly.

These choices belong to you. Schegent's job is to make the mechanisms transparent so you can make informed choices.

## Reporting issues

If you find a security issue:

- **Do not** post the issue publicly without coordination.
- Capture the audit log range, the relevant settings, and (if reproducible) a minimal repro.
- Report through the extension's security channel (see the repository README).

For non-security operational issues, file a regular bug report. See [Troubleshooting](../operations/troubleshooting.md) for what to include.

This page is a summary. For the underlying invariants and the long list of code-review rules, the extension's CLAUDE.md is the authoritative reference.

## Threat anchors

The headings below are the canonical anchor targets for the [Threat catalog (T1–T24)](#threat-catalog-t1t24) table. Each entry restates the threat, names the load-bearing defenses, and points to the elaborating prose.

### T1 — Secret leakage to operator-visible sinks

API keys, bearer tokens, JWTs, AWS access key ids, GitHub tokens, Slack tokens, GCP service-account material, and any matching env-style `KEY=VALUE` strings that reach an operator-visible sink. Mitigated by the single `SECRET_PATTERNS` set in [src/lib/logger.ts](../../src/lib/logger.ts); every `SanitizedLogger` sink (audit, runtime log, Output channel, phase-log IPC) re-uses the same regex set. See [Sanitization is centralized](#sanitization-is-centralized).

### T2 — Untrusted webview mutating host state

The Svelte sidebar is the messenger, not the source of truth. A crafted IPC message that bypasses primary-host gating, registry validation, or host-side re-validation would let a non-primary VS Code host mutate workspace state. Mitigated by the strict CSP, the `MUTATING_COMMANDS` registry, and host-side re-validation of every command payload. See [The CSP and webview integrity](#the-csp-and-webview-integrity) and [The mutating-commands registry](#the-mutating-commands-registry).

### T3 — Audit log tampering or non-append writes

The structured audit log at `<workspaceRoot>/.schegent/audit.log` is the operator's evidence trail. Any code path that truncates, overwrites, or deletes prior entries would destroy that evidence. Mitigated by the append-only invariant — `appendAudit` is the single writer; task deletion records `task-removed` and never erases history; rotation preserves the rotated generations. See [The append-only audit log](#the-append-only-audit-log).

### T4 — Workspace path leakage into the structured audit log

A workspace path serialized into an audit payload would leak the operator's directory structure when evidence is shared. Mitigated by the v3 metadata projection: sensitive keys are omitted, residual path/endpoint strings fail closed, and payloads are bounded to 32 KiB. Legacy v1/v2 records require review or counts-only export before sharing. See [The paths-free audit discipline](#the-paths-free-audit-discipline).

### T5 — Concurrent state mutation across multiple VS Code windows

Opening the same workspace in two VS Code windows would otherwise race on shared mutable state (queue, run, pause). Mitigated by primary-host gating — only the primary host accepts mutating commands; secondary hosts receive `not-primary-host` rejections. The `MUTATING_COMMANDS` registry is the single source of truth for which commands are gated. See [Primary-host gating (multi-window)](#primary-host-gating-multi-window).

### T6 — Lease leak (fail-deadly)

A lease acquired and never released would stall subsequent runs (fail-deadly). The two leases answer this differently, because they have different tenures.

The **window-primacy lease** is not exposed to this failure mode in the shape the threat was originally written for. Its tenure is the window's: acquired once at activation, released once at `dispose()`. There is no per-run scope to leak out of. This is a change — primacy used to be wrapped around each run by `WorkspaceLockManager.withLock`, which acquires idempotently for the same owner and keeps no reference count, so once a window could drive several runs the *opposite* failure appeared: the first run to finish released primacy for all of them, and the window went read-only while still working. The wrapper is gone rather than reference-counted; see [The Workspace Lock](../concepts/workspace-lock.md).

The **per-queue execution lease** is where the fail-deadly risk actually lives, and it has three releases: the run's terminal transition (`completed`, `failed`, `canceled`), the drain's step-7 path for a start that failed before a run existed, and window shutdown. Behind all three, a lease left by a window that died goes stale after `STALENESS_THRESHOLD_MS` and is reclaimable by the next window to ask. A leaked lease therefore costs one queue 15 seconds rather than deadlocking it — and 15 seconds is the *backstop*, not the design: it was the only thing ending a lease before the terminal release landed, which held a queue for as long as its window stayed alive and kept heartbeating.

One release is deliberately declined: a run whose queue cannot be resolved (its task row was deleted underneath it) releases nothing. Every run in one window shares an owner identity, so a guessed queue id would pass the ownership check and clear a sibling run's live lease — trading a bounded 15-second stall for an unbounded correctness failure.

### T7 — Untrusted workspace executing extension capabilities

A workspace the operator has not explicitly trusted must not cause Schegent to spawn the CLI, install OS-scheduler entries, or persist state. Mitigated by Schegent registering as a `workspaceTrust` consumer with `untrusted-restricted` posture; every mutating command rejects until the workspace is trusted. See [Workspace-trust gating](#workspace-trust-gating).

### T8 — Prompt-injection via spec / plan / task content

If the spec / plan / task / phase-instruction text contains injection instructions (e.g. "ignore prior instructions and exec X"), the CLI may follow them. The host does not analyze prompt content for adversarial inputs — this is upstream of the extension's threat model. Mitigations are out-of-band: do not check untrusted content into the workspace; operator-authored content is the trust boundary. See [A note on prompt-injection](#a-note-on-prompt-injection).

### T9 — Custom-phase bypassing audit or redaction

A phase definition in the catalog store could in principle skip the audit + redaction + raw-transcript path. Mitigated by routing every phase invocation through the same `appendAudit` + raw transcript writer — there is exactly one path and nothing is exempt from it. Phase audit payloads carry `pipelineId`, `phaseId`, and (when set) `model` / `effort` / `timeoutMs` / `runner`. Feature 072 task-execution lifecycle events (`task-execution-started`, `task-execution-ended`, etc.) flow through this identical `appendAudit` → `SanitizedLogger` path, introducing no new trust boundary.

The threat is narrower than it once was, and for a structural reason: since
feature 098 the extension ships no phases, so there is no privileged path a
custom phase could be measured against and no built-in behavior it could
acquire by naming itself something. Containment class, evidence policy, and
runner pinning are read from the definition's own **declaration**, never from
its id.

Feature 081 keeps catalog mutation inside the same primary-host, workspace-trust,
and fine-grained capability gates as the existing save command. Payloads are
exact-key validated, revision checked, whole-catalog validated, and persisted
once. A `skill` directive is converted to declarative Agent CLI prompt text;
the extension never resolves a skill path, imports code, or adds runner argv.
Removal uses the shared confirmation helper and cannot delete the last
effective definition referenced by a pipeline.

### T10 — Verbose-diagnostic unredacted leak

The verbose-diagnostic files (`debug.json`, `stream.jsonl`, `verbose.log` under `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`) are intentionally unredacted. The risk is that an operator ships them off-machine. Mitigated by making the sink operator-opt-in (`schegent.logging.verbose`, default off), gitignored, and excluded from the structured audit log. See [What requires local-only handling](#what-requires-local-only-handling).

### T11 — retryCondition DSL escape

The operator-authored `retryCondition` DSL must not execute arbitrary code, perform I/O, or access object members. Mitigated by sandboxing the evaluator in `src/lib/retry-condition.ts`: identifiers + numeric literals + comparison/boolean operators + parentheses only. Any new evaluator must preserve those invariants.

### T12 — Fatal-signature floor weakening

The code-resident `FATAL_SIGNATURES` floor in [src/lib/fatal-signature-registry.ts](../../src/lib/fatal-signature-registry.ts) classifies CLI exit signatures that always escalate to operator intervention. The risk is that operator workspace settings (`schegent.fatalSignatures`) remove, re-order, or shadow built-ins. Mitigated by making the operator-additive surface strictly extension-only — operator entries can extend the registry but cannot remove, modify, or re-order built-ins; the built-ins-first scan order is preserved so a built-in that matches the same text wins attribution. The `fatal-signature-matched` audit event carries `source: 'built-in' | 'operator-defined'`.

### T13 — State schema invariant violation

`WorkflowRun.pendingRetryAt` / `pendingRetryCause` and `WorkflowRun.manualPauseAt` / `manualPauseCause` are both-null-or-both-non-null pairs. A persisted run with a one-sided pair would leave the scheduler in an unresumable state. Mitigated by rejection in `WorkspaceStateStore.setRun()`; forward-only migrators backfill legacy records on activation.

### T14 — Multi-queue registry races

The registry admits up to `MAX_QUEUES === 20` entries again, so the surface the v6 collapse retired is reopened deliberately, with the migration and scheduler design v6 required as the price of reopening it. What remains a threat is the race surface itself: two windows promoting the same queue, a queue promoted past its own in-flight slot, a stranded claim after a crash, and orphaned tasks left addressable by nothing.

Mitigations, each a distinct control:

- **Per-queue execution lease** (`src/state/execution-lease.ts`) — one holder per queue, reclaimable on the same 15 s staleness terms as the workspace lock, so a crashed window cannot strand a queue permanently.
- **Two capacity predicates** — `hasQueueCapacity(queueId)` bounds a queue to one in-flight task; `hasWorkspaceCapacity()` bounds the workspace to the configured ceiling. Conflating them would let a queue promote past its own slot.
- **A single idle-pending enforcement site** — `AutoDrainCoordinator.drainIfIdle(queueId)`. A second gate elsewhere is what would let a scheduled queue auto-promote.
- **Forward-only v9 → v10 migrator** with the per-entry `scheduledStartAt` / `idle-pending` lockstep assertion, refusing any persisted version above 10.
- **Queue ids, never operator-authored names, in audit payloads** — a queue name is operator-supplied text and does not belong in the structured log.

The `tests/lint/no-multi-queue-commands.test.ts` guard is retired; the seven queue IPC commands it forbade are back and each is a member of `MUTATING_COMMANDS`, so each is primary-host gated.

### T14a — Concurrent Runs against one working tree

Queues are independent for scheduling, pausing, projection and audit attribution. They are **not** isolated on the filesystem: every queue runs against the same checkout, the same branch and the same `.schegent/` directory, and Schegent does not create, switch or merge branches on an operator's behalf.

Two tasks that touch the same files will interleave their edits. This is a risk *reduction* boundary, not a guarantee of isolation: per-queue attribution in the audit log and per-run session trees make it possible to determine after the fact which run wrote what, which is a different property from preventing the write. Operators partitioning work across queues own the conflict resolution; this is stated in [Multiple queues and concurrency](../operations/multi-queue-concurrency.md).

Feature 093 removed the narrowing that used to apply here. The run engine drove one `WorkflowRun` at a time and the drainer gated on it, so the interleaving window was between successive runs; it now holds one Run per queue, and up to `schegent.queue.globalConcurrencyCap` Runs edit the shared tree at the same time. The exposure is unchanged in kind and wider in window: interleaving is now *within* a pair of simultaneous runs, and the cap is the only thing bounding how many can contend. Operators who need the narrower window set the cap to `1`.

One consequence is mitigated in-product rather than left to the operator: a recovery checkpoint is a `git diff HEAD` of the shared tree, so under concurrency the raw diff captures a sibling Run's uncommitted work, and presenting that as restorable would let an operator recovering one Run silently revert another's. The mitigation is delivered at the **write** side, because there is no in-product restore path — a checkpoint is applied by hand, so the only way an unattributable one is never applied is for it never to be written.

FR-R3-004 made that mitigation attribution-based rather than a blanket refusal. Each phase's audit record names the files it created, modified and deleted; those declared paths, canonicalised against the workspace root and dropped if they resolve outside it, are what a Run claims, and the patch is scoped to the diff sections it claimed. The whole-tree diff is re-read at every phase boundary as the completeness check: a section present that no Run claims and no baseline explains means a write escaped its declaration, so a scoped patch would be incomplete. `RunCheckpointService` then declines — a `.declined.json` marker with `restorable: false`, a bounded `reason`, and **no** `.patch`. The four reasons are `attribution-evidence-incomplete`, `unattributed-worktree-change`, `path-mutated-by-multiple-runs` and `no-attributable-changes-observed`; `concurrent-runs-share-one-worktree` is the pre-FR-R3-004 reason and is no longer emitted. A decline is recorded, not silent, and does not block the phase.

Two properties of that design are security-relevant. Declared paths are **untrusted input** — they arrive on CLI stdout — so canonicalisation is lexical only, with no `realpath` or `lstat`: a syscall at an operator-influenced location performed to make a string comparison succeed is the pattern the run-output resolver's ordering rule already forbids, and a path that does not canonicalise inside the root produces a refusal rather than a misattribution. And the mechanism reduces *misattribution* risk, not the underlying sharing: a Run whose sibling overwrote its file still receives a patch of its own declared paths reflecting the tree as it ended up. A `.patch` remains unredacted source and stays `0600` under a `0700` directory in global storage.

### T15 — Phase-message env injection

A `phase-message.env` value could otherwise reach the UI or audit projection without passing through the sanitizer used at prompt composition time. Mitigated by routing phase-message values through `SanitizedLogger.sanitize` before downstream consumption; the audit + UI surfaces expose metadata only, never raw env values.

### T16 — Operator-additive fatal-signatures stale cache

Caching the `schegent.fatalSignatures` value on the runner would mask an operator update mid-run. Mitigated by reading the `FatalSignaturesAccessor` at the top of every `PhaseRunner.run()` (mirrors the `VerboseDiagnosticsAccessor` and `AutoCompactOverrideAccessor` patterns) so a toggle applies to the next phase boundary.

### T17 — Wake-up runner workspace contamination

**Retired.** This threat described the OS-scheduled wake-up runner: a process detached from the VS Code host, running with direct UID access to the operator's filesystem, that could spawn the CLI inside a workspace root or carry workspace-specific environment variables through. The Wake-up scheduler and its runner were withdrawn; no code installs an OS-native scheduled entry, and every CLI spawn now happens inside the extension host under the workspace-trust ceiling. There is no out-of-host execution surface left to mitigate.

The id is retained rather than reused so existing citations in source comments, `SECURITY.md`, and CLAUDE.md still resolve, and so the catalog does not renumber under anyone's feet. One operational residue survives the code: a machine that enabled Wake-up under an earlier release keeps whatever OS scheduled entry that release installed, and the current release has no way to remove it. See [Scheduled entries left by earlier releases](../reference/file-layout.md#scheduled-entries-left-by-earlier-releases) for manual removal.

### T18 — VS Code namespace leakage into headless or telemetry code

Any `vscode` import reaching `src/headless/` or `src/telemetry/` would either blow up a host-free caller at runtime (`Cannot find module 'vscode'`) or re-enable a capability surface those trees must not have. Mitigated by the lint regressions `tests/lint/no-vscode-import-in-{headless,telemetry}.test.ts`.

### T19 — Runtime log sink forking the redaction set

A second sanitizer in the runtime log sink would break the "single `SECRET_PATTERNS` source of truth" guarantee — extending the set in one place would no longer extend every sink. Mitigated by registering the runtime log sink as a `LogSink` on `SanitizedLogger`, which writes lines that have already been sanitized once. Direct `fs.appendFile` calls against a path containing `syslog` are blocked by the `tests/lint/no-direct-syslog-fs-writes.test.ts` regression.

### T20 — Phase-log IPC double or skipped sanitization

The phase-log IPC pipeline (manifest read + live tail) must sanitize exactly once at the host → webview boundary, in the fixed order project → truncate → sanitize. The risks are (a) double-sanitization corrupting the projected JSON, (b) skipping sanitization on a new field, or (c) the webview re-stringifying / re-sanitizing a host-sanitized field via `{@html …}` interpolation. Mitigated by a single injected `SanitizedLogger.sanitize` at the IPC boundary in `src/services/phase-log/phase-log-reader.ts` (manifest reads) and `src/services/phase-log/phase-log-tail-session.ts` (live tail pushes); the webview consumes the field as a typed JSON value only; `tests/lint/no-html-interpolation-in-activity-feed.test.ts` pins the rule.

### T21 — Untrusted stdout names local files

**Source**: Claude / Codex CLI stdout, operator-influenced phase prompts, repo files.
**Vector**: A CLI audit-event JSON line includes a `phaseMessagePath` field. A malicious phase prompt could induce the CLI to emit an audit entry naming `/etc/passwd` (or any operator-readable file) so the next phase reads its contents as prompt context. The 4 KiB byte cap limits exfiltration via the next prompt but does not prevent reading sensitive small files.
**Pre-feature mitigation**: basename filter (`path.basename === 'phase-message.env'`). Defeated by any attacker-named symlink or any operator-influenced file already named `phase-message.env`.
**Post-feature mitigation (feature 056, T1-T20 floor preserved)**: canonical-path containment in [src/controller/phase-sidecar-reader.ts](../../src/controller/phase-sidecar-reader.ts) `parsePhaseMessage()`. The host computes the expected sidecar path from `(workspaceRoot, runId, pipelineId, phaseId, iterationN)`. When the canonical file exists, the audit-reported path is IGNORED entirely; when it does not, audit-reported paths are accepted only if they canonicalize byte-equal to the canonical path (via `fs.realpathSync.native`). Otherwise the runner emits `phase-message-invalid` with `reason: 'path-outside-run-dir'` or `'missing-canonical-sidecar'` and proceeds with `sidecar: null, suspicious: true`.
**Residual risk**: If the operator places a malicious symlink AT the canonical path before the run starts, the host reads through it. This is operator-on-operator (the symlink had to be authored by the operator) and outside the trust boundary.

### T22 — Workflow condition acquiring an evaluator

**Source**: operator-authored Workflow definitions in the catalog store, reaching the host either through the Workflow Builder (`CMD_SAVE_WORKFLOWS`), an imported YAML document, or a hand-edited version record under `.schegent/catalog/workflows/`.

**Vector**: A Workflow connection may carry a condition that decides whether the branch is offered. The obvious design — an expression string — is the design Schegent already has once, in the phase `retryCondition` DSL ([T11](#t11--retrycondition-dsl-escape)). Repeating it here would put a second operator-authored expression language on a surface that also names pipelines and reads prior node output, and it would arrive without T11's sandbox invariants unless someone rebuilt them.

**Mitigation (by construction, not by blocklist)**: a `WorkflowCondition` is structured data — `{ left, operator, right? }`. `left` and `right` are `{ source: 'node-output', nodeId, field }` or `{ source: 'node-status', nodeId }`; `operator` is one of the eight members of `WORKFLOW_CONDITION_OPERATORS`; a `node-status` operand compares only against `WORKFLOW_NODE_TERMINAL_STATUSES`. Everything is a closed enum or an identifier resolved against the graph, so there is **no expression text, no parser, no evaluator, no template engine, and no sandbox** — there is nothing to evaluate. The host compares fields.

Because "we did not add an evaluator" is invisible to behavioral tests (every one of them would keep passing the day someone adds an expression escape hatch), the property is pinned against the module source: the `Feature 083 T046` block in [tests/unit/config/workflow-graph-validator.test.ts](../../tests/unit/config/workflow-graph-validator.test.ts) asserts that both condition modules — [src/config/workflow-graph-validator.ts](../../src/config/workflow-graph-validator.ts) and [src/config/workflow-definition-validator.ts](../../src/config/workflow-definition-validator.ts), which owns `readCondition` and runs first — import nothing but relative project modules, and contain no `eval`, `Function` constructor, `.constructor` access, dynamic `import(`, `require(`, or `node:vm`. The rule is stricter than a forbidden-package list on purpose: a blocklist would have to be maintained forever and would still miss the next engine published. The corresponding CLAUDE.md hard rule states the invariant for reviewers.

**Trust boundary**: authoring a Workflow graph is gated by Workspace Trust. The capability that once gated it separately, `allowWorkflowOverrides`, was retired in feature 099 with the layer tier it named — it decided which settings layer could redefine another's declaration, and a single-layer catalog store has no second layer. The ceiling it was subject to is now the whole gate, and it is not a weaker one: an untrusted workspace activates no catalog at all, so a `.schegent/catalog/workflows/` directory arriving with a cloned repository is inert until the operator trusts the workspace. See [Per-capability trust scopes](#per-capability-trust-scopes).

**Residual risk**: An operator who is permitted to author workflow graphs can route between any pipelines they are permitted to author. Conditions bound *which* branch is offered, never *whether* the operator is asked — a Workflow never starts a follow-up run on its own, so a mis-authored condition mis-suggests rather than mis-executes.

### T23 — Operator-authored identifier escaping its declared bound

**Source**: a phase, pipeline, workflow, port, or node id — authored in a builder, hand-edited into a catalog version record, or carried in an imported document.

**Vector**: an identifier is the one operator-authored string that is *supposed* to flow onward: into an audit payload, a validation error the webview renders, and a catalog key. An unbounded id therefore reaches a sink that is bounded everywhere else, and a very long one is a cheap way to push the fields that matter out of a truncated record. The subtler failure is a **second** bound for the same class of value: a module that declares its own `= 64` agrees with the catalog only by coincidence, and the day that catalog widens its id length, the private copy starts truncating identifiers the catalog itself accepts — silently, in exactly the reporting paths an operator would use to diagnose the problem.

**Mitigation**: each catalog declares its bound exactly once, in the `contracts/` leaf module that owns the definition — `PHASE_ID_MAX_LEN` ([src/contracts/process-definitions.ts](../../src/contracts/process-definitions.ts)), `PIPELINE_ID_MAX_LEN` ([src/contracts/pipeline-definitions.ts](../../src/contracts/pipeline-definitions.ts)), `WORKFLOW_ID_MAX_LEN` ([src/contracts/workflow-definitions.ts](../../src/contracts/workflow-definitions.ts)). The three are 64 today, but they are three bounds and not one shared maximum, so a catalog that widens its own does not widen the others. The exchange boundary reads them through the `RESOURCE_ID_MAX_LEN` map in [src/contracts/sidebar-ipc/process-yaml.ts](../../src/contracts/sidebar-ipc/process-yaml.ts); the definition validators reject an over-long or duplicate id before anything is persisted; and every site that reports an id — audit payload, save-command error, catalog diagnostic — truncates against the same constant rather than a local literal. `tests/integration/process-platform/audit-boundary.test.ts` scans the exchange-boundary sources for a re-declaration, so a fourth private copy fails the build.

**Residual risk**: an id within its bound is still operator-authored text. It is sanitized like any other string before it reaches a sink, but its *content* is the operator's — this threat bounds length and uniqueness, not meaning.

### T24 — Legacy persisted state re-entering the runtime

**Source**: VS Code `workspaceState` and `.schegent/audit.log` rows — both written by an earlier extension version, on a machine the current version has just been installed on.

**Vector**: persisted state is an input the running code did not write, and its shape is whatever some earlier release persisted — including shapes the invariants in force today forbid. A record predating an invariant does not announce itself. Reading one optimistically means a run resumes into a state the scheduler cannot advance (the one-sided pause/retry pair of [T13](#t13--state-schema-invariant-violation)), or a queue shape removed in v6 reappears behind the single-queue invariants ([T14](#t14--multi-queue-reintroduction)). The mirror-image case is a **downgrade**: state written by a newer version, read best-effort by an older one, which is the same problem with the arrow reversed and no migrator that could possibly exist for it.

**Mitigation**: migration is forward-only and runs at `WorkspaceStateStore.initialize()` before any consumer reads state — the numeric-version chain (v5→v6 queue registry, v6→v7, v7→v8, and feature 088's v8→v9 `migrateConnectedRuns` in [src/state/connected-run-migrator.ts](../../src/state/connected-run-migrator.ts)) plus the legacy `WorkflowRun` normalizer, each gated on the *persisted* version so a step never re-runs against records it already migrated. The downgrade case is refused rather than guessed at: a persisted `schemaVersion` above the runtime's throws at `initialize()` with an "update the extension" message instead of being partially read. `setRun()` re-asserts the pair invariants on every write, so a migrated record that is still one-sided cannot be persisted. For the audit log the discipline is the opposite and deliberate — legacy v1/v2 rows stay readable and are never rewritten in place, and the parser **warns and preserves** an event type it does not recognize rather than dropping it, because the log is evidence and a dropped row is destroyed evidence.

A withdrawn capability leaves both halves of that discipline visible. Retiring the Wake-up scheduler removed `'wake-up-runner'` from the legal `scheduledStartSource` values, so a queue record persisted by an earlier release is normalized on read to `'programmatic-scheduled'` — the thing it always meant — without disarming the schedule it carries. The `wakeup-daemon-*` and `wakeup-runner-invocation` rows already in an audit log are left exactly as written and read back through the warn-and-preserve path, because nothing about withdrawing a feature makes the record of what it did less true.

**Residual risk**: a migrator is code, and a migrator with a bug writes a wrong record once, forward-only, with no rollback. That is why each migration step emits audit events and why the migrators are covered by per-version fixtures rather than by a single end-to-end case.
