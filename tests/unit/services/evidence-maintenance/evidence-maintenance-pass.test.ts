// Feature 251 (FR-R4-F04, contract T21, SC-010, FR-031, S5, S6) — one maintenance pass, over the real
// transport router and the real session retention service on a fake clock.
//
// What it pins: an idle host with an inactive expired session group, an expired Run transport file and
// an active Run: one pass removes what expired and is inactive and keeps the active Run's; the active
// set is read fresh at the start of each pass; the session sweep runs before the transport step (the pass module says why), both
// given that one set; the report is counts only; and a pass that removes nothing appends no
// `session-retention-applied` row (the Run-end and activation sweeps, which pass no option, still do).
//
// Why: the filing's finding (O-17) is that expired evidence stayed on an idle host that never started
// a Run, and the row that would record each hourly pass would fill the audit log with no-op entries.
// Each "kept" claim is paired with a control that must hit: the item was there before the pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createEvidenceMaintenancePass } from '../../../../src/services/evidence-maintenance/evidence-maintenance-pass';
import { SessionArtifactRetentionService } from '../../../../src/services/session-retention/session-artifact-retention-service';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { createTransportHarness, type TransportHarness } from '../../monitor/transport/transport-harness';

const DAY_MS = 86_400_000;
const START = Date.parse('2026-09-01T00:00:00.000Z');
const AGE_DAYS = 30;
const MAX_BYTES = 512 * 1024 * 1024;
const EXPIRED_RUN = 'run-expired-251';
const ACTIVE_RUN = 'run-active-251';
const EXPIRED_MARKER = 'SYNTHETIC-MARKER-251-EXPIRED';
const ACTIVE_MARKER = 'SYNTHETIC-MARKER-251-ACTIVE';

let harness: TransportHarness;
let appended: Array<{ eventType: string }>;
let sessionRetention: SessionArtifactRetentionService;
let activeRuns: ReadonlySet<string>;
let protectedReads: number;

const sessionsRoot = (): string => path.join(harness.workspaceRoot, '.schegent', 'sessions');

/**
 * Dates every file and directory under `target` (and `target` itself). The clock this test fakes is `Date`
 * only, and a file's modification time is the operating system's, so a tree the test wants to look old is
 * dated by hand at every level: retention reads the group's own timestamps, directories included, and one
 * level left at the real time would make the whole group look fresh.
 */
async function dateTree(target: string, modifiedAt: number): Promise<void> {
  const at = new Date(modifiedAt);
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) await dateTree(child, modifiedAt);
    else await fs.utimes(child, at, at);
  }
  await fs.utimes(target, at, at);
}

/** A session group with one diagnostics file, last written at `modifiedAt`. */
async function plantSessionGroup(runId: string, modifiedAt: number): Promise<string> {
  const group = path.join(sessionsRoot(), runId);
  const directory = path.join(group, 'diagnostics');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'stream.jsonl'), '{"synthetic":true}\n');
  await dateTree(group, modifiedAt);
  return group;
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

function pass(): ReturnType<typeof createEvidenceMaintenancePass> {
  return createEvidenceMaintenancePass({
    protectedSessionRunIds: () => {
      protectedReads += 1;
      return activeRuns;
    },
    transport: harness.router,
    sessionRetention
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  harness = await createTransportHarness({ setting: 'on', ageDays: AGE_DAYS });
  appended = [];
  protectedReads = 0;
  activeRuns = new Set([ACTIVE_RUN]);
  sessionRetention = new SessionArtifactRetentionService({
    workspaceRoot: harness.workspaceRoot,
    policy: () => ({ maxAgeMs: AGE_DAYS * DAY_MS, maxBytes: MAX_BYTES }),
    logger: new SanitizedLogger([]),
    audit: {
      append: async (entry) => {
        appended.push({ eventType: entry.eventType });
        return { ...entry, id: `audit-${appended.length}`, timestamp: new Date().toISOString() };
      }
    },
    now: () => new Date(Date.now())
  });
});

afterEach(async () => {
  await harness.dispose();
  vi.useRealTimers();
});

describe('one pass on an idle host (SC-010)', () => {
  it('removes the expired inactive session group and transport, and keeps the active Run', async () => {
    // At START both Runs have a session group and transport records; only the first Run has ended.
    const expiredGroup = await plantSessionGroup(EXPIRED_RUN, START);
    const activeGroup = await plantSessionGroup(ACTIVE_RUN, START);
    harness.record(EXPIRED_RUN, `${EXPIRED_MARKER} line`);
    harness.record(ACTIVE_RUN, `${ACTIVE_MARKER} line`);
    await harness.flush();
    harness.statuses.set(EXPIRED_RUN, 'completed');
    await harness.router.finalizeRun(EXPIRED_RUN, 'completed', activeRuns);
    // The Run ended at START: its transport file, written just now by the real clock, is dated to match.
    await dateTree(expiredGroup, START);

    // The controls: before the pass everything is on disk.
    expect(await exists(expiredGroup)).toBe(true);
    expect(await exists(activeGroup)).toBe(true);
    expect(await exists(harness.runFile(EXPIRED_RUN))).toBe(true);
    expect(await exists(harness.runFile(ACTIVE_RUN))).toBe(true);

    // The host stays open and idle: forty days pass with no Run starting.
    vi.setSystemTime(START + 40 * DAY_MS);
    const report = await pass()();

    expect(await exists(harness.runFile(EXPIRED_RUN)), 'the expired inactive transport is removed').toBe(false);
    expect(await exists(expiredGroup), 'the expired inactive group is removed').toBe(false);
    expect(await exists(activeGroup), 'the active Run keeps its session group').toBe(true);
    expect(await exists(harness.runFile(ACTIVE_RUN)), 'the active Run keeps its transport').toBe(true);
    // One group went, and its transport file went with it (the sweep ran first), so the transport step had
    // nothing of this Run's left to remove. The counts the transport step reports are pinned in the order case.
    expect(report.sessionGroupsRemoved).toBe(1);
  });

  it('reads the active set fresh at the start of each pass', async () => {
    const activeGroup = await plantSessionGroup(ACTIVE_RUN, START);
    vi.setSystemTime(START + 40 * DAY_MS);
    const run = pass();

    await run();
    expect(protectedReads).toBe(1);
    expect(await exists(activeGroup), 'protected by the first read').toBe(true);

    // The Run ends between passes; the next pass sees it inactive.
    activeRuns = new Set();
    await run();
    expect(protectedReads).toBe(2);
    expect(await exists(activeGroup), 'no longer protected by the second read').toBe(false);
  });

  it('returns counts and no path or content', async () => {
    await plantSessionGroup(EXPIRED_RUN, START);
    vi.setSystemTime(START + 40 * DAY_MS);

    const report = await pass()();

    expect(Object.values(report).every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(EXPIRED_RUN);
  });
});

describe('the audit row (S6)', () => {
  it('appends none when a pass removed nothing', async () => {
    await plantSessionGroup(ACTIVE_RUN, START);
    vi.setSystemTime(START + DAY_MS);

    await pass()();
    await pass()();

    expect(appended.filter((entry) => entry.eventType === 'session-retention-applied')).toEqual([]);
  });

  it('appends one when a pass removed something (the control)', async () => {
    await plantSessionGroup(EXPIRED_RUN, START);
    vi.setSystemTime(START + 40 * DAY_MS);

    await pass()();

    expect(appended.filter((entry) => entry.eventType === 'session-retention-applied')).toHaveLength(1);
  });

  it('is unchanged for a caller that passes no option: a sweep that removed nothing still appends', async () => {
    await plantSessionGroup(ACTIVE_RUN, START);
    vi.setSystemTime(START + DAY_MS);

    await sessionRetention.sweep(new Set([ACTIVE_RUN]));

    expect(appended.filter((entry) => entry.eventType === 'session-retention-applied')).toHaveLength(1);
  });
});

describe('the order and the shared set (S5)', () => {
  it('runs the session sweep before the transport step, each given the one set read at the start', async () => {
    const order: string[] = [];
    const active: ReadonlySet<string> = new Set(['run-x']);
    const run = createEvidenceMaintenancePass({
      protectedSessionRunIds: () => {
        order.push('read');
        return active;
      },
      transport: {
        runPass: async (set) => {
          order.push(`transport:${set === active}`);
          return { removed: 2, compacted: 1, promoted: 0, discarded: 0, bytes: 10 };
        }
      },
      sessionRetention: {
        sweep: async (set, options) => {
          order.push(`sweep:${set === active}:${String(options?.recordNoop)}`);
          return {
            artifactCount: 0,
            totalBytes: 0,
            lastSweepAt: '2026-10-31T00:00:00.000Z',
            lastSweepFailures: 0,
            removedArtifactCount: 3,
            removedBytes: 30,
            protectedArtifactCount: 1
          };
        }
      }
    });

    const report = await run();

    expect(order).toEqual(['read', 'sweep:true:false', 'transport:true']);
    expect(report).toEqual({
      transportFilesRemoved: 2,
      transportFilesCompacted: 1,
      sessionGroupsRemoved: 3,
      sessionBytesRemoved: 30
    });
  });
});
