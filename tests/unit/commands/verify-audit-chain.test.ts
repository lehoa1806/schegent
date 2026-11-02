// FR-R3-194 — the decisions `runVerifyAuditChain` makes, pinned.
//
// WHY THIS EXISTS BESIDE `tests/unit/audit/audit-chain-end-to-end.test.ts`. That file proves
// the hash walk reads the chain the real writer produces. It cannot see the command's own
// choices, and those are the security-relevant part: what the operator is told, at what level,
// and whether the audit sink is reported as failing. Each is one line in
// `src/commands/verify-audit-chain.ts`, and each could be inverted, for example an unreadable
// log reported as verified, with no test failing.
//
// HOW. The broken and verified chains are written by the real `AuditLogWriter` and the break
// is made by editing bytes on disk, as the end-to-end file does. The unreadable log is a
// directory standing where `audit.log` should be, so the real read fails with EISDIR for every
// user and platform. One stub exists: a module mock that delegates to the real verifier and is
// reset after every case, so a throw that is not an `Error` can be queued in exactly one place.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CHAIN_UNREADABLE_TOAST,
  DAMAGE_RECORDED_NOT_REPAIRED,
  TRANSITION_TEXT,
  renderLossCheck,
  runVerifyAuditChain
} from '../../../src/commands/verify-audit-chain';
import { digestOf, verifyAuditChainAt } from '../../../src/audit/audit-chain';
import type { CheckpointRead, LossState } from '../../../src/audit/audit-checkpoint';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { Notifier } from '../../../src/ui/notifications';
import { removeTempRoot } from '../../temp-root-cleanup';

vi.mock('../../../src/audit/audit-chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/audit/audit-chain')>();
  return { ...real, verifyAuditChainAt: vi.fn(real.verifyAuditChainAt) };
});

interface Sent {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

describe('Verify Audit Chain command', () => {
  let workspaceRoot: string;
  let sent: Sent[];
  let notifier: Notifier;
  let logger: SanitizedLogger;
  let onBreak: ReturnType<typeof vi.fn<(detail: string) => void>>;
  let onLoss: ReturnType<typeof vi.fn<(code: 'history-shorter' | 'history-missing', detail: string) => void>>;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-verify-chain-'));
    sent = [];
    notifier = {
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
    } as unknown as Notifier;
    logger = new SanitizedLogger();
    onBreak = vi.fn<(detail: string) => void>();
    onLoss = vi.fn<(code: 'history-shorter' | 'history-missing', detail: string) => void>();
  });

  afterEach(async () => {
    vi.mocked(verifyAuditChainAt).mockReset();
    await removeTempRoot(workspaceRoot);
    // SC-005: hooks run after a failing case too, so each case proves its own workspace is gone.
    await expect(fs.access(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // FR-R4-F03 — the checkpoint read is asynchronous (it opens through the safe walk), so the command
  // is too, and every case awaits it. With no checkpoint given the read answers `absent`.
  const run = (read: CheckpointRead = { status: 'absent' }): Promise<void> =>
    runVerifyAuditChain({
      workspaceRoot,
      notifier,
      logger,
      onBreak,
      onLoss,
      readCheckpoint: () => Promise.resolve(read)
    });

  const writerWith = (): AuditLogWriter =>
    new AuditLogWriter(
      {
        workspaceRoot,
        rotationSizeBytes: 10 * 1024 * 1024,
        retentionMaxArchives: 50,
        retentionMaxArchiveAgeMs: 365 * 24 * 60 * 60 * 1000
      },
      logger
    );

  const append = async (writer: AuditLogWriter, i: number): Promise<void> => {
    await writer.append({
      runId: `run-${i}`,
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: { i },
      outcome: 'info'
    });
  };

  describe('the log cannot be read', () => {
    // An unanswerable check is a refusal, never a pass: the one inversion that gives an operator
    // a false all-clear about the evidence itself. The real verifier runs and the real read fails.
    it('U1 — an audit.log that is a directory warns once, says it could not be read, and reports no break', async () => {
      await fs.mkdir(path.join(workspaceRoot, '.schegent', 'audit.log'), { recursive: true });

      await run();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('warn');
      expect(sent[0]!.message).toContain('could not verify the audit chain');
      expect(sent[0]!.message).toContain('could not be read');
      expect(sent[0]!.message).not.toMatch(/verified/);
      expect(sent.map((entry) => entry.message)).toEqual([CHAIN_UNREADABLE_TOAST]);
      expect(onBreak).not.toHaveBeenCalled();
    });

    // No filesystem can make `readFileSync` throw a non-Error, so this is the one stubbed case.
    // FR-R4-F05: the warning is the same fixed sentence whatever was thrown; the description of
    // what was thrown goes to the log, not to the operator's screen.
    it('U2 — a read failure that is not an Error gets the same fixed warning, still a single one', async () => {
      vi.mocked(verifyAuditChainAt).mockImplementationOnce(() => {
        throw 'not-an-error-object';
      });
      const warnLog = vi.spyOn(logger, 'warn');

      await run();

      expect(sent).toEqual([{ level: 'warn', message: CHAIN_UNREADABLE_TOAST }]);
      expect(warnLog).toHaveBeenCalledWith(
        'audit chain verification could not read the log',
        expect.objectContaining({ reasonCode: 'chain-unreadable', error: 'not-an-error-object' })
      );
      expect(onBreak).not.toHaveBeenCalled();
    });

    // FR-R4-F05 (FR-014; contract O, O1): the warning "names basenames, counts and digest
    // prefixes, never a path". A real read fault names the path in its message, so the
    // message is kept for the log and the warning is the fixed sentence.
    it('U3 — a read fault that names a path leaves the path out of the warning and in the log', async () => {
      vi.mocked(verifyAuditChainAt).mockImplementationOnce(() => {
        throw new Error("EACCES: permission denied, open '/synthetic/home/user-252/.schegent/audit.log'");
      });
      const warnLog = vi.spyOn(logger, 'warn');

      await run();

      expect(sent).toEqual([{ level: 'warn', message: CHAIN_UNREADABLE_TOAST }]);
      expect(JSON.stringify(sent)).not.toContain('user-252');
      expect(warnLog).toHaveBeenCalledWith(
        'audit chain verification could not read the log',
        expect.objectContaining({ error: expect.stringContaining('user-252') })
      );
      expect(onBreak).not.toHaveBeenCalled();
    });

    it('U4 — the warning reads as a refusal, names no cause, and points at the log', () => {
      expect(CHAIN_UNREADABLE_TOAST).toBe(
        'Schegent could not verify the audit chain: the log could not be read. See the Schegent log for details.'
      );
    });
  });

  describe('the chain is broken', () => {
    // A detected break must reach the evidence-health surface and read as what it is. The break is
    // one historical entry edited on disk, as the end-to-end file does it: the verifier reports
    // it at the edited entry's successor, entry 3.
    it('B1 — an edited entry calls the break callback once and warns with the same detail', async () => {
      const writer = writerWith();
      for (let i = 0; i < 5; i++) await append(writer, i);
      const logPath = path.join(workspaceRoot, '.schegent', 'audit.log');
      const lines = (await fs.readFile(logPath, 'utf8')).split('\n');
      const edited = JSON.parse(lines[1]!) as Record<string, unknown>;
      edited.outcome = 'success';
      lines[1] = JSON.stringify(edited);
      await fs.writeFile(logPath, lines.join('\n'));

      await run();

      expect(onBreak).toHaveBeenCalledTimes(1);
      const detail = onBreak.mock.calls[0]![0];
      expect(detail.startsWith('broken-link at entry 3')).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('warn');
      expect(sent[0]!.message).toContain('audit chain is broken');
      expect(sent[0]!.message).toContain(detail);
      expect(sent[0]!.message).toContain('FIRST break only');
    });
  });

  describe('the chain verifies', () => {
    // A passing walk reports its counts at information level and calls nothing that could clear
    // an append failure. The counts are also the proof that the real verifier ran, so the stub
    // in the unreadable cases did not leak into these.
    it('V1 — an untouched chain reports its counts at information level and reports no break', async () => {
      const writer = writerWith();
      for (let i = 0; i < 6; i++) await append(writer, i);

      await run();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('info');
      expect(sent[0]!.message).toContain('audit chain verified');
      expect(sent[0]!.message).toContain('1 file(s)');
      expect(sent[0]!.message).toContain('6 chained entries');
      expect(sent[0]!.message).toContain('0 recorded prune(s)');
      expect(sent[0]!.message).not.toContain('Not read');
      expect(onBreak).not.toHaveBeenCalled();
    });

    // A name that starts like the log but carries no recognised stamp is skipped by the verifier,
    // and the verified report must say so rather than let it pass unmentioned.
    it('V2 — a file the verifier did not read is named in the verified report', async () => {
      const writer = writerWith();
      for (let i = 0; i < 6; i++) await append(writer, i);
      await fs.writeFile(path.join(workspaceRoot, '.schegent', 'audit.log.1'), 'not read\n');

      await run();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('info');
      expect(sent[0]!.message).toContain('audit chain verified');
      expect(sent[0]!.message).toContain('1 file(s)');
      expect(sent[0]!.message).toContain('6 chained entries');
      expect(sent[0]!.message).toContain('0 recorded prune(s)');
      expect(sent[0]!.message).toContain('Not read (unrecognized name): audit.log.1.');
      expect(onBreak).not.toHaveBeenCalled();
    });
  });

  describe('there is no log yet', () => {
    // A fresh workspace is not a failure. Reporting it as one would train operators to ignore the
    // one report that matters, so it gets one information message and no break report.
    it('N1 — a workspace with no .schegent and no checkpoint reads as a new workspace', async () => {
      await run();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('info');
      expect(sent[0]!.message).toContain(renderLossCheck({ state: 'new-workspace' }).text);
      expect(onBreak).not.toHaveBeenCalled();
    });
  });

  describe('the loss check and the chain facts (O1; FR-R4-F03)', () => {
    // The seven loss states, the transition line and the damage lines, each read from the result the
    // operator sees. The texts are the command's own exported constants, never copies of the prose.
    const KEY = 'k'.repeat(64);
    const activeAt = (
      position: number,
      headDigest: string,
      over: Record<string, unknown> = {}
    ): CheckpointRead => ({
      status: 'active',
      checkpoint: {
        version: 1,
        workspaceKey: KEY,
        state: 'active',
        origin: 'new',
        headDigest,
        position,
        establishedAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
        ...over
      } as never
    });
    const logPath = (): string => path.join(workspaceRoot, '.schegent', 'audit.log');
    const lastRowDigest = async (): Promise<string> => {
      const rows = (await fs.readFile(logPath(), 'utf8')).split('\n').filter((line) => line.trim().length > 0);
      return digestOf(rows[rows.length - 1] as string);
    };
    const written = async (rows = 6): Promise<void> => {
      const writer = writerWith();
      for (let i = 0; i < rows; i++) await append(writer, i);
    };
    const expectResult = (state: LossState, level: 'info' | 'warn'): void => {
      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe(level);
      expect(sent[0]!.message).toContain(renderLossCheck(state).text);
    };

    it('consistent: history reaches the checkpointed entry, at information level, and fails nothing', async () => {
      await written();
      await run(activeAt(6, await lastRowDigest()));

      expect(sent[0]!.message).toContain('audit chain verified');
      expectResult({ state: 'consistent', position: 6 }, 'info');
      expect(onLoss).not.toHaveBeenCalled();
      expect(onBreak).not.toHaveBeenCalled();
    });

    it('adopted: says when loss detection began and that earlier history was not checked for loss', async () => {
      await written();
      await run(activeAt(6, await lastRowDigest(), { origin: 'adopted' }));

      expectResult({ state: 'adopted', position: 6, adoptedAtMs: 1_700_000_000_000 }, 'info');
      expect(renderLossCheck({ state: 'adopted', position: 6, adoptedAtMs: 1_700_000_000_000 }).text).toContain(
        '2023-11-14'
      );
      expect(onLoss).not.toHaveBeenCalled();
    });

    it('shorter (tail removed): names the expected and the found counts, warns, and reports history-shorter', async () => {
      await written();
      await run(activeAt(9, 'f'.repeat(64)));

      expectResult({ state: 'shorter', expected: 9, found: 6, detail: 'tail-removed' }, 'warn');
      expect(onLoss).toHaveBeenCalledTimes(1);
      expect(onLoss.mock.calls[0]![0]).toBe('history-shorter');
      expect(onBreak).not.toHaveBeenCalled();
    });

    it('shorter (head absent): history at least as long as the checkpoint that no longer holds its head', async () => {
      await written();
      await run(activeAt(4, 'f'.repeat(64)));

      expectResult({ state: 'shorter', expected: 4, found: 6, detail: 'head-absent' }, 'warn');
      expect(onLoss.mock.calls[0]![0]).toBe('history-shorter');
    });

    it('missing: no audit file with an active checkpoint warns and reports history-missing', async () => {
      await run(activeAt(3, 'f'.repeat(64)));

      expectResult({ state: 'missing', expected: 3 }, 'warn');
      expect(onLoss).toHaveBeenCalledTimes(1);
      expect(onLoss.mock.calls[0]![0]).toBe('history-missing');
    });

    it('no-checkpoint-for-location: history with no checkpoint is information, not a finding', async () => {
      await written();
      await run({ status: 'absent' });

      expectResult({ state: 'no-checkpoint-for-location' }, 'info');
      expect(onLoss).not.toHaveBeenCalled();
    });

    it.each([
      ['corrupt', 'checkpoint-unreadable'],
      ['version-unknown', 'checkpoint-version-unknown'],
      ['unreachable', 'checkpoint-unreachable']
    ] as const)('not-performed (%s): still reports the chain, and never says the history is complete', async (reason, mapped) => {
      await written();
      await run({ status: 'unreadable', reason });

      expect(sent[0]!.message).toContain('audit chain verified');
      expectResult({ state: 'not-performed', reason: mapped }, 'info');
      expect(sent[0]!.message).not.toMatch(/complete/i);
      expect(onLoss).not.toHaveBeenCalled();
    });

    it('not-performed (chain not intact): the break is reported as before, in one result, and no loss is claimed', async () => {
      await written(5);
      const lines = (await fs.readFile(logPath(), 'utf8')).split('\n');
      lines[1] = lines[1]!.replace('"cli-invocation"', '"warning"');
      await fs.writeFile(logPath(), lines.join('\n'));

      await run(activeAt(5, 'f'.repeat(64)));

      expect(onBreak).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.message).toContain('audit chain is broken');
      expect(sent[0]!.message).toContain(renderLossCheck({ state: 'not-performed', reason: 'chain-not-intact' }).text);
      expect(onLoss).not.toHaveBeenCalled();
    });

    it('says how the chain began: at genesis, or by linking to the last legacy row', async () => {
      await written(3);
      await run();
      expect(sent[0]!.message).toContain(TRANSITION_TEXT.genesis);
      expect(sent[0]!.message).not.toContain(TRANSITION_TEXT.legacyTail);

      await fs.rm(path.join(workspaceRoot, '.schegent'), { recursive: true, force: true });
      await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
      await fs.writeFile(logPath(), `${JSON.stringify({ id: 'legacy', eventType: 'warning' })}\n`);
      await written(2);
      sent.length = 0;
      await run();
      expect(sent[0]!.message).toContain(TRANSITION_TEXT.legacyTail);
      expect(sent[0]!.message).toContain('1 leading entries predate the chain');
    });

    it('names each diagnosed damage by file, line and length, and says it is recorded, not repaired', async () => {
      await written(2);
      await fs.appendFile(logPath(), '{"id":"torn","eventType":"cli-inv');
      await append(writerWith(), 9);

      await run();

      expect(sent[0]!.level, 'diagnosed damage is reported, not failed').toBe('info');
      expect(sent[0]!.message).toContain('audit chain verified');
      expect(sent[0]!.message).toMatch(/audit\.log line 3, 33 bytes, sha256 [0-9a-f]{12}/);
      expect(sent[0]!.message).toContain(DAMAGE_RECORDED_NOT_REPAIRED);
      expect(onBreak).not.toHaveBeenCalled();
    });

    it('names the way back from each loss finding: move the history out first, then the reset command', async () => {
      const shorter = renderLossCheck({ state: 'shorter', expected: 9, found: 6, detail: 'tail-removed' }).text;
      expect(shorter).toContain('move the audit history out of .schegent/');
      expect(shorter).toContain('Schegent: Reset Audit History Checkpoint');
      const headAbsent = renderLossCheck({ state: 'shorter', expected: 4, found: 6, detail: 'head-absent' }).text;
      expect(headAbsent).toContain('Schegent: Reset Audit History Checkpoint');
      const missing = renderLossCheck({ state: 'missing', expected: 3 }).text;
      expect(missing).toContain('Schegent: Reset Audit History Checkpoint');
      expect(missing).not.toContain('move the audit history out');
    });

    it('writes nothing: no file under .schegent changes and none is created, whatever the result', async () => {
      await written();
      const names = async (): Promise<string[]> => (await fs.readdir(path.join(workspaceRoot, '.schegent'))).sort();
      const before = await names();
      const bytes = await fs.readFile(logPath());

      await run(activeAt(9, 'f'.repeat(64)));

      expect(await names()).toEqual(before);
      expect((await fs.readFile(logPath())).equals(bytes)).toBe(true);
    });
  });
});
