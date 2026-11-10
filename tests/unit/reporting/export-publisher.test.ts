// FR-R6-F11 T030 (FR-015, FR-016, FR-018; research R8) — staging files, publication and cleanup.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  nodeExportFs,
  openPartial,
  partialNames,
  publishPartial,
  removePartials,
  type ExportFs
} from '../../../src/services/reporting/export-publisher';

const EXPORT_ID = 'e'.repeat(32);
let sandbox = '';
let anchor = '';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'export-publisher-'));
  anchor = path.join(sandbox, 'out');
  fs.mkdirSync(anchor);
  anchor = fs.realpathSync(anchor);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function failing(operation: 'linkContained' | 'renameContained' | 'unlinkContained', code: string): ExportFs {
  const error = Object.assign(new Error('injected'), { code });
  return {
    ...nodeExportFs,
    [operation]: () => Promise.reject(error)
  };
}

async function stage(name: string, text: string): Promise<void> {
  const handle = await openPartial(nodeExportFs, anchor, name);
  expect(handle).not.toBeNull();
  await handle?.write(Buffer.from(text, 'utf8'));
  await handle?.sync();
  await handle?.close();
}

describe('partial names', () => {
  it('are hidden, carry the export id and differ for data and manifest', () => {
    expect(partialNames('report.csv', EXPORT_ID)).toEqual({
      data: `.report.csv.${EXPORT_ID}.data.partial`,
      manifest: `.report.csv.${EXPORT_ID}.manifest.partial`
    });
  });
});

describe('openPartial', () => {
  it('creates an owner-only file and refuses one that exists', async () => {
    await stage('.a.partial', 'x');
    expect(fs.statSync(path.join(anchor, '.a.partial')).mode & 0o777).toBe(0o600);
    expect(await openPartial(nodeExportFs, anchor, '.a.partial')).toBeNull();
  });

  it('refuses a name that leaves the anchor', async () => {
    expect(await openPartial(nodeExportFs, anchor, '../escape.partial')).toBeNull();
    expect(fs.existsSync(path.join(sandbox, 'escape.partial'))).toBe(false);
  });
});

describe('publishPartial', () => {
  it('links without overwrite and removes the partial', async () => {
    await stage('.p', 'data');
    expect(await publishPartial(nodeExportFs, anchor, '.p', 'report.json', false)).toBe('published');
    expect(fs.readFileSync(path.join(anchor, 'report.json'), 'utf8')).toBe('data');
    expect(fs.existsSync(path.join(anchor, '.p'))).toBe(false);
  });

  it('never replaces an existing file without overwrite', async () => {
    fs.writeFileSync(path.join(anchor, 'report.json'), 'keep');
    await stage('.p', 'data');
    expect(await publishPartial(nodeExportFs, anchor, '.p', 'report.json', false)).toBe('exists');
    expect(fs.readFileSync(path.join(anchor, 'report.json'), 'utf8')).toBe('keep');
  });

  it('replaces an existing file with overwrite', async () => {
    fs.writeFileSync(path.join(anchor, 'report.json'), 'old');
    await stage('.p', 'new');
    expect(await publishPartial(nodeExportFs, anchor, '.p', 'report.json', true)).toBe('published');
    expect(fs.readFileSync(path.join(anchor, 'report.json'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(anchor, '.p'))).toBe(false);
  });

  it('fails on an injected link or rename error and on a name outside the anchor', async () => {
    await stage('.p', 'data');
    expect(await publishPartial(failing('linkContained', 'EIO'), anchor, '.p', 'report.json', false)).toBe('failed');
    expect(await publishPartial(failing('renameContained', 'EIO'), anchor, '.p', 'report.json', true)).toBe('failed');
    expect(await publishPartial(nodeExportFs, anchor, '.p', '../report.json', false)).toBe('failed');
    expect(fs.existsSync(path.join(sandbox, 'report.json'))).toBe(false);
    expect(fs.existsSync(path.join(anchor, '.p'))).toBe(true);
  });
});

describe('removePartials', () => {
  it('removes only the named partials and treats an absent one as clean', async () => {
    await stage('.d', 'x');
    fs.writeFileSync(path.join(anchor, 'other.txt'), 'keep');
    expect(await removePartials(nodeExportFs, anchor, ['.d', '.m'])).toBe(true);
    expect(fs.readdirSync(anchor)).toEqual(['other.txt']);
  });

  it('never removes a file outside the anchor', async () => {
    fs.writeFileSync(path.join(sandbox, 'outside.txt'), 'keep');
    expect(await removePartials(nodeExportFs, anchor, ['../outside.txt'])).toBe(false);
    expect(fs.readFileSync(path.join(sandbox, 'outside.txt'), 'utf8')).toBe('keep');
  });

  it('reports an injected unlink failure', async () => {
    await stage('.d', 'x');
    expect(await removePartials(failing('unlinkContained', 'EACCES'), anchor, ['.d'])).toBe(false);
  });
});
