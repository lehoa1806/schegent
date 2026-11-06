// FR-R5-F19 (spec 278, T19.1, FR-003 to FR-005) — what the open request answers, over a real directory.
//
// The service resolves a queue row to its Run's feature directory (untrusted text), opens
// `<root>/<featureDir>/decisions.md` through the root-bounded safe open, reads it within a byte bound
// and hands the text to a read-only presenter. The nine outcomes are a closed set; only `opened` reads
// the body, and no outcome carries a path or record text. A symlink at any component is refused.
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_RECORD_FILE,
  DECISION_RECORD_MAX_BYTES,
  DECISION_RECORD_OUTCOMES
} from '../../../src/contracts/decision-record';
import {
  createDecisionRecordOpener,
  type DecisionRecordOpenerDeps,
  type RowFeatureDir
} from '../../../src/services/decision-record/decision-record-open';

const ROW = 'row-1';
const FEATURE = 'specs/001-blocked';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'decision-record-open-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function writeRecord(featureDir: string, text: string | Buffer): Promise<string> {
  const directory = path.join(root, featureDir);
  await fsp.mkdir(directory, { recursive: true });
  const target = path.join(directory, DECISION_RECORD_FILE);
  await fsp.writeFile(target, text);
  return target;
}

interface Harness {
  readonly open: (rowId?: string) => Promise<string>;
  readonly present: ReturnType<typeof vi.fn>;
  readonly readBytes: ReturnType<typeof vi.fn>;
  readonly warnings: string[];
}

function harness(overrides: Partial<DecisionRecordOpenerDeps> & { row?: RowFeatureDir } = {}): Harness {
  const present = vi.fn(async () => undefined);
  const readBytes = vi.fn(async (handle: import('node:fs/promises').FileHandle, maxBytes: number) => {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    return buffer.subarray(0, bytesRead);
  });
  const warnings: string[] = [];
  const row: RowFeatureDir = overrides.row ?? { found: true, featureDir: FEATURE };
  const opener = createDecisionRecordOpener({
    workspaceRoot: root,
    isTrusted: () => true,
    featureDirOfRow: () => row,
    present,
    readBytes,
    logger: { warn: (message: string) => warnings.push(message) },
    ...overrides
  });
  return {
    open: async (rowId = ROW) => (await opener.open(rowId)).outcome,
    present,
    readBytes,
    warnings
  };
}

describe('the outcome set', () => {
  it('is the nine values of the contract, in order', () => {
    expect(DECISION_RECORD_OUTCOMES).toEqual([
      'opened',
      'row-not-found',
      'no-record',
      'outside-root',
      'symlink-refused',
      'too-large',
      'not-a-file',
      'unreadable',
      'workspace-not-trusted'
    ]);
  });
});

describe('opened', () => {
  it('reads the file and presents its exact text once', async () => {
    await writeRecord(FEATURE, '## D-1: Pick the window\nStatus: needs-maintainer\n');
    const h = harness();
    await expect(h.open()).resolves.toBe('opened');
    expect(h.present).toHaveBeenCalledTimes(1);
    expect(h.present.mock.calls.at(0)?.at(0)).toBe('## D-1: Pick the window\nStatus: needs-maintainer\n');
  });

  it('passes control characters and markup through as text, unmodified', async () => {
    const hostile = '<script>alert(1)</script> [x](command:workbench.action.reloadWindow) \u0007 \u202e';
    await writeRecord(FEATURE, hostile);
    const h = harness();
    await expect(h.open()).resolves.toBe('opened');
    expect(h.present.mock.calls.at(0)?.at(0)).toBe(hostile);
  });

  it('opens a file of exactly the byte limit', async () => {
    await writeRecord(FEATURE, 'a'.repeat(DECISION_RECORD_MAX_BYTES));
    const h = harness();
    await expect(h.open()).resolves.toBe('opened');
  });

  it('only this outcome reads the body', async () => {
    await writeRecord(FEATURE, 'text');
    const opened = harness();
    await opened.open();
    expect(opened.readBytes).toHaveBeenCalledTimes(1);

    const refused: Array<[string, Harness]> = [
      ['row-not-found', harness({ row: { found: false } })],
      ['outside-root', harness({ row: { found: true, featureDir: '' } })],
      ['workspace-not-trusted', harness({ isTrusted: () => false })]
    ];
    for (const [outcome, h] of refused) {
      await expect(h.open()).resolves.toBe(outcome);
      expect(h.readBytes, outcome).not.toHaveBeenCalled();
      expect(h.present, outcome).not.toHaveBeenCalled();
    }
  });
});

describe('row-not-found and no-record', () => {
  it('answers row-not-found for a row this window does not hold', async () => {
    const h = harness({ row: { found: false } });
    await expect(h.open('gone')).resolves.toBe('row-not-found');
    expect(h.present).not.toHaveBeenCalled();
  });

  it('answers no-record for a row with no Run', async () => {
    const h = harness({ row: { found: true, featureDir: null } });
    await expect(h.open()).resolves.toBe('no-record');
  });

  it('answers no-record when the feature has no decisions.md', async () => {
    await fsp.mkdir(path.join(root, FEATURE), { recursive: true });
    const h = harness();
    await expect(h.open()).resolves.toBe('no-record');
  });

  it('answers no-record when the feature directory does not exist', async () => {
    const h = harness();
    await expect(h.open()).resolves.toBe('no-record');
  });
});

describe('outside-root: featureDir is untrusted text', () => {
  it.each([
    ['empty', ''],
    ['absolute', '/etc'],
    ['a drive path', 'C:/specs/x'],
    ['a backslash path', 'specs\\x'],
    ['a parent segment', '../outside'],
    ['an embedded parent segment', 'specs/../../outside'],
    ['a dot segment', './specs/x'],
    ['a NUL', 'specs/x\u0000y'],
    ['an empty segment', 'specs//x']
  ])('refuses a featureDir that is %s', async (_name, featureDir) => {
    const h = harness({ row: { found: true, featureDir } });
    await expect(h.open()).resolves.toBe('outside-root');
    expect(h.present).not.toHaveBeenCalled();
  });

  it('refuses an absolute featureDir that names a real record under the root', async () => {
    const target = await writeRecord(FEATURE, 'secret');
    const h = harness({ row: { found: true, featureDir: path.dirname(target) } });
    await expect(h.open()).resolves.toBe('outside-root');
    expect(h.present).not.toHaveBeenCalled();
  });
});

describe('symlink-refused', () => {
  it('refuses a symlinked decisions.md and never reads its target', async () => {
    const elsewhere = path.join(root, 'elsewhere.md');
    await fsp.writeFile(elsewhere, 'outside content');
    await fsp.mkdir(path.join(root, FEATURE), { recursive: true });
    await fsp.symlink(elsewhere, path.join(root, FEATURE, DECISION_RECORD_FILE));
    const h = harness();
    await expect(h.open()).resolves.toBe('symlink-refused');
    expect(h.readBytes).not.toHaveBeenCalled();
    expect(h.present).not.toHaveBeenCalled();
  });

  it('refuses a symlinked parent directory', async () => {
    const real = path.join(root, 'real-feature');
    await fsp.mkdir(real, { recursive: true });
    await fsp.writeFile(path.join(real, DECISION_RECORD_FILE), 'outside content');
    await fsp.mkdir(path.join(root, 'specs'), { recursive: true });
    await fsp.symlink(real, path.join(root, FEATURE));
    const h = harness();
    await expect(h.open()).resolves.toBe('symlink-refused');
    expect(h.present).not.toHaveBeenCalled();
  });
});

describe('too-large and not-a-file and unreadable', () => {
  it('refuses a file one byte over the limit without reading it', async () => {
    await writeRecord(FEATURE, 'a'.repeat(DECISION_RECORD_MAX_BYTES + 1));
    const h = harness();
    await expect(h.open()).resolves.toBe('too-large');
    expect(h.readBytes).not.toHaveBeenCalled();
    expect(h.present).not.toHaveBeenCalled();
  });

  it('answers too-large when the file grew past the limit between stat and read', async () => {
    await writeRecord(FEATURE, 'small');
    const h = harness({ readBytes: async () => Buffer.alloc(DECISION_RECORD_MAX_BYTES + 1, 97) });
    await expect(h.open()).resolves.toBe('too-large');
    expect(h.present).not.toHaveBeenCalled();
  });

  it('answers not-a-file when decisions.md is a directory', async () => {
    await fsp.mkdir(path.join(root, FEATURE, DECISION_RECORD_FILE), { recursive: true });
    const h = harness();
    await expect(h.open()).resolves.toBe('not-a-file');
    expect(h.present).not.toHaveBeenCalled();
  });

  it('answers unreadable for bytes that are not UTF-8', async () => {
    await writeRecord(FEATURE, Buffer.from([0xff, 0xfe, 0xfd]));
    const h = harness();
    await expect(h.open()).resolves.toBe('unreadable');
    expect(h.present).not.toHaveBeenCalled();
  });

  it('answers unreadable when the presenter throws, and logs a code without the path or the text', async () => {
    await writeRecord(FEATURE, 'RECORD-TEXT-MARKER');
    const h = harness({
      present: async () => {
        throw new TypeError(`cannot show ${root}/${FEATURE} RECORD-TEXT-MARKER`);
      }
    });
    await expect(h.open()).resolves.toBe('unreadable');
    expect(h.warnings).toHaveLength(1);
    const line = h.warnings.at(0) ?? '';
    expect(line).toContain('TypeError');
    expect(line).not.toContain(root);
    expect(line).not.toContain('RECORD-TEXT-MARKER');
    expect(line).not.toContain(ROW);
  });
});

describe('workspace-not-trusted', () => {
  it('answers it before any lookup or read in an untrusted workspace', async () => {
    await writeRecord(FEATURE, 'text');
    const featureDirOfRow = vi.fn(() => ({ found: true, featureDir: FEATURE }) as RowFeatureDir);
    const h = harness({ isTrusted: () => false, featureDirOfRow });
    await expect(h.open()).resolves.toBe('workspace-not-trusted');
    expect(featureDirOfRow).not.toHaveBeenCalled();
    expect(h.readBytes).not.toHaveBeenCalled();
  });

  it('answers it when trust is lost between the request and the presentation', async () => {
    await writeRecord(FEATURE, 'text');
    const isTrusted = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const h = harness({ isTrusted });
    await expect(h.open()).resolves.toBe('workspace-not-trusted');
    expect(h.present).not.toHaveBeenCalled();
  });
});

describe('the answer carries no path and no record text', () => {
  it('has exactly one key, outcome', async () => {
    await writeRecord(FEATURE, 'RECORD-TEXT-MARKER');
    const opener = createDecisionRecordOpener({
      workspaceRoot: root,
      isTrusted: () => true,
      featureDirOfRow: () => ({ found: true, featureDir: FEATURE }),
      present: async () => undefined,
      logger: { warn: () => undefined }
    });
    const answer = await opener.open(ROW);
    expect(Object.keys(answer)).toEqual(['outcome']);
    expect(JSON.stringify(answer)).not.toContain('RECORD-TEXT-MARKER');
  });
});
