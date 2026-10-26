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

- Prompt injection in repository files, task text, imported instructions, or prior output is not classified by the host. Where each surface reaches the model, what bounds it, and what the live canary has and has not seen are in [Prompt-injection surfaces](#prompt-injection-surfaces). <!-- Source: src/runner/prompt-builder.ts -->
- A Phase outcome is judged on **the process's exit status** whenever the Phase's claim is load-bearing, and `hostVerification: 'model-token'` is the explicit **opt-out** (FR-R3-058 built the mechanism opt-in; **FR-R3-117 inverted the default**, and this paragraph stated the inverse of what shipped until FR-R3-126 corrected it). Load-bearing means anything other than a resolved `sideEffects: 'none'`, or a Phase that produces a declared output — and because omitted `sideEffects` resolves to `'workspace'`, a Phase that declares nothing is exit-code-judged. A clean termination token cannot override a non-zero exit the backend itself reported, a timeout or the absolute deadline — **and that is a veto, not a second witness.** The status is the backend CLI's own, and on a turn that exits 0 inside its deadlines the model's token decides under either basis: for a Phase that runs tests or claims a side effect, the agent whose work is judged can no longer advance it past a failed process, and is still the author of the evidence that advances it past a clean one. Until `FR-R3-182` (2026-10-02) this sentence said the agent was therefore *no longer the author of the evidence that advances it*; the veto does not reach that far. **Self-certification without even the veto is what remains for the advisory case**: a Phase resolving to `sideEffects: 'none'` with no declared output, or one that opts out with `model-token`, is classified from the model's own account of its work — a timed-out process whose output parsed clean is treated as success, and a non-zero exit alongside a clean token is logged and advanced. Definitions written before v14 keep their semantics: the resolved verdict basis and its provenance are stamped into each Phase at snapshot time rather than re-derived later. The bounded control sentinel prevents arbitrary content from becoming process control, but a well-formed model report can still be false. `resolveRunOutputs` checks whether a declared output exists; it does not prove correctness. Authors should mark verification Phases `exit-code` and, as before, write an independent verification Phase as described in [Custom Phases](../features/custom-phases.md). <!-- Source: src/parser/stdout-parser.ts --><!-- Source: src/services/run-driver.ts --><!-- Source: tests/lint/no-content-driven-process-control.test.ts --><!-- Source: src/controller/phase-runner.ts --><!-- Source: src/controller/phase-outcome-mapper.ts -->
- Concurrent Runs share one checkout and can interleave edits. Lowering the workspace-wide concurrency cap to `1` narrows simultaneous execution but is not rollback or file locking. Lower it in the **Queue configuration** surface, which saves through `CMD_SAVE_QUEUE_SETTINGS`: that value is workspace state, and it is the one both of the drain's capacity predicates read. **Naming that surface is a correction to this line, not a change to any control** (`FR-R3-145`). Until 2026-08-30 this bullet pointed an operator at a `settings.json` key of the same name; no scheduling path ever read that key, so following the instruction narrowed nothing. That was a defect in this document and **not** a containment hole. The store the drain has always read defaults to `1`, so a workspace whose stored cap was never raised ran one Run at a time before the correction and runs one Run at a time after it: the fail-safe direction held throughout, and no cap an operator set through the queue surface was ever ignored. Admission behaviour is unchanged — what changed is where this page sends you to set the number. <!-- Source: src/services/auto-drain-coordinator.ts --><!-- Source: src/queue/queue-manager.ts --><!-- Source: src/state/workspace-state.ts -->
- Local raw transcripts are intentionally unredacted, and Claude verbose diagnostics are unredacted when enabled. Recovery checkpoints can contain an unredacted binary Git diff. These artifacts must remain local and unshared. **Which of them are kept, and for how long, is a choice with a name** (`FR-R3-127`): the three privacy profiles in [the settings reference](../reference/settings.md) — `ephemeral`, `diagnostic` (the shipped defaults) and `forensic` — each state what they keep, who they are for, and what they do not change. The concentration worth knowing: under the default `errors-only`, a successful Run retains nothing raw and a **failed, canceled or paused** Run retains an unredacted transcript, which is where sensitive debugging context is most likely to be. `Schegent: Delete Run Evidence` removes one Run's evidence; nothing is encrypted at rest, and [that declination is a record with a reversal trigger](../architecture/evidence-encryption-declination.md). <!-- Source: src/audit/raw-transcript-writer.ts --><!-- Source: src/audit/verbose-diagnostic-writer.ts --><!-- Source: src/services/run-checkpoint-service.ts -->
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
  the plan applied, with every flag respected. `FR-R3-105` added an observer
  (`src/services/ambient-config-observer.ts`) and a field on `capability-applied` to carry its result,
  but the phase runner does not pass the observer (`src/controller/phase-runner.ts:558`), so every
  `capability-applied` event records that field as `null`: **nothing is observed today**. Once the
  observer is called it reads one user-level file per backend. For `claude` that is
  `~/.claude/settings.json`, digested over whichever of `permissions`, `allowedTools`, `disallowedTools`
  and `env` are present, or over the whole text when the file does not parse as JSON. For `codex` it is
  the whole of `~/.codex/config.toml`. For `agy` it is nothing, and an absent or unreadable file yields no
  observation either. No other settings file is read: the workspace's own `.claude/settings.json` and
  `.claude/settings.local.json` are never observed, and a phase allowed to write the workspace can change
  them. So evidence cannot answer *was the ambient configuration the same on these two Runs*. Once the
  observer is wired it could answer only whether the observed user-level file, or its widening keys,
  changed, and two Runs that both lack that file would have nothing to compare, which is not the same as
  the same. The observation never records the path (workspace paths may not enter the structured log,
  and a home path additionally carries the operator's username) or the values (a settings file can hold
  an API key). Pinning with `--settings` is the stronger answer and is the recorded destination; taking it needs
  the flag's stability established against a live CLI, which costs operator quota and has not been spent.
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
payloads carry closed-union members and a phase index. `capability-applied` also has a field for the
ambient-configuration observation described above, which production records as `null` because the
observer is not wired; `capability-refused` has none. Nothing
else. <!-- Source: src/services/capability-enforcement-plan.ts --><!-- Source: src/contracts/phase-capabilities.ts -->

## Prompt-injection surfaces

`FR-R3-182`, 2026-10-02. Untrusted text reaches the model by three routes, and the host classifies
none of them. This section names what bounds each one, read at its source rather than from a page
that summarises it, and labels every bound **structural** — it holds by construction, whatever the
model does — or **behavioural** — it holds only while the model declines.

| Surface | How it reaches the model | What bounds it | Kind |
|---|---|---|---|
| **Task text** — the Phase instruction, the operator's brief, request inputs, supplemental `text` and `instruction` items, operator instructions | Composed verbatim by `PromptBuilder.build`: under `TASK:` (`taskInstructionFor`), under `FEATURE DESCRIPTION:`, and in the envelope sections (`envelopeSections`). Never parsed or interpreted; each envelope section's own Schegent-authored line carries no interpolation, so an operator string cannot extend it. | Its **length**: the Phase instruction at `PHASE_INSTRUCTION_MAX_LEN` characters, request content by per-field, count and whole-request byte budgets (`MAX_REQUEST_TOTAL_BYTES` and its siblings). Nothing bounds what it says. | length: structural · content: **behavioural** |
| **Repository file content** — specs, plans, source, a supplemental `local-file` or `local-folder`, and any instruction file a backend CLI loads on its own | Not through the host. The prompt names locations only — `SCHEGENT_FEATURE_DIR:`, declared output targets, supplemental paths — and the backend reads the files with its own tools. The host never reads them into the prompt and never sees what the backend read. | Nothing on the host side. | **behavioural** |
| **Prior output** — text a model wrote earlier | Four routes. `Previous Phase Messages:` carries the previous Phase's `phase-message.env` entries (`previousPhaseMessage` in the run driver). `Unresolved from previous iteration:` carries the issue bullets the parser lifted from the previous iteration's output (`pickCarriedIssues`). A supplemental `prior-output` item carries a prior Run's output **location** (`resolvePriorOutput`); the host does not read what is there, and the backend may. Session continuation replays the backend's own conversation — `--resume` or `-c` for Claude, `--conversation` for Agy; Codex has none. | The sidecar's **shape**: size, key pattern and secret redaction before it is composed (`PhaseSidecarReader`, [T15](#t15--phase-message-env-injection)). Nothing bounds what any of the four routes says. | shape: structural · content: **behavioural** |

<!-- Source: src/runner/prompt-builder.ts -->
<!-- Source: src/config/process-definition-validator.ts -->
<!-- Source: src/contracts/validators/run-request-budgets.ts -->
<!-- Source: src/contracts/run-request.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/services/run-request/output-reference-resolver.ts -->
<!-- Source: src/controller/phase-sidecar-reader.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->

**What the three share is the way back.** Whatever reaches the model can affect a host decision only
through the output stream and the process's exit status, so the controls on that path are the same
for every surface:

- **Process control is structural.** Claude grace termination arms only on the harness's own
  `{"type":"result"}` record (`isTerminalResultLine`), never on model text, and
  `tests/lint/no-content-driven-process-control.test.ts` pins the mechanism
  ([T25](#t25--control-sentinel-carried-in-cli-output)).
- **A status token quoted from any surface is ignored, structurally — when the audit block is
  present.** Only the trailing region decides (`detectTermination`, over the region the audit-log
  parser computes), so a token echoed mid-output is counted and dropped. Without a complete block the
  whole-stream fallback accepts a token anywhere and labels the acceptance
  `[constitution] token accepted without audit block`: labelled, not refused.
- **A model persuaded to print the real token where the protocol expects it is classified as a model
  that finished.** That is **behavioural**, and it is the residue no structural control reaches. The
  exit-code verdict basis does not reach it either: it vetoes a non-zero exit the backend itself
  reported, a timeout and the absolute deadline (`requiresHostVerification`), and on a turn that
  exits 0 `mapOutcome` returns `clean` for a clean result under either basis.
- **What a persuaded model does with the backend's authority is behavioural.** It acts with the
  backend's permissions: approval prompts are disabled for Claude and Agy
  (`--dangerously-skip-permissions`) and Codex runs under `--sandbox workspace-write`. A Phase's
  capability set narrows that reach; the backend enforces it and the host does not observe it (the
  `FR-R3-086` paragraph in [What Schegent cannot prevent](#what-schegent-cannot-prevent)), and
  `Bash` ⊃ `network`. Narrowing bounds what a persuaded model can do. Nothing detects that it was
  persuaded.

<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: tests/lint/no-content-driven-process-control.test.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/controller/phase-outcome-mapper.ts -->
<!-- Source: src/services/capability-enforcement-plan.ts -->

Content the backend fetches for itself — a supplemental `url`, a web search, a command's output — is
not one of the three surfaces as `FR-R3-182` drew them. It arrives by the repository-file route,
through the backend's own tools, and is bounded by the same nothing.

**What the canary corpus has sampled, recorded 2026-10-19.** The corpus is `CANARY_SCENARIOS` in
`scripts/backend-canary.mjs`. `npm run canary:record` records it into `tests/fixtures/canary-live/`,
and `tests/unit/build/canary-live-records.test.ts` replays the recordings through the host's parsers.
The recordings are dated 2026-10-19, from Claude Code 2.1.302, Codex 0.159.2 and Agy 1.4.2, and hold
one recording of every case on each of the three backends:

- `live-protocol-probe` establishes that a one-word prompt reaches the model in the host's protocol
  shape. It carries no untrusted text.
- `prompt-injection-in-output` asks the model to print four lines, among them an instruction aimed at
  the host and an unbracketed `SCHEGENT_STATUS: CLEAR`. All three printed them, where on 2026-08-26
  Claude had refused, and all three envelopes replay to `issues_remain`. That establishes only that
  the unbracketed form beside prose is not a verdict. It reaches none of the three surfaces, because
  printing what the prompt itself asks for is compliance, not injection. Nor does it reach the
  trailing-region rule: the replay passes no region.

**What the surface cases sampled.** On 2026-10-02 `FR-R3-182` added one case per surface on each
backend: the feature description for task text, a planted `NOTES.md` for repository file content,
and the previous Phase's messages for prior output. Each pairs a word only the surface holds with a
note asking for a second word, and declares what its reply must show (`expectedObservable`). All nine
were recorded on 2026-10-19. Both words are read in the text the host parses, the model's own reply,
because Claude's and Codex's repository-file envelopes also carry both words of `NOTES.md` in the
output of the tool call that read it. Every reply held the first word, so each surface reached its
model. Claude's replies added the second word for task text and prior output, not for the repository
file; Codex's and Agy's added it for none. All nine replay to `issues_remain`. Each answer is one
sample of one model on one turn: a reply with the second word shows that the model obeyed the note on
that turn, and a reply without it that the model did not, not that it resists (FR-057). No host
decision reads either answer.

The cases also leave routes unsampled. Prior output is sampled on the sidecar route only, not through
carried issues, a supplemental prior-output location or session continuation, and content the
backend fetches is not sampled at all. The canary passes none of the host's permission flags, so each
backend runs with its own default authority rather than the host's, and the canary observes nothing
about what a persuaded model does with the authority the host grants. What holds whatever the model
does is structural, pinned at no cost in turns by
`tests/unit/parser/stdout-injection.test.ts` and `tests/lint/no-content-driven-process-control.test.ts`.

<!-- Source: scripts/backend-canary.mjs -->
<!-- Source: scripts/backend-canary-run.mjs -->
<!-- Source: tests/unit/build/canary-live-records.test.ts -->
<!-- Source: tests/unit/parser/stdout-injection.test.ts -->

### Injection corpus: recorded on demand, never per release — 2026-10-02

Feature 217 (`FR-R3-182`; FR-055, T1836), in the four-field shape.

**Amended 2026-10-19 (`FR-R3-182`): every case is recorded.** One `npm run canary:record` run spent
all 15 turns, at the operator's request, after every installed CLI had moved past the version
qualified on 2026-08-26. All 12 injection-shaped turns now have a recording, and the list of
recordings `tests/unit/build/canary-live-records.test.ts` expects is derived from `CANARY_CASES`. The
count under **Measurement** below, 3 recorded and 9 never, is the 2026-10-02 figure, and this
paragraph supersedes it. The decision, its reason and its revisit condition stand: the answers are
reported above as samples, and no control on this page rests on them.

**Decision.** The injection cases run only under `npm run canary:record`: never per release, never in
`npm run gate`, never in `npm run release:preflight`. What a release requires stays the protocol
probe, which `npm run canary` runs and `release:preflight` reads through the qualification record.

**Measurement.** With all three backends installed:

- `npm run canary` spends 3 turns, the probe on each backend.
- `npm run canary:record` spends 15 turns, five cases on each backend, up from 6 before the surface
  cases.

Each turn has a 120-second deadline (`LIVE_TIMEOUT_MS`), so a recording run's turns are bounded at 30
minutes in total. Of its 12 injection-shaped turns, 3 were recorded on 2026-08-26 and 9 never have
been. `tests/unit/build/backend-canary.test.ts` fails if the two turn counts stop matching
`CANARY_CASES`, and `tests/unit/build/canary-live-records.test.ts` fails if a recording appears or
goes missing.

**Reason.** A recording is a behavioural sample, and no host decision reads one. The controls that
hold whatever the model does are structural and already pinned at no cost in turns. Running the
corpus per release would spend 12 more turns on every release for a result no release decision reads.

**Revisit condition.** The host acts on model text beyond the trailing-region status token and the
exit code, or a claim in this documentation comes to rest on how a model answers injected text.
Either makes a sample evidence for a decision, and a fresh `npm run canary:record` is owed first.

## Threat anchors

### T1 — Secret leakage to operator-visible sinks

All operator-visible logger sinks receive text after the single code-resident redaction set. A new sink that bypasses `SanitizedLogger`, or a secret pattern duplicated elsewhere, breaks the mitigation.

The sanitizer reaches that set by rebuilding each object it cleans onto a fresh one, and the same rebuild shape appears elsewhere in the tree. The [prototype rebuild census](prototype-rebuild-census.md) enumerates every enumerated-key rebuild in `src/` and records, per site, whether it is reachable from model- or CLI-derived input. It is a measurement, not a gate.

<!-- Source: src/lib/logger.ts -->

### T2 — Untrusted webview mutating host state

The webview is not authoritative. Runtime validation precedes routing; the 46 metadata-classified mutations then require workspace trust and authoritative window primacy.

<!-- Source: src/contracts/runtime-validators.ts -->
<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->

The CSP is the other half of that boundary, and it has two halves of its own. The runtime header is asserted where it is built. That the *built bundle* never references a remote origin is asserted separately, because the runtime denial is silent — a dependency that stages a CDN link produces a blank pane and a console entry, not a failing test. [The CSP supply-chain record](csp-supply-chain-record.md) holds the decision, what the build-time gate can and cannot see, and the three conditions that would reverse it.

<!-- Source: src/ui/sidebar/csp.ts -->
<!-- Source: tests/unit/ui/sidebar/no-remote-refs.test.ts -->

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

<!-- Source: src/host-services/catalog-fs-adapter.ts -->
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

Three surfaces reach extension capability, and each is gated on the same read of the same trust
state:

- **Mutating IPC** fails closed when the trust callback is missing, throws, or returns anything but
  `true`.
- **Commands** (`FR-R3-136`). Every one of the 23 mutating command ids is registered through
  `registerGuardedCommand`, which re-reads `vscode.workspace.isTrusted` **at the point of effect**.
  Until 2026-08-28 the 30 registrations were bare `vscode.commands.registerCommand` calls and the
  sidebar router was the only gate — so the palette, a task, and any other installed extension
  reached every mutation directly. Contributed visibility is not authorization, and this manifest
  has no `enablement` clauses that could have stood in for one.
- **Activation** — see the election below.

**The election is itself a write** (`FR-R3-136`). `store.ownership.acquire` writes a generation file
under `.schegent/ownership/`, so acquiring the workspace resource is a filesystem write to a
workspace-influenced path in the same sense a Run's output is, and being the primary window is what
subsequently authorizes replaying transitions, re-arming a scheduled start, reattaching the watchdog
and resuming a persisted Run. Before FR-R3-136 an untrusted window elected: Stage 2 was split by
construction, and everything workspace-bound that ran was on the *built* side. It is now split by
**act**. The graph is still built eagerly in an untrusted window — that is what keeps the read-only
surfaces working — and the acts moved behind the gate, together with the capability probe that spawns
`<cli> --help`. Granting trust runs that half exactly once, through a single
`onDidGrantWorkspaceTrust` subscriber.

**An untrusted window is not write-free, and the distinction is the point.** The Stage-1 runtime log
sink is attached before any trust decision this feature makes, so `<workspaceRoot>/.schegent/syslog`
is created and appended to in a window nobody trusted — which is exactly how a refusal becomes
observable, and why `logging.runtimeLogFilePath` and its two bounds are `restrictedConfigurations`
entries rather than left to the workspace to name. What the gate withholds is the *acts*: no
election, no replay, no re-arm, no reattach, no resume, no probe. A claim that an untrusted window
touches nothing would be both false and weaker than the one that holds.

**The intent is declared, not inferred** (`FR-R3-126`). `package.json` carries
`capabilities.untrustedWorkspaces` with `supported: "limited"`. Until 2026-08-27 the manifest carried
no `capabilities` key at all, so VS Code applied its conservative default: the behaviour was safe and
the *intent* was left to a reader's inference, which is not the same thing in a document reviewers
read to decide what this extension does. `false` would be the opposite error — a claim the extension
does not run in an untrusted window, when it activates and serves reads deliberately.

**Settings are the fourth surface** (`FR-R3-136`). A workspace `.vscode/settings.json` could vote on
a capability, silence an operator signal, or redirect and truncate evidence without invoking
anything. The 14 `restrictedConfigurations` entries are the properties where it could, derived from
the sensitivity classes in `src/contracts/configuration-trust-dispositions.ts`; the nine
executable-authority properties are `application`-scoped instead, which is stronger because it holds
in a trusted window too.

**What checks it.** `tests/integration/trust-untrusted-workspace.host.test.ts` drives 28 of the 30
command ids through `executeCommand` in a real untrusted window and asserts one refusal each for the
mutating ids, none for the read-only ones, no ownership generation file, and no spawn against a
user-scope sentinel; `trust-granted-workspace.host.test.ts` is the same fixture with trust granted and
turns every one of those absences into a presence.

This paragraph previously claimed the check was "the VS Code 1.107 Electron integration suite — 13
modules across two launches". **That claim was unsound, and worth recording rather than quietly
replacing.** `@vscode/test-electron`'s `runTests` appends `--disable-workspace-trust` to every launch,
so `workspace.isTrusted` was unconditionally `true` and no host assertion this repository had ever
made could observe an untrusted window. The suite is now 15 modules across four launches, two of
which set the trust posture explicitly.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/activation/guarded-command-registration.ts -->
<!-- Source: src/activation/stage2-producers.ts -->
<!-- Source: src/contracts/configuration-trust-dispositions.ts -->
<!-- Source: src/extension.ts -->
<!-- Source: package.json -->

### T8 — Prompt injection via spec, plan, task, or instruction content

The prompt composer deliberately transports operator-selected content. There is no prompt-injection detector in the ingress path; the operator's repository and approvals remain part of the security decision. The three surfaces, what bounds each, and whether that bound is structural or behavioural are enumerated in [Prompt-injection surfaces](#prompt-injection-surfaces), beside what the live canary has recorded of them.

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
- **Evidence at rest is owner-only** (`FR-R3-179`, 2026-10-02). Until then the CLI transport log and the runtime log were created without a declared mode, `0644` under the common `022` umask, readable by every local account, and every evidence path an earlier release created kept the bits it was born with, because a mode applies only when a path is created. The host now declares `0600` for each evidence file and `0700` for each evidence directory it creates, and narrows an existing path in place the next time it writes through it: group and other bits are cleared, the file is never recreated or truncated, so the audit chain stays intact, and a symbolic link is refused rather than followed: each path is checked with `lstat` before it is narrowed, and narrowing stops at the first directory found to be a link. Rotated generations and audit archives are narrowed where they lie. Every writer reports what it narrowed, or could not narrow, without naming the path, and a report that cannot be delivered never fails the write. This is a boundary against **other local accounts** only. It keeps out nothing that runs as the operator — the operator, a backend process, an extension — and it is not encryption. Two limits are stated rather than closed. A path swapped for a link between that check and the `chmod` redirects the change, the window every path-based change has; the mode it sets carries no group or other bit, and `chmod` succeeds only on a file the operator owns, so the worst a swap can do is set one of the operator's own files to an owner-only mode, and no other account gains anything. And files a backend writes itself under `.schegent/sessions/`, Claude's `debug.json` and the `phase-message.env` sidecars, are not narrowed, nor are the `latest` links; other accounts cannot reach them only because an ancestor is `0700`: the host creates `.schegent/` owner-only and narrows it the next time it writes through it.

<!-- Source: src/lib/narrow-mode.ts -->
<!-- Source: src/lib/evidence-narrowing.ts -->
<!-- Source: src/lib/safe-open.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->
<!-- Source: src/audit/schegent-gitignore.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
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

A command the turn left running in the background holds that settle (FR-R3-198), and the hold is keyed the same way: on the harness's `system/task_*` records — a `task_started` whose `is_backgrounded` is `true` opens a task, its `task_notification` closes it — whose structural fields model text cannot produce. A hold can only delay the settle; it arms no termination of its own. It is bounded three ways: it ends `BACKGROUND_HOLD_CEILING_MS` (600 000 ms) after the result that began it, the idle window still applies while it lasts, and the absolute deadline is never reset.

This does not make the model's evidence truthful. It separates a bounded control sentinel from the Phase's self-reported outcome — and for a **load-bearing** Phase that outcome can be **vetoed**: a non-zero exit the backend itself reported, a timeout or the absolute deadline fails the Phase by default, and the model's token cannot override it (FR-R3-058 shipped the mechanism opt-in; FR-R3-117 made it the default; `hostVerification: 'model-token'` is the opt-out). It is a veto and nothing more. On a turn that exits 0 the token decides under either basis, so a model that content persuades to print the real token where the protocol expects it is classified as a model that finished — the residue [Prompt-injection surfaces](#prompt-injection-surfaces) names. Until `FR-R3-182` (2026-10-02) this paragraph said that for a load-bearing Phase the self-reported outcome *does not decide at all* and *the host's own exit status does*; the status is the backend's, and it decides only when it reports a failure. The limit documented above applies in full to the advisory case — a Phase resolving to `sideEffects: 'none'` with no declared output, or one that has opted out — which has not even the veto. FR-R3-023 verified evidence *shape* and FR-R3-038 *disclosed* the self-certification; the resolved default is where the veto is now *enforced*.

<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: src/parser/stdout-parser.ts -->
<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/background-task-tracker.ts -->
<!-- Source: tests/lint/no-content-driven-process-control.test.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/controller/phase-outcome-mapper.ts -->

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

**Teardown's own stop could start one.** Stage-2 teardown runs `cancelAll()`, whose SIGTERM
ends a child with 143. A turn that still had background work open then reads as unfinished,
and the controller resumes an unfinished turn with a new `--resume` spawn, detached like every
other, after the teardown that was meant to stop every CLI (the feature-228 security review,
S1). `cancelAll()` now closes each runner too, and a closed runner refuses every later
invocation with `SpawnRefusedAfterCloseError` before anything is spawned; a runner built after
teardown is handed out closed. The refused invocation fails the Run rather than resuming it.
The refusal sits in the runner, not the resume loop, so a phase retry or an auto-drain
admission after teardown is refused the same way. Teardown also closes the auto-drain before it
stops any child, so a closed drain starts nothing, and a task waiting for the slot a stopped Run
frees stays pending for the next session instead of being admitted and failed.

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
- **An admission already starting when teardown begins goes on.** Teardown closes the auto-drain
  first, but a start that is already past the drain's last check, in the interval before the
  runner's first invocation, is not stopped by the close. The closed runner refuses that
  invocation, so that Run fails with the refusal named instead of starting a CLI.

<!-- Source: src/contracts/spawn-identity.ts -->
<!-- Source: src/runner/backend-runner-registry.ts -->
<!-- Source: src/runner/spawn-refused-after-close.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/services/process-liveness.ts -->
<!-- Source: src/services/resume-decision.ts -->
<!-- Source: src/state/spawn-identity-recorder.ts -->

### T27 — A persisted consent grant outlives what the operator agreed to

Both consent surfaces are now answered **once** rather than per task (`FR-R3-146`). A grant that is
remembered is a grant that can be remembered longer, or read more widely, than the operator meant.
There are two, and each is bound on a different axis.

**The uncontained-backend grant.** Asked at the refusal point, as a blocking modal answered before
anything is spawned. Approving writes the refused backend id — and no other — to
`schegent.backend.uncontainedBackends` in User settings. Its scope is the **machine**:
`application`-scoped by design, so a workspace cannot grant itself the right to run an unbounded
agent. Withdrawn by removing the id from the setting. The manifest default stays `[]`, so a fresh
install still refuses its first run, and the setting is read at **every** runner construction rather
than captured at activation — a grant written mid-session takes effect with no window reload.

**The Git mutation-plan grant.** Asked before the first Run on a plan. `Approve This Run` covers that
Run and records nothing; `Always Approve This Plan Here` writes an entry under
`schegent.consent.gitPlanGrants.v1` in this workspace's `workspaceState` memento, keyed by the plan
fingerprint and carrying the pipeline id, the phase ids, and when it was given. Its scope is **this
workspace and this exact plan**: editing the pipeline changes the fingerprint and asks again, and
another repository asks. Withdrawn from `Schegent: Git Approvals`, which lists what this workspace
holds and withdraws one entry or all of them; resetting workspace state also clears them.

For both, cancelling or dismissing **denies**, and neither value is written except by its own
affirmative action. A failed write does not become a denial of the run just approved — it means the
next run asks again, which is the fail-closed direction for a grant that was never recorded.

**Residual risk, stated rather than implied:**

- **A remembered grant is not a re-consulted operator.** The Git plan fingerprint covers the
  pipeline id and each phase's id, runner, declared side effects and `promptVersion`. A phase prompt
  revised *without* changing `promptVersion` is the same fingerprint and does not ask again.
- **The uncontained grant is not evicted mid-session.** Enforcement is at runner construction and the
  registry caches by kind, so removing the id does not tear down a runner already built in this
  window, nor stop a phase already running. Reload the window to make a withdrawal bite now.
- **Neither grant bounds the model.** The uncontained grant decides whether a run *starts*;
  `--dangerously-skip-permissions` is still passed. The Git grant covers the phases the host runs,
  and a backend with a shell can invoke `git` regardless of what any phase declared — T8's position,
  restated at a different seam.
- **The Git grant is scoped to the workspace but not stored in it.** This page said until FR-R3-146
  that the grant was a file in the repository directory, and that anyone who could write it could
  write a grant. Both halves were wrong, in the direction that understates the product. A
  `workspaceState` memento is keyed *by* the workspace and kept *outside* it, in VS Code's own
  `workspaceStorage` under the user's data directory — so repository content cannot forge a grant by
  checking one in, and cloning a repository carries none. What can write one is anything already
  running as the operator with write access to that directory, which is the same actor that could
  edit User settings; no boundary this product draws survives it, and none is claimed.
- **It is not observable by opening a file.** The memento is a SQLite database VS Code owns
  (`state.vscdb`), which is why withdrawal is a command rather than an editing instruction, and why
  five surfaces telling operators to edit a file that does not exist left FR-012 unmet in practice
  until there was a surface that reads it. `Schegent: Git Approvals` is that surface.

<!-- Source: src/activation/uncontained-consent.ts -->
<!-- Source: src/activation/git-approval.ts -->
<!-- Source: src/state/git-plan-grants.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->

### T28 — A command acknowledgement carries an error message to the webview

A new egress channel, opened by `FR-R3-154`. Five lifecycle routes used to acknowledge `accepted`
unconditionally, which was a truthfulness defect but leaked nothing: they never reported a reason at
all. Reporting the host's real answer means a `catch` block's output now has somewhere to go, and an
exception message from this layer carries absolute workspace paths.

The two shapes that could carry arbitrary text are converted to **fixed codes** at the one place that
reads them. A thrown dispatch becomes `failed` with `command-dispatch-failed`; a registered command
answering a shape no reading covers becomes `failed` with `command-result-unrecognized`. The
sanitized message goes to the extension log and never into the acknowledgement. `accepted` carries
no `reason` field at all, so an acceptance cannot arrive alongside an explanation of why it did not
happen.

<!-- Source: src/ui/sidebar/commands/handler-helpers.ts -->
<!-- Source: src/contracts/command-outcome.ts -->
<!-- Source: tests/unit/ui/sidebar/commands/cmd-start-queue.test.ts -->

**Residual risk, stated rather than implied:**

- **A reason from the host's own vocabulary travels verbatim and is not re-sanitized here.** That is
  deliberate: those vocabularies belong to the mutating services (`resolveControlTarget`,
  `PhaseControlService`, the Queue start path), and translating them at the boundary would be the
  second eligibility oracle this feature exists to remove. The guarantee is therefore conditional on
  those reasons being codes rather than composed strings — a host service that interpolated a path
  into a `MutationResult.reason` would reach the webview intact. What is checked is the class where
  the risk actually arose: the dispatch-failure path is asserted to put no absolute path in any field
  of the acknowledgement, not merely to carry the right code.
