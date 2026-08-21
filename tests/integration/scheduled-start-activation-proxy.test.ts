// Feature 111 (T699 — FR-018, FR-019, FR-020, SC-013, SC-014) — arming a
// schedule leaves `.schegent/` on disk, which is what makes
// `workspaceContains:.schegent/` a usable activation trigger.
//
// Why this test exists at all, given that nothing in this feature changed the
// arm path: the guarantee it depends on is **transitive**, and nothing states
// it. Arming reaches the directory through four hops —
//
//   coordinator.arm()
//     → appendAudit()
//       → auditWriter.append()
//         → doWrite()
//           → fs.mkdir(dir, { recursive: true }) + ensureSchegentGitignore()
//
// — none of which is about activation, and any of which a reasonable refactor
// could move. Buffer the append in memory and flush on dispose; make the
// `mkdir` lazy behind a first-write check that the armed event does not trip;
// route the armed event to a different sink. Each is a defensible change, and
// each would silently turn the new activation event into a watch for a
// directory that never appears. There would be no failing test and no visible
// symptom — just schedules that quietly need a manual window open before they
// can fire. This file is the statement that the arm path owns that side effect.
//
// It is deliberately NOT a `.host.test.ts`: the guarantee is filesystem-level,
// needs no extension host, and therefore gates in the default suite. The
// manifest half of the same contract is asserted by
// `tests/lint/activation-events-declared.test.ts`, which also records the
// residual that no activation event can observe a `Memento`.
//
// The second case pins FR-020: best-effort. Arming is the operator's
// instruction, and a filesystem that refuses the audit write does not
// invalidate it — a missing directory degrades unattended firing, it does not
// mean the schedule was never asked for. So `arm()` must resolve and the timer
// must stay registered. That failure is produced by pointing the workspace root
// through a regular file rather than by stubbing `fs`, so the error is a real
// `ENOTDIR` from the kernel and the test cannot pass because a mock drifted.

import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import type { QueueState } from '../../src/queue/feature-request';
import {
  ScheduledStartCoordinator,
  type ScheduledStartCoordinatorDeps
} from '../../src/services/scheduled-start-coordinator';

const QUEUE_ID = 'default';
const NOW = 1_700_000_000_000;
/** Far enough out that a real `setTimeout` cannot fire mid-test. */
const SCHEDULED_AT = NOW + 3_600_000;

interface Wired {
  readonly coordinator: ScheduledStartCoordinator;
  /** Everything the sanitized logger emitted, joined per call. */
  readonly logLines: string[];
}

/**
 * A coordinator wired to a real `AuditLogWriter` over `workspaceRoot`.
 *
 * The store stubs are present to satisfy the dependency contract and are never
 * read on this path: `arm()` consults the clock, the timer functions and the
 * audit writer, and nothing else. If that ever changes, these throw rather than
 * returning a plausible-looking default.
 */
function wire(workspaceRoot: string): Wired {
  const logLines: string[] = [];
  const logger = new SanitizedLogger([{ appendLine: (line: string) => logLines.push(line) }]);
  const auditWriter = new AuditLogWriter({ workspaceRoot }, logger);
  const deps: ScheduledStartCoordinatorDeps = {
    store: {
      // The parameter is named, not ignored: `tests/lint/no-implicit-default-queue.test.ts`
      // holds FR-R3-002's rule that every `getQueue` names its queue, and a
      // zero-arg stub reads as exactly the unaddressed access that rule forbids.
      getQueue: (queueId: string) => {
        throw new Error(`arm() must not read queue state (asked for ${queueId})`);
      },
      getQueueStates: (): Record<string, QueueState> => {
        throw new Error('arm() must not sweep queue states');
      }
    },
    auditWriter,
    logger,
    onFire: () => {
      throw new Error('the timer must not fire during this test');
    },
    now: () => NOW
  };
  return { coordinator: new ScheduledStartCoordinator(deps), logLines };
}

const roots: string[] = [];
const wired: ScheduledStartCoordinator[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'schegent-activation-proxy-'));
  roots.push(root);
  return root;
}

function track(w: Wired): Wired {
  wired.push(w.coordinator);
  return w;
}

afterEach(async () => {
  // `dispose()` first: a live handle would outlive the directory it was armed
  // against, and on the happy path that handle is a real `setTimeout`.
  for (const coordinator of wired.splice(0)) coordinator.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('arming a schedule creates the activation proxy (111, FR-018, FR-019)', () => {
  it('leaves .schegent/ and its self-ignore file on disk', async () => {
    const root = await freshRoot();
    const { coordinator } = track(wire(root));

    await coordinator.arm(QUEUE_ID, SCHEDULED_AT, 'operator-chooser');

    // The directory is the trigger `workspaceContains:.schegent/` watches.
    const auditLog = join(root, '.schegent', 'audit.log');
    const body = await readFile(auditLog, 'utf8');
    expect(body).toContain('scheduled-start-armed');

    // And the self-ignore, because the trigger directory holds operator-local
    // runtime data and an installed extension may be pointed at any workspace.
    const gitignore = await readFile(join(root, '.schegent', '.gitignore'), 'utf8');
    expect(gitignore).toContain('*');
  });

  it('records the arm as one durable audit line, not a buffered promise', async () => {
    // The vacuity guard for the case above. `arm()` awaits the append, so a
    // future change that made the write lazy would still leave the directory
    // behind on dispose and pass a file-exists assertion. Reading the content
    // back immediately after `arm()` resolves is what pins the ordering: the
    // side effect happens before the caller is told the schedule is armed.
    const root = await freshRoot();
    const { coordinator } = track(wire(root));

    await coordinator.arm(QUEUE_ID, SCHEDULED_AT, 'operator-chooser');

    const lines = (await readFile(join(root, '.schegent', 'audit.log'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(entry.eventType).toBe('scheduled-start-armed');
    expect(entry.payload).toMatchObject({
      queueId: QUEUE_ID,
      scheduledStartAt: SCHEDULED_AT
    });
  });
});

describe('the proxy is best-effort and the schedule is not (111, FR-020)', () => {
  it('arms anyway when the filesystem refuses, and keeps the timer', async () => {
    // A regular file where a directory would have to be, so
    // `mkdir(<root>/.schegent, { recursive: true })` fails with ENOTDIR. Real
    // kernel refusal, no `fs` stub to drift out of step with the writer.
    const parent = await freshRoot();
    const blocker = join(parent, 'not-a-directory');
    await writeFile(blocker, 'this is a file\n', 'utf8');
    const root = join(blocker, 'workspace');

    const { coordinator, logLines } = track(wire(root));

    await expect(
      coordinator.arm(QUEUE_ID, SCHEDULED_AT, 'operator-chooser')
    ).resolves.toBeUndefined();

    const armed = coordinator.armedTimer(QUEUE_ID);
    expect(armed, 'the operator asked for this schedule; a bad disk does not retract it').toBeDefined();
    expect(armed?.scheduledStartAt).toBe(SCHEDULED_AT);
    expect(armed?.source).toBe('operator-chooser');
    expect(coordinator.hasActiveTimer(QUEUE_ID)).toBe(true);

    // Silent is the one failure mode worse than degraded: the operator's
    // unattended start now depends on a window being open, and the only trace
    // of that is the runtime log.
    expect(logLines.join('\n')).toMatch(/audit append failed|schedule audit append failed/);
  });

  it('is failing for the reason the case claims', async () => {
    // Vacuity guard: if the blocker stopped blocking, the case above would pass
    // by arming successfully and never exercise the degraded path at all.
    const parent = await freshRoot();
    const blocker = join(parent, 'not-a-directory');
    await writeFile(blocker, 'this is a file\n', 'utf8');

    await expect(mkdir(join(blocker, 'workspace', '.schegent'), { recursive: true })).rejects.toThrow(
      /ENOTDIR|ENOENT/
    );
  });
});
