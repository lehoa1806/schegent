import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import {
  AuditNotOwnerError,
  lockWriteAuthority,
  type AuditWriteAuthority
} from '../../../src/audit/audit-write-authority';
import { digestOf, verifyAuditChainAt } from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';

/**
 * FR-R4-F03 (FR-010, FR-012, SC-004; contract T6, W4, R10) — only the owner writes the audit log, and
 * the question is asked INSIDE every step, at its own turn.
 *
 * The writer is built in every window, because a window that does not own the workspace still reads
 * and verifies through it. Nothing stopped such a window from appending: its rows interleaved with
 * the owner's and forked the chain at the next transfer. Asking once at `append()` is not enough
 * either: a step queued while this window was the owner runs later, so it asks again when it runs.
 *
 * REAL COMPONENTS, WITH THE OWNERSHIP SEAM. Two writers share one temporary workspace and one real
 * log; each has an `AuditWriteAuthority` adapter over one shared mutable cell, which is how two
 * "windows" are modelled without two real ones (qualification with two real windows stays pending,
 * R20). "Noticed" counts the `audit-not-owner` warnings.
 */

const NOT_OWNER_NOTICE = 'audit-not-owner';

interface Cell {
  holder: 'a' | 'b' | null;
  fence: number;
}

describe('only the owner writes, and every refusal is noticed (SC-004)', () => {
  let root: string;
  let lines: string[];
  let cell: Cell;
  const logFile = (): string => path.join(root, '.schegent', 'audit.log');
  const entry = (runId: string) =>
    ({ eventType: 'phase-start', runId, payload: { phase: 'implement' } }) as never;
  const notices = (): number => lines.filter((line) => line.includes(NOT_OWNER_NOTICE)).length;

  const authorityFor = (id: 'a' | 'b'): AuditWriteAuthority => ({
    currentFence: async () => (cell.holder === id ? cell.fence : null)
  });
  /** Hand ownership to `holder` under a new fence, as a transfer does. */
  const give = (holder: 'a' | 'b' | null): void => {
    cell = { holder, fence: cell.fence + 1 };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-authority-'));
    lines = [];
    cell = { holder: null, fence: 0 };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const writerFor = (authority: AuditWriteAuthority, health?: EvidenceHealthMonitor): AuditLogWriter =>
    new AuditLogWriter(
      { workspaceRoot: root, authority },
      new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]),
      health
    );

  const rawRows = async (): Promise<string[]> =>
    (await fs.readFile(logFile(), 'utf8')).split('\n').filter((line) => line.trim().length > 0);

  it('writes nothing, rejects with AuditNotOwnerError, notices once and leaves health unchanged when not the owner', async () => {
    const monitor = new EvidenceHealthMonitor();
    const writer = writerFor(authorityFor('a'), monitor);
    give('b');

    const outcome = await writer.append(entry('refused')).then(
      () => null,
      (err: unknown) => err
    );

    expect(outcome).toBeInstanceOf(AuditNotOwnerError);
    expect((outcome as AuditNotOwnerError).eventType).toBe('phase-start');
    expect(notices()).toBe(1);
    expect(monitor.getSnapshot().audit).toMatchObject({ status: 'healthy', failureCount: 0 });
    await expect(fs.stat(logFile())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(lines.join('\n')).not.toContain(root);
  });

  it('refuses every step queued before ownership was lost, at its own turn', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    give('a');
    let asks = 0;
    const writer = writerFor({
      currentFence: async () => {
        asks += 1;
        // The first step waits here, so the other two are queued behind it while this window owns.
        if (asks === 1) await held;
        return cell.holder === 'a' ? cell.fence : null;
      }
    });

    const queued = [writer.append(entry('one')), writer.append(entry('two')), writer.append(entry('three'))];
    const settled = Promise.allSettled(queued);
    give('b');
    release();
    const outcomes = await settled;

    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const outcome of outcomes) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(AuditNotOwnerError);
    }
    expect(notices()).toBe(3);
    await expect(fs.stat(logFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps one verifiable chain across two writers as ownership moves a, b, a, and notices every non-owner event', async () => {
    const a = writerFor(authorityFor('a'));
    const b = writerFor(authorityFor('b'));

    give('a');
    await a.append(entry('a-1'));
    await expect(b.append(entry('b-refused-1'))).rejects.toBeInstanceOf(AuditNotOwnerError);
    give('b');
    await b.append(entry('b-1'));
    await expect(a.append(entry('a-refused-1'))).rejects.toBeInstanceOf(AuditNotOwnerError);
    give('a');
    await a.append(entry('a-2'));
    await expect(b.append(entry('b-refused-2'))).rejects.toBeInstanceOf(AuditNotOwnerError);

    const rows = (await rawRows()).map((row) => JSON.parse(row) as { runId: string });
    expect(rows.map((row) => row.runId)).toEqual(['a-1', 'b-1', 'a-2']);
    expect(verifyAuditChainAt(path.join(root, '.schegent'))?.verdict).toMatchObject({ ok: true, entries: 3 });
    expect(notices()).toBe(3);
  });

  it('links the first row of the window that gains ownership to the last row on disk, not to its own last row', async () => {
    const a = writerFor(authorityFor('a'));
    const b = writerFor(authorityFor('b'));

    give('b');
    await b.append(entry('b-before'));
    give('a');
    await a.append(entry('a-1'));
    await a.append(entry('a-2'));
    await a.append(entry('a-3'));
    give('b');
    await b.append(entry('b-after'));

    const rows = await rawRows();
    expect(rows).toHaveLength(5);
    expect((JSON.parse(rows[4] as string) as { prevDigest: string }).prevDigest).toBe(digestOf(rows[3] as string));
    expect(verifyAuditChainAt(path.join(root, '.schegent'))?.verdict).toMatchObject({ ok: true, entries: 5 });
  });

  it('re-reads the tail when the fence changes with no gain event at all', async () => {
    const a = writerFor(authorityFor('a'));
    const b = writerFor(authorityFor('b'));

    give('a');
    await a.append(entry('a-before'));
    give('b');
    await b.append(entry('b-between'));
    // Lost and regained within one beat: nothing told `a`, and only the fence number differs.
    give('a');
    await a.append(entry('a-after'));

    const rows = await rawRows();
    expect(rows).toHaveLength(3);
    expect(
      (JSON.parse(rows[2] as string) as { prevDigest: string }).prevDigest,
      'linked to a row this writer did not write'
    ).toBe(digestOf(rows[1] as string));
    expect(verifyAuditChainAt(path.join(root, '.schegent'))?.verdict).toMatchObject({ ok: true, entries: 3 });
  });
});

describe('the production adapter fails closed (R10)', () => {
  const lock = (primary: boolean | Error, fence: number | null) => ({
    hasPrimacy: async (): Promise<boolean> => {
      if (primary instanceof Error) throw primary;
      return primary;
    },
    fenceOfRecord: (): number | null => fence
  });

  it('answers the fence while primary', async () => {
    expect(await lockWriteAuthority(lock(true, 4)).currentFence()).toBe(4);
  });

  it('answers null when not primary', async () => {
    expect(await lockWriteAuthority(lock(false, 4)).currentFence()).toBeNull();
  });

  it('answers null when the lock cannot answer, and when a primary window has no fence', async () => {
    expect(await lockWriteAuthority(lock(new Error('store unreadable'), 4)).currentFence()).toBeNull();
    expect(await lockWriteAuthority(lock(true, null)).currentFence()).toBeNull();
  });
});

describe('production wiring supplies a real authority (W9)', () => {
  // A writer built with no authority is the owner of every window with a constant fence, which is
  // what the many tests that build one without a lock rely on. That default is right for them and
  // wrong for the product: a window wired without an authority appends beside the owner and forks
  // the chain at the next transfer. The cases above prove the adapter fails closed; these prove
  // activation hands it to the writer, on the source, because nothing else builds that call.
  const wiring = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'src', 'activation', 'evidence-wiring.ts'),
    'utf8'
  );
  // The options literal of the one `new AuditLogWriter(` call, up to its first closing brace.
  const AUTHORITY_IN_WRITER_OPTIONS =
    /new AuditLogWriter\(\s*\{[^}]*authority:\s*lockWriteAuthority\(lock\)/;
  const CHECKPOINT_IN_WRITER_OPTIONS =
    /new AuditLogWriter\(\s*\{[^}]*\.\.\.\(checkpoint === undefined \? \{\} : \{ checkpoint \}\)/;

  it('constructs the writer with the lock-backed authority', () => {
    expect(wiring).toMatch(AUTHORITY_IN_WRITER_OPTIONS);
  });

  it('hands the writer the head checkpoint port when the store could be prepared', () => {
    expect(wiring).toMatch(CHECKPOINT_IN_WRITER_OPTIONS);
  });

  it('never wires the test default into production', () => {
    expect(wiring).not.toContain('OWNER_FOR_TESTS');
  });

  it('the patterns discriminate: they do not match the call with the line removed', () => {
    const withoutAuthority = wiring.replace('authority: lockWriteAuthority(lock),', '');
    const withoutCheckpoint = wiring.replace('...(checkpoint === undefined ? {} : { checkpoint })', '');
    expect(withoutAuthority).not.toBe(wiring);
    expect(withoutCheckpoint).not.toBe(wiring);
    expect(withoutAuthority).not.toMatch(AUTHORITY_IN_WRITER_OPTIONS);
    expect(withoutCheckpoint).not.toMatch(CHECKPOINT_IN_WRITER_OPTIONS);
  });
});
