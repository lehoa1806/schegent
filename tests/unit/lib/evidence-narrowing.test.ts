import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeNarrowing,
  listGenerations,
  NarrowingReporter,
  narrowRotatedFiles
} from '../../../src/lib/evidence-narrowing';

/**
 * Feature 217 (FR-003, FR-004, FR-005) — the policy the evidence sinks share
 * around `narrowMode`.
 *
 * The sink suites prove the reporter's once-only, path-free lines and the
 * operator's non-numeric suffixes through each sink. What no sink test reaches
 * is pinned here: the words for a platform that could not narrow, the padding
 * of a mode with no owner bits, a sink that throws, a directory that cannot be
 * listed, and a rotated file outside every root.
 */

const OWNER_ONLY_FILE = 0o600;
const WIDENED_FILE = 0o644;

/** POSIX-only: `mode` is not an enforceable concept on Windows. */
const posixOnly = process.platform === 'win32' ? it.skip : it;

const modeOf = async (p: string): Promise<number> => (await fs.lstat(p)).mode & 0o777;

async function leaveWidened(file: string): Promise<void> {
  await fs.writeFile(file, 'evidence\n', 'utf8');
  await fs.chmod(file, WIDENED_FILE);
}

describe('describeNarrowing — the words an operator reads', () => {
  it('pads the mode it found to three octal digits', () => {
    expect(describeNarrowing({ scope: 'file', outcome: 'narrowed', previousMode: 0o044 })).toBe(
      'an evidence file granted access beyond its owner (mode 044); narrowed to owner-only'
    );
  });

  it('says a platform could not narrow, carrying the bounded code', () => {
    expect(
      describeNarrowing({ scope: 'directory', outcome: 'unsupported', code: 'not-applied' })
    ).toBe(
      'could not narrow an evidence directory to owner-only (not-applied); ' +
        'it may be readable by other local accounts'
    );
  });
});

describe('NarrowingReporter — a sink that throws', () => {
  const WIDENED_FILE_NOTICE = { scope: 'file', outcome: 'narrowed', previousMode: WIDENED_FILE } as const;

  it('keeps the throw out of the caller, and says the line on the next report instead', () => {
    const delivered: string[] = [];
    let sinkAvailable = false;
    const reporter = new NarrowingReporter('evidence:', (message) => {
      if (!sinkAvailable) throw new Error('sink unavailable');
      delivered.push(message);
    });

    expect(() => reporter.report([WIDENED_FILE_NOTICE])).not.toThrow();
    sinkAvailable = true;
    reporter.report([WIDENED_FILE_NOTICE]);
    reporter.report([WIDENED_FILE_NOTICE]);

    expect(delivered).toEqual([
      'evidence: an evidence file granted access beyond its owner (mode 644); narrowed to owner-only'
    ]);
  });
});

describe('listGenerations — the rotated files beside a live log', () => {
  it('answers null when the directory cannot be read: not a failed write, and not an empty directory', async () => {
    const unreadable = (): Promise<readonly string[]> =>
      Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));

    await expect(listGenerations(path.join('evidence', 'syslog'), unreadable)).resolves.toBeNull();
  });

  it('keeps a purely numeric suffix of the live name, and nothing that only resembles one', async () => {
    const entries = (): Promise<readonly string[]> =>
      Promise.resolve(['syslog', 'syslog.1', 'syslog.12', 'syslog.1.bak', 'syslogx.1', 'other.1']);

    await expect(listGenerations(path.join('evidence', 'syslog'), entries)).resolves.toEqual([
      path.join('evidence', 'syslog.1'),
      path.join('evidence', 'syslog.12')
    ]);
  });
});

describe('narrowRotatedFiles — rotated files narrowed where they lie', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-evidence-root-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-evidence-outside-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  posixOnly('narrows a rotated file inside a root, and says what it found', async () => {
    const generation = path.join(root, 'syslog.1');
    await leaveWidened(generation);

    const notices = await narrowRotatedFiles([generation], OWNER_ONLY_FILE, [root]);

    expect(await modeOf(generation)).toBe(OWNER_ONLY_FILE);
    expect(notices).toEqual([{ scope: 'file', outcome: 'narrowed', previousMode: WIDENED_FILE }]);
  });

  posixOnly('leaves a file outside every root as it found it, and says nothing', async () => {
    const stray = path.join(outside, 'syslog.1');
    await leaveWidened(stray);

    const notices = await narrowRotatedFiles([stray], OWNER_ONLY_FILE, [root]);

    expect(await modeOf(stray), 'containment is proven before any mode changes').toBe(WIDENED_FILE);
    expect(notices, 'the sink reports containment; this sweep does not').toEqual([]);
  });
});
