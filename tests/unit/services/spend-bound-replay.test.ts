// FR-R4-F02 (spec 240, US4; contract S4 G13 to G17; research R8; FR-032 to FR-036) — the restart
// replay gives each live Run a complete total or the reason its total is only a lower bound.
//
// It replaces the seed reader that read the last 2 MiB of the live log and nothing else, so a
// restarted Run's total understated whenever its rows lay before that window or in an archive and
// nothing said so. That reader's own cases moved here (RD1, RD3, RD4, RD5 and the wiring case), and
// are listed in measurements.md with the one that was dropped.
//
// The two bounded-resource claims are measured, not read off the source: a wrapper around the real
// bounded reader sums the bytes it returned, and a wrapper around the real checked open records the
// flags every open used.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SanitizedLogger } from '../../../src/lib/logger';
import { AUDIT_SCHEMA_VERSION } from '../../../src/audit/audit-entry';
import {
  readSpendReplay,
  SPEND_REPLAY_MAX_BYTES,
  type ReplayRun
} from '../../../src/services/spend-bound-replay';

const measured = vi.hoisted(() => ({
  bytesRead: 0,
  openedFlags: [] as string[],
  openedNames: [] as string[]
}));

vi.mock('../../../src/lib/bounded-read', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/bounded-read')>();
  return {
    ...original,
    readBoundedTail: async (...args: Parameters<typeof original.readBoundedTail>) => {
      const result = await original.readBoundedTail(...args);
      measured.bytesRead += result.bytes.length;
      return result;
    }
  };
});

vi.mock('../../../src/lib/safe-open', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/safe-open')>();
  return {
    ...original,
    openWithinRoot: async (...args: Parameters<typeof original.openWithinRoot>) => {
      measured.openedFlags.push(String(args[2].flags));
      measured.openedNames.push(args[1].join('/'));
      return original.openWithinRoot(...args);
    }
  };
});

interface CapturedWarning {
  message: string;
  context?: Record<string, unknown> | undefined;
}

const BASE = Date.parse('2026-10-26T00:00:00.000Z');
const at = (offsetSeconds: number): string => new Date(BASE + offsetSeconds * 1000).toISOString();
const startedAtOffset = (offsetSeconds: number): number => BASE + offsetSeconds * 1000;

let base: string;
let workspaceRoot: string;
let logger: SanitizedLogger;
let warnings: CapturedWarning[];

beforeEach(async () => {
  measured.bytesRead = 0;
  measured.openedFlags.length = 0;
  measured.openedNames.length = 0;
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'spend-replay-'));
  workspaceRoot = path.join(base, 'workspace');
  await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
  warnings = [];
  logger = new SanitizedLogger();
  vi.spyOn(logger, 'warn').mockImplementation((message: string, context?: Record<string, unknown>) => {
    warnings.push({ message, context });
  });
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const logPath = (name = 'audit.log'): string => path.join(workspaceRoot, '.schegent', name);

interface RowOptions {
  readonly runId?: string;
  readonly offsetSeconds?: number;
  readonly pad?: number;
  readonly schemaVersion?: number;
}

/** One audit row as the writer lays it down, with a payload padded by `pad` ASCII bytes. */
function row(id: string, eventType: string, options: RowOptions = {}): string {
  return `${JSON.stringify({
    v: 3,
    ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
    id,
    timestamp: at(options.offsetSeconds ?? 100),
    eventType,
    runId: options.runId ?? 'run-1',
    phase: 'speckit-plan',
    iteration: 1,
    outcome: 'info',
    payload: { detail: 'x'.repeat(options.pad ?? 0), metrics: { totalCostUsd: 0.5 } }
  })}\n`;
}

/** Rows of a different Run (or none the Run owns), as filler of an exact size. */
function filler(prefix: string, bytes: number, offsetSeconds: number): string {
  const lines: string[] = [];
  let written = 0;
  for (let index = 0; written < bytes; index += 1) {
    const remaining = bytes - written;
    const pad = Math.min(64 * 1024, Math.max(0, remaining - 330));
    const line = row(`${prefix}-${index}`, 'phase-start', { runId: 'other', offsetSeconds, pad });
    lines.push(line);
    written += Buffer.byteLength(line);
  }
  return lines.join('');
}

const RUN: ReplayRun = { runId: 'run-1', startedAt: startedAtOffset(50) };
const OLDER = row('before', 'phase-start', { runId: 'other', offsetSeconds: 10 });

describe('the rows the replay returns (RD1)', () => {
  it('RD1: returns the Run\'s phase-end rows, parsed, in file order, and nothing else', async () => {
    await fs.writeFile(
      logPath(),
      OLDER +
        row('start-1', 'phase-start') +
        row('end-1', 'phase-end', { offsetSeconds: 101 }) +
        row('start-2', 'phase-start') +
        row('end-2', 'phase-end', { offsetSeconds: 102 }) +
        row('end-other', 'phase-end', { runId: 'run-2', offsetSeconds: 103 })
    );

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.rows.map((entry) => entry.id)).toEqual(['end-1', 'end-2']);
    expect(replay.completeness.get('run-1')).toEqual({ kind: 'complete' });
    expect([...replay.completeness.keys()]).toEqual(['run-1']);
    expect(warnings).toEqual([]);
  });

  it('never covers a Run the caller did not name: no completeness entry, and no rows', async () => {
    await fs.writeFile(logPath(), OLDER + row('end-x', 'phase-end', { runId: 'run-2' }));

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.rows).toEqual([]);
    expect(replay.completeness.has('run-2')).toBe(false);
  });

  it('answers an empty replay for no Runs, an empty root, and never rejects', async () => {
    expect(await readSpendReplay(workspaceRoot, logger, [])).toEqual({ rows: [], completeness: new Map() });
    expect(await readSpendReplay('', logger, [RUN])).toEqual({ rows: [], completeness: new Map() });
    expect(measured.openedNames).toEqual([]);
  });
});

describe('a Run whose rows span more than the old window (US4-1, SC-005)', () => {
  it('RD6: the 3,067,358-byte gap yields BOTH rows and a complete total (it was the second row only)', async () => {
    const GAP_BYTES = 3_067_358;
    await fs.writeFile(
      logPath(),
      OLDER +
        row('first-end', 'phase-end', { offsetSeconds: 60 }) +
        filler('gap', GAP_BYTES, 70) +
        row('second-end', 'phase-end', { offsetSeconds: 200 })
    );

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.rows.map((entry) => entry.id)).toEqual(['first-end', 'second-end']);
    expect(replay.completeness.get('run-1')).toEqual({ kind: 'complete' });
  });
});

describe('rows split across the live log and a rotated archive (US4-2)', () => {
  const ARCHIVE = 'audit.log.20261025-235900';

  it('is complete within the budget', async () => {
    await fs.writeFile(logPath(ARCHIVE), OLDER + row('in-archive', 'phase-end', { offsetSeconds: 60 }));
    await fs.writeFile(logPath(), row('in-live', 'phase-end', { offsetSeconds: 200 }));

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.rows.map((entry) => entry.id)).toEqual(['in-archive', 'in-live']);
    expect(replay.completeness.get('run-1')).toEqual({ kind: 'complete' });
  });

  it('is incomplete(budget) when the budget is below the span', async () => {
    const archive = OLDER + row('in-archive', 'phase-end', { offsetSeconds: 60 });
    const live = row('in-live', 'phase-end', { offsetSeconds: 200 });
    await fs.writeFile(logPath(ARCHIVE), archive);
    await fs.writeFile(logPath(), live);

    // The budget covers the live log and not a byte of the archive.
    const replay = await readSpendReplay(workspaceRoot, logger, [RUN], Buffer.byteLength(live));

    expect(replay.rows.map((entry) => entry.id)).toEqual(['in-live']);
    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'budget' });
  });

  it('RD4: drops the first line of a cut window even when the cut lands exactly on a whole row', async () => {
    const dropped = row('cut', 'phase-end', { offsetSeconds: 60 });
    const kept = row('kept', 'phase-end', { offsetSeconds: 70 });
    await fs.writeFile(logPath(), OLDER + dropped + kept);

    // The budget is exactly the last row, so the window begins at a row boundary and its first line
    // is a whole row. It is dropped all the same: whether a window began inside a row cannot be told
    // from the bytes, and a figure that counts money does not lean on the parser to refuse a fragment.
    const replay = await readSpendReplay(workspaceRoot, logger, [RUN], Buffer.byteLength(kept));

    expect(replay.rows.map((entry) => entry.id)).toEqual([]);
    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'budget' });
  });

  it('is incomplete(budget) when the budget cuts a file mid-row, and the cut is not reported as damage', async () => {
    await fs.writeFile(logPath(), OLDER + row('a', 'phase-end', { offsetSeconds: 60 }) + row('b', 'phase-end', { offsetSeconds: 70 }));
    const oneRow = Buffer.byteLength(row('b', 'phase-end', { offsetSeconds: 70 }));

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN], oneRow + 20);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'budget' });
    expect(replay.rows.map((entry) => entry.id)).toEqual(['b']);
  });
});

describe('a chain that does not reach back to the Run (US4-3)', () => {
  it('archive-missing: every file was read and none holds a row older than the Run', async () => {
    await fs.writeFile(logPath(), row('only', 'phase-end', { offsetSeconds: 60 }));

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'archive-missing' });
    expect(replay.rows.map((entry) => entry.id)).toEqual(['only']);
  });

  it('archive-missing: a workspace with no audit directory at all, silently', async () => {
    await fs.rm(path.join(workspaceRoot, '.schegent'), { recursive: true, force: true });

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'archive-missing' });
    expect(warnings).toEqual([]);
  });

  it('read-failed: a file in the chain that cannot be opened safely, reported with no path', async () => {
    const outside = path.join(base, 'outside.log');
    await fs.writeFile(outside, OLDER + row('end', 'phase-end', { offsetSeconds: 60 }));
    await fs.symlink(outside, logPath());

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'read-failed' });
    expect(warnings).toHaveLength(1);
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain(workspaceRoot);
    expect(serialized).not.toContain(outside);
  });

  it('damaged-row: an unparseable non-empty line inside the Run\'s span', async () => {
    await fs.writeFile(
      logPath(),
      OLDER + row('a', 'phase-end', { offsetSeconds: 60 }) + 'this is not json\n' + row('b', 'phase-end', { offsetSeconds: 70 })
    );

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'damaged-row' });
    expect(replay.rows.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('damaged-row: a torn first line of a whole file, when the Run is not bounded before it', async () => {
    const torn = row('torn', 'phase-end', { offsetSeconds: 60 }).slice(0, 40) + '\n';
    await fs.writeFile(logPath(), torn + row('b', 'phase-end', { offsetSeconds: 70 }));

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'damaged-row' });
  });

  it('control: an unparseable line OLDER than the Run\'s start does not touch its completeness', async () => {
    await fs.writeFile(
      logPath(),
      'this is not json\n' + OLDER + row('a', 'phase-end', { offsetSeconds: 60 })
    );

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'complete' });
  });

  it('unknown-row-schema: a phase-end row stamped newer than this build knows', async () => {
    await fs.writeFile(
      logPath(),
      OLDER + row('future', 'phase-end', { offsetSeconds: 60, schemaVersion: AUDIT_SCHEMA_VERSION + 1 })
    );

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'unknown-row-schema' });
  });

  it('control: a row at the known schema version is not unknown', async () => {
    await fs.writeFile(
      logPath(),
      OLDER + row('now', 'phase-end', { offsetSeconds: 60, schemaVersion: AUDIT_SCHEMA_VERSION })
    );

    expect((await readSpendReplay(workspaceRoot, logger, [RUN])).completeness.get('run-1')).toEqual({ kind: 'complete' });
  });
});

describe('each Run is judged on its own span', () => {
  it('a Run bounded early stays complete while an older sibling is incomplete', async () => {
    const newer: ReplayRun = { runId: 'run-new', startedAt: startedAtOffset(150) };
    const older: ReplayRun = { runId: 'run-old', startedAt: startedAtOffset(5) };
    await fs.writeFile(
      logPath(),
      row('ante', 'phase-start', { runId: 'other', offsetSeconds: 100 }) +
        row('end-new', 'phase-end', { runId: 'run-new', offsetSeconds: 160 })
    );

    const replay = await readSpendReplay(workspaceRoot, logger, [newer, older]);

    expect(replay.completeness.get('run-new')).toEqual({ kind: 'complete' });
    expect(replay.completeness.get('run-old')).toEqual({ kind: 'incomplete', reason: 'archive-missing' });
  });
});

describe('the scan is bounded (FR-036; G13, G14)', () => {
  const MIB = 1024 * 1024;

  it('never reads more than SPEND_REPLAY_MAX_BYTES across a live log and two archives, and says why', async () => {
    await fs.writeFile(logPath(), filler('live', 5 * MIB, 150));
    await fs.writeFile(logPath('audit.log.20261025-000001'), filler('a1', 5 * MIB, 140));
    await fs.writeFile(logPath('audit.log.20261024-000001'), filler('a2', 5 * MIB, 130));

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(measured.bytesRead).toBeLessThanOrEqual(SPEND_REPLAY_MAX_BYTES);
    // The budget is spent, not skipped: the scan reads up to it before giving up.
    expect(measured.bytesRead).toBeGreaterThan(SPEND_REPLAY_MAX_BYTES - MIB);
    expect(replay.completeness.get('run-1')).toEqual({ kind: 'incomplete', reason: 'budget' });
  });

  it('stops at the first file once every Run is bounded there, and opens no archive', async () => {
    await fs.writeFile(logPath(), OLDER + row('end', 'phase-end', { offsetSeconds: 60 }));
    await fs.writeFile(logPath('audit.log.20261025-000001'), filler('a1', MIB, 20));
    await fs.writeFile(logPath('audit.log.20261024-000001'), filler('a2', MIB, 10));

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.completeness.get('run-1')).toEqual({ kind: 'complete' });
    expect(measured.openedNames).toEqual(['.schegent/audit.log']);
    expect(measured.bytesRead).toBeLessThan(MIB);
  });

  it('reads the live log first and then archives newest first', async () => {
    await fs.writeFile(logPath(), filler('live', 1024, 150));
    await fs.writeFile(logPath('audit.log.20261024-000001'), filler('old', 1024, 120));
    await fs.writeFile(logPath('audit.log.20261025-000001'), filler('mid', 1024, 140));

    await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(measured.openedNames).toEqual([
      '.schegent/audit.log',
      '.schegent/audit.log.20261025-000001',
      '.schegent/audit.log.20261024-000001'
    ]);
  });

  it('opens every file read-only, and never touches the cut record', async () => {
    await fs.writeFile(logPath(), filler('live', 1024, 150));
    await fs.writeFile(logPath('audit.log.cuts'), 'a cut record\n');
    await fs.writeFile(logPath('audit.log.20261025-000001'), filler('a1', 1024, 140));

    await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(measured.openedFlags.length).toBeGreaterThan(0);
    expect(new Set(measured.openedFlags)).toEqual(new Set(['r']));
    expect(measured.openedNames).not.toContain('.schegent/audit.log.cuts');
  });

  it('writes, truncates and removes nothing: every file is byte-identical afterwards', async () => {
    const live = OLDER + row('end', 'phase-end', { offsetSeconds: 60 });
    await fs.writeFile(logPath(), live);
    await fs.writeFile(logPath('audit.log.20261025-000001'), 'archive content\n');
    const before = await fs.readdir(path.join(workspaceRoot, '.schegent'));

    await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(await fs.readdir(path.join(workspaceRoot, '.schegent'))).toEqual(before);
    expect(await fs.readFile(logPath(), 'utf8')).toBe(live);
    expect(await fs.readFile(logPath('audit.log.20261025-000001'), 'utf8')).toBe('archive content\n');
  });
});

describe('a workspace from before this feature takes the same path (US4-5, FR-035)', () => {
  it('reads ordinary rows with no marker of the feature, and is complete when the chain reaches back', async () => {
    await fs.writeFile(
      logPath(),
      OLDER +
        JSON.stringify({
          id: 'legacy-end',
          timestamp: at(60),
          eventType: 'phase-end',
          runId: 'run-1',
          phase: 'speckit-plan',
          iteration: 1,
          outcome: 'success',
          payload: { totalCostUsd: 0.25 }
        }) +
        '\n'
    );

    const replay = await readSpendReplay(workspaceRoot, logger, [RUN]);

    expect(replay.rows.map((entry) => entry.id)).toEqual(['legacy-end']);
    expect(replay.completeness.get('run-1')).toEqual({ kind: 'complete' });
  });
});

describe('the wiring starts the replay beside the subscription (contract S4 G16; moved from the seed test)', () => {
  it('W1: the statement after the watcher subscription starts the seed with readSpendReplay', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../src/activation/run-safety-wiring.ts'),
      'utf8'
    );
    const lines = source.split(/\r?\n/);
    const subscription = lines.findIndex((line) =>
      line.includes('input.auditWriter.subscribe(spendWatcher.onAuditEntry)')
    );
    expect(subscription, 'the watcher subscription is in the wiring').toBeGreaterThanOrEqual(0);

    const next = lines
      .slice(subscription + 1)
      .find((line) => line.trim() !== '' && !line.trim().startsWith('//'));

    expect(next).toContain('spendWatcher.seedFrom(');
    expect(lines.slice(subscription + 1, subscription + 12).join('\n')).toContain('readSpendReplay(');
  });
});
