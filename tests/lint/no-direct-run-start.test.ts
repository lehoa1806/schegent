// Feature 013 T033 — repo-grep regression enforcing FR-006/FR-007/FR-008.
//
// `GuardedRunService` is the SINGLE guarded entry point for run-starting
// and queue-mutating run-start paths. Direct calls to `queue.enqueue(`
// and `controller.startNew(` from command handlers or webview IPC
// handlers are forbidden — they bypass the validation/audit/lock
// boundary the service provides.
//
// This test scans `src/**/*.ts` for both patterns and fails if any file
// outside the allowlist matches. The allowlist is intentionally narrow:
// only the service itself, the queue/controller implementations that
// own those methods, and the queue-ops helpers that the service
// composes with.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src');

// Files allowed to reference `queue.enqueue(` or `controller.startNew(`.
// These are implementation files (the methods are defined here or are
// composed by the guarded service) — not command handlers.
const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The single guarded entry point.
  'src/services/guarded-run-service.ts',
  // QueueManager defines `enqueue` itself.
  'src/queue/queue-manager.ts',
  // Queue ops helpers (clearCompleted/clearFailed/pause/resume/retry) — they
  // don't start a new run; they manipulate existing queue items.
  'src/commands/queue-ops.ts',
  // The controller defines `startNew` itself; the workflow-controller is
  // allowed to call `queue.enqueue` only as part of its own internal
  // bookkeeping (auto-drain, etc). Audit any call here carefully.
  'src/controller/workflow-controller.ts',
  // Feature 013 Wave 7 (T099): auto-drain orchestration extracted from
  // `WorkflowController`. Calls `this.controller.startNew(next, null)`
  // ONLY as the four-step gate's terminal step. This is system-internal
  // (not a user-initiated call) and the four-step gate (paused, inFlightId,
  // peekNextPending, lock.tryAcquire) provides the same invariants as
  // GuardedRunService for this internal promotion path.
  //
  // Feature 092 (T051) — that gate is now seven ordered steps and takes a
  // `queueId`; the allowlist entry is unchanged because what it permits is
  // unchanged.
  'src/services/auto-drain-coordinator.ts'
]);

// Feature 092 (T063, FR-034, SC-011) — the four entrances to the start path.
//
// FR-034 names them: auto-drain, the guarded run service, the operator
// start-queue action, and the headless run interface. Each MUST be able to say
// which queue it is acting on, so each MUST mention `queueId` — a start path
// that cannot name a queue silently means "the default one", which is precisely
// the collapse this feature reverses.
//
// The operator action appears twice because it is two files: the IPC handler
// that receives the addressed queue and the host command that acts on it.
// Threading one and dropping the other loses the id in between.
const START_PATH_ENTRANCES: readonly string[] = [
  'src/services/auto-drain-coordinator.ts',
  'src/services/guarded-run-service.ts',
  'src/ui/sidebar/commands/cmd-start-queue.ts',
  'src/commands/start-queue.ts',
  'src/headless/pipeline-run-api.ts'
];

// Feature 092 (T063) — every file that reaches a run-start or enqueue seam.
//
// This is the fifth-entrance gate SC-011 asks for: the seam patterns below are
// grepped across `src/`, and any matching file not declared here fails. Adding a
// fifth entrance therefore cannot be done silently — the author has to name it
// here, which is the moment they are asked whether it carries a `queueId`.
//
// Declared-but-not-an-entrance files are listed too, and deliberately: they call
// an enqueue seam rather than a start seam, so FR-034's queue-identification
// obligation does not reach them, but a new caller appearing among them is still
// a change to the start surface that someone has to look at.
// Feature 093 (T049a) — `admitNew` is the same seam as `startNew` with the
// drive handed back instead of awaited, so it is guarded on identical terms.
// Listing only `startNew` would leave a caller one word away from the gate:
// `controller.admitNew(feature, null)` starts a Run exactly as `startNew` does,
// and a file reaching it would have matched nothing here.
const START_SEAM_METHODS: readonly string[] = [
  'controller\\.startNew(',
  'controller\\.admitNew('
];

const SEAM_CALL_PATTERNS: readonly string[] = [
  ...START_SEAM_METHODS,
  'drainIfIdle(',
  'applyStartQueueIntent(',
  'scheduleOrEnqueue(',
  'startPipelineRun('
];

const DECLARED_SEAM_CALLERS: ReadonlySet<string> = new Set([
  ...START_PATH_ENTRANCES,
  // Owns `drainQueuedWork` / `startNew`; delegates to the coordinator.
  'src/controller/workflow-controller.ts',
  // Enqueue-side callers of the guarded service (feature 013 onward).
  'src/commands/enqueue.ts',
  'src/commands/rerun-from-history.ts',
  'src/commands/retry-active-run.ts',
  'src/commands/schedule.ts',
  'src/ui/sidebar/commands/cmd-start.ts',
  'src/ui/sidebar/commands/router-types.ts',
  // The shared four-gate start seam and its two callers (feature 088).
  'src/services/workflow-execution/node-run-starter.ts',
  'src/services/workflow-execution/workflow-launcher.ts',
  'src/ui/sidebar/commands/cmd-launch-pipeline.ts',
  // Wiring only: registers the host command, starts nothing itself.
  'src/activation/ui-wiring.ts',
  'src/extension.ts',
  // FR-R3-002 (T284/T285) — the scheduled-start pair. Both reach the start
  // path, and neither does so in a way this grep can see: each calls an
  // *injected* callback (`promote` on the watchdog, `onFire` on the
  // coordinator), and `src/extension.ts` supplies the same
  // `promoteScheduledQueue` to both — that one function is where the
  // `drainQueuedWork(queueId)` actually happens. They match here only on the
  // `drainIfIdle(` their comments name.
  //
  // Declaring them anyway is the point of this list. A file that can cause a
  // queue to start belongs on the start surface whether or not the seam call
  // is lexically present, and both thread a `queueId` through every hop, so
  // the FR-034 question this declaration exists to ask is answered.
  //
  // Neither is added to START_PATH_ENTRANCES: that list is FR-034's own
  // enumeration of four, and these are a later feature's callers of one of
  // them, not a fifth entrance alongside them.
  'src/controller/schedule-watchdog.ts',
  'src/services/scheduled-start-coordinator.ts',
  // Contract and type declarations, not call sites.
  'src/contracts/sidebar-ipc.ts',
  // Feature 102 (FR-025) — one `import type` and one `export interface`, 51
  // lines, no runtime code at all. It matches on prose: the doc comment on
  // `CatalogVersionRef` says the frozen plan is "carried through
  // `guardedRun.scheduleOrEnqueue()` untouched", which is the immutability
  // claim the field exists to make. Named rather than paraphrased, because the
  // seam it survives is the point — a reader who has to guess which seam has
  // been told nothing. Declaring a types-only module here is safe in a way
  // declaring an implementation module would not be: there is no runtime import
  // for a call to hide behind, so the grep cannot go quiet on this file for any
  // reason but the one recorded.
  'src/contracts/catalog-version.ts'
]);

function listMatchingFiles(pattern: string): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rln --include="*.ts" "${pattern}" "${SCAN_ROOT}"`,
      { encoding: 'utf8' }
    );
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) => (abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs));
}

describe('Feature 013 T033 — no direct queue.enqueue / controller.startNew', () => {
  it('only the allowlisted files reference queue.enqueue(', () => {
    const matched = listMatchingFiles('queue\\.enqueue(');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Files calling queue.enqueue(...) outside the allowlist must go through GuardedRunService.\nOffenders:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it.each(START_SEAM_METHODS)('only the allowlisted files reference %s', (pattern) => {
    const matched = listMatchingFiles(pattern);
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Files calling ${pattern.replace(/\\/g, '')}...) outside the allowlist must go through GuardedRunService.\nOffenders:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('GuardedRunService is one of the matched files (sanity)', () => {
    const enqueueMatches = listMatchingFiles('queue\\.enqueue(');
    expect(enqueueMatches).toContain('src/services/guarded-run-service.ts');
  });
});

describe('Feature 092 T063 (FR-034, SC-011) — the start path is queue-identified', () => {
  it.each(START_PATH_ENTRANCES)('%s names the queue it acts on', (rel) => {
    const withQueueId = listMatchingFiles('queueId');
    expect(
      withQueueId,
      `${rel} is a start-path entrance and must identify the queue it starts (FR-034).`
    ).toContain(rel);
  });

  it('no undeclared file reaches a run-start or enqueue seam', () => {
    const matched = new Set<string>();
    for (const pattern of SEAM_CALL_PATTERNS) {
      for (const rel of listMatchingFiles(pattern)) matched.add(rel);
    }
    const undeclared = [...matched].filter((rel) => !DECLARED_SEAM_CALLERS.has(rel)).sort();
    expect(
      undeclared,
      'A new file reaches the start path. Declare it in DECLARED_SEAM_CALLERS, and if it is a '
        + 'fifth entrance, add it to START_PATH_ENTRANCES and thread a queueId through it '
        + '(FR-034).\nUndeclared:\n' + undeclared.join('\n')
    ).toEqual([]);
  });

  it('every declared entrance still exists (the list cannot rot silently)', () => {
    const missing = START_PATH_ENTRANCES.filter(
      (rel) => !existsSync(resolve(REPO_ROOT, rel))
    );
    expect(
      missing,
      `Declared start-path entrances that no longer exist:\n${missing.join('\n')}`
    ).toEqual([]);
  });
});
