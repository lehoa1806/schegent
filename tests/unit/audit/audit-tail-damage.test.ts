import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { cutRecordFor, digestOf, verifyAuditChainAt, verifyChain } from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';

/**
 * FR-R4-F03 (FR-007 to FR-009, SC-003; contract T5, W3, V3, R5, R6) — a damaged final line is kept,
 * named and continued past; it is never truncated and never silently repaired.
 *
 * A torn append leaves a final line that is not valid JSON, and older releases left a worse shape
 * (a row appended onto the fragment). The owner checks the chain's last line, as BYTES, before it
 * links its first row: a valid line only missing its newline is terminated and is not damage; an
 * invalid line is left exactly as found, terminated, and followed by a versioned
 * `audit-integrity-condition` row that names it by file, line, offset, length and the SHA-256 of its
 * raw bytes. Verification reads that row as the diagnosis that excuses the line, and nothing else.
 *
 * Real writer, real verifier, real temporary directories. "Bytes unchanged" is `Buffer.equals`.
 */

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const NOTICE = 'audit-tail-damaged';
const TORN_JSON = '{"id":"cut-short","eventType":"phase-start","runId":"r","payl';

describe('a damaged final line is diagnosed, kept and continued past (SC-003)', () => {
  let root: string;
  let lines: string[];
  let monitor: EvidenceHealthMonitor;
  const dir = (): string => path.join(root, '.schegent');
  const logFile = (): string => path.join(dir(), 'audit.log');
  const entry = (runId: string) =>
    ({ eventType: 'phase-start', runId, payload: { phase: 'implement' } }) as never;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-tail-'));
    lines = [];
    monitor = new EvidenceHealthMonitor();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const newWriter = (overrides: Record<string, number> = {}): AuditLogWriter =>
    new AuditLogWriter(
      { workspaceRoot: root, ...overrides },
      new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]),
      monitor
    );

  async function seed(count: number): Promise<void> {
    const writer = newWriter();
    for (let n = 0; n < count; n += 1) await writer.append(entry(`seed-${n}`));
  }

  /** The rows that parse, in order. A damaged fragment is not a row, so it is skipped. */
  const rowsOf = async (file = logFile()): Promise<Array<Record<string, unknown>>> => {
    const rows: Array<Record<string, unknown>> = [];
    for (const line of (await fs.readFile(file, 'latin1')).split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // The damaged fragment.
      }
    }
    return rows;
  };

  const warnings = (): number => lines.filter((line) => line.includes(NOTICE)).length;

  it('keeps partial JSON byte for byte, then terminates it, names it, and links the entry past it', async () => {
    await seed(2);
    const intact = await fs.readFile(logFile());
    await fs.appendFile(logFile(), TORN_JSON);
    const before = await fs.readFile(logFile());

    await newWriter().append(entry('after'));

    const after = await fs.readFile(logFile());
    expect(after.subarray(0, before.length).equals(before), 'the damaged bytes are unchanged').toBe(true);
    expect(after[before.length], 'a newline follows the damaged bytes').toBe(0x0a);

    const rows = await rowsOf();
    // Two seed rows, then the damage row, then the entry (the fragment is not a row).
    const damage = rows[2] as { eventType: string; payload: Record<string, unknown>; prevDigest: string };
    expect(damage.eventType).toBe('audit-integrity-condition');
    expect(damage.payload).toMatchObject({
      condition: 'damaged-tail',
      conditionVersion: 1,
      file: 'audit.log',
      line: 3,
      byteOffset: intact.length,
      byteLength: Buffer.byteLength(TORN_JSON),
      digestAlg: 'sha256',
      digest: sha256(Buffer.from(TORN_JSON))
    });
    const rawRows = (await fs.readFile(logFile(), 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    expect(damage.prevDigest, 'linked to the last valid row before the damage').toBe(digestOf(rawRows[1] as string));
    expect(rows[3]?.prevDigest, 'the entry links to the damage row').toBe(digestOf(rawRows[3] as string));

    const verdict = verifyAuditChainAt(dir())?.verdict;
    expect(verdict).toMatchObject({ ok: true, entries: 4 });
    if (verdict?.ok !== true) throw new Error('unreachable');
    expect(verdict.damages).toEqual([
      expect.objectContaining({ file: 'audit.log', line: 3, byteLength: Buffer.byteLength(TORN_JSON) })
    ]);
    expect(verdict.damages[0]?.digestPrefix).toBe(sha256(Buffer.from(TORN_JSON)).slice(0, 12));
  });

  it('only terminates a valid final line that lacks its newline, and reports no damage', async () => {
    await seed(2);
    const body = await fs.readFile(logFile(), 'utf8');
    await fs.writeFile(logFile(), body.replace(/\n$/, ''));
    const before = await fs.readFile(logFile());
    expect(before[before.length - 1]).not.toBe(0x0a);

    await newWriter().append(entry('after'));

    const after = await fs.readFile(logFile());
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after[before.length]).toBe(0x0a);
    expect((await rowsOf()).some((row) => row.eventType === 'audit-integrity-condition')).toBe(false);
    const verdict = verifyAuditChainAt(dir())?.verdict;
    expect(verdict).toMatchObject({ ok: true, entries: 3 });
    if (verdict?.ok !== true) throw new Error('unreachable');
    expect(verdict.damages).toEqual([]);
  });

  it('diagnoses invalid JSON that already ends with a newline (an older release merged tail)', async () => {
    await seed(1);
    const rows = (await fs.readFile(logFile(), 'utf8')).split('\n').filter((l) => l.length > 0);
    // A valid row, a fragment appended onto it by an older release, then a newline.
    const merged = `${rows[0] as string}${TORN_JSON}\n`;
    await fs.writeFile(logFile(), merged);
    const before = await fs.readFile(logFile());

    await newWriter().append(entry('after'));

    const after = await fs.readFile(logFile());
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    const verdict = verifyAuditChainAt(dir())?.verdict;
    expect(verdict).toMatchObject({ ok: true });
    if (verdict?.ok !== true) throw new Error('unreachable');
    expect(verdict.damages).toHaveLength(1);
    expect(verdict.damages[0]).toMatchObject({ file: 'audit.log', line: 1 });
  });

  it('digests a torn multi-byte UTF-8 sequence over its raw bytes', async () => {
    await seed(1);
    // The euro sign is E2 82 AC; keep only its first byte.
    const torn = Buffer.concat([Buffer.from('{"payload":"cost: '), Buffer.from([0xe2])]);
    await fs.appendFile(logFile(), torn);

    await newWriter().append(entry('after'));

    const body = await fs.readFile(logFile());
    expect(body.includes(torn), 'the torn bytes are still on disk, as found').toBe(true);
    const damageLine = body.toString('latin1').split('\n').find((l) => l.includes('audit-integrity-condition'));
    expect(damageLine).toBeDefined();
    const payload = (JSON.parse(damageLine as string) as { payload: Record<string, unknown> }).payload;
    expect(payload.byteLength).toBe(torn.length);
    expect(payload.digest).toBe(sha256(torn));
    expect(verifyAuditChainAt(dir())?.verdict).toMatchObject({ ok: true });
  });

  it('calls the same damage with no damage row malformed, at that line', () => {
    const verdict = verifyChain([TORN_JSON, JSON.stringify({ id: 'x', prevDigest: 'genesis' })]);
    expect(verdict).toMatchObject({ ok: false, reason: 'malformed', atEntry: 1 });
  });

  it.each([
    ['digest', (row: string): string => row.replace(/"digest":"[0-9a-f]{64}"/, `"digest":"${'0'.repeat(64)}"`)],
    ['length', (row: string): string => row.replace(/"byteLength":(\d+)/, (_m, n: string) => `"byteLength":${Number(n) + 1}`)],
    ['link', (row: string): string => row.replace(/"prevDigest":"[0-9a-f]{64}"/, `"prevDigest":"${'1'.repeat(64)}"`)],
    // A row written by a later release names a version this one does not know; a row for another
    // condition is not the diagnosis of a damaged tail. Neither may excuse the line before it.
    ['condition version', (row: string): string => row.replace(/"conditionVersion":\d+/, '"conditionVersion":2')],
    ['condition', (row: string): string => row.replace(/"condition":"damaged-tail"/, '"condition":"damaged-head"')]
  ])('calls a damage row with a wrong %s malformed', async (_name, edit) => {
    await seed(1);
    await fs.appendFile(logFile(), TORN_JSON);
    await newWriter().append(entry('after'));

    const text = await fs.readFile(logFile(), 'utf8');
    const all = text.split('\n');
    const at = all.findIndex((line) => line.includes('audit-integrity-condition'));
    all[at] = edit(all[at] as string);
    await fs.writeFile(logFile(), all.join('\n'));

    expect(verifyAuditChainAt(dir())?.verdict).toMatchObject({ ok: false, reason: 'malformed', atEntry: at });
  });

  it('diagnoses a damaged line that ends an archive without touching any archive', async () => {
    await seed(2);
    const archiveName = 'audit.log.20260101-000000-000-aaaaaaaa';
    const archive = path.join(dir(), archiveName);
    await fs.rename(logFile(), archive);
    await fs.appendFile(archive, TORN_JSON);
    const archiveBefore = await fs.readFile(archive);

    await newWriter().append(entry('after'));

    expect((await fs.readFile(archive)).equals(archiveBefore), 'an archive is never opened for writing').toBe(true);
    const verdict = verifyAuditChainAt(dir())?.verdict;
    expect(verdict).toMatchObject({ ok: true });
    if (verdict?.ok !== true) throw new Error('unreachable');
    expect(verdict.damages).toEqual([expect.objectContaining({ file: archiveName, line: 3 })]);
  });

  it('keeps every earlier archive byte-identical when the append rotates the damaged log into one', async () => {
    await seed(2);
    const olderName = 'audit.log.20250101-000000-000-aaaaaaaa';
    const older = path.join(dir(), olderName);
    await fs.rename(logFile(), older);
    await seed(1);
    await fs.appendFile(logFile(), TORN_JSON);
    const olderBefore = await fs.readFile(older);

    await newWriter({ rotationSizeBytes: 1 }).append(entry('after'));

    expect((await fs.readFile(older)).equals(olderBefore), 'an earlier archive is untouched').toBe(true);
    const verdict = verifyAuditChainAt(dir())?.verdict;
    expect(verdict).toMatchObject({ ok: true, entries: 5 });
    if (verdict?.ok !== true) throw new Error('unreachable');
    expect(verdict.damages).toHaveLength(1);
    expect(verdict.damages[0]?.file, 'the damage rotated into the new archive and is still diagnosed').not.toBe(
      olderName
    );
    expect(verdict.damages[0]?.file).toMatch(/^audit\.log\.\d{8}-\d{6}/);
  });

  /**
   * A prune that removed every retained row (a rotation whose archive retention then removed, before the
   * next row landed) leaves only the cut record. The verifier reads the cut first and resumes the chain at
   * its `removedTo`, so the tail check must link there too, and a damage row must link where the verifier
   * expects it, not to genesis.
   */
  async function pruneEverything(): Promise<void> {
    const removed = (await fs.readFile(logFile(), 'utf8')).split('\n');
    await fs.writeFile(path.join(dir(), 'audit.log.cuts'), `${JSON.stringify(cutRecordFor(removed, 1))}\n`);
    await fs.rm(logFile());
  }

  it('links the first row after a prune that left only the cut record to where the cut ends', async () => {
    await seed(2);
    await pruneEverything();

    await newWriter().append(entry('after'));

    expect(verifyAuditChainAt(dir())?.verdict).toMatchObject({ ok: true, entries: 1, cuts: 1 });
  });

  it('diagnoses a damaged first line after a prune that left only the cut record', async () => {
    await seed(2);
    await pruneEverything();
    await fs.writeFile(logFile(), TORN_JSON);

    await newWriter().append(entry('after'));

    const verdict = verifyAuditChainAt(dir())?.verdict;
    expect(verdict).toMatchObject({ ok: true, entries: 2, cuts: 1 });
    if (verdict?.ok !== true) throw new Error('unreachable');
    expect(verdict.damages).toEqual([expect.objectContaining({ file: 'audit.log', line: 1 })]);
  });

  it('logs one audit-tail-damaged warning and does not report the audit sink unavailable', async () => {
    await seed(1);
    await fs.appendFile(logFile(), TORN_JSON);

    await newWriter().append(entry('after'));
    await newWriter().append(entry('later'));

    expect(warnings()).toBe(1);
    expect(monitor.getSnapshot().audit.status).toBe('healthy');
    expect(monitor.getSnapshot().audit.failureCount).toBe(0);
  });
});
