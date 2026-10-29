/**
 * FR-R4-F15 (feature 243) — contracts C3 to C5: the store writes a record once, with owner-only
 * modes, and reads the newest back; the recorder turns every failure into one sanitized warning.
 *
 * `specs/243-retained-failure-diagnostics/contracts/capture-and-write.md` C7.4 to C7.7. Everything
 * runs on a real temporary directory as the workspace root. Write cases go through
 * `createFailureRecorder(...).record()` with an injected clock, suffix source and logger spy, and
 * assert its return value and the count of `warn` calls; read cases go through the store's
 * `readNewest`. The filesystem seam is used only where a real filesystem cannot be made to fail
 * after the open.
 */
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailureRecordV1 } from '../../../../src/contracts/failure-record';
import { isValidFailureRecord, parseRecordName } from '../../../../src/contracts/validators/failure-record';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { InvocationResult } from '../../../../src/parser/stdout-parser';
import {
  createFailureRecorder,
  type FailureRecorder
} from '../../../../src/services/failure-record/failure-record-service';
import { FailureRecordStore } from '../../../../src/services/failure-record/failure-record-store';

const IS_WINDOWS = process.platform === 'win32';
const realLogger = new SanitizedLogger([]);
const CLOCK = new Date('2026-10-28T14:30:05.123Z');
const RECORDS_DIR = path.join('.schegent', 'failure-records');
const WARNING = 'failure-record: not written';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'failure-record-store-'));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'failure-record-outside-'));
});

afterEach(async () => {
  // A case may have made a directory unwritable; undo that so the removal below can run.
  await fsp.chmod(path.join(root, RECORDS_DIR), 0o700).catch(() => undefined);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

function issuesResult(summaries: string[]): InvocationResult {
  return {
    kind: 'remaining_issues',
    issues: summaries.map((summary) => ({ tag: 'regression', summary })),
    auditEntry: null
  } as InvocationResult;
}

function makeRecorder(
  options: {
    suffixes?: string[];
    store?: FailureRecordStore;
    queueThrows?: boolean;
  } = {}
): { recorder: FailureRecorder; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const suffixes = [...(options.suffixes ?? ['0a1b2c3d', '1b2c3d4e', '2c3d4e5f', '3d4e5f60'])];
  const recorder = createFailureRecorder({
    logger: { warn, sanitize: (value: string) => realLogger.sanitize(value) },
    queue: {
      queueIdForExistingTask: (taskId: string) => {
        if (options.queueThrows === true) throw new Error(`boom ${root}`);
        return taskId === 'task-1' ? 'default' : null;
      }
    },
    workspaceRoot: root,
    platform: 'linux',
    now: () => CLOCK,
    drawSuffix: () => suffixes.shift() ?? 'ffffffff',
    ...(options.store === undefined ? {} : { store: options.store })
  });
  return { recorder, warn };
}

function failInput(summaries: string[] = ['one case fails'], extra: Record<string, unknown> = {}) {
  return {
    run: { id: 'run-1', featureId: 'task-1', currentPhase: 'implement' },
    cause: 'last_phase_issues_remain' as const,
    result: issuesResult(summaries),
    iteration: 2,
    iterationCap: 3,
    ...extra
  };
}

function warnings(warn: ReturnType<typeof vi.fn>): unknown[][] {
  return warn.mock.calls.filter((call) => call[0] === WARNING);
}

async function recordFiles(): Promise<string[]> {
  return (await fsp.readdir(path.join(root, RECORDS_DIR)).catch(() => [])).sort();
}

function recordForName(name: string, overrides: Record<string, unknown> = {}): FailureRecordV1 {
  const parsed = parseRecordName(name);
  if (parsed === null) throw new Error(`fixture name ${name} does not parse`);
  return {
    recordVersion: 1,
    queueId: 'default',
    taskId: parsed.taskId,
    runId: parsed.runId,
    failedAt: new Date(parsed.failedAtMs).toISOString(),
    suffix: parsed.suffix,
    cause: 'cap_exhausted',
    issueState: 'none-reported',
    entries: [],
    omittedIssueCount: 0,
    metrics: [],
    omittedMetricCount: 0,
    ...overrides
  } as FailureRecordV1;
}

async function plant(name: string, content: string | Buffer): Promise<void> {
  await fsp.mkdir(path.join(root, RECORDS_DIR), { recursive: true });
  await fsp.writeFile(path.join(root, RECORDS_DIR, name), content);
}

async function plantRecord(name: string, overrides: Record<string, unknown> = {}): Promise<FailureRecordV1> {
  const record = recordForName(name, overrides);
  await plant(name, JSON.stringify(record, null, 2) + '\n');
  return record;
}

function store(): FailureRecordStore {
  return new FailureRecordStore({ workspaceRoot: root, logger: { warn: vi.fn() } });
}

describe('record() writes one immutable file (C7.4)', () => {
  it('writes a valid record under the name its identity gives, and returns true', async () => {
    const { recorder, warn } = makeRecorder();
    expect(await recorder.record(failInput())).toBe(true);
    const files = await recordFiles();
    expect(files).toEqual(['20261028T143005123Z_0a1b2c3d_run-1_task-1.json']);
    const text = await fsp.readFile(path.join(root, RECORDS_DIR, files[0] as string), 'utf8');
    const parsed: unknown = JSON.parse(text);
    expect(isValidFailureRecord(parsed, parseRecordName(files[0] as string) ?? undefined)).toBe(true);
    expect(text).toBe(JSON.stringify(parsed, null, 2) + '\n');
    expect(parsed).toMatchObject({
      queueId: 'default',
      taskId: 'task-1',
      runId: 'run-1',
      cause: 'last_phase_issues_remain',
      issueState: 'listed',
      suffix: '0a1b2c3d'
    });
    expect(warnings(warn)).toHaveLength(0);
  });

  it.skipIf(IS_WINDOWS)('creates the file with mode 0600 and the directory with mode 0700', async () => {
    const { recorder } = makeRecorder();
    await recorder.record(failInput());
    const dir = await fsp.stat(path.join(root, RECORDS_DIR));
    const file = await fsp.stat(path.join(root, RECORDS_DIR, (await recordFiles())[0] as string));
    expect(dir.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
  });

  it.skipIf(IS_WINDOWS)('narrows a directory it walks that was created wider, and says so without a path', async () => {
    await fsp.mkdir(path.join(root, RECORDS_DIR), { recursive: true, mode: 0o755 });
    await fsp.chmod(path.join(root, '.schegent'), 0o755);
    await fsp.chmod(path.join(root, RECORDS_DIR), 0o755);
    const { recorder, warn } = makeRecorder();
    expect(await recorder.record(failInput())).toBe(true);
    expect((await fsp.stat(path.join(root, RECORDS_DIR))).mode & 0o077).toBe(0);
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(root);
  });

  it('writes a second file for a second failure of the same Run and leaves the first untouched', async () => {
    const { recorder } = makeRecorder({ suffixes: ['0a1b2c3d', '1b2c3d4e'] });
    await recorder.record(failInput());
    const first = (await recordFiles())[0] as string;
    const before = await fsp.readFile(path.join(root, RECORDS_DIR, first));
    expect(await recorder.record(failInput(['a different issue']))).toBe(true);
    expect(await recordFiles()).toHaveLength(2);
    expect(await fsp.readFile(path.join(root, RECORDS_DIR, first))).toEqual(before);
  });
});

describe('a name collision draws a new suffix (C7.5)', () => {
  it('uses the second suffix when the first name exists, and leaves the first file as it was', async () => {
    const existing = '20261028T143005123Z_0a1b2c3d_run-1_task-1.json';
    await plant(existing, 'not a record, and must stay exactly this');
    const { recorder, warn } = makeRecorder();
    expect(await recorder.record(failInput())).toBe(true);
    expect(await recordFiles()).toEqual([existing, '20261028T143005123Z_1b2c3d4e_run-1_task-1.json']);
    expect(await fsp.readFile(path.join(root, RECORDS_DIR, existing), 'utf8')).toBe(
      'not a record, and must stay exactly this'
    );
    const second = JSON.parse(
      await fsp.readFile(path.join(root, RECORDS_DIR, '20261028T143005123Z_1b2c3d4e_run-1_task-1.json'), 'utf8')
    ) as FailureRecordV1;
    expect(second.suffix).toBe('1b2c3d4e');
    expect(warnings(warn)).toHaveLength(0);
  });

  it('gives up after three opens: false, one warning, and every colliding file unchanged', async () => {
    const names = ['0a1b2c3d', '1b2c3d4e', '2c3d4e5f'].map((suffix) => `20261028T143005123Z_${suffix}_run-1_task-1.json`);
    for (const name of names) await plant(name, `held ${name}`);
    const { recorder, warn } = makeRecorder();
    expect(await recorder.record(failInput())).toBe(false);
    expect(await recordFiles()).toEqual([...names].sort());
    for (const name of names) {
      expect(await fsp.readFile(path.join(root, RECORDS_DIR, name), 'utf8')).toBe(`held ${name}`);
    }
    const calls = warnings(warn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ operation: 'create', errorCode: 'EEXIST' });
  });
});

describe('every failure is one sanitized warning and a false (C7.6)', () => {
  function expectOnlyCodes(context: unknown): void {
    const keys = Object.keys(context as object).sort();
    expect(['cleanup', 'errorCode', 'operation'].filter((key) => keys.includes(key))).toEqual(keys);
    expect(keys).toContain('operation');
    expect(keys).toContain('errorCode');
  }

  function expectNothingIdentifying(warn: ReturnType<typeof vi.fn>): void {
    const text = JSON.stringify(warn.mock.calls);
    for (const fragment of [root, outside, 'run-1', 'task-1', 'one case fails', 'default']) {
      expect(text).not.toContain(fragment);
    }
  }

  it.skipIf(IS_WINDOWS)('refuses a records directory that is a symlink out of the workspace', async () => {
    await fsp.mkdir(path.join(root, '.schegent'), { recursive: true });
    await fsp.symlink(outside, path.join(root, RECORDS_DIR));
    const { recorder, warn } = makeRecorder();
    expect(await recorder.record(failInput())).toBe(false);
    expect(await fsp.readdir(outside)).toEqual([]);
    const calls = warnings(warn);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.[1] as { operation: string }).operation).toBe('create');
    expectOnlyCodes(calls[0]?.[1]);
    expectNothingIdentifying(warn);
  });

  it.skipIf(IS_WINDOWS || process.getuid?.() === 0)('reports a directory that is not writable', async () => {
    await fsp.mkdir(path.join(root, RECORDS_DIR), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.join(root, RECORDS_DIR), 0o500);
    const { recorder, warn } = makeRecorder();
    expect(await recorder.record(failInput())).toBe(false);
    const calls = warnings(warn);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.[1] as { operation: string; errorCode: string }).operation).toBe('create');
    expect((calls[0]?.[1] as { errorCode: string }).errorCode).toMatch(/^E[A-Z]+$/);
    expectOnlyCodes(calls[0]?.[1]);
    expectNothingIdentifying(warn);
  });

  it('removes the partial file when the write throws after the open, and warns once', async () => {
    const failing = new FailureRecordStore({
      workspaceRoot: root,
      logger: { warn: vi.fn() },
      fs: {
        write: async () => {
          throw Object.assign(new Error(`ENOSPC at ${root}`), { code: 'ENOSPC' });
        }
      }
    });
    const { recorder, warn } = makeRecorder({ store: failing });
    expect(await recorder.record(failInput())).toBe(false);
    expect(await recordFiles()).toEqual([]);
    const calls = warnings(warn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ operation: 'write', errorCode: 'ENOSPC' });
    expectNothingIdentifying(warn);
  });

  it('reports a failed cleanup in the same single warning, and leaves a file that reads as malformed', async () => {
    const failing = new FailureRecordStore({
      workspaceRoot: root,
      logger: { warn: vi.fn() },
      fs: {
        write: async () => {
          throw Object.assign(new Error('disk'), { code: 'EIO' });
        },
        rm: async () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
      }
    });
    const { recorder, warn } = makeRecorder({ store: failing });
    expect(await recorder.record(failInput())).toBe(false);
    const calls = warnings(warn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ operation: 'write', errorCode: 'EIO', cleanup: 'failed' });
    expect(await recordFiles()).toEqual(['20261028T143005123Z_0a1b2c3d_run-1_task-1.json']);
    expect(await store().readNewest('run-1')).toMatchObject({ outcome: 'malformed', recordCount: 1 });
  });

  it('reports a close that fails, removing what it wrote', async () => {
    const failing = new FailureRecordStore({
      workspaceRoot: root,
      logger: { warn: vi.fn() },
      fs: {
        // Close the real handle first, so the double itself leaks no descriptor.
        close: async (handle) => {
          await handle.close();
          throw Object.assign(new Error('nope'), { code: 'EIO' });
        }
      }
    });
    const { recorder, warn } = makeRecorder({ store: failing });
    expect(await recorder.record(failInput())).toBe(false);
    expect(await recordFiles()).toEqual([]);
    expect(warnings(warn)[0]?.[1]).toEqual({ operation: 'close', errorCode: 'EIO' });
  });

  it('writes nothing and warns with operation identity when the task has no queue', async () => {
    const { recorder, warn } = makeRecorder();
    const input = failInput();
    expect(await recorder.record({ ...input, run: { ...input.run, featureId: 'task-unknown' } })).toBe(false);
    expect(await recordFiles()).toEqual([]);
    const calls = warnings(warn);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.[1] as { operation: string }).operation).toBe('identity');
    expectNothingIdentifying(warn);
  });

  it('writes nothing and warns with operation identity for a Run id that cannot be a file name', async () => {
    const { recorder, warn } = makeRecorder();
    const input = failInput();
    expect(await recorder.record({ ...input, run: { ...input.run, id: 'run_1' } })).toBe(false);
    expect(await recordFiles()).toEqual([]);
    expect((warnings(warn)[0]?.[1] as { operation: string }).operation).toBe('identity');
  });

  it('never throws when the queue lookup throws, and warns once without the message', async () => {
    const { recorder, warn } = makeRecorder({ queueThrows: true });
    expect(await recorder.record(failInput())).toBe(false);
    expect(warnings(warn)).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('boom');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(root);
  });

  it('never throws when the warning itself throws', async () => {
    const warn = vi.fn(() => {
      throw new Error('sink down');
    });
    const recorder = createFailureRecorder({
      logger: { warn, sanitize: (value: string) => value },
      queue: { queueIdForExistingTask: () => null },
      workspaceRoot: root
    });
    await expect(recorder.record(failInput())).resolves.toBe(false);
  });
});

describe('readNewest (C7.7)', () => {
  it('reports none for a Run with no record, and for a directory that does not exist', async () => {
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'none' });
    await plantRecord('20261028T143005123Z_0a1b2c3d_run-2_task-1.json');
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'none' });
  });

  it('returns the one valid record with a count of 1', async () => {
    const name = '20261028T143005123Z_0a1b2c3d_run-1_task-1.json';
    const record = await plantRecord(name);
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'read', record, recordCount: 1 });
  });

  it('returns the newest of three by stamp and then suffix, with a count of 3', async () => {
    await plantRecord('20261028T143005000Z_ffffffff_run-1_task-1.json');
    await plantRecord('20261028T143006000Z_aaaaaaaa_run-1_task-1.json');
    const newest = await plantRecord('20261028T143006000Z_bbbbbbbb_run-1_task-1.json');
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'read', record: newest, recordCount: 3 });
  });

  it('matches the Run id by exact segment, not by substring', async () => {
    await plantRecord('20261028T143005123Z_0a1b2c3d_run-10_task-1.json');
    await plantRecord('20261028T143005123Z_0a1b2c3d_xrun-1_task-1.json');
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'none' });
    const mine = await plantRecord('20261028T143005123Z_0a1b2c3d_run-1_task-9.json');
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'read', record: mine, recordCount: 1 });
  });

  const MALFORMED: ReadonlyArray<readonly [string, () => string | Buffer]> = [
    ['a truncated file', () => JSON.stringify(recordForName('20261028T143005123Z_0a1b2c3d_run-1_task-1.json'), null, 2).slice(0, 80)],
    [
      'a future record version',
      () => JSON.stringify({ ...recordForName('20261028T143005123Z_0a1b2c3d_run-1_task-1.json'), recordVersion: 2 })
    ],
    [
      'a record naming another Run than its file',
      () => JSON.stringify(recordForName('20261028T143005123Z_0a1b2c3d_run-1_task-1.json', { runId: 'run-2' }))
    ],
    ['invalid UTF-8', () => Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ['a JSON array', () => '[]'],
    ['an empty file', () => '']
  ];

  it.each(MALFORMED)('reports %s as malformed, with its count and no content', async (_label, content) => {
    await plant('20261028T143005123Z_0a1b2c3d_run-1_task-1.json', content());
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'malformed', recordCount: 1 });
  });

  it('reports a file over 32,768 bytes as malformed without reading it', async () => {
    const name = '20261028T143005123Z_0a1b2c3d_run-1_task-1.json';
    await plant(name, JSON.stringify(recordForName(name), null, 2) + ' '.repeat(40 * 1024));
    const read = vi.fn();
    const guarded = new FailureRecordStore({ workspaceRoot: root, logger: { warn: vi.fn() }, fs: { read } });
    expect(await guarded.readNewest('run-1')).toEqual({ outcome: 'malformed', recordCount: 1 });
    expect(read).not.toHaveBeenCalled();
  });

  it('control: a valid file of the same shape and under the bound is read', async () => {
    const name = '20261028T143005123Z_0a1b2c3d_run-1_task-1.json';
    const read = vi.fn(async (handle: FileHandle) => handle.readFile());
    await plantRecord(name);
    const guarded = new FailureRecordStore({ workspaceRoot: root, logger: { warn: vi.fn() }, fs: { read } });
    expect((await guarded.readNewest('run-1')).outcome).toBe('read');
    expect(read).toHaveBeenCalled();
  });

  it('reads the newest only: a malformed newest is not replaced by an older valid record', async () => {
    await plantRecord('20261028T143005000Z_0a1b2c3d_run-1_task-1.json');
    await plant('20261028T143006000Z_0a1b2c3d_run-1_task-1.json', '{');
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'malformed', recordCount: 2 });
  });

  it.skipIf(IS_WINDOWS)('ignores a symlink named like a record and a foreign file', async () => {
    const target = path.join(outside, 'elsewhere.json');
    await fsp.writeFile(target, JSON.stringify(recordForName('20261028T143005123Z_0a1b2c3d_run-1_task-1.json')));
    await fsp.mkdir(path.join(root, RECORDS_DIR), { recursive: true });
    await fsp.symlink(target, path.join(root, RECORDS_DIR, '20261028T143009000Z_0a1b2c3d_run-1_task-1.json'));
    await plant('notes.txt', 'not a record');
    await plant('.pending', '');
    await plant('20261028T143005123Z_0a1b2c3d_run-1_task-1.json.lock', '');
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'none' });
    const real = await plantRecord('20261028T143005123Z_0a1b2c3d_run-1_task-1.json');
    expect(await store().readNewest('run-1')).toEqual({ outcome: 'read', record: real, recordCount: 1 });
  });

  it('tries the next name when the newest vanishes between the listing and the open', async () => {
    const older = await plantRecord('20261028T143005000Z_0a1b2c3d_run-1_task-1.json');
    await plantRecord('20261028T143006000Z_0a1b2c3d_run-1_task-1.json');
    const vanishing = new FailureRecordStore({
      workspaceRoot: root,
      logger: { warn: vi.fn() },
      fs: {
        readdir: async (directory) => {
          const entries = await fsp.readdir(directory, { withFileTypes: true });
          await fsp.rm(path.join(directory, '20261028T143006000Z_0a1b2c3d_run-1_task-1.json'));
          return entries;
        }
      }
    });
    expect(await vanishing.readNewest('run-1')).toEqual({ outcome: 'read', record: older, recordCount: 1 });
  });

  it('reports none when every listed name vanished', async () => {
    await plantRecord('20261028T143005000Z_0a1b2c3d_run-1_task-1.json');
    const vanishing = new FailureRecordStore({
      workspaceRoot: root,
      logger: { warn: vi.fn() },
      fs: {
        readdir: async (directory) => {
          const entries = await fsp.readdir(directory, { withFileTypes: true });
          await fsp.rm(directory, { recursive: true });
          return entries;
        }
      }
    });
    expect(await vanishing.readNewest('run-1')).toEqual({ outcome: 'none' });
  });

  it.skipIf(IS_WINDOWS)('reports an unreadable listing when the records directory is a symlink out of the workspace', async () => {
    await fsp.mkdir(path.join(root, '.schegent'), { recursive: true });
    await fsp.symlink(outside, path.join(root, RECORDS_DIR));
    const result = await store().readNewest('run-1');
    expect(result.outcome).toBe('unreadable');
  });

  it('never writes, renames, narrows or deletes: the directory is byte-identical after reads', async () => {
    await plantRecord('20261028T143005123Z_0a1b2c3d_run-1_task-1.json');
    await plant('20261028T143006000Z_0a1b2c3d_run-1_task-1.json', '{');
    const snapshot = async (): Promise<string> => {
      const names = await recordFiles();
      const parts: string[] = [];
      for (const name of names) {
        const full = path.join(root, RECORDS_DIR, name);
        const stat = await fsp.stat(full);
        parts.push(`${name}:${stat.mode}:${stat.mtimeMs}:${(await fsp.readFile(full)).toString('hex')}`);
      }
      return parts.join('|');
    };
    const before = await snapshot();
    await store().readNewest('run-1');
    await store().list('run-1');
    expect(await snapshot()).toBe(before);
  });
});
