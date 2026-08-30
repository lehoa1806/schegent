// Lifecycle round-check of 2026-08-30, finding A — the gate the bug report asked
// for: "a reachability assertion that every command which writes
// `status: 'pending'` has a drain trigger, so the fourth such command does not
// repeat this."
//
// WHAT WENT WRONG
//
// `AutoDrainCoordinator` is edge-triggered. Nothing polls; a queue drains only
// where a call site asks it to. Three separate implementations returned a Task
// to `pending` and asked for nothing — `runEnqueue` did ask, and the two that
// did not each carried a comment claiming "the dequeue pump picks it up on the
// next tick". No such pump exists. The operator saw the row go back to
// `pending` and sit there: no Run, no log, and no refusal to explain it.
//
// The belief in a pump is why the omission survived three implementations, and a
// comment is exactly what a lint cannot read. So this gate reads the two things
// it can: which source files put a Task into `pending`, and whether the command
// registration that reaches each one drains the queue it landed on.
//
// TWO DIRECTIONS, FOR THE REASON THE MUTATING PINNED LIST HAS TWO
//
//   1. Every registration named below contains `drainQueuedWork`. Catches a
//      trigger deleted in a refactor.
//   2. Every `status: 'pending'` writer in `src/` is classified in the table
//      below. Catches the failure that actually happened — a *fourth* writer
//      added with no trigger and nothing noticing, which direction (1) cannot
//      see because an unlisted writer is absent from both sides at once.
//
// Deriving either side from the other would make every assertion `X === X`.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const UI_WIRING = resolve(SRC_ROOT, 'activation', 'ui-wiring.ts');

// The literal that puts a Task into the state only a drain can leave.
const PENDING_WRITE = "status: 'pending'";

/**
 * Every file that writes `status: 'pending'`, and what reaches it.
 *
 * `commandId: null` means the write is not operator-initiated and has no
 * registration to carry a trigger. That is a claim about the write, not an
 * excuse for it, so it carries the same sentence-length reason as any other
 * entry here.
 */
interface PendingWriter {
  /** Repo-relative path, as `relativize` renders it. */
  readonly file: string;
  /** The `schegent.*` command whose registration must drain, or null. */
  readonly commandId: string | null;
  readonly reason: string;
}

const PENDING_WRITERS: readonly PendingWriter[] = [
  {
    file: 'src/queue/queue-manager.ts',
    commandId: 'schegent.enqueue',
    reason:
      'Two writes in this file: `enqueue` creates a pending row, and `retry` returns a ' +
      'failed/canceled/paused row to pending. They reach different registrations — the ' +
      'second is `schegent.retryQueuedItem`, listed below — so both are named.'
  },
  {
    file: 'src/queue/queue-manager.ts',
    commandId: 'schegent.retryQueuedItem',
    reason:
      '`QueueManager.retry`. This is also the sidebar Retry (the ↻ affordance): ' +
      '`cmd-retry-queue-item.ts` delegates to the host command rather than calling ' +
      '`queueOps.retry()` itself, precisely so both affordances share one trigger.'
  },
  {
    file: 'src/commands/restart-canceled-task.ts',
    commandId: 'schegent.restartCanceledTask',
    reason:
      'Restores a canceled row to pending through `store.updateQueue` directly rather ' +
      'than through `QueueManager`, which is why its trigger had to be added separately ' +
      'from the retry one.'
  },
  {
    file: 'src/state/queue-state-migrator.ts',
    commandId: null,
    reason:
      'Not operator-initiated. The migrator demotes rows left `in-flight` by a host that ' +
      'died mid-run, and it runs during state load, before a controller exists to drain ' +
      'with. The drain that picks these up is the one activation performs once the ' +
      'controller is up, so a trigger here would fire into nothing.'
  }
];

const MIN_REASON_LENGTH = 40;

function relativize(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

/** Files under `src/` that contain the pending-write literal. */
function scanPendingWriters(): readonly string[] {
  return filesUnder(SRC_ROOT, { extensions: ['.ts'], skipDirectories: ['generated'] })
    .filter((abs) => readFileSync(abs, 'utf8').includes(PENDING_WRITE))
    .map(relativize)
    .sort();
}

/**
 * The source of one `registerGuardedCommand(guard, '<id>', ...)` call, from the
 * command id to the start of the next registration.
 *
 * Brace matching would be stricter, but the registrations are a flat comma-
 * separated array and the next `registerGuardedCommand(` is an unambiguous
 * terminator — and a block that over-reads would only ever make this check more
 * permissive in a way the `null`-registration test below would catch.
 */
function registrationBlock(source: string, commandId: string): string | null {
  const start = source.indexOf(`'${commandId}'`);
  if (start === -1) return null;
  const next = source.indexOf('registerGuardedCommand(', start);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('Lifecycle round-check finding A — a pending transition must trigger a drain', () => {
  const uiWiringSource = readFileSync(UI_WIRING, 'utf8');
  const scanned = scanPendingWriters();

  it('finds the pending-write literal in source (the scan is not broken)', () => {
    // Without this, a renamed literal would empty both directions at once and
    // report a clean gate over a codebase it never read.
    expect(scanned.length).toBeGreaterThan(0);
  });

  it('classifies every file in src/ that writes a Task to pending', () => {
    const classified = new Set(PENDING_WRITERS.map((w) => w.file));
    const unclassified = scanned.filter((file) => !classified.has(file));
    expect(
      unclassified,
      `These files write \`${PENDING_WRITE}\` and are not classified in ` +
        `PENDING_WRITERS. A Task returned to pending with no drain trigger sits ` +
        `there forever — the coordinator is edge-triggered and nothing polls. Add ` +
        `the file with the command that reaches it, and add the trigger to that ` +
        `command's registration in src/activation/ui-wiring.ts:\n${unclassified.join('\n')}`
    ).toEqual([]);
  });

  it('classifies nothing that no longer writes a pending transition', () => {
    // The mirror direction: a file that stopped writing pending has to leave
    // this table deliberately, rather than sit here making the count look right.
    const scannedSet = new Set(scanned);
    const stale = PENDING_WRITERS.map((w) => w.file).filter((file) => !scannedSet.has(file));
    expect(stale).toEqual([]);
  });

  it('drains the queue from every registration that returns a Task to pending', () => {
    const missing: string[] = [];
    for (const writer of PENDING_WRITERS) {
      if (writer.commandId === null) continue;
      const block = registrationBlock(uiWiringSource, writer.commandId);
      if (block === null) {
        missing.push(`${writer.commandId} — no registration found in ui-wiring.ts`);
        continue;
      }
      if (!block.includes('drainQueuedWork')) {
        missing.push(`${writer.commandId} — registration does not call drainQueuedWork`);
      }
    }
    expect(
      missing,
      `A command that writes a Task to pending must drain the queue the row landed ` +
        `on. Without it the row waits for an unrelated event that may never come — ` +
        `the defect the bug report calls "retried task is returned to pending and ` +
        `never drained":\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('drains the queue the row landed on, never a defaulted sweep', () => {
    // `drainQueuedWork()` with no argument swept the default queue, which is a
    // silent no-op for a Task on any other one — a trigger that reads as present
    // and does nothing. Every call in a pending-producing registration must name
    // a queue.
    const bare: string[] = [];
    for (const writer of PENDING_WRITERS) {
      if (writer.commandId === null) continue;
      const block = registrationBlock(uiWiringSource, writer.commandId);
      if (block !== null && /drainQueuedWork\(\s*\)/.test(block)) bare.push(writer.commandId);
    }
    expect(
      bare,
      `These registrations call drainQueuedWork() with no queue, which sweeps the ` +
        `default queue and silently skips a Task on any other one:\n${bare.join('\n')}`
    ).toEqual([]);
  });

  it('records a substantive reason for every classification', () => {
    expect(PENDING_WRITERS.length).toBeGreaterThan(0);
    for (const writer of PENDING_WRITERS) {
      expect(
        writer.reason.trim().length,
        `${writer.file} (${writer.commandId ?? 'no command'}) needs a reason saying what ` +
          `reaches the write and why its trigger is where it is`
      ).toBeGreaterThan(MIN_REASON_LENGTH);
    }
  });
});
