import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DEFAULT_MAX_READ_BYTES } from '../../../src/lib/bounded-read';
import { SanitizedLogger } from '../../../src/lib/logger';
import { readSpendSeed, SPEND_SEED_MAX_BYTES } from '../../../src/services/spend-bound-seed';

// FR-R3-209 (T1895) — the seed reader reads the end of the audit log, read-only and bounded, and
// the wiring starts it beside the watcher's subscription.

interface CapturedWarning {
  message: string;
  context?: Record<string, unknown> | undefined;
}

let base: string;
let workspaceRoot: string;
let logger: SanitizedLogger;
let warnings: CapturedWarning[];

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'spend-seed-'));
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

function logPath(): string {
  return path.join(workspaceRoot, '.schegent', 'audit.log');
}

/** One audit row as the writer lays it down, with a payload padded by `padBytes` ASCII bytes. */
function row(id: string, eventType: string, padBytes = 0): string {
  return `${JSON.stringify({
    v: 3,
    id,
    timestamp: '2026-10-26T00:00:00.000Z',
    eventType,
    runId: 'run-1',
    phase: 'speckit-plan',
    iteration: 1,
    outcome: 'info',
    payload: { detail: 'x'.repeat(padBytes) }
  })}\n`;
}

describe('FR-R3-209 — readSpendSeed (T1895)', () => {
  it('RD1: returns the phase-end rows, parsed, in file order, and nothing else', async () => {
    await fs.writeFile(
      logPath(),
      row('start-1', 'phase-start') +
        row('end-1', 'phase-end') +
        row('start-2', 'phase-start') +
        row('end-2', 'phase-end')
    );

    const entries = await readSpendSeed(workspaceRoot, logger);

    expect(entries.map((entry) => entry.id)).toEqual(['end-1', 'end-2']);
    expect(entries.map((entry) => entry.eventType)).toEqual(['phase-end', 'phase-end']);
    expect(warnings).toEqual([]);
  });

  it('RD2: reads only the last SPEND_SEED_MAX_BYTES of a longer log', async () => {
    const paddingRows: string[] = [];
    for (let i = 0; i < 48; i += 1) paddingRows.push(row(`pad-${i}`, 'phase-start', 64 * 1024));
    await fs.writeFile(logPath(), row('head', 'phase-end') + paddingRows.join('') + row('tail', 'phase-end'));
    // Above the seed's window and below the default bounded read, so that reading with the
    // default instead of the window changes the outcome.
    const { size } = await fs.stat(logPath());
    expect(size).toBeGreaterThan(SPEND_SEED_MAX_BYTES);
    expect(size).toBeLessThan(DEFAULT_MAX_READ_BYTES);

    const entries = await readSpendSeed(workspaceRoot, logger);

    expect(entries.map((entry) => entry.id)).toEqual(['tail']);
  });

  it('RD3: stays silent on an absent log, and reports a refused one once with no path', async () => {
    expect(await readSpendSeed(workspaceRoot, logger)).toEqual([]);
    expect(warnings).toEqual([]);

    const outside = path.join(base, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(workspaceRoot, '.schegent'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'), 'dir');

    expect(await readSpendSeed(workspaceRoot, logger)).toEqual([]);
    expect(warnings).toHaveLength(1);
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain(workspaceRoot);
    expect(serialized).not.toContain(outside);
  });

  it('RD4: drops the first line of the window even when the cut lands on a whole row', async () => {
    const cut = row('cut', 'phase-end');
    const afterOne = row('after-1', 'phase-end');
    const afterTwo = row('after-2', 'phase-end');
    const unpadded = Buffer.byteLength(cut + afterOne + row('pad', 'phase-start') + afterTwo);
    const padBytes = SPEND_SEED_MAX_BYTES - unpadded;
    expect(padBytes).toBeGreaterThan(0);
    const window = cut + afterOne + row('pad', 'phase-start', padBytes) + afterTwo;
    expect(Buffer.byteLength(window)).toBe(SPEND_SEED_MAX_BYTES);
    const lead = row('lead', 'phase-end') + row('lead-pad', 'phase-start', 1024);
    await fs.writeFile(logPath(), lead + window);
    const { size } = await fs.stat(logPath());
    expect(size - Buffer.byteLength(lead)).toBe(SPEND_SEED_MAX_BYTES);

    const entries = await readSpendSeed(workspaceRoot, logger);

    expect(entries.map((entry) => entry.id)).toEqual(['after-1', 'after-2']);
  });

  it('RD5: skips a line that does not parse and returns the rows around it', async () => {
    await fs.writeFile(logPath(), row('first', 'phase-end') + 'this is not json\n' + row('second', 'phase-end'));

    const entries = await readSpendSeed(workspaceRoot, logger);

    expect(entries.map((entry) => entry.id)).toEqual(['first', 'second']);
  });
});

describe('FR-R3-209 — the wiring starts the seed beside the subscription (T1895)', () => {
  it('W1: the statement after the watcher subscription starts the seed with readSpendSeed', () => {
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

    expect(next).toContain('spendWatcher.seedFrom(readSpendSeed(');
  });
});
