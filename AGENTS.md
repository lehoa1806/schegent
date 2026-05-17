# AGENTS.md

This file provides guidance to autonomous coding agents (Codex, Cursor,
Claude Code) when working with this repository.

<!-- SPECKIT START -->
Active plan: [specs/056-principal-arch-hardening/plan.md](specs/056-principal-arch-hardening/plan.md)
For technical context, project structure, and verification commands, read the current plan.
<!-- SPECKIT END -->

## What this repo is

**Schegent** is a VS Code extension that orchestrates the Claude Code CLI
as a headless backend to autonomously drive the Speckit spec-driven
development pipeline (specify → clarify → plan → tasks → analyze →
implement → finalize).

The extension is **implemented**. Source code lives under [src/](src/).
For the architectural map, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Verification commands

These are real, runnable commands — not placeholders:

```bash
npm run typecheck          # tsc --noEmit on the host
npm run typecheck:webview  # tsc --noEmit on the Svelte app
npm run lint               # eslint --ext .ts src tests
npm run test               # vitest run + webview-ui test
npm run build              # esbuild host + Vite webview
npm run test:integration   # @vscode/test-electron host smoke tests
npm run ci                 # the full pre-merge gate
```

Run `npm run ci` before opening a PR.

## Speckit-driven workflow

This project is managed via [Speckit](https://github.com/github/spec-kit)
v0.8.7. Always prefer the slash commands over hand-rolling spec/plan/task
files:

| Slash command | Skill file | Purpose |
|---|---|---|
| `/speckit-constitution` | [.claude/skills/speckit-constitution/SKILL.md](.claude/skills/speckit-constitution/SKILL.md) | Fill in [.specify/memory/constitution.md](.specify/memory/constitution.md) |
| `/speckit-specify` | [.claude/skills/speckit-specify/SKILL.md](.claude/skills/speckit-specify/SKILL.md) | Create `specs/<NNN-name>/spec.md` from a feature description |
| `/speckit-clarify` | [.claude/skills/speckit-clarify/SKILL.md](.claude/skills/speckit-clarify/SKILL.md) | Resolve open questions in the spec |
| `/speckit-plan` | [.claude/skills/speckit-plan/SKILL.md](.claude/skills/speckit-plan/SKILL.md) | Generate the implementation plan |
| `/speckit-tasks` | [.claude/skills/speckit-tasks/SKILL.md](.claude/skills/speckit-tasks/SKILL.md) | Break the plan into tasks |
| `/speckit-analyze` | [.claude/skills/speckit-analyze/SKILL.md](.claude/skills/speckit-analyze/SKILL.md) | Audit cross-artifact consistency |
| `/speckit-implement` | [.claude/skills/speckit-implement/SKILL.md](.claude/skills/speckit-implement/SKILL.md) | Execute tasks |
| `/speckit-bugfix-*` | bugfix extension | Trace and patch bugs across spec artifacts |

Templates live in [.specify/templates/](.specify/templates/) and shell
helpers in [.specify/scripts/bash/](.specify/scripts/bash/).

## Hooks fire automatically

[.specify/extensions.yml](.specify/extensions.yml) wires the git and
bugfix extensions into every Speckit command:

- `before_specify` runs `/speckit-git-feature` (mandatory) —
  auto-creates a feature branch.
- `before_*` / `after_*` clarify/plan/tasks/implement/checklist/analyze/
  taskstoissues offer optional `/speckit-git-commit` prompts.
- `after_implement` offers `/speckit-bugfix-verify` to check
  spec/plan/tasks consistency.

When invoking `/speckit-*`, follow the skill file's pre-execution hook
check exactly — read `.specify/extensions.yml`, surface optional hooks,
execute mandatory ones, and **wait for the result** before proceeding.
Slash-command names derive from extension names by replacing `.` with `-`
(`speckit.git.commit` → `/speckit-git-commit`).

## Project conventions

- **Branch numbering**: `sequential`. Feature branches and spec dirs are
  numbered `001-…`, `002-…`.
- **Spec location**: `specs/<NNN-short-name>/spec.md`.
- **Clarification budget**: spec authoring is capped at 3
  `[NEEDS CLARIFICATION]` markers — make informed defaults for the rest
  and document them in the spec's Assumptions section.
- **Auto-commits**: disabled by default. Honor the user's choice rather
  than committing unprompted.
- **Architecture drift**: every PR that touches host structure or IPC
  contracts must update [ARCHITECTURE.md](ARCHITECTURE.md) and any
  affected operations docs.

## Key local trust constraints

Schegent runs an autonomous local Claude CLI backend with broad
workspace capabilities. Read [docs/security/threat-model.md](docs/security/threat-model.md)
before changing the audit pipeline, the redaction set, the lock
semantics, or the webview IPC layer.

### Hard rules

The full set of hard rules is maintained in [CLAUDE.md](CLAUDE.md)
under the "Hard rules when changing host code" section. **CLAUDE.md
is the single source of truth.** Any autonomous coding agent working
in this repository — Claude Code, Codex, Cursor, or any other —
MUST read and obey those rules. The parity guard at
[tests/lint/agents-claude-parity.test.ts](tests/lint/agents-claude-parity.test.ts)
asserts that the topical anchors below appear in CLAUDE.md so the
two files cannot silently drift.

Short summary (non-authoritative; consult CLAUDE.md for the full
text, citations, and rationale):

- **Never** weaken the redaction set in [src/lib/logger.ts](src/lib/logger.ts).
- **Never** route untrusted strings to the UI without sanitization.
- **Never** weaken CSP for webviews. No remote `script-src` permitted.
- **Never** skip lock release. Use the existing `lockReleased` flag
  pattern in `WorkflowController.driveRun()`.
- **Never** drop unknown audit event types from the parser. Warn and
  preserve.
- **Never** bypass `appendAudit` or the raw transcript writer for
  custom-phase invocations. Custom phases (`schegent.phases`, spec 009)
  flow through the identical audit + redaction + transcript path as
  built-ins. Custom-phase audit payloads must carry `pipelineId`,
  `phaseId`, and (when set) `model` / `effort` / `timeoutMs`. See
  [docs/security/threat-model.md](docs/security/threat-model.md) T9.
- **Never** mutate or retarget an in-flight `WorkflowRun.pipeline`
  snapshot from settings changes. Catalog reloads only affect newly
  enqueued runs (FR-013).
- **Never** implement task or phase deletion by erasing the structured
  `<workspaceRoot>/.schegent/audit.log` file. The audit log is append-only
  and must preserve append-only evidence across every deletion path.
- **Never** roll back the queue removal on session-cleanup I/O failure.
  The structured `.schegent/audit.log` is append-only and never deleted
  by task removal. The per-runId session tree under
  `.schegent/sessions/<runId>/` and the sibling `raw-<runId>.log` MAY be
  removed on operator-confirmed task deletion (feature 034). The cleanup
  is best-effort: I/O failure MUST be logged via `SanitizedLogger.warn`
  and MUST NOT roll back the queue removal.
- **Never** add inline `postCommand(CMD_SAVE_PHASES, …)` call sites in
  webview components. Use
  [webview-ui/src/lib/save-phases.ts](webview-ui/src/lib/save-phases.ts).
  The repo-grep regression at
  [tests/lint/no-inline-save-phases.test.ts](tests/lint/no-inline-save-phases.test.ts)
  fails the build on any drift; the allowlist is maintained in that
  test. A user-layer save MUST be accepted even when the workspace
  layer shadows the same row — the shadow only affects the *effective*
  run-time value, not the persisted user-layer record (026 FR-021).
- **Never** compute phase-catalog precedence in the webview — read
  `snapshot.phasePrecedence` from the host projection. The projection
  is **UI-only** and is never persisted or logged. The composite-key
  shape is `"<phaseId>::<fieldKey>"` covering the per-phase tunable
  keys (`model`, `effort`, `timeoutSeconds`, `loopable`,
  `retryCondition`); the UI consumes the `model` and `effort` keys
  today and the remaining keys are reserved for forward UI use without
  a fresh contract change. The host recomputation point is
  [src/ui/sidebar/snapshot.ts](src/ui/sidebar/snapshot.ts); the pure
  projection module is
  [src/config/phase-precedence.ts](src/config/phase-precedence.ts)
  (no `vscode` import, no I/O) (026).
- **Never** persist a `WorkflowRun` with `manualPauseCause ===
  'breakpoint-paused'` and `resumeTargetPhaseId === null`, or
  conversely a non-null `resumeTargetPhaseId` paired with any other
  `manualPauseCause`. The pair is both-set-or-both-cleared and is
  enforced in `WorkspaceStateStore.setRun()`. The legacy
  both-null-or-both-non-null invariant on `manualPauseAt` /
  `manualPauseCause` is preserved and now accepts `'breakpoint-paused'`
  alongside `'operator-paused'` (028 T008).
- **Never** mutate `WorkflowRun.phaseBreakpoints` from outside
  `WorkflowController`. The breakpoint set is `Object.freeze`-d and
  rewritten by `setPhaseBreakpoint` / `clearPhaseBreakpoint` /
  `driveRun` only. Direct mutation would bypass the
  `phase-breakpoint-set` / `-cleared` audit emission and the
  pipeline-membership / no-double-override invariants (028 T008,
  T015–T017).
- **Never** add inline `postCommand(CMD_SET_PHASE_BREAKPOINT, …)` or
  `postCommand(CMD_CLEAR_PHASE_BREAKPOINT, …)` call sites in webview
  components. The shared helper at
  [webview-ui/src/lib/phase-breakpoint-ipc.ts](webview-ui/src/lib/phase-breakpoint-ipc.ts)
  is the SINGLE call site for both commands — mirrors the
  `save-phases.ts` / `phase-log-ipc.ts` discipline. The repo-grep
  regression at
  [tests/lint/no-inline-phase-breakpoint-ipc.test.ts](tests/lint/no-inline-phase-breakpoint-ipc.test.ts)
  fails the build on any drift; the allowlist of legitimate
  importers is pinned in that test (028 T010, T044).
- **Never** register a new mutating IPC command without adding it to
  `MUTATING_COMMANDS` in [src/ui/sidebar/messages.ts](src/ui/sidebar/messages.ts).
  The primary-host gate there is the ONLY thing preventing a
  secondary VS Code window from mutating workspace state during a
  multi-window session. The two 028 additions
  (`CMD_SET_PHASE_BREAKPOINT`, `CMD_CLEAR_PHASE_BREAKPOINT`) are
  members; any future addition must follow suit (028 T012, mirrors
  the 011/014/020 pattern).
- **Never** clear `QueueRegistryEntry.pauseSource === 'operator'`
  when resuming a phase. The cascade resume path in
  `WorkflowController.resumeActivePhase()` may only clear the queue
  pause when `pauseSource === 'cascade'`; an independent operator
  queue-pause MUST survive phase resume (operator-wins precedence;
  028 FR-008 / SC-003).
- **Never** widen the floor for a `manualPauseCause = 'breakpoint-paused'`
  outside the breakpoint-fired branch of `driveRun`. The cause is
  set only at the cooperative pause boundary when the next phase
  matches a registered breakpoint, and is cleared by the resume path
  alongside `resumeTargetPhaseId` (028 FR-005, FR-007).
- **Never** re-stringify or re-sanitize
  `PhaseLogEntryBody.toolArguments` on the webview side. The field is
  host-sanitized at the existing IPC boundary in
  [src/services/phase-log/phase-log-reader.ts](src/services/phase-log/phase-log-reader.ts)
  / [src/services/phase-log/phase-log-tail-session.ts](src/services/phase-log/phase-log-tail-session.ts)
  via the same `SanitizedLogger.sanitize` call as the rest of the
  pipeline — `SECRET_PATTERNS` stays the SINGLE source of truth. A
  second sanitizer on the webview, or a re-encode → re-parse round
  trip in the view layer, is forbidden; the webview consumes the
  field as a typed JSON value only. The lint regression at
  [tests/lint/no-html-interpolation-in-activity-feed.test.ts](tests/lint/no-html-interpolation-in-activity-feed.test.ts)
  fails the build if any `PhaseLogFeed/` Svelte component reaches for
  `{@html …}` interpolation of operator-influenced strings (029 FR-017).
- **Never** `import 'vscode'` (directly or transitively) from
  [src/wakeup/](src/wakeup/). The wake-up session-log writer at
  [src/wakeup/session-log-writer.ts](src/wakeup/session-log-writer.ts)
  and any sibling modules reached by the bundled
  `dist/wakeup-runner.js` entry MUST stay vscode-free for the same
  reason as the rest of `src/headless/` (014): the OS scheduler
  spawns the runner detached from the extension host. A lint
  regression test in [tests/lint/](tests/lint/) greps the bundled
  output and fails the build on any drift (031).
- **Never** widen the closed
  `WAKEUP_SUPPORTED_MODELS = ['claude-opus-4-7',
  'claude-sonnet-4-6', 'claude-haiku-4-6']` registry at runtime.
  The registry is code-resident in [src/wakeup/models.ts](src/wakeup/models.ts)
  (or equivalent) and is the SINGLE source of truth for the
  webview dropdown, the host validator, and the runner
  invocation contract. The sentinel `RUNNER_DEFAULT_MODEL =
  'runner-default'` selects whatever the CLI defaults to. An
  operator value outside the closed set MUST be rejected at the
  `CMD_SAVE_WAKEUP_SETTINGS` boundary and MUST fall back to
  `'runner-default'` on the runner side; the actual model in use
  is recorded in the `actualModel` field of the
  `wakeup-runner-invocation` audit payload (031 FR-002, FR-022).
  Operator-additive parity with `schegent.fatalSignatures` is
  intentionally out of scope for v1.
- **Never** consume operator-supplied path components for the two
  new wake-up read-only IPCs `CMD_READ_WAKEUP_SESSION_LOG` and
  `CMD_REVEAL_WAKEUP_SESSION_LOG`. The IPC payload carries
  identifiers (correlation id, block offset/limit, etc.) only; the
  host MUST compose the session-log path from its own
  `<globalStorageUri>/wakeup/` base. Even though the two commands
  are READ-ONLY (and therefore correctly absent from
  `MUTATING_COMMANDS`), the handlers MUST gate on
  `isPrimaryHost()` to keep multi-window sessions from racing on
  the same on-disk artifact during retention trimming (031
  FR-014, FR-015).
- **Never** sanitize, truncate, or otherwise transform the bytes
  written to `<globalStorageUri>/wakeup/session.log` by the
  wake-up session-log writer. The writer is a SINK — like the
  verbose diagnostic sink at
  `<workspaceRoot>/.schegent/sessions/.../verbose.log` (010 T10)
  — and the bytes have already been redaction-passed by
  `SanitizedLogger` upstream. A second sanitizer in the writer
  module is forbidden; double sanitization is forbidden. The
  32 MB soft cap (`SESSION_LOG_MAX_BYTES`) trims oldest complete
  blocks to recover headroom; the 128 MB hard cap
  (`SESSION_LOG_HARD_CAP_BYTES`) is an absolute backstop. The
  `sessionLogTrimmed` counter on the `InvocationRecord` JSONL row
  MUST reflect the trimmed-bytes count for that invocation; the
  counter is NEVER mirrored into the
  `wakeup-runner-invocation` audit payload — that payload remains
  paths-free and counter-free for size discipline (031 FR-008,
  FR-009).
- **Never** add inline `postCommand(CMD_READ_WAKEUP_SESSION_LOG,
  …)` or `postCommand(CMD_REVEAL_WAKEUP_SESSION_LOG, …)` call
  sites in webview components. Use
  [webview-ui/src/lib/wakeup-session-log-ipc.ts](webview-ui/src/lib/wakeup-session-log-ipc.ts)
  and
  [webview-ui/src/lib/reveal-wakeup-session-log.ts](webview-ui/src/lib/reveal-wakeup-session-log.ts)
  respectively. The repo-grep regression tests in
  [tests/lint/](tests/lint/) fail the build on any drift; the
  allowlist of legitimate importers is pinned in those tests
  (031 T013-T015, mirrors the 020 phase-log-ipc pattern).
- **Never** append `-c` (Claude CLI `--continue`) to the spawned
  argv from anywhere other than
  [src/runner/claude-cli.ts](src/runner/claude-cli.ts) based on
  `request.isContinue === true`. The
  `SchegentWorkflowController` dispatch matrix is the SINGLE source
  of truth for the continuation hint: `retryPhaseNow`,
  `resumeActivePhase`, and `resumeExisting` (when the persisted run
  has a non-null pause-cause or pending-retry-cause) arm the
  controller's private `nextDispatchIsContinue` flag; `driveRun()`
  consumes-and-resets it on the first runner call so subsequent loop
  iterations and phase advancements within the same invocation
  revert to `isContinue: false`. `restartActivePhase`, `startNew`,
  loop iterations, and bugfix-loop iterations MUST NOT arm the flag.
  Runner-side magic (appending `-c` based on env vars, retry
  counters, or upstream argv inspection) is forbidden; the
  `=== true` strict gate in `ClaudeCliRunner.invoke` is the ONLY
  append site. The `phase-start` audit payload's mandatory
  `isContinue: boolean` field uses the SAME strict gate so the
  audit record and the spawned argv stay in lock-step. Additive
  field — no `AUDIT_SCHEMA_VERSION` bump, no persisted state shape
  change (the hint is derived per-dispatch, never stored on
  `WorkflowRun`). See
  [specs/032-context-preserving-retries/spec.md](specs/032-context-preserving-retries/spec.md)
  (032 FR-001 / FR-007 / FR-013).

## What you'll be doing here

Most work is now feature-level: bug fixes, new commands, UI polish,
performance tuning, additional backends. Every change must:

1. Stay within the requested scope.
2. Preserve the trust boundaries above.
3. Pass `npm run ci` locally before commit.
4. Update [ARCHITECTURE.md](ARCHITECTURE.md) and operations docs when
   host structure or persistence shape changes.

For the full architectural picture before planning anything that touches
runtime behavior, read [ARCHITECTURE.md](ARCHITECTURE.md) and the active
plan at the top of this file.
