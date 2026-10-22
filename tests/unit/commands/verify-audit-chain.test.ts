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
import { runVerifyAuditChain } from '../../../src/commands/verify-audit-chain';
import { verifyAuditChainAt } from '../../../src/audit/audit-chain';
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
  });

  afterEach(async () => {
    vi.mocked(verifyAuditChainAt).mockReset();
    await removeTempRoot(workspaceRoot);
    // SC-005: hooks run after a failing case too, so each case proves its own workspace is gone.
    await expect(fs.access(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const run = (): void => {
    runVerifyAuditChain({ workspaceRoot, notifier, logger, onBreak });
  };

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

      run();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('warn');
      expect(sent[0]!.message).toContain('could not verify the audit chain');
      expect(sent[0]!.message).toContain('could not be read');
      expect(sent[0]!.message).not.toMatch(/verified/);
      expect(onBreak).not.toHaveBeenCalled();
    });

    // No filesystem can make `readFileSync` throw a non-Error, so this is the one stubbed case.
    it('U2 — a read failure that is not an Error is named unknown, still a single warning', () => {
      vi.mocked(verifyAuditChainAt).mockImplementationOnce(() => {
        throw 'not-an-error-object';
      });

      run();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('warn');
      expect(sent[0]!.message).toContain('could not verify the audit chain');
      expect(sent[0]!.message).toContain('unknown error');
      expect(onBreak).not.toHaveBeenCalled();
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

      run();

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

      run();

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

      run();

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
    it('N1 — a workspace with no .schegent says there is nothing to verify', () => {
      run();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.level).toBe('info');
      expect(sent[0]!.message).toContain('no audit log yet');
      expect(onBreak).not.toHaveBeenCalled();
    });
  });
});
