import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { digestOf, verifyAuditChainAt } from '../../../src/audit/audit-chain';
import {
  checkpointKey,
  type AuditCheckpointPort,
  type CheckpointRead,
  type LossState
} from '../../../src/audit/audit-checkpoint';
import { createAuditCheckpointStore } from '../../../src/audit/audit-checkpoint-store';
import { ensureCheckpointRoot } from '../../../src/audit/audit-checkpoint-root';
import { renderLossCheck, runVerifyAuditChain } from '../../../src/commands/verify-audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';
import type { Notifier } from '../../../src/ui/notifications';

/**
 * FR-R4-F03 (FR-015 to FR-018, SC-006, SC-007; contract T11, C5, W3 to W8, O1) — loss of established
 * history, with the real writer, the real checkpoint store and the real verify command.
 *
 * The checkpoint lives in a storage root OUTSIDE the workspace, so removing the workspace's audit
 * files cannot remove it. Verification classifies the history against it into one of seven states,
 * and the two loss states reach audit health. The writer advances the checkpoint only after a row
 * lands, never in a mode that would erase a finding, and never overwrites a file it cannot read.
 *
 * "Loss" here is made by removing real bytes from a real log. The advance that "fails" is a store
 * adapter over the real store whose `write` throws once, because a full per-user disk cannot be made
 * in a test (R20). Ownership is not under test here: the writer has no authority and acts as the
 * owner.
 */

const ONE_ROW = (runId: string) =>
  ({ eventType: 'phase-start', runId, payload: { phase: 'implement' } }) as never;

interface Sent {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

describe('loss detection over real history (SC-006, SC-007)', () => {
  let workspace: string;
  let storage: string;
  let key: string;
  let sent: Sent[];
  let monitor: EvidenceHealthMonitor;
  let lines: string[];
  let onBreak: ReturnType<typeof vi.fn<(detail: string) => void>>;
  let onLoss: ReturnType<typeof vi.fn<(code: 'history-shorter' | 'history-missing', detail: string) => void>>;
  const auditDir = (root = workspace): string => path.join(root, '.schegent');
  const logFile = (): string => path.join(auditDir(), 'audit.log');
  const checkpointFile = (forKey = key): string => path.join(storage, 'audit-checkpoints', `${forKey}.json`);

  const notifier = (): Notifier =>
    ({
      info: (message: string) => {
        sent.push({ level: 'info', message });
      },
      warn: (message: string) => {
        sent.push({ level: 'warn', message });
        return Promise.resolve(undefined);
      },
      error: (message: string) => {
        sent.push({ level: 'error', message });
      }
    }) as unknown as Notifier;

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-lifecycle-ws-')));
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-lifecycle-store-'));
    await ensureCheckpointRoot(storage);
    key = checkpointKey(workspace);
    sent = [];
    lines = [];
    monitor = new EvidenceHealthMonitor();
    onBreak = vi.fn<(detail: string) => void>();
    onLoss = vi.fn<(code: 'history-shorter' | 'history-missing', detail: string) => void>();
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(storage, { recursive: true, force: true });
  });

  const store = (forKey = key): AuditCheckpointPort => createAuditCheckpointStore({ root: storage, key: forKey });

  /** `null` builds a writer with NO checkpoint port (an `undefined` argument would take the default store). */
  const writer = (
    port: AuditCheckpointPort | null = store(),
    overrides: Record<string, number> = {}
  ): AuditLogWriter =>
    new AuditLogWriter(
      { workspaceRoot: workspace, ...overrides, ...(port === null ? {} : { checkpoint: port }) },
      new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]),
      monitor
    );

  const appendRows = async (w: AuditLogWriter, count: number, prefix = 'row'): Promise<void> => {
    for (let n = 0; n < count; n += 1) await w.append(ONE_ROW(`${prefix}-${n}`));
  };

  /** The advance is queued behind the append and the caller does not wait for it: wait for it here. */
  const checkpointAt = async (position: number, forKey = key): Promise<void> => {
    await vi.waitFor(async () => {
      const read = await store(forKey).read();
      expect(read.status === 'active' ? read.checkpoint.position : -1).toBe(position);
    });
  };

  async function verify(
    options: { root?: string; read?: () => Promise<CheckpointRead> } = {}
  ): Promise<string> {
    sent = [];
    await runVerifyAuditChain({
      workspaceRoot: options.root ?? workspace,
      notifier: notifier(),
      logger: new SanitizedLogger([]),
      onBreak,
      onLoss,
      readCheckpoint: options.read ?? (() => store().read())
    });
    expect(sent, 'one result per verification').toHaveLength(1);
    return (sent[0] as Sent).message;
  }

  const expectLoss = (message: string, state: LossState): void => {
    const rendered = renderLossCheck(state);
    expect(message).toContain(rendered.text);
    expect(sent[0]?.level).toBe(rendered.level);
  };

  const rawRows = async (): Promise<string[]> =>
    (await fs.readFile(logFile(), 'utf8')).split('\n').filter((line) => line.trim().length > 0);

  const removeLastRow = async (): Promise<void> => {
    const rows = await rawRows();
    await fs.writeFile(logFile(), `${rows.slice(0, -1).join('\n')}\n`);
  };

  it('reports a tail removed from the log as shorter than the checkpoint, with both counts, and fails audit health', async () => {
    await appendRows(writer(), 5);
    await checkpointAt(5);
    expect(await verify()).toContain('audit chain verified');
    expect(onLoss).not.toHaveBeenCalled();

    await removeLastRow();
    const message = await verify();

    expectLoss(message, { state: 'shorter', expected: 5, found: 4, detail: 'tail-removed' });
    expect(onLoss).toHaveBeenCalledTimes(1);
    expect(onLoss.mock.calls[0]?.[0]).toBe('history-shorter');
  });

  it('reports every audit file removed as missing history, and fails audit health', async () => {
    await appendRows(writer(), 3);
    await checkpointAt(3);

    await fs.rm(auditDir(), { recursive: true, force: true });
    const message = await verify();

    expectLoss(message, { state: 'missing', expected: 3 });
    expect(onLoss.mock.calls[0]?.[0]).toBe('history-missing');
  });

  it('reads a workspace with no log and no checkpoint as new, and fails nothing', async () => {
    const message = await verify();

    expectLoss(message, { state: 'new-workspace' });
    expect(onLoss).not.toHaveBeenCalled();
    expect(onBreak).not.toHaveBeenCalled();
  });

  it('says no-checkpoint-for-location before an owner append, writes nothing to verify, then adopts at the first append', async () => {
    await appendRows(writer(null), 3);
    const before = new Map<string, Buffer>();
    for (const name of await fs.readdir(auditDir())) before.set(name, await fs.readFile(path.join(auditDir(), name)));

    const message = await verify();

    expectLoss(message, { state: 'no-checkpoint-for-location' });
    await expect(fs.stat(checkpointFile()), 'verification wrote no checkpoint (FR-004)').rejects.toMatchObject({
      code: 'ENOENT'
    });
    for (const [name, bytes] of before) {
      expect((await fs.readFile(path.join(auditDir(), name))).equals(bytes), `${name} is unchanged`).toBe(true);
    }

    await appendRows(writer(), 1, 'adopting');
    await checkpointAt(4);
    expect(await store().read()).toMatchObject({ status: 'active', checkpoint: { origin: 'adopted' } });
    const afterMessage = await verify();
    const adopted = await store().read();
    const adoptedAtMs = adopted.status === 'active' ? adopted.checkpoint.establishedAtMs : -1;
    expectLoss(afterMessage, { state: 'adopted', position: 4, adoptedAtMs });
  });

  it('keeps the establishedAtMs it first stored on every later advance', async () => {
    const real = store();
    const established: number[] = [];
    const recording: AuditCheckpointPort = {
      key: real.key,
      read: () => real.read(),
      write: async (next) => {
        established.push(next.establishedAtMs);
        await real.write(next);
      }
    };
    // A clock that moves on every read, so the time the writer settled and the time it first advanced differ.
    let clock = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000));
    try {
      await appendRows(writer(recording), 3);
    } finally {
      now.mockRestore();
    }
    await checkpointAt(3);

    expect(established).toHaveLength(3);
    expect(new Set(established).size, 'one establishment time across every advance').toBe(1);
  });

  it('reports no loss when an advance failed after a landing, and finds the head behind at the next start', async () => {
    await appendRows(writer(), 2);
    await checkpointAt(2);

    let failed = 0;
    const flaky: AuditCheckpointPort = {
      key,
      read: () => store().read(),
      write: async () => {
        failed += 1;
        throw new Error(`simulated advance failure ${failed}`);
      }
    };
    await appendRows(writer(flaky), 2, 'unadvanced');
    expect(failed, 'the advance really was attempted and refused').toBeGreaterThanOrEqual(1);
    expect(lines.filter((line) => line.includes('audit-checkpoint-unavailable'))).toHaveLength(1);

    // The checkpoint is behind the log, never ahead of it: still no loss.
    expectLoss(await verify(), { state: 'consistent', position: 2 });
    expect(onLoss).not.toHaveBeenCalled();

    await appendRows(writer(), 1, 'caught-up');
    await checkpointAt(5);
    expectLoss(await verify(), { state: 'consistent', position: 5 });
    expect(onLoss).not.toHaveBeenCalled();
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'never advances the checkpoint ahead of the log: a rejected append leaves it at the last landed row',
    async () => {
      const w = writer();
      await appendRows(w, 2);
      await checkpointAt(2);

      await fs.chmod(logFile(), 0o400);
      await expect(w.append(ONE_ROW('rejected'))).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.chmod(logFile(), 0o600);

      expect(await store().read(), 'the checkpoint names only a row that landed').toMatchObject({
        status: 'active',
        checkpoint: { position: 2 }
      });
      expectLoss(await verify(), { state: 'consistent', position: 2 });
      expect(onLoss).not.toHaveBeenCalled();
    }
  );

  it('stays consistent across rotation and pruning, even when the checkpointed row was pruned', async () => {
    await appendRows(writer(), 2);
    await checkpointAt(2);

    const rotating = writer(null, { rotationSizeBytes: 1, retentionMaxArchives: 1 });
    for (let n = 0; n < 6; n += 1) {
      await rotating.append(ONE_ROW(`rotated-${n}`));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }

    const message = await verify();
    expectLoss(message, { state: 'consistent', position: 2 });
    expect(message).toContain('audit chain verified');
    expect(onLoss).not.toHaveBeenCalled();
  });

  it('still reports the chain verdict when the checkpoint is unreadable, and never says complete', async () => {
    await appendRows(writer(), 3);
    await checkpointAt(3);
    await fs.writeFile(checkpointFile(), '{ this is not json');

    const message = await verify();

    expect(message).toContain('audit chain verified');
    expectLoss(message, { state: 'not-performed', reason: 'checkpoint-unreadable' });
    expect(message).not.toMatch(/history is complete/i);
    expect(onLoss).not.toHaveBeenCalled();
  });

  it('says no-checkpoint-for-location for the same history under a different root path', async () => {
    await appendRows(writer(), 3);
    await checkpointAt(3);
    const moved = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-lifecycle-moved-')));
    try {
      await fs.cp(auditDir(), auditDir(moved), { recursive: true });

      const message = await verify({ root: moved, read: () => store(checkpointKey(moved)).read() });

      expectLoss(message, { state: 'no-checkpoint-for-location' });
    } finally {
      await fs.rm(moved, { recursive: true, force: true });
    }
  });

  it('retires the checkpoint on a reset, reads as new, then begins the next history with a reset row', async () => {
    const w = writer();
    await appendRows(w, 3);
    await checkpointAt(3);
    await fs.rm(auditDir(), { recursive: true, force: true });
    await verify();
    monitor.reportFailure('audit', 'history-missing');
    expect(monitor.getSnapshot().audit.cause).toBe('history-missing');

    expect(await w.retireCheckpoint()).toBe('retired');
    expect(monitor.getSnapshot().audit.status, 'the reset clears the history finding').toBe('healthy');

    expectLoss(await verify(), { state: 'new-workspace' });

    await w.append(ONE_ROW('first-after-reset'));
    const rows = (await rawRows()).map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      eventType: 'audit-integrity-condition',
      prevDigest: 'genesis',
      payload: { condition: 'history-reset', conditionVersion: 1, retiredPosition: 3 }
    });
    expect(rows[1]?.prevDigest).toBe(digestOf((await rawRows())[0] as string));
    await checkpointAt(2);
    expect(await store().read()).toMatchObject({ status: 'active', checkpoint: { origin: 'reset' } });
    expectLoss(await verify(), { state: 'consistent', position: 2 });
  });

  it('does not advance after a truncated tail, still reports the loss after the next append, and sets health first', async () => {
    await appendRows(writer(), 5);
    await checkpointAt(5);
    await removeLastRow();

    // A writer's own tail check finds the loss, before any verification has run.
    await appendRows(writer(), 1, 'after-truncation');
    expect(monitor.getSnapshot().audit.cause, 'set by the writer, not by a command').toBe('history-shorter');
    expect(monitor.getSnapshot().audit.status).toBe('unavailable');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await store().read(), 'the checkpoint is not advanced over the loss').toMatchObject({
      status: 'active',
      checkpoint: { position: 5 }
    });

    const message = await verify();
    expectLoss(message, { state: 'shorter', expected: 5, found: 5, detail: 'head-absent' });
    expect(onLoss.mock.calls[0]?.[0]).toBe('history-shorter');
  });

  it('a verifier and a writer count the same positions', async () => {
    await appendRows(writer(), 4);
    await checkpointAt(4);
    const check = verifyAuditChainAt(auditDir());
    expect(check?.verdict.ok === true ? check.verdict.positions.tail : -1).toBe(4);
  });

  it('does not follow a planted archive link out of the workspace when it settles the checkpoint', async () => {
    // Four chained rows made elsewhere: the first three sit OUTSIDE the workspace behind an archive-slot
    // link, the fourth is the live log. Followed, the link would make an intact walk and an adoption at 4.
    const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-lifecycle-out-')));
    try {
      await appendRows(new AuditLogWriter({ workspaceRoot: elsewhere }, new SanitizedLogger([]), monitor), 4);
      const made = (await fs.readFile(path.join(elsewhere, '.schegent', 'audit.log'), 'utf8')).trim().split('\n');
      const outside = path.join(elsewhere, 'outside.log');
      await fs.writeFile(outside, `${made.slice(0, 3).join('\n')}\n`);
      await fs.mkdir(auditDir(), { recursive: true });
      await fs.writeFile(logFile(), `${made[3]}\n`);
      await fs.symlink(outside, path.join(auditDir(), 'audit.log.20250101-000000'));

      const w = writer();
      await appendRows(w, 2);

      expect((await store().read()).status, 'the walk refused the link, so nothing was adopted').toBe('absent');
      expect(lines.some((line) => line.includes('audit-checkpoint-unavailable'))).toBe(true);
      expect(monitor.getSnapshot().auditCheckpoint).toMatchObject({
        status: 'degraded',
        cause: 'checkpoint-unavailable'
      });
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('FR-R5-F13 (FR-006) — clears chain-broken on verified chain after appending a chain-verified row', async () => {
    const w = writer();
    await appendRows(w, 3);
    await checkpointAt(3);

    w.noteChainBreak('simulated break before restore');
    expect(monitor.getSnapshot().audit).toMatchObject({
      status: 'unavailable',
      cause: 'chain-broken'
    });

    await runVerifyAuditChain({
      workspaceRoot: workspace,
      notifier: notifier(),
      logger: new SanitizedLogger([]),
      onBreak,
      onLoss,
      onVerified: () => w.noteChainVerified(),
      readCheckpoint: () => w.readCheckpoint()
    });
    await checkpointAt(4);

    expect(monitor.getSnapshot().audit).toMatchObject({
      status: 'healthy',
      cause: null
    });
    const rows = (await rawRows()).map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(rows.at(-1)).toMatchObject({
      eventType: 'audit-integrity-condition',
      payload: {
        condition: 'chain-verified',
        conditionVersion: 1,
        entries: 3,
        cuts: 0
      }
    });
    expect(verifyAuditChainAt(auditDir())?.verdict).toMatchObject({ ok: true, entries: 4 });
  });

  it('FR-R5-F13 (FR-007) — re-anchors the checkpoint in-place without deleting or moving .schegent/audit.log', async () => {
    const w = writer();
    await appendRows(w, 4);
    await checkpointAt(4);
    await removeLastRow();
    await verify();
    monitor.reportFailure('audit', 'history-shorter');
    expect(monitor.getSnapshot().audit.cause).toBe('history-shorter');

    expect(await w.reanchorCheckpoint()).toBe('reanchored');
    expect(monitor.getSnapshot().audit).toMatchObject({ status: 'healthy', cause: null });
    expect(monitor.getSnapshot().auditCheckpoint).toMatchObject({ status: 'healthy', cause: null });

    const rows = (await rawRows()).map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(rows.at(-1)).toMatchObject({
      eventType: 'audit-integrity-condition',
      payload: {
        condition: 'checkpoint-reanchored',
        conditionVersion: 1,
        priorStatus: 'active',
        priorPosition: 4,
        newPosition: 4
      }
    });
    expectLoss(await verify(), { state: 'consistent', position: 4 });
  });

  it('FR-R5-F13 (FR-004, FR-007) — recovers from a corrupt checkpoint file when allowOverwriteUnreadable is true', async () => {
    const w = writer();
    await appendRows(w, 2);
    await checkpointAt(2);
    await fs.writeFile(checkpointFile(), '{ corrupt json');

    // A fresh writer settles in mode 'off' and reports auditCheckpoint degraded
    const w2 = writer();
    await appendRows(w2, 1, 'after-corrupt');
    expect(monitor.getSnapshot().auditCheckpoint).toMatchObject({
      status: 'degraded',
      cause: 'checkpoint-unavailable'
    });

    expect(await w2.reanchorCheckpoint()).toBe('unreadable-refused');
    expect(await w2.reanchorCheckpoint({ allowOverwriteUnreadable: true })).toBe('reanchored');
    expect(monitor.getSnapshot().auditCheckpoint).toMatchObject({
      status: 'healthy',
      cause: null
    });
    expectLoss(await verify(), { state: 'consistent', position: 4 });
  });
});
