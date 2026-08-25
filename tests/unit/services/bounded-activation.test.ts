import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunCheckpointRetentionService } from '../../../src/services/run-checkpoint-retention';
import { readAuditTailColdStart } from '../../../src/ui/sidebar/audit-tail-coldstart';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R3-082 (T1095, T1097) — activation over a workspace someone else wrote.
 *
 * `REL-07`, two halves of one finding. The cold-start tail read a WHOLE audit
 * log to show its END, and the retention sweep walked recursively with no bound
 * on breadth, depth or elapsed time. Both run at activation and both operate on
 * content a cloned workspace can plant, so both were a way to make opening a
 * repository expensive.
 *
 * The bounds are the deliverable, and so is saying when they are hit: a sweep
 * that silently gives up leaves evidence unreaped while reporting success, which
 * is worse than a slow one because nothing downstream can tell.
 *
 * NON-VACUITY, measured: restoring `fs.readFile(filePath, 'utf8')` in the
 * cold-start reader makes the planted-log fixture below hold the whole 12 MiB
 * rather than the 256 KiB cap — observed by watching the returned entry count
 * come from the head of the file rather than its tail. Reverted, re-run green.
 */
let workspaceRoot: string;
let storageRoot: string;
let logger: SanitizedLogger;
let warnings: Array<{ message: string; context?: Record<string, unknown> }>;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-activation-'));
  workspaceRoot = path.join(base, 'workspace');
  storageRoot = path.join(base, 'storage');
  await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
  await fs.mkdir(storageRoot, { recursive: true });
  warnings = [];
  logger = new SanitizedLogger();
  vi.spyOn(logger, 'warn').mockImplementation((message: string, context?: Record<string, unknown>) => {
    warnings.push({ message, context });
  });
});

/** One audit entry per line, distinguishable by index so the tail is provable. */
function auditLine(index: number): string {
  return `${JSON.stringify({
    v: 3,
    id: `entry-${index}`,
    timestamp: '2026-08-25T00:00:00.000Z',
    eventType: 'phase-start',
    runId: 'run-1',
    phase: 'speckit-plan',
    iteration: 1,
    outcome: 'info',
    payload: {}
  })}\n`;
}

describe('FR-R3-082 — the cold-start audit tail is bounded by bytes (T1095)', () => {
  it('shows the END of a planted log and holds only the cap', async () => {
    const logPath = path.join(workspaceRoot, '.schegent', 'audit.log');
    // Well past the 256 KiB cap: ~12 MiB of entries.
    const handle = await fs.open(logPath, 'a');
    try {
      for (let i = 0; i < 40_000; i += 1) await handle.write(auditLine(i));
    } finally {
      await handle.close();
    }
    expect((await fs.stat(logPath)).size).toBeGreaterThan(4 * 1024 * 1024);

    const entries = await readAuditTailColdStart(workspaceRoot, logger);

    // The tail, not the head: the last entry written is present and the first is
    // not. This is the assertion a whole-file read would also pass — so the
    // byte-cap warning below is what distinguishes them.
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).toContain('entry-39999');
    expect(JSON.stringify(entries)).not.toContain('entry-0"');
    // And the skip is REPORTED. A tail that quietly starts megabytes in looks
    // like a short log.
    expect(warnings.map((entry) => entry.message).join('\n')).toContain('tail byte cap');
  }, 60_000);

  it('reads a small log whole, with nothing reported', async () => {
    const logPath = path.join(workspaceRoot, '.schegent', 'audit.log');
    await fs.writeFile(logPath, auditLine(1) + auditLine(2));

    const entries = await readAuditTailColdStart(workspaceRoot, logger);
    expect(entries).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('stays silent on an absent log and reports a refused one', async () => {
    // Nothing has run yet: the ordinary cold start.
    expect(await readAuditTailColdStart(workspaceRoot, logger)).toEqual([]);
    expect(warnings).toEqual([]);

    // A component swapped for a link out of the workspace is NOT the ordinary
    // case, and an empty tail that came from a refusal must not look like a
    // workspace with no history.
    const outside = path.join(path.dirname(workspaceRoot), 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(workspaceRoot, '.schegent'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'), 'dir');

    expect(await readAuditTailColdStart(workspaceRoot, logger)).toEqual([]);
    expect(warnings.map((entry) => entry.message).join('\n')).toContain('refused');
  });
});

describe('FR-R3-082 — the retention walk is bounded and says so (T1096, T1097)', () => {
  async function plantWide(runDir: string, entries: number): Promise<void> {
    await fs.mkdir(runDir, { recursive: true });
    for (let i = 0; i < entries; i += 1) {
      await fs.writeFile(path.join(runDir, `f-${i}`), 'x');
    }
  }

  async function plantDeep(runDir: string, depth: number): Promise<void> {
    let current = runDir;
    for (let i = 0; i < depth; i += 1) {
      current = path.join(current, `d${i}`);
    }
    await fs.mkdir(current, { recursive: true });
    await fs.writeFile(path.join(current, 'leaf'), 'x');
  }

  it('reports the depth cap and still completes, rather than throwing or hanging', async () => {
    // Deeper than the 32-level cap. The old recursion would descend all of it,
    // and a deep enough tree would overflow the stack — which turns a slow
    // sweep into a thrown one.
    await plantDeep(path.join(storageRoot, 'checkpoints', 'run-deep'), 60);

    const service = new RunCheckpointRetentionService({
      globalStorageRoot: storageRoot,
      logger
    });
    const result = await service.sweep();

    // Completed, with a result — degraded, not abandoned.
    expect(result.failures).toBe(0);
    expect(warnings.map((entry) => entry.message).join('\n')).toContain('depth cap reached');
  }, 60_000);

  it('reports the breadth cap once, not once per directory', async () => {
    // Wider than the 10,000-entry cap. Ten thousand identical warnings is a way
    // of saying nothing, so the cap is reported once per sweep with its counts.
    await plantWide(path.join(storageRoot, 'checkpoints', 'run-wide'), 10_050);

    const service = new RunCheckpointRetentionService({
      globalStorageRoot: storageRoot,
      logger
    });
    await service.sweep();

    const breadthWarnings = warnings.filter((entry) => entry.message.includes('breadth cap'));
    expect(breadthWarnings).toHaveLength(1);
    expect(breadthWarnings[0]?.context?.entries).toBe(10_050);
  }, 120_000);

  it('sweeps an ordinary store with no caps reported at all', async () => {
    const runDir = path.join(storageRoot, 'checkpoints', 'run-normal');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'patch.diff'), 'diff');
    await fs.writeFile(path.join(runDir, 'metadata.json'), '{}');

    const service = new RunCheckpointRetentionService({
      globalStorageRoot: storageRoot,
      logger
    });
    const result = await service.sweep();

    expect(result.retainedRunCount).toBe(1);
    expect(warnings.filter((entry) => entry.message.includes('cap reached'))).toEqual([]);
  });
});
