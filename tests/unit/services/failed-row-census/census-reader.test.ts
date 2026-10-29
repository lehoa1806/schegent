/**
 * FR-R4-F16 (feature 244) — contract A3.2 and A3.3: the reader that turns the audit chain into a
 * compact census log.
 *
 * `specs/244-failed-row-exit-evidence/contracts/census-reader.md` A2.1 to A2.9. Every case runs on a
 * real temporary directory used as the workspace root, with the real chain lister except where a case
 * names the lister seam. The reader must never write, truncate, rename or unlink, so each case that
 * reads a real chain also compares every file's bytes and mode before and after.
 */
import { promises as fsp, readdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectChainFiles } from '../../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  CENSUS_MAX_LINE_UNITS,
  readCensusLog
} from '../../../../src/services/failed-row-census/census-reader';
import { createCensusLogBuilder } from '../../../../src/services/failed-row-census/census-log';

const IS_WINDOWS = process.platform === 'win32';
const AUDIT_DIR = '.schegent';
const CUTS = 'audit.log.cuts';
const LIVE = 'audit.log';
const ARCHIVE_OLD = 'audit.log.20261018-100000';
const ARCHIVE_NEW = 'audit.log.20261019-100000';
const STAMP = '2026-10-20T10:00:00.000Z';

let root: string;
let warnings: string[];
let logger: SanitizedLogger;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'census-reader-'));
  warnings = [];
  logger = new SanitizedLogger([{ appendLine: (line) => warnings.push(line) }]);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function auditLine(eventType: string, payload: Record<string, unknown>, id = 'e'): string {
  return JSON.stringify({
    id,
    timestamp: STAMP,
    runId: 'run-envelope',
    phase: 'queue-manager',
    iteration: 0,
    eventType,
    outcome: 'info',
    payload
  });
}

function clearedLine(queueId: string): string {
  return auditLine('queue-cleared', { queueId });
}

function cutLine(): string {
  return JSON.stringify({
    kind: 'audit-cut',
    cutAtMs: 1,
    removedFrom: 'aaa',
    removedTo: 'bbb',
    removedCount: 2
  });
}

async function writeChainFile(name: string, lines: readonly string[]): Promise<string> {
  const dir = path.join(root, AUDIT_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await fsp.writeFile(target, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
  return target;
}

/** Every file under `.schegent/` with its bytes and mode, so a read that wrote anything shows. */
function treeSnapshot(): Record<string, { bytes: string; mode: number }> {
  const dir = path.join(root, AUDIT_DIR);
  const out: Record<string, { bytes: string; mode: number }> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    out[name] = { bytes: readFileSync(full).toString('base64'), mode: stat.mode };
  }
  return out;
}

function queueIds(log: Awaited<ReturnType<typeof readCensusLog>>): string[] {
  return log.events.flatMap((event) => (event.kind === 'queue-cleared' ? [event.queueId] : []));
}

describe('the census reader: which files, in which order (contract A2.2, A2.5, A2.6, A2.7)', () => {
  it('reads a cut file, two archives and a live log in collectChainFiles order', async () => {
    await writeChainFile(CUTS, [cutLine()]);
    await writeChainFile(ARCHIVE_NEW, [clearedLine('second')]);
    await writeChainFile(ARCHIVE_OLD, [clearedLine('first')]);
    await writeChainFile(LIVE, [clearedLine('live')]);
    const before = treeSnapshot();

    const log = await readCensusLog(root, logger);

    expect(log.events.map((event) => event.kind)).toEqual([
      'gap',
      'queue-cleared',
      'queue-cleared',
      'queue-cleared'
    ]);
    expect(log.events[0]).toEqual({ kind: 'gap', seq: 0, cause: 'cut' });
    expect(queueIds(log)).toEqual(['first', 'second', 'live']);
    expect(log.cutRecords).toBe(1);
    expect(log.segmentsRead).toBe(3);
    expect(log.unreadableSegments).toBe(0);
    expect(treeSnapshot()).toEqual(before);
  });

  it('reads a line of the cut file that is not a cut record as one unparseable line', async () => {
    await writeChainFile(CUTS, [cutLine(), '{"kind":"something-else"}']);
    await writeChainFile(LIVE, [clearedLine('live')]);

    const log = await readCensusLog(root, logger);

    expect(log.cutRecords).toBe(1);
    expect(log.unparseableLines).toBe(1);
  });

  it('gives an empty log when there is no .schegent directory', async () => {
    const log = await readCensusLog(root, logger);
    expect(log).toEqual(createCensusLogBuilder().finish());
    expect(warnings).toEqual([]);
  });

  it('gives an empty log when .schegent holds no audit file', async () => {
    await fsp.mkdir(path.join(root, AUDIT_DIR), { recursive: true });
    await fsp.writeFile(path.join(root, AUDIT_DIR, 'unrelated.txt'), 'x', 'utf8');
    const log = await readCensusLog(root, logger);
    expect(log).toEqual(createCensusLogBuilder().finish());
  });

  it('counts an unrecognized name beside the log and never opens it', async () => {
    await writeChainFile(LIVE, [clearedLine('live')]);
    await writeChainFile('audit.log.garbage', [clearedLine('never-read')]);

    const log = await readCensusLog(root, logger);

    expect(log.unrecognizedNames).toBe(1);
    expect(queueIds(log)).toEqual(['live']);
  });

  it('reads a line that does not parse, and the lines after it', async () => {
    await writeChainFile(LIVE, [clearedLine('before'), '{not json', clearedLine('after')]);

    const log = await readCensusLog(root, logger);

    expect(log.unparseableLines).toBe(1);
    expect(queueIds(log)).toEqual(['before', 'after']);
  });
});

describe('the census reader: files it cannot read (contract A2.3, A2.4)', () => {
  it.skipIf(IS_WINDOWS)(
    'refuses an archive that is a symbolic link and counts it as one unreadable segment',
    async () => {
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'census-reader-outside-'));
      try {
        const target = path.join(outside, 'elsewhere.log');
        await fsp.writeFile(target, `${clearedLine('outside')}\n`, 'utf8');
        await fsp.mkdir(path.join(root, AUDIT_DIR), { recursive: true });
        await fsp.symlink(target, path.join(root, AUDIT_DIR, ARCHIVE_OLD));
        await writeChainFile(LIVE, [clearedLine('live')]);

        const log = await readCensusLog(root, logger);

        expect(log.unreadableSegments).toBe(1);
        expect(log.segmentsRead).toBe(1);
        expect(queueIds(log)).toEqual(['live']);
        expect(log.events.map((event) => event.kind)).toEqual(['gap', 'queue-cleared']);
        expect(log.events[0]).toEqual({ kind: 'gap', seq: 0, cause: 'unreadable-segment' });
        // Control: the refusal was warned, so the path check below is not vacuous.
        expect(warnings.length).toBeGreaterThan(0);
        for (const warning of warnings) {
          expect(warning).not.toContain(root);
          expect(warning).not.toContain(outside);
        }
      } finally {
        await fsp.rm(outside, { recursive: true, force: true });
      }
    }
  );

  it('counts a file that appears between the two listings as one unreadable segment before the live log', async () => {
    await writeChainFile(ARCHIVE_OLD, [clearedLine('archive')]);
    await writeChainFile(LIVE, [clearedLine('live')]);
    let calls = 0;
    const lister = (auditDir: string) => {
      calls += 1;
      const real = collectChainFiles(auditDir);
      if (calls === 1 || real === null) return real;
      return {
        ordered: [...real.ordered, 'audit.log.20261020-110000'],
        unrecognized: real.unrecognized
      };
    };

    const log = await readCensusLog(root, logger, lister);

    expect(calls).toBe(2);
    expect(log.unreadableSegments).toBe(1);
    expect(log.events.map((event) => event.kind)).toEqual(['queue-cleared', 'gap', 'queue-cleared']);
    expect(log.events[1]).toEqual({ kind: 'gap', seq: 1, cause: 'unreadable-segment' });
    expect(queueIds(log)).toEqual(['archive', 'live']);
  });

  it('counts a listing that throws as one unreadable segment and does not throw', async () => {
    const lister = (): never => {
      throw new Error(`boom at ${root}`);
    };

    const log = await readCensusLog(root, logger, lister);

    expect(log.unreadableSegments).toBe(1);
    expect(log.events).toEqual([{ kind: 'gap', seq: 0, cause: 'unreadable-segment' }]);
    for (const warning of warnings) expect(warning).not.toContain(root);
  });
});

describe('the census reader: line limit and size (contract A2.5, A3.2, A3.3)', () => {
  it('reads a line over the framer limit as one unparseable line, and the next line still reads', async () => {
    const huge = auditLine('queue-cleared', { queueId: 'huge', padding: 'x'.repeat(CENSUS_MAX_LINE_UNITS + 10) });
    await writeChainFile(LIVE, [clearedLine('before'), huge, clearedLine('after')]);
    const before = treeSnapshot();

    const log = await readCensusLog(root, logger);

    expect(log.unparseableLines).toBe(1);
    expect(queueIds(log)).toEqual(['before', 'after']);
    expect(treeSnapshot()).toEqual(before);
  });

  it('reads 20,000 lines across three files to the end and keeps only the census entries', async () => {
    const perFile = 6667;
    let planted = 0;
    const files: Array<[string, string[]]> = [
      [ARCHIVE_OLD, []],
      [ARCHIVE_NEW, []],
      [LIVE, []]
    ];
    let written = 0;
    for (const [, lines] of files) {
      for (let index = 0; index < perFile && written < 20000; index += 1, written += 1) {
        if (written % 4 === 0) {
          lines.push(clearedLine(`q-${written}`));
          planted += 1;
        } else {
          lines.push(auditLine('phase-end', { taskId: `t-${written}` }, `n-${written}`));
        }
      }
    }
    for (const [name, lines] of files) await writeChainFile(name, lines);
    const before = treeSnapshot();

    const log = await readCensusLog(root, logger);

    expect(written).toBe(20000);
    expect(log.segmentsRead).toBe(3);
    expect(log.unreadableSegments).toBe(0);
    expect(log.unparseableLines).toBe(0);
    expect(log.events).toHaveLength(planted);
    expect(planted).toBe(5000);
    expect(treeSnapshot()).toEqual(before);
  });
});
