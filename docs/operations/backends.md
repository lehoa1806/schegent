# Backend operations

Schegent supports three local CLI adapters. Claude is the default backend. Claude and Agy run with approval prompts disabled and therefore act without asking; Codex is the only adapter with a Schegent-selected sandbox mode.

<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: package.json -->

## Capability table

| Runner | Executable setting | Invocation prefix | Permission posture | Continuation |
|---|---|---|---|---|
| `claude` *(default)* | `schegent.cli.path` (`claude`) | `--dangerously-skip-permissions [--resume <id> \| -c] -p [--model <model>] [--effort <effort>] --output-format stream-json --verbose [--debug-file <path>]` | CLI approval prompts are off; Schegent supplies no OS-enforced bound. | `--resume <id>` for a known session; `-c` only for continuation without an ID. <!-- Source: src/runner/claude-cli.ts --><!-- Source: src/config/cli-path-accessor.ts --> |
| `codex` | `schegent.codex.path` (`codex`) | `exec --json --sandbox workspace-write` | OS-enforced `--sandbox workspace-write`; the workspace is writable and `.git` remains read-only. | Request continuation fields are ignored. <!-- Source: src/runner/codex-cli.ts --><!-- Source: src/config/cli-path-accessor.ts --> |
| `agy` | `schegent.agy.path` (`agy`) | `--dangerously-skip-permissions [--conversation <id>] --input-format stream-json [--model <model>] [--effort <effort>] --output-format stream-json` | CLI approval prompts are off; Schegent supplies no OS-enforced bound. | `--conversation <id>` when reuse/continuation has an ID; no flag-only fallback. <!-- Source: src/runner/agy-cli.ts --><!-- Source: src/config/cli-path-accessor.ts --> |

Model arguments are `--model <id>` for all three adapters. Claude and Agy use `--effort <level>`; Codex uses `--config model_reasoning_effort=<level>`. Agy rejects unsupported `xhigh` and `max` effort values before spawn.

<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->

## Select and configure a runner

Set `schegent.backend.runner` to `claude`, `codex`, or `agy`. The default is `claude`. A blank, missing, or non-string value silently selects that default; an unknown nonblank string selects the default and emits a warning. The runner choice is cached when the workspace-bound Extension Host activates, so reload that host after changing it. Binary paths are read dynamically, so changing `schegent.cli.path`, `schegent.codex.path`, or `schegent.agy.path` does not require a reload.

The Settings tab edits the same settings without the native Settings editor: the runner selector, one section per backend carrying that backend's binary path and its containment posture, and a per-run spend ceiling in dollars and in tokens (`schegent.spend.maxUsdPerRun`, `schegent.spend.maxTokensPerRun`). The sections are generated from the supported-backend enumeration, so a backend the product supports cannot be missing from the tab.

<!-- Source: package.json -->
<!-- Source: src/runner/backend-runner-factory.ts -->
<!-- Source: src/config/cli-path-accessor.ts -->
<!-- Source: src/extension.ts -->

There is no repository-declared supported-version band for any backend CLI and no runtime version rejection. Availability probing establishes only that the configured executable can complete `--help`; it is not compatibility certification.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: package.json -->

## Environment forwarding

`schegent.cli.environmentMode` defaults to `allowlist`. In that mode, the process receives required path/home/temp/locale bootstrap variables plus the names in `schegent.cli.environmentAllowlist`; values are read from the extension-host environment at spawn time and are not stored in settings. `minimal` sends only Schegent-controlled variables. `inherit` preserves the ambient extension-host environment. The legacy `schegent.cli.inheritEnvironment: false` forces `minimal`.

<!-- Source: package.json -->
<!-- Source: src/runner/spawn-env.ts -->

The effective environment policy is also cached during workspace-bound activation. Reload the Extension Host after changing `schegent.cli.environmentMode`, `schegent.cli.environmentAllowlist`, or `schegent.cli.inheritEnvironment`.

<!-- Source: src/extension.ts -->

Five host spawns of a configured backend CLI receive the same effective policy, and each builds its child environment through `buildSpawnEnv`: the Phase runner, the session compactor (pre-phase compaction), the credit watchdog's automatic `/status` poll, the backend capability probe, and the CLI version probe (`--version`). A `schegent.cli.environmentMode` value that is not `inherit`, `minimal` or `allowlist` resolves to `allowlist`; only the exact string `inherit` inherits the extension-host environment. The version probe caches its answer per executable path and per policy, so a changed policy probes again instead of reusing an answer observed under another one. The allowlist filters what a child is given at spawn time; it is not an operating-system boundary, and it does not stop an uncontained backend from acting with the operator's own user authority.

<!-- Source: src/controller/session-compactor.ts -->
<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: src/watchdog/credit-watchdog.ts -->
<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/runner/cli-version-probe.ts -->
<!-- Source: src/contracts/process-environment-policy.ts -->

## Availability and model discovery

Every availability probe runs the dynamically resolved executable with `--help`, `shell: false`, the canonical workspace root as `cwd`, hidden Windows process mode, a 64 KiB retained-output cap, and a normalized 1–30-second timeout that defaults to 5 seconds. Timeout cleanup sends TERM and escalates to KILL after 2 seconds.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: package.json -->

Claude and Codex report no discovered models because their adapters expose no listing command. Agy additionally runs `models` and parses its bounded stdout. The operator's `schegent.models` catalog is separate configuration, not probe output.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: package.json -->

Probe failure causes exposed to the host are `not-found`, `not-executable`, `non-zero-exit`, `timed-out`, and `unknown`. Configured paths, stderr, environment values, and raw errors do not enter the webview result.

<!-- Source: src/services/backend-capability-service.ts -->

## Contract every adapter must honor

Adding a backend is not three edits: the places that name a backend, with their roles, are listed in
`tests/fixtures/backend-recipe-sites.ts`, and a census gate fails when a source file names a backend and is
not on that list. Start from the list.

1. One `invoke()` represents one non-interactive subprocess and resolves when it exits or is terminated.
2. The prompt travels over stdin; it is not appended to argv.
3. `shell: false` is mandatory, with `cwd` set to the workspace root and an explicitly built environment for ordinary Phase execution.
4. Stdout and stderr use bounded `ZippedStreamBuffer` instances with observable truncation.
5. The timeout is idle-based: output resets it unless sink backpressure has paused the stream.
**Capability posture (FR-R3-056).** A backend with no OS-enforced bound on what it can reach is
**refused by default**. `claude` and `agy` are spawned with `--dangerously-skip-permissions`: their
approval prompts are off and they act under the operator's local permissions. `codex` is spawned with
`--sandbox workspace-write`, an OS-enforced filesystem bound that leaves `.git` read-only.

Since `schegent.backend.runner` defaults to `claude`, **a fresh install refuses its first run** until
the operator either names that backend in `schegent.backend.uncontainedBackends` or selects a backend
that carries a sandbox. The refusal names both options and happens at the point the backend would be
constructed, so no route reaches an unbounded agent without it — not admission, not a resume, not an
auto-drain, not a continuation.

The setting is `application`-scoped: a workspace cannot grant itself the right to run an unbounded
agent. Each constructed uncontained runner logs that it is running without a bound and names the
setting that permitted it. Activation is unaffected — a refused posture does not stop Schegent
loading, only running.

### What that asymmetry means for a declared output target

An operator naming an output inside the workspace is confirming a path that is checked twice: once at
request time, and once more at dispatch, immediately before the frozen plan reaches the runner
(FR-R3-079). The second check walks the target's component chain and refuses a Run whose target has
since acquired a symlinked parent — before the child is started, with a named cause in the evidence
record rather than an error surfaced from the CLI.

**It narrows the window; it does not close it.** The host's last look at the target and the child's
write are still separated by the child's own runtime, and only an OS-enforced bound can cover that
interval:

| Runner | After the dispatch-time walk |
|---|---|
| `codex` | The sandbox (`--sandbox workspace-write`) bounds the write itself. The interval is covered. |
| `claude`, `agy` | Uncontained by construction — the CLI runs under the operator's full local authority, and nothing but the operator's own filesystem permissions bounds where it writes. The interval is **not** covered. |

So for the enabled uncontained runners the dispatch check is a strong narrowing and not a guarantee,
and this is the honest statement of it rather than an implication drawn from the table above. The
asymmetry itself is not new and is not this item's to change; it is the one FR-R3-032 established and
the reason `schegent.backend.uncontainedBackends` exists as a deliberate, application-scoped, per-backend decision. Which containment each backend actually has is qualified in [Backend containment qualification](../architecture/backend-containment-qualification.md); the untrusted-repository rule is owned by [Running Schegent on a repository you do not trust](untrusted-repositories.md).

The full reasoning, the two shapes not chosen, and what remains outstanding are in
[Agent capability posture](../architecture/agent-capability-posture.md).
<!-- Source: src/services/backend-containment-policy.ts -->
<!-- Source: src/runner/backend-runner-factory.ts -->

6. Cancellation observes the request's abort signal. Timeout or cancellation sends SIGTERM and
   escalates to SIGKILL after 2 seconds. **The signal goes to the backend's whole process tree, not
   only to the direct child** (FR-R3-054): each backend is spawned into its own process group on
   POSIX and signalled as a group, and reached with `taskkill /T` on Windows. Before this, a CLI
   tool that forked a helper survived cancel, timeout, aggressive pause and deactivation, and could
   keep mutating the workspace after Schegent had recorded a terminal state.

   Where the tree cannot be confirmed gone 500 ms after SIGKILL, that is logged explicitly
   ("process tree not confirmed gone after SIGKILL; descendants may still be running") rather than
   the terminal state silently implying the work has stopped. SIGKILL is not catchable, so a group
   that survives it is a group Schegent does not own.

   **Permanent limit, stated plainly:** a Windows Job Object with kill-on-close is stronger than
   `taskkill /T` — it cannot be escaped by a process that re-parents itself — and needs a native
   binding. On POSIX, a descendant that calls `setsid` for itself leaves the group and is likewise
   out of reach.

   This is **not** a pending follow-up. Whether this product should carry a native binding was
   decided once, for the four residuals that share the question, in
   [Native binding decision](../architecture/native-binding-decision.md) (2026-08-25). The answer is
   **no**, so both escapes above will remain open, and `taskkill /T` — the well-audited equivalent
   the requirement itself allows — is what Schegent ships. The record states what the rejected branch
   would have bought and the three things that would reopen it.

   Where the tree cannot be confirmed gone, that is now also recorded in the audit log as a
   `process-tree-unconfirmed` event, so an operator reconstructing why a later phase saw foreign
   writes has evidence and not only a log line.

   **Read the absence of that event narrowly.** On POSIX the check asks whether the process
   *group* is gone. A descendant that calls `setsid` for itself, or that re-parents, has left the
   group — the check then reports the group as gone while that process is still running. So no
   event means *the group was confirmed gone*, not *no descendant survives*. That gap is the same
   permanent limit stated above, and it is why the runtime-log warning is kept beside the audit
   entry rather than replaced by it.

   **A helper that outlives its parent is escalated, on evidence that the group is still
   ours.** The ladder addresses a tree by the direct child's pid, and once the operating system
   has reaped that child the pid is free to be reused: a new process group leader can hold it, and
   a probe would then answer "alive" about a stranger. Signalling there would kill an unrelated
   process tree. So on POSIX a group signal to a reaped leader is sent only with **ownership
   evidence**: the leader was still unreaped when the ladder began, or the host saw the group
   still answering at the moment the leader exited; and, immediately before each signal, the
   leader's pid is still free and the group still answers. Where the evidence is missing, or
   `EPERM` comes back from either probe, no signal is sent. A leader that handles SIGTERM and exits
   while a helper in its group ignores it therefore gets the group's SIGKILL at the 2-second rung,
   and the confirmation then reports the group gone or reports it surviving. The `group-gone`
   outcome means the group is gone, not that no descendant survives.

   Two residuals remain, stated rather than closed. **The ownership-evidence race:** between two
   observations our group could empty, its number could be reallocated, the new holder could make
   itself a group leader and exit, and its members could remain; the fresh check requires the pid
   to be free, which removes every case where that stranger leader is still alive, and leaves this
   narrow one. **The normal-completion survivor:** when a backend finishes normally, nothing
   signals its group, and once the runner drops the Run's active entry and the recorded identity is
   cleared, neither shutdown nor the next start can find a helper that outlived it. This ladder
   covers a cancelled, timed-out or torn-down tree, and a tree a dead host left behind.

   **On Windows the event is not emitted at all.** There is no process group to probe, so the only
   question `processTreeIsGone` can answer is whether the direct child is gone — and once
   `taskkill /T /F` has reaped it, a recycled pid inside the confirmation window would answer
   "alive" and produce an audit entry against a Run whose tree had in fact died. A false lead is
   worse than none, so the check declines rather than guesses. The runtime-log warning is what
   Windows operators have, and closing this properly needs the Job Object named above.

   The event also requires an invocation that names a Run; one that does not produces the log
   warning and no audit entry.

   Which acceptance halves have actually been observed, and on which platform, is in
   [Platform observation record](platform-observation-record.md).
7. Monitor events identify the Run and report start, chunks, and exit. Hook errors do not control the child.
8. Retry and rate-limit policy remain in the controller; adapters return raw invocation outcomes.
9. Adapters do not own operator-visible sanitization or structured audit writes; those occur at the Phase runner/logger boundary.

<!-- Source: src/contracts/backend-runner.ts -->
<!-- Source: src/runner/process-lifecycle-runner.ts -->
<!-- Source: src/runner/zipped-stream-buffer.ts -->
<!-- Source: src/controller/phase-runner.ts -->

## Resume after a restart

Before Schegent resumes a Run that recorded a backend process, it asks whether that process tree
is still there. The question is asked on **every** resume attempt, not once at activation: the
activation sweep, primacy-gain recovery, a manual resume or retry, the auto-drain and an unattended
wakeup all pass through one admission check, and none of them can start a backend beside a survivor.
The check sends signal 0 only. It never kills an orphan and never reattaches to one.

| Verdict | What the check found | Resumes? |
|---|---|---|
| `alive` | The recorded leader's pid is held by the same process (the start time matches) | No |
| `orphaned-group` | The leader has exited, but a member of its process group still answers | No |
| `dead` | The leader and its group are gone, or the pid is held by a different process | Yes |
| `unrecorded` | The Run carries no recorded process (it predates the record, or its child was already reaped) | Yes |
| `unanswerable` | The platform or the permissions would not say (Windows, `EPERM`, an unreadable start time) | Yes |

`unanswerable` resumes on purpose: refusing every resume where the check cannot run would strand
Runs exactly where the mechanism is weakest. The audit trail records which verdict applied, so an
operator can see that the check could not answer. The verdicts that permit a resume are the
single list `RESUME_ON` in `src/contracts/spawn-identity.ts`; the two lists below are copies, and a
test fails if either drifts from the source.

<!-- resume-on:start -->
Permits a resume: `dead`, `unrecorded`, `unanswerable`
<!-- resume-on:end -->

<!-- liveness-verdicts:start -->
All verdicts: `alive`, `dead`, `unrecorded`, `unanswerable`, `orphaned-group`
<!-- liveness-verdicts:end -->

**What `orphaned-group` asks of the operator.** The previous backend process has exited, but
processes it started are still alive in its process group, and a new Run beside them would share a
working tree with something still writing to it. Schegent declines the resume, records a
`run-resume-declined-orphan-alive` event whose `liveness` field is `orphaned-group`, and tells the
operator. End those processes, then resume or reload. The Run's existing controls stay available.
A queued retry for that Run waits; it is not turned into a fresh start.

<!-- Source: src/contracts/spawn-identity.ts -->
<!-- Source: src/services/process-liveness.ts -->
<!-- Source: src/services/resume-admission-guard.ts -->

## Shutdown

When the window closes, Schegent stops every backend it started **and waits for the result** before it lets go
of ownership. The order, in the sense that each step finishes before the next begins:

1. **Admission closes.** The auto-drain stops starting work, an unattended wakeup (credits restored, a retry
   deadline, the activation handshake) is refused, a resume is refused, and every backend runner is closed so that
   nothing spawns again. This happens synchronously, before any wait.
2. **The teardown.** Each runner's SIGTERM, then SIGKILL, ladder runs against its process tree (see the
   contract above), and the host waits for the outcome of every one.
3. **The evidence.** A tree the host could not answer for is recorded (below).
4. **The transport flush.** The runtime log's last lines are written, after the dying backend's final output has
   been accepted.
5. **The execution leases** are released.
6. **Window primacy** is released.

So another window can take ownership only after this one has either confirmed its backends gone or written down
that it could not.

**The bound is 2,750 ms**, the ladder's own two delays plus slack: 2,000 ms from SIGTERM to SIGKILL, 500 ms for the
group to disappear, and 250 ms of slack for timer scheduling and a Windows `taskkill` exit. A ladder that has not
settled by then is reported `bound-elapsed`, and the release does not wait further. The bound sits inside the
5,000 ms the editors give an extension to deactivate (VS Code 1.144.0 and Antigravity IDE 1.107.0 both end the
extension host after `Promise.race([timeout(5e3), deactivateAll()])`): 2,750 ms for the teardown plus the 2,000 ms
transport-flush grace is 4,750 ms. The evidence appends and the lease and lock writes are counted in the 250 ms that
remains; they start no timer and wait on nothing but their own writes. A test asserts the relation, so a change to
either number has to change it on purpose.

**What is recorded.** For each tree whose outcome is `platform-unanswerable` or `bound-elapsed`, one
`host-teardown-unconfirmed` event is appended, attributed to the Run, before the leases are released, because the
audit log refuses appends from a window that no longer owns it. A tree that was confirmed gone writes nothing, and a
tree that survived SIGKILL already has its `process-tree-unconfirmed` event, which shutdown waits for.

- **`group-gone`** means the process group is gone. It does not mean no descendant survives: a process that left
  the group on its own (`setsid`) is the permanent limit stated above.
- **Windows** answers `platform-unanswerable` for every tree. `taskkill /T` is sent and no group exists to probe,
  so the platform cannot confirm a tree, and the event says so rather than implying a confirmation.
- **A reset** (clearing the workspace's state) stops producers through the same stage-2 teardown, so it waits for the
  same bounded teardown. Its own steps (quiesce, stop producers, mark, clear, commit, reload) are unchanged.

<!-- Source: src/runner/process-tree.ts -->
<!-- Source: src/runner/backend-runner-registry.ts -->
<!-- Source: src/activation/stage2-teardown.ts -->
<!-- Source: src/controller/host-teardown-recorder.ts -->

## Remote development is unqualified

Whether the extension works under **Remote SSH** or a **Dev Container** has not been measured, and nothing in
this page or the qualification record should be read to promise it. The pieces that would have to line up (the
extension host, the workspace URI scheme, the sidecar and the process host, and where each backend CLI is
found) are recorded as `unobserved` in
[Backend containment qualification](../architecture/backend-containment-qualification.md), section 8, with the
prerequisite for observing them. The extension declares no `extensionKind`.

## Per-phase capability sets (FR-R3-086)

A Phase definition may declare `capabilities` — any subset of `workspace-write`,
`outside-workspace-write`, `process-spawn`, `network`. The set is frozen into the Run's plan snapshot,
so what an agent may do is part of the plan the operator approved rather than a property of the machine
it runs on.

**Omitting it means every capability**, which is what every phase does today: the adapter spawns with
exactly the argv it spawned with before this existed. Narrowing is opt-in, per phase.

The host does not intercept tool calls. It translates the declared set into the chosen backend's own
enforcement flags, and the backend's permission engine refuses at the attempt:

| Backend | Capabilities it can withhold | How | Enforcement class | What it leaves open |
|---|---|---|---|---|
| `claude` | all four (`network` only partly; see the third limit) | `--disallowedTools`, `--permission-mode` | tool restriction | tools the denylist does not name (`unlisted-tools`), always; and, while `process-spawn` stays granted, a shell that can still reach the network or write files (`shell-network`, `shell-workspace-write`, `shell-outside-workspace-write`) |
| `codex` | `workspace-write`, `outside-workspace-write`, `process-spawn` | one `--sandbox` mode, the strictest the set needs | the CLI's own sandbox | nothing, except that withholding `process-spawn` still lets model-run commands execute, inside Codex's read-only sandbox (`sandboxed-commands-run`) |
| `agy` | `process-spawn` only | `--sandbox` | the CLI's own sandbox | the scope of Agy's sandbox has not been qualified (`sandbox-scope-unqualified`) |

Each of the 48 combinations of backend and granted set has a declared outcome, checked against a table
written out by hand. A **tool restriction** is the CLI's tool layer applying a denylist to itself;
a **CLI sandbox** is the vendor's own, which the vendor claims sits below the tool layer. The record
qualifies only that the flag is listed by the installed CLI's `--help`
([Backend containment qualification](../architecture/backend-containment-qualification.md), section 7); it does
not verify the vendor's claim. When a set needs a flag no capture has confirmed the installed CLI lists, the
phase is refused and the refusal says the flag could not be confirmed.

**A capability a backend cannot express refuses the phase before it starts**, recording a
`capability-refused` audit event naming every unenforceable capability. It is not run with the declared
set ignored — an unbounded phase where a narrower set was approved is the failure the mechanism exists
to prevent.

**Three stated limits**, repeated here because an operator reading this table will otherwise infer more:

- the host trusts the backend to apply the flags it was given; nothing here verifies that;
- `agy` bounds one of the four, so a narrowed phase on that backend is usually a refusal rather than a
  bounded run;
- on `claude`, withholding `network` adds `--disallowedTools WebFetch,WebSearch` and nothing else: it
  removes the two fetch tools, not network reach. A phase that keeps `process-spawn` keeps `Bash`, and
  `Bash` reaches the network (`curl`, `git`, `npm`). A Claude restriction is a tool-access restriction, not
  OS network or filesystem isolation. See [the threat model](../security/threat-model.md) for what that
  leaves open.

The launcher says so before the Run starts: a launchable whose Phase declares a set that leaves something
open, or cannot be enforced, shows the host's sentence for it beside the authority notice, and the audit
rows record the same facts (`enforcement`, `residuals`, and for a refusal `unqualified`).

### Changes in FR-R4-F06

- **(a) No stored set is rewritten.** A definition that declares `capabilities` keeps exactly what it
  declared; nothing in this release edits, normalizes or re-saves one.
- **(b) Three Codex combinations now emit a valid argv.** A set that withholds `outside-workspace-write`
  together with `workspace-write`, with `process-spawn`, or with both used to emit `--sandbox` once per
  capability, joined into the value `read-only,workspace-write`, which Codex does not accept. They now
  emit `--sandbox read-only`, the strictest value, once.
- **(c) Cells newly refused for an unconfirmed flag: none.** The offline help capture of 2026-10-31 showed
  every flag the planner declares in the installed `claude`, `codex` and `agy` `--help`, so no combination
  that ran before is refused for want of a confirmed flag, and no stored definition is affected.

<!-- Source: src/contracts/phase-capabilities.ts -->
<!-- Source: src/services/capability-enforcement-plan.ts -->

## `sideEffects` and runner eligibility

The Phase `sideEffects` declaration does not restrict a child process. It drives the mutation plan, consent, and rollback checkpoint. A Phase declaring `sideEffects: git` is refused on Codex and must use a Git-capable runner because Codex's workspace-write sandbox keeps `.git` read-only.

<!-- Source: src/services/mutation-plan.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->

## Failure diagnostics

Use the Phase lifecycle audit fields (`exitCode`, `timedOut`, `killed`, and stream truncation metadata), then inspect the sanitized runtime log. Raw transcripts are local and unredacted. Claude alone currently writes adapter-specific verbose diagnostic artifacts when verbose logging is enabled.

<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->
<!-- Source: src/runner/claude-cli.ts -->
