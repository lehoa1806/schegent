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
| [T3](#t3--audit-log-tampering-or-non-append-writes) | Audit evidence is truncated or rewritten | **Mitigated: tamper-evident, chain-verifiable.** Every entry carries the previous entry's digest (`node:crypto`, sha256); `npm run audit:verify` and `Schegent: Verify Audit Chain` name the first break; a retention prune records a cut point. Deletion and truncation remain **detectable, not preventable**. | <!-- Source: src/audit/audit-chain.ts --><!-- Source: src/audit/audit-log-writer.ts --> |
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

- Claude and Agy run with approval prompts disabled, so they can act without asking under the operator's local permissions. `schegent.backend.runner` **defaults to `claude`**, so this is the default path, not an opt-in one — and as of FR-R3-056 **it is refused by default**: an uncontained backend does not run until it is named in `schegent.backend.uncontainedBackends`, and the refusal is enforced where the backend would be constructed rather than disclosed in prose. As of FR-R3-125 the grant is **per backend**, so allowing Agy does not allow Claude. What containment is actually available per backend and platform is qualified in [Backend containment qualification](../architecture/backend-containment-qualification.md); when naming a backend there is and is not acceptable is owned by [Running Schegent on a repository you do not trust](../operations/untrusted-repositories.md), which this document does not paraphrase. Disclosure alone changed informed consent, not reachability; this changes reachability. The decision, the shapes not chosen, and what remains outstanding are in [Agent capability posture](../architecture/agent-capability-posture.md). Codex's `workspace-write` sandbox is the only adapter-level filesystem bound documented by its argv. None of these facts make generated actions correct. <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/runner/codex-cli.ts --><!-- Source: src/runner/agy-cli.ts -->
<!-- executable-example: phase-verdict-basis -->

```
| declared   | sideEffects  | producesOutput | resolves to |
|------------|--------------|----------------|-------------|
| (omitted)  | (omitted)    | no             | exit-code   |
| (omitted)  | workspace    | no             | exit-code   |
| (omitted)  | git          | no             | exit-code   |
| (omitted)  | unrestricted | no             | exit-code   |
| (omitted)  | none         | no             | model-token |
| (omitted)  | none         | yes            | exit-code   |
| model-token| workspace    | no             | model-token |
| exit-code  | none         | no             | exit-code   |
```

The rows above are read by `tests/lint/documented-defaults-are-executable.test.ts` and fed through
`resolveHostVerification` in `src/config/phase-runner-policy.ts`. If this table and that function
disagree, the gate fails and names both sides. It is here, in the document a security reviewer opens
first, because the two sentences below it stated the **inverse** of the shipped default from
`FR-R3-117` until 2026-08-27 while every documentation gate passed — `FR-R3-126`.

- Prompt injection in repository files, task text, imported instructions, or prior output is not classified by the host. <!-- Source: src/runner/prompt-builder.ts -->
- A Phase outcome is judged on **the process's exit status** whenever the Phase's claim is load-bearing, and `hostVerification: 'model-token'` is the explicit **opt-out** (FR-R3-058 built the mechanism opt-in; **FR-R3-117 inverted the default**, and this paragraph stated the inverse of what shipped until FR-R3-126 corrected it). Load-bearing means anything other than a resolved `sideEffects: 'none'`, or a Phase that produces a declared output — and because omitted `sideEffects` resolves to `'workspace'`, a Phase that declares nothing is exit-code-judged. A clean termination token cannot override a non-zero exit or a timeout, so for a Phase that runs tests or claims a side effect the agent whose work is judged is no longer the author of the evidence that advances it. **Self-certification is what remains for the advisory case**: a Phase resolving to `sideEffects: 'none'` with no declared output, or one that opts out with `model-token`, is classified from the model's own account of its work — a timed-out process whose output parsed clean is treated as success, and a non-zero exit alongside a clean token is logged and advanced. Definitions written before v14 keep their semantics: the resolved verdict basis and its provenance are stamped into each Phase at snapshot time rather than re-derived later. The bounded control sentinel prevents arbitrary content from becoming process control, but a well-formed model report can still be false. `resolveRunOutputs` checks whether a declared output exists; it does not prove correctness. Authors should mark verification Phases `exit-code` and, as before, write an independent verification Phase as described in [Custom Phases](../features/custom-phases.md). <!-- Source: src/parser/stdout-parser.ts --><!-- Source: src/services/run-driver.ts --><!-- Source: tests/lint/no-content-driven-process-control.test.ts -->
- Concurrent Runs share one checkout and can interleave edits. Lowering `schegent.queue.globalConcurrencyCap` to `1` narrows simultaneous execution but is not rollback or file locking. <!-- Source: src/services/auto-drain-coordinator.ts --><!-- Source: package.json -->
- Local raw transcripts are intentionally unredacted, and Claude verbose diagnostics are unredacted when enabled. Recovery checkpoints can contain an unredacted binary Git diff. These artifacts must remain local and unshared. <!-- Source: src/audit/raw-transcript-writer.ts --><!-- Source: src/audit/verbose-diagnostic-writer.ts --><!-- Source: src/services/run-checkpoint-service.ts -->
- The sanitized CLI transport log can still contain local paths, and a saved full Task description can retain sensitive operator text that does not match the sanitizer's secret patterns. <!-- Source: src/monitor/cli-transport-sink.ts --><!-- Source: src/services/history/history-description-store.ts --><!-- Source: src/lib/logger.ts -->
- Workspace-local audit evidence can be **deleted or truncated** by an operator or backend process, and Schegent cannot prevent that. Since FR-R3-112 it is **detectable**: every entry carries the previous entry's digest, so `npm run audit:verify` names the first break. Tampering is evident, not impossible — the chain head sits on the same disk as the log, so an actor who can edit the file can recompute every later digest; what they cannot do is edit one entry and leave the rest consistent. <!-- Source: src/audit/audit-log-writer.ts --><!-- Source: src/audit/audit-chain.ts -->
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
- **Withholding `network` does not withhold network access.** Stated plainly because the capability's
  name implies otherwise. `network` maps to `--disallowedTools WebFetch,WebSearch` — it withholds a
  **vocabulary**, not an ability. A phase that withholds `network` while granting `process-spawn` keeps
  `Bash`, and `Bash` reaches the network: `curl`, `wget`, a script, a package manager. So the honest
  reading of that combination is *"the model cannot use the fetch tools"*, not *"the phase cannot reach
  the network"*. **`Bash` ⊃ `network`.** Withholding both is what actually removes network reach on this
  backend, and the destination that would close the gap properly is a mediated broker or a CLI-side
  network sandbox — neither of which exists here.
- **The ambient CLI configuration can widen a narrowed set without any flag being dishonoured.** The
  trust anchor above says the backend honours its own flags. It does — and it also honours its own
  configuration file, which the host neither pins nor controls. A narrowed argv defers to whatever
  `~/.claude/settings.json` (or the codex equivalent) says, so an operator-local file can loosen a bound
  the plan applied, with every flag respected. As of `FR-R3-105` this is **observed rather than
  pinned**: `capability-applied` carries a digest of the relevant keys and the names of the keys read,
  so evidence can answer *was the ambient configuration the same on these two Runs* — never the path
  (workspace paths may not enter the structured log, and a home path additionally carries the
  operator's username) and never the values (a settings file can hold an API key). Pinning with
  `--settings` is the stronger answer and is the recorded destination; taking it needs the flag's
  stability established against a live CLI, which costs operator quota and has not been spent.
- **An authored field can no longer inject a flag.** `phaseDef.model` reaches the child as its own argv
  token at all three backends and was validated as a non-empty string only, so an imported pipeline
  document supplying `model: "--dangerously-skip-permissions"` put that flag into argv — granting
  exactly the authority this mechanism exists to narrow, through a field the narrowing never saw.
  Spawns are `shell: false` throughout, so this was flag injection rather than shell injection.
  `FR-R3-105` bounds every authored field that reaches argv by charset and length and refuses a leading
  dash, at the validator **and again at dispatch** for plans frozen before the rule existed. The value
  is refused, never rewritten. `tests/lint/argv-field-partition.test.ts` fails if a future authored
  field reaches argv unclassified. <!-- Source: src/contracts/argv-value.ts -->
- **Each enforcement flag is emitted exactly once.** The plan used to de-duplicate by joined token, so
  Claude's three `--disallowedTools` rows emitted the flag two or three times on a narrowed set. If the
  CLI's parser is last-wins, that **silently re-granted `Bash` on the most restrictive set anyone can
  request** — the stricter the ask, the more likely it was defeated. Values are now merged into one
  flag, which is the CLI's own comma-list form. What this cannot establish without a live turn is which
  merge semantics the real parser uses; what it establishes is that the host no longer depends on the
  answer. <!-- Source: src/services/capability-enforcement-plan.ts -->
- **This is not a mediated broker.** The broker — where the host would see each call rather than
  delegating — is recorded as the destination in
  [Agent capability posture](../architecture/agent-capability-posture.md), with the review's own 1–3
  month estimate and the expansion-freeze constraint that blocks its most plausible route.

A refusal is a Run-level outcome with a named cause and a declared `capability-refused` audit event,
distinguishable from a phase failure. A set the backend *can* enforce is recorded too, as
`capability-applied`: the bound itself lives in argv and argv is never written to the structured log, so
without that event a completed Run could not tell an operator whether its phase ran bounded. Both
payloads carry closed-union members, a phase index, and — since `FR-R3-105` — the ambient-configuration
observation described above, which is a digest and a list of key names rather than any content. Nothing
else. <!-- Source: src/services/capability-enforcement-plan.ts --><!-- Source: src/contracts/phase-capabilities.ts -->

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

**Status: mitigated — tamper-evident, chain-verifiable. Deletion and truncation remain detectable, not preventable.**

The host's audit writer appends JSONL records and owns rotation; Task deletion records an event rather than asking that writer to erase earlier entries. Until FR-R3-112 that was a write discipline and nothing more: an operator or backend process with workspace access could modify or delete the file, and there was no chain, signature or post-write detection. Every record this product added was therefore operational telemetry rather than evidence — against the one actor the log describes, since the CLI runs with the OS user's authority and `.schegent/audit.log` is an ordinary 0600 file inside the workspace.

Each entry now carries `prevDigest` — the sha256 of the previous entry's on-disk bytes — and `digestAlg`. The digest is computed over the **sanitized** line that actually reaches disk, and the link is complete before any byte is written, so a hashing failure is an append failure handled by the existing evidence-health machinery rather than a silently unchained line. `npm run audit:verify` and the `Schegent: Verify Audit Chain` command walk the chain across rotated files and report the **first** break; a break also reports the audit sink as failing on the evidence-health surface. A retention prune writes a cut record naming the removed range's boundary digests to `.schegent/audit.log.cuts`, so the legitimate operation that most resembles tampering is distinguishable from tampering — without it, every routine prune would report a break and the verifier would be switched off within a week.

**What this does not establish, stated plainly.** The chain head lives on the same disk as the log. An attacker who can edit the log can recompute every later digest, and can delete the cut file or forge a cut record. What they cannot do is edit or remove one entry and leave the rest consistent. Anchoring the head somewhere the workspace cannot reach — a signature, an external append-only sink, or a periodic digest published elsewhere — is the step that would make tampering *hard* rather than *evident*, and it is not taken here. Entries written before FR-R3-112 carry no link; they are excused only as a leading prefix, counted, and reported by the verifier, so an operator reading "ok" learns how much of their history the chain actually covers.

The live-file append is opened through the canonical-path walk (`openWithinRoot`, FR-R3-053), so a planted `.schegent` or audit-log symlink is refused rather than followed; the rotation and prune paths resolve both ends the same way.

<!-- Source: src/audit/audit-chain.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: scripts/verify-audit-chain.ts -->
<!-- Source: src/commands/verify-audit-chain.ts -->

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

**The intent is now declared, not inferred** (`FR-R3-126`). `package.json` carries
`capabilities.untrustedWorkspaces` with `supported: "limited"`. Until 2026-08-27 the manifest carried
no `capabilities` key at all, so VS Code applied its conservative default: the behaviour was safe and
the *intent* was left to a reader's inference, which is not the same thing in a document reviewers
read to decide what this extension does.

**Why `limited` and not `false`.** `false` would claim the extension does not run in an untrusted
window. It does: it activates, and it serves the read-only view above — state, history, audit and logs
are visible, which is deliberate and useful. Declaring `false` would be a false claim about our own
behaviour, in the manifest, which is the class of defect this item exists to close. `limited` states
what is true: it runs, and the mutating set is refused while the workspace is untrusted.

Adding a capability block is exactly the kind of edit that quietly enables something, so the check is
the VS Code 1.107 Electron integration suite rather than this paragraph — 13 modules across two
launches, green with the block present.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/extension.ts -->
<!-- Source: package.json -->

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

This does not make the model's evidence truthful. It separates a bounded control sentinel from the Phase's self-reported outcome — and for a **load-bearing** Phase the self-reported outcome does not decide at all: **the host's own exit status does, by default, and the model's token cannot override it** (FR-R3-058 shipped the mechanism opt-in; FR-R3-117 made it the default; `hostVerification: 'model-token'` is the opt-out). The limit documented above therefore applies to the advisory case — a Phase resolving to `sideEffects: 'none'` with no declared output, or one that has opted out. FR-R3-023 verified evidence *shape* and FR-R3-038 *disclosed* the self-certification; the resolved default is where it is now *enforced*.

<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: tests/lint/no-content-driven-process-control.test.ts -->

### T26 — A process nobody owns keeps writing the working tree

**Mitigated in two of three places, and the third is a stated limit.** The ownership fence is
this project's strongest mechanism and it protects exactly one thing: Memento writes. The two
ways a Run's *working tree* gets mutated by a process nobody owns were both open until
`FR-R3-103`.

**A dead extension host orphaned the CLI tree.** Children are spawned detached — deliberately,
so the terminate ladder reaches descendants — and no process identity was ever persisted. Pids
existed only in memory, in audit payloads and in temp-file names. So activation resumed every
persisted in-flight Run with no way to ask whether the previous host's tree was still alive,
and the resumed phase raced the orphan in one shared checkout. Now each invocation's identity
(pid, process-group id, start timestamp) is persisted beside its Run record under the fence and
cleared when the child is reaped; activation checks it and **declines** to resume into a live
tree, telling the operator the Run is executing elsewhere. It does not kill and does not
reattach: both are destructive in a way declining is not, and `FR-R3-103` §3.2 calls that
choice a decision to record rather than to default.

**A superseded window's live child kept writing.** Losing the fence stopped the *state store*
from committing and did nothing about the child — no path from fence loss reached an
`AbortController` or a process tree. So a superseded window's subprocess went on mutating the
shared checkout while its state writes were refused: fencing protected state, not the tree.
The heartbeat's rejected-beat path now notifies a listener the driver registers, which runs the
same abort → SIGTERM → SIGKILL group ladder an operator cancel uses. It acts on the
**invocation** and never on the window-primacy lease, which `AGENTS.md` states as a hard rule
with FR-028's history behind it.

**What remains, stated rather than implied:**

- **A window between SIGKILL and filesystem quiescence.** Signalling a group is not the same as
  the group having stopped writing. A write already in flight lands.
- **The worktree is still shared.** Per-run isolation (`R-16` / `REL-08`) stays deferred by
  recorded decision; this makes concurrent entry *detectable and refused at the seam*, not
  impossible.
- **The liveness check answers `unanswerable` on Windows and resumes anyway.** `detached` is
  false there, so the recorded group is not probeable, and the job-object gap is a stated
  permanent limit (`FR-R3-083`). Refusing every resume where the check cannot run would strand
  Runs exactly where the mechanism is weakest, so the decision is to resume and record the
  verdict — an operator can see `unanswerable` in the audit trail rather than inferring it from
  a resume that looks ordinary. This claims no more than POSIX evidence supports, which is the
  same discipline `FR-R3-054` applies.
- **A recycled pid is refused, not tolerated.** Liveness is decided by the identity triple, so
  a pid the OS has handed to an unrelated process reads as `dead` rather than as a live orphan.
  A bare `kill(pid, 0)` would have produced a false refusal that never clears.
- **Retried phases still have no side-effect idempotency**, and there is still no in-product
  checkpoint restore. Both are recorded in the reliability register and neither is touched here.

<!-- Source: src/contracts/spawn-identity.ts -->
<!-- Source: src/services/process-liveness.ts -->
<!-- Source: src/services/resume-decision.ts -->
<!-- Source: src/state/spawn-identity-recorder.ts -->
