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

import { readFileSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

// FR-R4-F07 (audit G-E; FR-007, V4) — the two router adapters that wrap the reader log the same way
// ---------------------------------------------------------------------------
//
// `readChosenProcessDocument` logs a closed code and no path, and the cases above hold it. The save
// dialog and the export write live in adapters that `createSidebarRouter` builds and no test
// constructs, so their `catch` arms were held by nothing: an arm that logged the caught message would
// print the location a file-system error names, and `logger.sanitize` redacts secrets, not paths.
//
// They cannot be called here, so the property is held on the text of each arm: the only thing the arm
// does with the caught value is take its closed code, and the only thing it interpolates is that code.
// It is a narrow text check and it does not parse. It is shown to say no (the synthetic arms) and to find
// both production arms (the control), so a clean verdict is not a failed lookup.

const ROUTER_WIRING = resolve(__dirname, '..', '..', '..', 'src', 'activation', 'sidebar-router-wiring.ts');

/** The two adapters' log lines, by the text they begin with. */
const ADAPTER_ARMS: readonly (readonly [string, string])[] = [
  ['export write', 'extension: phase export write failed'],
  ['import dialog', 'extension: phase import dialog failed']
];

/** `${closedErrorCode(err)}` as text, the one interpolation an arm may hold. */
const CLOSED_CODE_INTERPOLATION = '$' + '{closedErrorCode(err)}';

/** TypeScript source with block and line comments removed. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The body of the `catch (err) { … }` arm that holds `logText`, by balanced braces; absent when none does. */
function catchArmHolding(code: string, logText: string): string | undefined {
  const at = code.indexOf(logText);
  if (at < 0) return undefined;
  const opener = 'catch (err) {';
  const open = code.lastIndexOf(opener, at);
  if (open < 0) return undefined;
  const bodyStart = open + opener.length;
  let depth = 1;
  for (let position = bodyStart; position < code.length; position += 1) {
    const character = code.charAt(position);
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return code.slice(bodyStart, position);
  }
  return undefined;
}

/** What an arm does with the caught value beyond taking its closed code; empty when it does nothing more. */
function excessOfClosedCodeArm(arm: string): readonly string[] {
  const excess: string[] = [];
  if (!arm.includes(CLOSED_CODE_INTERPOLATION)) excess.push('does not log the closed code');
  const rest = arm.split(CLOSED_CODE_INTERPOLATION).join('');
  if (/\berr\b/.test(rest)) excess.push('uses the caught value beyond its closed code');
  if (rest.includes('${')) excess.push('interpolates something other than the closed code');
  return excess;
}

/** `${expression}` as text, without writing a template placeholder in a string the linter reads. */
const placeholder = (expression: string): string => '$' + '{' + expression + '}';

/** An arm shaped like the production ones, logging `logged` after the log's opening words. */
const armLogging = (logged: string): string =>
  'logger.warn(`extension: phase export write failed: ' + logged + '`); return { outcome: "failed" };';

describe('FR-R4-F07 audit G-E — the router adapters log a closed code and nothing else (FR-007, V4)', () => {
  const code = withoutComments(readFileSync(ROUTER_WIRING, 'utf8'));

  it.each(ADAPTER_ARMS)('control: finds the %s arm in the production wiring', (_name, logText) => {
    const arm = catchArmHolding(code, logText);
    expect(arm).toBeDefined();
    expect(arm).toContain('logger.warn(');
    expect(arm).toContain(logText);
  });

  it.each(ADAPTER_ARMS)('the %s arm takes only the closed code of what it caught', (_name, logText) => {
    expect(excessOfClosedCodeArm(catchArmHolding(code, logText) ?? '(no arm found)')).toEqual([]);
  });

  it('accepts an arm shaped like the production ones', () => {
    expect(excessOfClosedCodeArm(armLogging('code=' + placeholder('closedErrorCode(err)')))).toEqual([]);
  });

  it('names an arm that logs the message of what it caught (synthetic)', () => {
    expect(excessOfClosedCodeArm(armLogging(placeholder('err.message')))).toEqual([
      'does not log the closed code',
      'uses the caught value beyond its closed code',
      'interpolates something other than the closed code'
    ]);
  });

  it('names an arm that adds the message beside the closed code (synthetic)', () => {
    const logged = 'code=' + placeholder('closedErrorCode(err)') + ' ' + placeholder('logger.sanitize(err.message)');
    expect(excessOfClosedCodeArm(armLogging(logged))).toEqual([
      'uses the caught value beyond its closed code',
      'interpolates something other than the closed code'
    ]);
  });

  it('names an arm that adds a location beside the closed code (synthetic)', () => {
    const logged = 'code=' + placeholder('closedErrorCode(err)') + ' ' + placeholder('target.fsPath');
    expect(excessOfClosedCodeArm(armLogging(logged))).toEqual([
      'interpolates something other than the closed code'
    ]);
  });

  it('names an arm that logs no code at all (synthetic)', () => {
    expect(excessOfClosedCodeArm(armLogging('failed'))).toEqual(['does not log the closed code']);
  });

  it('finds no arm where the log text is absent, rather than reading a neighbour', () => {
    expect(catchArmHolding(code, 'extension: no such adapter failed')).toBeUndefined();
  });
});
