import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditWriteAuthority } from '../../../src/audit/audit-write-authority';
import { AUDIT_CHAIN_GENESIS, digestOf, verifyAuditChainAt } from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R4-F03 (FR-013, FR-014, SC-005; contract T7, W1, W5) — constructing the audit writer changes
 * nothing, and archive maintenance is one explicit, latched step behind the owner check.
 *
 * The constructor used to queue a retention sweep: it narrowed archive modes, unlinked expired
 * archives and wrote a cut record, all before any trust check or election, in a window the operator
 * had not trusted. Construction is now read-only. The sweep is `runArchiveMaintenance()`, called from
 * the trust gate in the window that won the election. The fixture holds expired archives, archives at
 * `0644` and a cut file, so "unchanged" compares bytes, modes, names and the cut file.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRED_ARCHIVE = 'audit.log.20250101-000000-000-aaaaaaaa';
const KEPT_ARCHIVE = 'audit.log.20260101-000000-000-bbbbbbbb';
const CUTS_FILE = 'audit.log.cuts';

const chainedRow = (n: number, prevDigest: string): string =>
  JSON.stringify({
    id: `row-${n}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    eventType: 'phase-start',
    runId: 'r',
    payload: { phase: 'implement' },
    schemaVersion: 3,
    prevDigest,
    digestAlg: 'sha256'
  });

function chainFrom(from: string, firstId: number, count: number): { lines: string[]; head: string } {
  const lines: string[] = [];
  let head = from;
  for (let n = 0; n < count; n += 1) {
    const line = chainedRow(firstId + n, head);
    lines.push(line);
    head = digestOf(line);
  }
  return { lines, head };
}

type Snapshot = ReadonlyMap<string, { readonly mode: number; readonly bytes: string }>;

/** Two ticks of the event loop are not enough for a thread-pool fs call: wait for real quiet. */
async function drain(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('construction is read-only and maintenance is one explicit step (SC-005)', () => {
  let root: string;
  let owner: { fence: number | null };
  let authority: AuditWriteAuthority;
  const auditDir = (): string => path.join(root, '.schegent');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-maintenance-'));
    owner = { fence: 7 };
    authority = { currentFence: async () => owner.fence };
    await fs.mkdir(auditDir(), { recursive: true, mode: 0o700 });

    const expired = chainFrom(AUDIT_CHAIN_GENESIS, 1, 3);
    const kept = chainFrom(expired.head, 4, 2);
    await fs.writeFile(path.join(auditDir(), EXPIRED_ARCHIVE), `${expired.lines.join('\n')}\n`);
    await fs.writeFile(path.join(auditDir(), KEPT_ARCHIVE), `${kept.lines.join('\n')}\n`);
    await fs.writeFile(
      path.join(auditDir(), CUTS_FILE),
      `${JSON.stringify({ kind: 'audit-cut', cutAtMs: 1, removedFrom: AUDIT_CHAIN_GENESIS, removedTo: AUDIT_CHAIN_GENESIS, removedCount: 0 })}\n`
    );
    for (const name of [EXPIRED_ARCHIVE, KEPT_ARCHIVE, CUTS_FILE]) {
      await fs.chmod(path.join(auditDir(), name), 0o644);
    }
    const old = new Date(Date.now() - 200 * DAY_MS);
    await fs.utimes(path.join(auditDir(), EXPIRED_ARCHIVE), old, old);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function snapshot(): Promise<Snapshot> {
    const copy = new Map<string, { mode: number; bytes: string }>();
    for (const name of await fs.readdir(auditDir())) {
      const file = path.join(auditDir(), name);
      const [stat, bytes] = await Promise.all([fs.stat(file), fs.readFile(file)]);
      copy.set(name, { mode: stat.mode & 0o777, bytes: bytes.toString('base64') });
    }
    return copy;
  }

  const newWriter = (): AuditLogWriter =>
    new AuditLogWriter({ workspaceRoot: root, authority }, new SanitizedLogger());

  it('leaves expired archives, wide modes, names and the cut file unchanged when constructed', async () => {
    const before = await snapshot();
    expect(before.get(EXPIRED_ARCHIVE)?.mode).toBe(0o644);

    newWriter();
    await drain();

    expect(await snapshot()).toEqual(before);
  });

  it('prunes, narrows and writes a version 2 cut when the owner runs maintenance; the chain verifies', async () => {
    const writer = newWriter();
    expect(await writer.runArchiveMaintenance()).toBe('ran');

    const after = await snapshot();
    expect(after.has(EXPIRED_ARCHIVE), 'the expired archive is pruned').toBe(false);
    expect(after.get(KEPT_ARCHIVE)?.mode, 'a kept archive is narrowed').toBe(0o600);

    const cuts = (await fs.readFile(path.join(auditDir(), CUTS_FILE), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(cuts.at(-1)).toMatchObject({
      kind: 'audit-cut',
      version: 2,
      removedChained: 3,
      removedLegacy: 0,
      removedFrom: AUDIT_CHAIN_GENESIS
    });

    expect(verifyAuditChainAt(auditDir())?.verdict).toMatchObject({ ok: true, entries: 2 });
  });

  it('answers already-ran to a second call and touches nothing', async () => {
    const writer = newWriter();
    expect(await writer.runArchiveMaintenance()).toBe('ran');
    const afterFirst = await snapshot();

    expect(await writer.runArchiveMaintenance()).toBe('already-ran');
    await drain();

    expect(await snapshot()).toEqual(afterFirst);
  });

  it('refuses as a non-owner, touches nothing, and does not set the latch', async () => {
    owner.fence = null;
    const writer = newWriter();
    const before = await snapshot();

    expect(await writer.runArchiveMaintenance()).toBe('not-owner');
    await drain();
    expect(await snapshot()).toEqual(before);

    owner.fence = 8;
    expect(await writer.runArchiveMaintenance()).toBe('ran');
    expect((await snapshot()).has(EXPIRED_ARCHIVE)).toBe(false);
  });
});
