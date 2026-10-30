import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import {
  AUDIT_CHAIN_GENESIS,
  collectChainFiles,
  digestOf,
  verifyAuditChainAt
} from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R4-F03 (FR-001 to FR-003, SC-001; contract T2) — both legacy transition forms, with the real
 * writer, the real verifier and a real temporary directory.
 *
 * Form B is what the shipped writer produces over a legacy log: its first row links to the digest of
 * the last legacy row. Form A is what an older release left, a first chained row linked to
 * `genesis` after the legacy rows. The matrix crosses the two forms with four histories (appends,
 * a restart between appends, rotation on every append, and a prune that removes the legacy rows),
 * over a 100-row legacy prefix: eight combinations. Each must verify with the expected counts, and
 * in each an edit, a deletion and an inserted unchained row must still fail, so accepting the
 * transition has not opened the chain to anything else (FR-002).
 */

const LEGACY_ROWS = 100;
const SETTLE_MS = 8;

interface ChainedRow {
  readonly file: string;
  readonly index: number;
  readonly lines: string[];
}

type Form = 'A' | 'B';
type History = 'append' | 'restart' | 'rotation' | 'prune';

interface Expected {
  readonly entries: number;
  readonly unchainedPrefix: number;
  readonly prunedLegacy: number;
}

const legacyRow = (n: number): string =>
  JSON.stringify({
    id: `legacy-${n}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    eventType: 'phase-start',
    runId: 'legacy',
    payload: { phase: 'implement' },
    schemaVersion: 3
  });

/** The first chained row an older release wrote after the legacy rows: linked to genesis. */
const formAFirstRow = (): string =>
  JSON.stringify({
    id: 'older-release-first',
    timestamp: '2026-01-02T00:00:00.000Z',
    eventType: 'phase-start',
    runId: 'older',
    payload: { phase: 'implement' },
    schemaVersion: 3,
    prevDigest: AUDIT_CHAIN_GENESIS,
    digestAlg: 'sha256'
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('both legacy transition forms verify with the real writer (SC-001)', () => {
  let root: string;
  const auditDir = (): string => path.join(root, '.schegent');
  const logFile = (): string => path.join(auditDir(), 'audit.log');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-legacy-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedLegacy(form: Form): Promise<void> {
    await fs.mkdir(auditDir(), { recursive: true, mode: 0o700 });
    const rows = Array.from({ length: LEGACY_ROWS }, (_, n) => legacyRow(n));
    if (form === 'A') rows.push(formAFirstRow());
    await fs.writeFile(logFile(), `${rows.join('\n')}\n`, { mode: 0o600 });
  }

  const newWriter = (overrides: Record<string, number> = {}): AuditLogWriter =>
    new AuditLogWriter({ workspaceRoot: root, ...overrides }, new SanitizedLogger());

  const appendRows = async (writer: AuditLogWriter, count: number, pause = false): Promise<void> => {
    for (let n = 0; n < count; n += 1) {
      await writer.append({
        eventType: 'phase-start',
        runId: `run-${n}`,
        payload: { phase: 'p' }
      } as never);
      if (pause) await sleep(SETTLE_MS);
    }
  };

  async function build(form: Form, history: History): Promise<void> {
    await seedLegacy(form);
    if (history === 'append') {
      await appendRows(newWriter(), 5);
    } else if (history === 'restart') {
      await appendRows(newWriter(), 2);
      await appendRows(newWriter(), 3);
    } else if (history === 'rotation') {
      await appendRows(newWriter({ rotationSizeBytes: 1 }), 5, true);
    } else {
      await appendRows(newWriter({ rotationSizeBytes: 1, retentionMaxArchives: 1 }), 5, true);
    }
  }

  const expectedFor = (form: Form, history: History): Expected => {
    if (history === 'prune') return { entries: 2, unchainedPrefix: 0, prunedLegacy: LEGACY_ROWS };
    return { entries: form === 'A' ? 6 : 5, unchainedPrefix: LEGACY_ROWS, prunedLegacy: 0 };
  };

  async function snapshot(): Promise<Map<string, Buffer>> {
    const copy = new Map<string, Buffer>();
    for (const name of await fs.readdir(auditDir())) {
      copy.set(name, await fs.readFile(path.join(auditDir(), name)));
    }
    return copy;
  }

  async function restore(copy: ReadonlyMap<string, Buffer>): Promise<void> {
    for (const [name, bytes] of copy) await fs.writeFile(path.join(auditDir(), name), bytes);
  }

  /** The chained rows in walk order, as `[file, index in that file]`, cut file excluded. */
  async function chainedPositions(): Promise<ChainedRow[]> {
    const files = collectChainFiles(auditDir());
    if (files === null) throw new Error('fixture has no chain file');
    const found: ChainedRow[] = [];
    for (const name of files.ordered) {
      if (name === 'audit.log.cuts') continue;
      const lines = (await fs.readFile(path.join(auditDir(), name), 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (line.includes('"prevDigest"')) found.push({ file: name, index, lines });
      });
    }
    return found;
  }

  /**
   * Mutate around the second-to-last chained row, which has a successor to give it away. An
   * unchained row goes AFTER it: before the first chained row it would be a legal legacy row.
   * `delete-first` removes the first chained row, so the second row's link is the first one the
   * verifier meets: a verifier that accepted any first link would let it through.
   */
  async function mutateTarget(
    kind: 'edit' | 'delete' | 'insert-unchained' | 'delete-first'
  ): Promise<void> {
    const rows = await chainedPositions();
    const target = (kind === 'delete-first' ? rows[0] : rows[rows.length - 2]) as ChainedRow | undefined;
    if (target === undefined) throw new Error('fixture has fewer than two chained rows');
    const next = [...target.lines];
    if (kind === 'edit') {
      next[target.index] = (next[target.index] as string).replace('"phase-start"', '"phase-end"');
    } else if (kind === 'delete' || kind === 'delete-first') {
      next.splice(target.index, 1);
    } else {
      next.splice(target.index + 1, 0, legacyRow(999));
    }
    await fs.writeFile(path.join(auditDir(), target.file), next.join('\n'));
  }

  const forms: readonly Form[] = ['A', 'B'];
  const histories: readonly History[] = ['append', 'restart', 'rotation', 'prune'];

  for (const form of forms) {
    for (const history of histories) {
      it(`form ${form}, ${history}: verifies, and edits, deletions and unchained rows still fail`, async () => {
        await build(form, history);
        const check = verifyAuditChainAt(auditDir());
        expect(check).not.toBeNull();
        const verdict = check?.verdict;
        expect(verdict).toMatchObject({ ok: true, ...expectedFor(form, history) });
        if (verdict?.ok !== true) throw new Error('unreachable');
        expect(verdict.transition).toBe(form === 'A' ? 'genesis' : 'legacy-tail');

        const original = await snapshot();
        for (const kind of ['edit', 'delete', 'insert-unchained', 'delete-first'] as const) {
          await mutateTarget(kind);
          const tampered = verifyAuditChainAt(auditDir())?.verdict;
          expect(tampered?.ok, `${kind} must fail`).toBe(false);
          await restore(original);
        }
        expect(verifyAuditChainAt(auditDir())?.verdict.ok).toBe(true);
      }, 30_000);
    }
  }

  it('the digest a form B history links to is the last legacy row, byte for byte', async () => {
    await build('B', 'append');
    const first = (await chainedPositions())[0] as ChainedRow | undefined;
    if (first === undefined) throw new Error('fixture has no chained row');
    const parsed = JSON.parse(first.lines[first.index] as string) as { prevDigest: string };
    expect(parsed.prevDigest).toBe(digestOf(legacyRow(LEGACY_ROWS - 1)));
  });
});
