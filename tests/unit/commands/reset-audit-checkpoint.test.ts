// FR-R4-F03 (FR-017; contract T13, O2, O3; R17; TA8, TA9) — `Schegent: Reset Audit History Checkpoint`.
//
// WHAT THE COMMAND IS FOR. After the audit history is lost, or removed on purpose, the head checkpoint
// outside the workspace keeps saying "established history existed here", and the loss finding would
// last for ever. The reset retires the checkpoint so the history that follows can begin, and the next
// history's first row is a reset record, so the history itself shows the reset. It is an owner-only,
// mutating command, it asks for modal confirmation, and it never deletes or moves evidence: it refuses
// while any `audit.log*` file is present, and tells the operator to move the history out first.
//
// REAL COMPONENTS. The real writer, the real checkpoint store and a real workspace. The one stub is
// `vscode.window.showWarningMessage`, the modal. Each row of contract O2's table is one case.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { modal, registered } = vi.hoisted(() => ({
  modal: { answer: undefined as string | undefined, calls: [] as unknown[][], beforeAnswer: null as null | (() => Promise<void>) },
  registered: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: async (...args: unknown[]) => {
      modal.calls.push(args);
      await modal.beforeAnswer?.();
      return modal.answer;
    }
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(id, handler);
      return { dispose: () => undefined };
    }
  }
}));

import { registerGuardedCommand } from '../../../src/activation/guarded-command-registration';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { checkpointKey } from '../../../src/audit/audit-checkpoint';
import { createAuditCheckpointStore } from '../../../src/audit/audit-checkpoint-store';
import { ensureCheckpointRoot } from '../../../src/audit/audit-checkpoint-root';
import {
  RESET_AUDIT_CHECKPOINT_TEXT,
  runResetAuditCheckpoint
} from '../../../src/commands/reset-audit-checkpoint';
import { SanitizedLogger } from '../../../src/lib/logger';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';
import type { Notifier } from '../../../src/ui/notifications';

const ONE_ROW = (runId: string) =>
  ({ eventType: 'phase-start', runId, payload: { phase: 'implement' } }) as never;

describe('Reset Audit History Checkpoint (O2)', () => {
  let workspace: string;
  let storage: string;
  let key: string;
  let sent: Array<{ level: string; message: string }>;
  let monitor: EvidenceHealthMonitor;
  let owner: { fence: number | null };
  let writer: AuditLogWriter;
  const auditDir = (): string => path.join(workspace, '.schegent');
  const checkpointFile = (): string => path.join(storage, 'audit-checkpoints', `${key}.json`);

  const notifier = (): Pick<Notifier, 'info' | 'warn'> =>
    ({
      info: (message: string) => {
        sent.push({ level: 'info', message });
      },
      warn: (message: string) => {
        sent.push({ level: 'warn', message });
        return Promise.resolve(undefined);
      }
    }) as unknown as Pick<Notifier, 'info' | 'warn'>;

  const run = (): Promise<unknown> => runResetAuditCheckpoint({ workspaceRoot: workspace, notifier: notifier(), writer });

  /** Write history through a real writer with the checkpoint, and wait for the advance. */
  async function establishHistory(rows: number): Promise<void> {
    for (let n = 0; n < rows; n += 1) await writer.append(ONE_ROW(`row-${n}`));
    await vi.waitFor(async () => {
      const read = await createAuditCheckpointStore({ root: storage, key }).read();
      expect(read.status === 'active' ? read.checkpoint.position : -1).toBe(rows);
    });
  }

  /** Move the audit history out of `.schegent/` the way an operator would. */
  const moveHistoryOut = async (): Promise<void> => {
    await fs.rm(auditDir(), { recursive: true, force: true });
  };

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-reset-ws-')));
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-reset-store-'));
    await ensureCheckpointRoot(storage);
    key = checkpointKey(workspace);
    sent = [];
    monitor = new EvidenceHealthMonitor();
    owner = { fence: 1 };
    modal.answer = RESET_AUDIT_CHECKPOINT_TEXT.confirmLabel;
    modal.calls = [];
    modal.beforeAnswer = null;
    registered.clear();
    writer = new AuditLogWriter(
      {
        workspaceRoot: workspace,
        authority: { currentFence: async () => owner.fence },
        checkpoint: createAuditCheckpointStore({ root: storage, key })
      },
      new SanitizedLogger([]),
      monitor
    );
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(storage, { recursive: true, force: true });
  });

  it('refuses while any audit.log file is present, and writes nothing', async () => {
    await establishHistory(3);
    const before = await fs.readFile(checkpointFile());

    await run();

    expect(sent).toEqual([{ level: 'warn', message: RESET_AUDIT_CHECKPOINT_TEXT.filesPresent }]);
    expect(modal.calls, 'no modal for a refusal').toEqual([]);
    expect((await fs.readFile(checkpointFile())).equals(before)).toBe(true);
    expect((await fs.readdir(auditDir())).some((name) => name.startsWith('audit.log'))).toBe(true);
  });

  it('says there is no checkpoint to reset when there is none, and writes nothing', async () => {
    await run();

    expect(sent).toEqual([{ level: 'info', message: RESET_AUDIT_CHECKPOINT_TEXT.absent }]);
    expect(modal.calls).toEqual([]);
    await expect(fs.stat(checkpointFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('asks for modal confirmation, and writes nothing when the operator cancels', async () => {
    await establishHistory(3);
    await moveHistoryOut();
    const before = await fs.readFile(checkpointFile());
    modal.answer = undefined;

    await run();

    expect(modal.calls).toHaveLength(1);
    expect(modal.calls[0]?.[1], 'a modal, not a toast').toMatchObject({ modal: true });
    expect((await fs.readFile(checkpointFile())).equals(before), 'cancel leaves the checkpoint alone').toBe(true);
    expect(sent.some((entry) => entry.message === RESET_AUDIT_CHECKPOINT_TEXT.done)).toBe(false);
  });

  it('retires the checkpoint, clears the history finding and says what happens next, when confirmed', async () => {
    await establishHistory(3);
    await moveHistoryOut();
    monitor.reportFailure('audit', 'history-missing');

    await run();

    const parsed = JSON.parse(await fs.readFile(checkpointFile(), 'utf8')) as Record<string, unknown>;
    expect(parsed).toMatchObject({ state: 'retired', headDigest: '', position: 0, retiredPosition: 3 });
    expect(typeof parsed.retiredAtMs).toBe('number');
    expect(monitor.getSnapshot().audit.status, 'history-missing is cleared by the reset').toBe('healthy');
    expect(sent).toEqual([{ level: 'info', message: RESET_AUDIT_CHECKPOINT_TEXT.done }]);
    expect(RESET_AUDIT_CHECKPOINT_TEXT.done).toContain('reset record');
    await expect(fs.stat(auditDir()), 'the command deletes and moves nothing').rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses at the step when this window stops being the owner after the modal', async () => {
    await establishHistory(3);
    await moveHistoryOut();
    const before = await fs.readFile(checkpointFile());
    modal.beforeAnswer = async () => {
      owner.fence = null;
    };

    await run();

    expect(sent).toEqual([{ level: 'warn', message: RESET_AUDIT_CHECKPOINT_TEXT.notOwner }]);
    expect((await fs.readFile(checkpointFile())).equals(before)).toBe(true);
  });

  it('refuses at the step when history reappears after the modal', async () => {
    await establishHistory(3);
    await moveHistoryOut();
    const before = await fs.readFile(checkpointFile());
    modal.beforeAnswer = async () => {
      await fs.mkdir(auditDir(), { recursive: true });
      await fs.writeFile(path.join(auditDir(), 'audit.log'), '');
    };

    await run();

    expect(sent).toEqual([{ level: 'warn', message: RESET_AUDIT_CHECKPOINT_TEXT.filesPresent }]);
    expect((await fs.readFile(checkpointFile())).equals(before)).toBe(true);
  });

  it('does not retire a checkpoint it cannot read, and says so', async () => {
    await establishHistory(1);
    await moveHistoryOut();
    await fs.writeFile(checkpointFile(), '{ not json');

    await run();

    expect(sent).toEqual([{ level: 'warn', message: RESET_AUDIT_CHECKPOINT_TEXT.unavailable }]);
    expect(await fs.readFile(checkpointFile(), 'utf8')).toBe('{ not json');
  });

  describe('through the guard (O3, TA8)', () => {
    const deps = (trusted: boolean, isOwner: () => Promise<boolean>) => {
      const warnings: string[] = [];
      return {
        warnings,
        deps: {
          isWorkspaceTrusted: () => trusted,
          notifier: { warn: (message: string) => void warnings.push(message) },
          logger: { info: () => undefined },
          isOwner
        }
      };
    };

    it('refuses untrusted with the trust refusal, before anything is read', async () => {
      await establishHistory(1);
      await moveHistoryOut();
      const h = deps(false, async () => true);
      registerGuardedCommand(h.deps, 'schegent.resetAuditCheckpoint', () => run());

      expect(await registered.get('schegent.resetAuditCheckpoint')!()).toBeUndefined();

      expect(modal.calls).toEqual([]);
      expect(h.warnings).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(checkpointFile(), 'utf8'))).toMatchObject({ state: 'active' });
    });

    it('refuses in a window that is not the owner, with the palette wording', async () => {
      await establishHistory(1);
      await moveHistoryOut();
      const h = deps(true, async () => false);
      registerGuardedCommand(h.deps, 'schegent.resetAuditCheckpoint', () => run());

      expect(await registered.get('schegent.resetAuditCheckpoint')!()).toBeUndefined();

      expect(modal.calls).toEqual([]);
      expect(h.warnings).toEqual(['Schegent: another window holds the workspace lock; ignoring request.']);
    });
  });
});
