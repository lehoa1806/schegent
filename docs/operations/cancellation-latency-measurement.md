# Sidebar Cancellation Latency Measurement and Ordering Decision (`FR-R7-18` / `N01`)

**Measured**: 2026-11-24 · **Item**: `FR-R7-18` (`N01`, `FR-001`, `SC-001`, `specs/332-recovery-verification-gaps/spec.md`) · **Decision**: Reclassify `CMD_CANCEL` as `gatedConcurrent('workflow cancellation')`, add a payload-scoped concurrency bypass in `MessageRouter` strictly for workflow-cancel `CMD_CONTINUE_WORKFLOW` payloads, and guard `task-canceled` audit emission behind terminal-transition ownership in `cancel.ts`.

This page records the repeatable sidebar cancellation dispatch and acknowledgement latency measurements while real serialized start (`CMD_START_QUEUE`) and teardown (`CMD_CLEAR_QUEUE`, `CMD_REMOVE_QUEUE_ITEM`) mutations are held pending for `>= 500 ms`, together with the ordering, gating, replay-deduplication, and single-terminal-transition invariant proofs.

<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/ui/sidebar/mutation-command-executor.ts -->
<!-- Source: src/commands/cancel.ts -->
<!-- Source: tests/integration/sidebar-cancel-behind-slow-mutation.test.ts -->
<!-- Source: docs/reference/api-and-cli.md -->

> **Single-platform qualification notice**: Every figure on this page was measured locally on one machine (`darwin/arm64`, Apple M4 Max, local APFS, Node `v24.22.2`). These figures provide single-platform risk reduction rather than a cross-platform guarantee; Linux and Windows hosts remain unobserved until measured on those platforms.

---

## 1. Problem and Ordering Decision

Before `FR-R7-18` (`N01`), `CMD_CANCEL` and every `CMD_CONTINUE_WORKFLOW` payload ran with `serialize: true` on the single global `MutationCommandExecutor` promise chain shared across all queues and webviews. Any long-running serialized mutation — such as `CMD_START_QUEUE` awaiting isolated lane provisioning (`provisionRunLane`, up to 120–600 s) or modal Git mutation approval (`requestGitApproval`), `CMD_CLEAR_QUEUE` waiting on runner stop (`waitForQueueRunnerStop`, up to 2 s), or `CMD_REMOVE_QUEUE_ITEM` awaiting recursive `sessionCleanup` — starved sidebar cancellation even when targeting an unrelated queue.

Three coordinated host changes close this gap without weakening any boundary invariant:

1. **`COMMAND_AUTHORITY.CMD_CANCEL` → `gatedConcurrent('workflow cancellation')`** (`src/contracts/sidebar-command-metadata.ts`): keeps `CMD_CANCEL` in the 57-command gated set (moving the gated execution split to 11 concurrent / 46 serialized) while passing `{ serialize: false }` to `MutationCommandExecutor.execute`.
2. **Payload-scoped cancellation bypass for `CMD_CONTINUE_WORKFLOW`** (`src/ui/sidebar/message-router.ts`, `src/services/workflow-execution/continuation-service.ts`): `CMD_CONTINUE_WORKFLOW` stays `gated` (`serialized`) by default in `COMMAND_AUTHORITY`, and `MessageRouter.dispatch` passes `{ serialize: false }` strictly when `isWorkflowCancelCommand(command, hasControlCommandService(this.deps))` holds:
   - `payload.controlCommand` is present, a `controlCommandService` (or `controlCommandServiceDeps`) is wired on `deps`, and `payload.controlCommand.action.kind === 'cancel'`, **or**
   - `payload.controlCommand` is absent and `payload.operation === 'cancel'`.
   - Any non-cancel continuation or control action — including a mixed payload carrying a non-cancel `controlCommand` alongside `operation: 'cancel'`, or an unserviced `controlCommand` when `controlCommandService` is not wired — remains strictly serialized behind the global mutation chain, and `continueConnectedRun` fails closed (`LAUNCHER_UNAVAILABLE`) on an unserviced `controlCommand` instead of falling through to `operation` or `continueWorkflow`.
3. **Race-free `task-canceled` audit emission** (`src/commands/cancel.ts`): `cancelByTaskId` (and `cancelActiveRun`) now append the metadata-only `task-canceled` audit row **only after** claiming the single terminal transition (`queue.finish(id, 'canceled')` returns `{ ok: true }`, or `markCanceled` claims the terminal Run transition in `cancelActiveRun` when no queue row owned the task). A concurrent cancel that loses a race to another cancel, normal completion, task deletion, or queue clear returns a coded refusal and appends zero stray `task-canceled` audit entries.

---

## 2. Measurement Environment and Reproduction

| Field | Captured Value |
|---|---|
| Date (UTC) | 2026-11-24 |
| Hardware / machine class | Apple M4 Max (16 cores, 64.0 GiB RAM) |
| OS / architecture | macOS 27.0 (`darwin` 27.0.0, build `26A428`, `arm64`) |
| Node.js runtime | `v24.22.2` |
| Host load average (`1m / 5m / 15m`) | `5.31 / 3.85 / 3.17` |
| Base commits | Master `0f4eed74`, `repo/` `3efdb44f` + `N01` changes |
| Acceptance ceiling (`SC-001`) | Cancel dispatch `< 250 ms` and ACK `< 250 ms` while held mutation stays pending `>= 500 ms` |
| Reproduction command (from `repo/`) | `SCHEGENT_PRINT_N01_REPORT=1 npx vitest run tests/integration/sidebar-cancel-behind-slow-mutation.test.ts --reporter=verbose` |

---

## 3. Measured Ordering and Latency Results

Each scenario drives the real `MessageRouter.dispatch` entry point against real production command orchestrators (`runStartQueueCommand` → `AutoDrainCoordinator` → `SchegentWorkflowController` → `WorkflowRunFactory`, `runClearQueue` → `waitForQueueRunnerStop`, `controller.deleteTask` → `deleteTaskWithSessionCleanup`, `runCancel`, and `continueConnectedRun`), parking the slow serialized mutation on a controllable deferred barrier held for `>= 500 ms` (`520 ms` target release).

| Scenario (Held Slow Serialized Mutation → Concurrent Cancellation) | Cancel Dispatch Latency (ms) | Cancel ACK Latency (ms) | Held Mutation Elapsed (ms) | Completed While Held | Ceiling (`< 250 ms`) |
|---|---|---|---|---|---|
| `CMD_START_QUEUE` (`provisionRunLane`) → `CMD_CANCEL` | `0.038` | `2.980` | `525.973` | Yes | **PASS** (83.9× headroom) |
| `CMD_START_QUEUE` (`requestGitApproval`) → `CMD_CANCEL` | `0.021` | `0.632` | `522.292` | Yes | **PASS** (395× headroom) |
| `CMD_CLEAR_QUEUE` (`waitForQueueRunnerStop`) → `CMD_CANCEL` | `0.021` | `0.648` | `538.021` | Yes | **PASS** (385× headroom) |
| `CMD_REMOVE_QUEUE_ITEM` (`sessionCleanup`) → `CMD_CANCEL` | `0.021` | `0.632` | `523.572` | Yes | **PASS** (395× headroom) |
| `CMD_START_QUEUE` (`provisionRunLane`) → `CMD_CONTINUE_WORKFLOW` (`controlCommand.action.kind: 'cancel'`) | `0.195` | `0.214` | `523.934` | Yes | **PASS** (1,168× headroom) |
| `CMD_START_QUEUE` (`provisionRunLane`) → `CMD_CONTINUE_WORKFLOW` (`operation: 'cancel'`) | `0.034` | `1.321` | `523.934` | Yes | **PASS** (189× headroom) |

- **Worst measured dispatch latency**: `0.195 ms` (`< 250 ms`).
- **Worst measured ACK latency**: `2.980 ms` (`< 250 ms`, including on-disk `.schegent/audit.log` creation and hash-chained append on the first cancel).
- **Non-cancel ordering verification**: Non-cancel `CMD_CONTINUE_WORKFLOW` mutations (`controlCommand.action.kind: 'pause'` and mixed payload `{ operation: 'cancel', controlCommand: { action: { kind: 'resume' } } }`) submitted **before** the cancel commands remained queued behind the held `CMD_START_QUEUE` (`0` ACKs while held) and dispatched strictly after `CMD_START_QUEUE` settled at `523.934 ms`, producing observed control dispatch order `['cancel', 'pause', 'resume']`.

---

## 4. Invariant Proof Summary

All invariants in [API and command reference](../reference/api-and-cli.md#webview-command-boundary), [What a refused command shows](../reference/api-and-cli.md#what-a-refused-command-shows), and [Repeat protection](../reference/api-and-cli.md#repeat-protection) remain intact and are verified directly by `tests/integration/sidebar-cancel-behind-slow-mutation.test.ts` alongside the unit and lint gates:

| Invariant | Verification Coverage | Observed Outcome |
|---|---|---|
| Workspace trust & window primacy gating | Untrusted (`trusted=false, primary=true`), secondary (`trusted=true, primary=false`), and untrusted-secondary (`trusted=false, primary=false`) dispatch for `CMD_CANCEL` and both workflow-cancel `CMD_CONTINUE_WORKFLOW` forms | Refused before handler (`untrusted-workspace`, `secondary-window-readonly`, trust checked first); `0` handler calls, `0` audit rows |
| Correlation-ID in-flight join & replay cache | Concurrent duplicate `correlationId` joining an in-flight `CMD_CANCEL` + post-completion replay for both `CMD_CANCEL` and workflow-cancel `CMD_CONTINUE_WORKFLOW` | Handler executed strictly once; joined and replayed callers received identical frozen first ACK |
| Single terminal transition & zero stray `task-canceled` audits | (a) Two concurrent `CMD_CANCEL` with distinct correlation IDs on the same task; (b) `CMD_CANCEL` racing same-task `completed` transition; (c) `CMD_CANCEL` racing `CMD_REMOVE_QUEUE_ITEM` deletion | Case (a): exactly 1 `accepted`, 1 `rejected`, 1 `task-canceled` audit row; Cases (b) and (c): losing cancel `rejected`, winning state (`completed` / removed) preserved, `0` stray `task-canceled` audit rows |
| Pinned metadata & reference parity | `sidebar-command-metadata.test.ts`, `mutating-commands-pinned-list.test.ts`, `webview-command-reference-parity.test.ts`, `asserted-counts.test.ts`, `command-authority-routing.test.ts` | 57 gated (11 concurrent, 46 serialized) + 14 read-only = 71 commands; all parity gates pass |

---

## 5. Scope Boundary and Re-Measurement Triggers

- These figures isolate host-side `MessageRouter` dispatch, trust/primacy gating, correlation-ID deduplication, state transition, and `.schegent/audit.log` append latency on `darwin/arm64`. They do not measure VS Code webview frame scheduling or backend child-process `SIGTERM`/`SIGKILL` exit duration after `controller.cancelActive(queueId)` signals abort.
- Re-run this measurement suite if `MutationCommandExecutor` queueing changes, if additional command families gain payload-scoped concurrency bypasses, or when qualifying Linux or Windows desktop hosts.
