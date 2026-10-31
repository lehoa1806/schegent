// Feature 254 (FR-R4-F07, S-T3; contract S4, S9; data-model §2; FR-003, FR-007) — the chosen import
// file is judged by size BEFORE its contents are read, and a failed read leaks no path.
//
// The inline adapter read the chosen file with `vscode.workspace.fs.readFile`, which allocates the
// whole file. The 1 MiB cap lived in the parser, after the allocation, so the cap bounded the parse and
// not the memory. `readChosenProcessDocument` closes that for a local (`file:`) document: it opens the
// file read-only, refuses on the `fstat` size before any content read, and otherwise reads at most
// cap + 1 bytes, so a file that grew after the `fstat` is caught by its length. A document from another
// provider has no ranged read in VS Code's API, so it gets `stat` first and then the parser's cap.
//
// Real filesystem under `mkdtemp`, no process spawned (plan, Testing). The `FileHandle` prototype's
// `read` is spied on to prove the refusal happens before a content read; every spy is restored in
// `afterEach`.

import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readChosenProcessDocument } from '../../../src/activation/process-yaml-document-read';
import { PHASE_YAML_MAX_BYTES } from '../../../src/services/process-yaml/types';

interface Target {
  readonly scheme: string;
  readonly fsPath: string;
}

const FAILED_MESSAGE = 'Could not read the document.';

let directory: string;
let warnings: string[];

const logger = { warn: (message: string): void => void warnings.push(message) };

/** A deps object whose `fs` must not be reached for a `file:` document. */
const unreachableFs = {
  stat: vi.fn(async (): Promise<{ size: number }> => {
    throw new Error('fs.stat must not be called for a file: document');
  }),
  readBytes: vi.fn(async (): Promise<Uint8Array> => {
    throw new Error('fs.readBytes must not be called for a file: document');
  })
};

async function documentOfSize(name: string, size: number): Promise<Target> {
  const path = join(directory, name);
  await writeFile(path, Buffer.alloc(size, 0x61));
  return { scheme: 'file', fsPath: path };
}

/** The `FileHandle` class's prototype, which `open()` instances share. */
async function fileHandlePrototype(path: string): Promise<object> {
  const probe = await open(path, 'r');
  try {
    return Object.getPrototypeOf(probe) as object;
  } finally {
    await probe.close();
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'schegent-254-read-'));
  warnings = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  unreachableFs.stat.mockClear();
  unreachableFs.readBytes.mockClear();
  await rm(directory, { recursive: true, force: true });
});

describe('FR-R4-F07 S-T3 — a local document is refused by size before it is read', () => {
  it('admits a file of exactly the cap and returns every byte', async () => {
    const target = await documentOfSize('at-cap.yaml', PHASE_YAML_MAX_BYTES);
    const result = await readChosenProcessDocument(target, { fs: unreachableFs, logger });
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.bytes.byteLength).toBe(PHASE_YAML_MAX_BYTES);
    expect(warnings).toEqual([]);
    expect(unreachableFs.stat).not.toHaveBeenCalled();
  });

  it('refuses a file one byte over the cap before any content read', async () => {
    const target = await documentOfSize('over-cap.yaml', PHASE_YAML_MAX_BYTES + 1);
    const read = vi.spyOn(await fileHandlePrototype(target.fsPath), 'read' as never);
    const result = await readChosenProcessDocument(target, { fs: unreachableFs, logger });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(read).toHaveBeenCalledTimes(0);
    expect(warnings).toEqual([]);
  });

  it('reads an ordinary small file whole', async () => {
    const target = await documentOfSize('small.yaml', 120);
    const result = await readChosenProcessDocument(target, { fs: unreachableFs, logger });
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.bytes.byteLength).toBe(120);
    expect(Buffer.from(result.bytes).every((byte) => byte === 0x61)).toBe(true);
  });

  it('reads an empty file as zero bytes', async () => {
    const target = await documentOfSize('empty.yaml', 0);
    const result = await readChosenProcessDocument(target, { fs: unreachableFs, logger });
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.bytes.byteLength).toBe(0);
  });

  it('catches a file that grew after the stat: a handle that reports less than its content is too-large by length', async () => {
    const target = await documentOfSize('grew.yaml', PHASE_YAML_MAX_BYTES + 1);
    // The handle says the file is small; the bytes behind it say otherwise.
    const proto = await fileHandlePrototype(target.fsPath);
    vi.spyOn(proto, 'stat' as never).mockResolvedValue({ size: 10 } as never);
    const result = await readChosenProcessDocument(target, { fs: unreachableFs, logger });
    expect(result).toEqual({ outcome: 'too-large' });
  });

  it('never reads more than cap + 1 bytes from a local file', async () => {
    const target = await documentOfSize('bounded.yaml', PHASE_YAML_MAX_BYTES + 4096);
    const proto = await fileHandlePrototype(target.fsPath);
    vi.spyOn(proto, 'stat' as never).mockResolvedValue({ size: 10 } as never);
    const read = vi.spyOn(proto, 'read' as never);
    await readChosenProcessDocument(target, { fs: unreachableFs, logger });
    let total = 0;
    for (const call of read.mock.calls) total += Number((call as unknown as unknown[])[2]);
    expect(total).toBeLessThanOrEqual(PHASE_YAML_MAX_BYTES + 1);
  });
});

describe('FR-R4-F07 S-T3 — a document from another provider is judged by stat first', () => {
  const remote: Target = { scheme: 'vscode-vfs', fsPath: '/virtual/secret-project/doc.yaml' };

  it('is too-large by stat, with readBytes never called', async () => {
    const fs = {
      stat: vi.fn(async () => ({ size: PHASE_YAML_MAX_BYTES + 1 })),
      readBytes: vi.fn(async () => new Uint8Array(4))
    };
    const result = await readChosenProcessDocument(remote, { fs, logger });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(fs.stat).toHaveBeenCalledTimes(1);
    expect(fs.readBytes).toHaveBeenCalledTimes(0);
  });

  it('reads the document when stat is within the cap', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fs = {
      stat: vi.fn(async () => ({ size: 3 })),
      readBytes: vi.fn(async () => bytes)
    };
    const result = await readChosenProcessDocument(remote, { fs, logger });
    expect(result).toEqual({ outcome: 'read', bytes });
    expect(fs.readBytes).toHaveBeenCalledTimes(1);
  });

  it('hands a provider that under-reports its size to the parser, whose own cap still applies', async () => {
    const big = new Uint8Array(PHASE_YAML_MAX_BYTES + 10);
    const fs = { stat: async () => ({ size: 0 }), readBytes: async () => big };
    const result = await readChosenProcessDocument(remote, { fs, logger });
    expect(result.outcome).toBe('read');
  });
});

describe('FR-R4-F07 S-T3 / S9 — a failed read logs a closed code and no path', () => {
  it('logs once with the errno and neither the directory nor the file name', async () => {
    const target: Target = { scheme: 'file', fsPath: join(directory, 'never-created-private-name.yaml') };
    const result = await readChosenProcessDocument(target, { fs: unreachableFs, logger });
    expect(result).toEqual({ outcome: 'failed', message: FAILED_MESSAGE });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ENOENT');
    expect(warnings[0]).not.toContain(directory);
    expect(warnings[0]).not.toContain('never-created-private-name');
    expect(warnings[0]).not.toContain('schegent-254-read');
  });

  it('logs the code of a failing stat for another provider, never its message', async () => {
    const failure = Object.assign(new Error('cannot reach /virtual/secret-project/doc.yaml'), {
      code: 'FileNotFound'
    });
    const fs = {
      stat: async (): Promise<{ size: number }> => {
        throw failure;
      },
      readBytes: async (): Promise<Uint8Array> => new Uint8Array(0)
    };
    const result = await readChosenProcessDocument(
      { scheme: 'vscode-vfs', fsPath: '/virtual/secret-project/doc.yaml' },
      { fs, logger }
    );
    expect(result).toEqual({ outcome: 'failed', message: FAILED_MESSAGE });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('FileNotFound');
    expect(warnings[0]).not.toContain('secret-project');
  });

  it('logs an unknown code when the failure carries none', async () => {
    const fs = {
      stat: async (): Promise<{ size: number }> => {
        throw new Error('boom at /private/path');
      },
      readBytes: async (): Promise<Uint8Array> => new Uint8Array(0)
    };
    await readChosenProcessDocument({ scheme: 'untitled', fsPath: '/private/path' }, { fs, logger });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('private');
    expect(warnings[0]).not.toContain('boom');
  });
});
