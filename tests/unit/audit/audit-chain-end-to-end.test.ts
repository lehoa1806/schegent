// FR-R3-112 (FR-124..FR-126a) — the chain, verified against files the REAL writer produced.
//
// WHY THIS EXISTS BESIDE `audit-chain.test.ts`. That file drives `verifyChain` over
// hand-built line arrays, which is the right way to pin the walk's edge cases and the wrong
// way to establish that the product's own rotation, pruning and file naming produce a chain
// this verifier can read. The integer-suffix bug is the proof: every unit test over
// hand-built arrays passed while the script silently read one file. So these cases use
// `AuditLogWriter` for the writing and `verifyAuditChainAt` for the reading, and touch the
// bytes on disk when the point is that a tampered log is caught.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { verifyAuditChainAt, cutRecordFor } from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';
import { removeTempRoot } from '../../temp-root-cleanup';

describe('the chain the product writes is the chain the verifier reads', () => {
  let workspaceRoot: string;
  let auditDir: string;
  let logger: SanitizedLogger;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-chain-e2e-'));
    auditDir = path.join(workspaceRoot, '.schegent');
    logger = new SanitizedLogger();
  });

  afterEach(async () => {
    await removeTempRoot(workspaceRoot);
  });

  const writerWith = (overrides: Record<string, number> = {}): AuditLogWriter =>
    new AuditLogWriter(
      {
        workspaceRoot,
        rotationSizeBytes: 10 * 1024 * 1024,
        retentionMaxArchives: 50,
        retentionMaxArchiveAgeMs: 365 * 24 * 60 * 60 * 1000,
        ...overrides
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

  it('verifies a single untouched file end to end', async () => {
    const writer = writerWith();
    for (let i = 0; i < 6; i++) await append(writer, i);
    const checked = verifyAuditChainAt(auditDir);
    expect(checked).not.toBeNull();
    expect(checked!.verdict.ok, JSON.stringify(checked!.verdict)).toBe(true);
    expect(checked!.verdict.ok && checked!.verdict.entries).toBe(6);
    // Non-vacuity: a chain of zero entries verifies trivially, so the count is asserted.
    expect(checked!.verdict.ok && checked!.verdict.unchainedPrefix).toBe(0);
  });

  it('FR-126 — verifies across real rotation boundaries, in the writer\'s own file order', async () => {
    // Rotation at one byte means every append rotates, so the chain has to cross every
    // boundary. This is the case the integer-suffix bug would have "passed" by reading only
    // the live file: the entry count below is what makes that impossible.
    const writer = writerWith({ rotationSizeBytes: 1 });
    for (let i = 0; i < 5; i++) {
      await append(writer, i);
      await new Promise((r) => setTimeout(r, 5));
    }
    const checked = verifyAuditChainAt(auditDir);
    expect(checked!.files.ordered.length, 'archives must actually exist').toBeGreaterThan(3);
    expect(checked!.files.unrecognized, 'every file the writer made must be readable').toEqual([]);
    expect(checked!.verdict.ok, JSON.stringify(checked!.verdict)).toBe(true);
    expect(checked!.verdict.ok && checked!.verdict.entries).toBe(5);
  });

  it('FR-125 — editing one historical entry names THAT entry', async () => {
    const writer = writerWith();
    for (let i = 0; i < 5; i++) await append(writer, i);
    const logPath = path.join(auditDir, 'audit.log');
    const lines = (await fs.readFile(logPath, 'utf8')).split('\n');
    const edited = JSON.parse(lines[1]!) as Record<string, unknown>;
    edited.outcome = 'success';
    lines[1] = JSON.stringify(edited);
    await fs.writeFile(logPath, lines.join('\n'));

    const verdict = verifyAuditChainAt(auditDir)!.verdict;
    expect(verdict.ok).toBe(false);
    // Entry 3 is the first whose link cannot be reproduced: entry 2's bytes changed, so the
    // digest entry 3 carries is the digest of the ORIGINAL entry 2. The edited entry itself
    // still links correctly to entry 1 — which is precisely why the break is reported at its
    // successor and not at the edit.
    expect(!verdict.ok && verdict.atEntry).toBe(3);
    expect(!verdict.ok && verdict.reason).toBe('broken-link');
  });

  it('FR-126a — a pruned set verifies via its cut record', async () => {
    const writer = writerWith({ rotationSizeBytes: 1, retentionMaxArchives: 1 });
    for (let i = 0; i < 5; i++) {
      await append(writer, i);
      await new Promise((r) => setTimeout(r, 5));
    }
    const cuts = await fs.readFile(path.join(auditDir, 'audit.log.cuts'), 'utf8');
    expect(cuts.trim().length, 'the prune must have recorded its cut').toBeGreaterThan(0);
    const verdict = verifyAuditChainAt(auditDir)!.verdict;
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(verdict.ok && verdict.cuts, 'the cut must be COUNTED, not merely tolerated').toBeGreaterThan(0);
  });

  it('FR-126a — the same removal without its cut record is a break', async () => {
    // The load-bearing direction. If a discontinuity verified with or without the record,
    // the record would be decoration and a deletion would be indistinguishable from a prune.
    const writer = writerWith({ rotationSizeBytes: 1, retentionMaxArchives: 1 });
    for (let i = 0; i < 5; i++) {
      await append(writer, i);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(verifyAuditChainAt(auditDir)!.verdict.ok).toBe(true);
    await fs.unlink(path.join(auditDir, 'audit.log.cuts'));
    const verdict = verifyAuditChainAt(auditDir)!.verdict;
    expect(verdict.ok, 'a gap with no cut record must not verify').toBe(false);
  });

  it('owes no cut record for a removal of pre-chain entries only', () => {
    // Those entries never advanced the chain, so recording their removal would move the
    // expected digest off genesis and make the first genuinely chained entry look broken —
    // a false alarm manufactured by the mechanism meant to prevent one.
    const legacy = ['{"id":"a","eventType":"warning"}', '{"id":"b","eventType":"warning"}'];
    expect(cutRecordFor(legacy, 1)).toBeNull();
    expect(cutRecordFor([], 1)).toBeNull();
    expect(cutRecordFor(['   ', ''], 1)).toBeNull();
  });

  it('every entry the writer appends carries a link — never a silent unchained line', async () => {
    // FR-127. The fail-closed claim, checked on the bytes rather than on the intent: a line
    // with no `prevDigest`, or one carrying the genesis marker mid-file, makes every later
    // entry unverifiable while looking ordinary.
    const writer = writerWith();
    for (let i = 0; i < 4; i++) await append(writer, i);
    const lines = (await fs.readFile(path.join(auditDir, 'audit.log'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(4);
    lines.forEach((line, index) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.prevDigest, `entry ${index + 1} must carry a link`).toBe('string');
      expect(parsed.digestAlg).toBe('sha256');
      if (index === 0) expect(parsed.prevDigest).toBe('genesis');
      else expect(parsed.prevDigest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('continues the chain across a host restart rather than restarting it mid-file', async () => {
    // THE CASE THAT WAS MISSING, and it is the one that would have broken every real workspace.
    // A fresh `AuditLogWriter` starts at the genesis marker. Without seeding from the log already
    // on disk, the first append after an activation writes `prevDigest: "genesis"` into the middle
    // of the file — and the verifier reports that as a break, which is indistinguishable from a
    // removed entry. Every unit case above passed throughout, because none of them constructed a
    // SECOND writer over the same file.
    const first = writerWith();
    for (let i = 0; i < 3; i++) await append(first, i);

    const afterRestart = writerWith();
    for (let i = 3; i < 6; i++) await append(afterRestart, i);

    const checked = verifyAuditChainAt(auditDir)!;
    expect(checked.verdict.ok, JSON.stringify(checked.verdict)).toBe(true);
    expect(checked.verdict.ok && checked.verdict.entries).toBe(6);

    // Non-vacuity: the entry written first after the restart must link to its PREDECESSOR, not to
    // genesis. A seed that silently did nothing would leave a second genesis marker here.
    const lines = (await fs.readFile(path.join(auditDir, 'audit.log'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const genesisMarkers = lines.filter(
      (line) => (JSON.parse(line) as { prevDigest?: string }).prevDigest === 'genesis'
    );
    expect(genesisMarkers, 'exactly one entry may begin the chain').toHaveLength(1);
  });

  it('reports a file beside the log that it cannot place, rather than skipping it', async () => {
    const writer = writerWith();
    await append(writer, 0);
    await fs.writeFile(path.join(auditDir, 'audit.log.operator-backup'), '{}\n');
    const checked = verifyAuditChainAt(auditDir)!;
    expect(checked.files.unrecognized).toEqual(['audit.log.operator-backup']);
    // ...and reading it is not attempted, so the operator's own copy cannot fabricate a break.
    expect(checked.verdict.ok).toBe(true);
  });
});
