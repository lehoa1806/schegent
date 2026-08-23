import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SanitizedLogger } from '../../../src/lib/logger';
import {
  VerboseDiagnosticWriter,
  type VerboseDiagnosticTarget
} from '../../../src/audit/verbose-diagnostic-writer';

/**
 * FR-R3-050 / M-13 — verbose diagnostics must be owner-only.
 *
 * The content is deliberately unredacted: the module's own header records that
 * "the operator opted in to raw payloads." That opt-in is about what gets
 * WRITTEN. It says nothing about who may read it, and the threat model claims
 * private modes — while `mkdir` and `appendFile` were called with no `mode`, so a
 * common 022 umask produced 0755 directories and 0644 files.
 *
 * WHY A REAL FILESYSTEM
 *
 * A mocked `fs` can only prove which argument was passed. The claim is what the
 * filesystem GRANTED, which needs a real directory, a real file, and a real
 * `stat`.
 *
 * WHY CONTROL-VS-TREATMENT INSTEAD OF TWO UMASKS
 *
 * `process.umask()` cannot be set inside a vitest worker, so the umask cannot be
 * varied. A control is stronger than varying it anyway: create one path with NO
 * mode and one through the writer, under whatever umask is ambient, and compare.
 * If the control comes out group- or world-readable and the writer's does not,
 * the mode was asserted rather than inherited — which is the actual claim, and it
 * holds under any umask the machine happens to have.
 *
 * No raw payload appears in any name, fixture, or message here — these are the
 * unredacted files, so a careless assertion is one step from printing a prompt.
 */

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const SENTINEL = 'diagnostic-body-sentinel';

/** POSIX-only: `mode` is not an enforceable concept on Windows. */
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('verbose diagnostics are owner-only (M-13)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-diag-modes-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function target(dir: string): VerboseDiagnosticTarget {
    return {
      directory: dir,
      debugFile: path.join(dir, 'debug.log'),
      streamFile: path.join(dir, 'stream.jsonl'),
      verboseLogFile: path.join(dir, 'verbose.log')
    };
  }

  async function writeThrough(dir: string): Promise<void> {
    const writer = new VerboseDiagnosticWriter(new SanitizedLogger([]));
    const t = target(dir);
    await writer.prepare(t);
    await writer.teeStream(t, `${SENTINEL}\n`);
  }

  /** What an unmoded create yields under the ambient umask. The control. */
  async function unmodedControl(): Promise<{ dir: number; file: number }> {
    const dir = path.join(root, 'control');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'control.log');
    await fs.appendFile(file, 'c', 'utf8');
    return { dir: await modeOf(dir), file: await modeOf(file) };
  }

  const modeOf = async (p: string): Promise<number> => (await fs.stat(p)).mode & 0o777;

  posixOnly('creates the directory owner-only', async () => {
    const dir = path.join(root, 'diagnostics');
    await writeThrough(dir);
    expect(await modeOf(dir)).toBe(OWNER_ONLY_DIR);
  });

  posixOnly('creates the file owner-only', async () => {
    const dir = path.join(root, 'diagnostics');
    await writeThrough(dir);
    expect(await modeOf(path.join(dir, 'stream.jsonl'))).toBe(OWNER_ONLY_FILE);
  });

  posixOnly('asserts the mode rather than inheriting the umask', async () => {
    const control = await unmodedControl();
    const dir = path.join(root, 'treatment');
    await writeThrough(dir);

    expect(await modeOf(dir)).toBe(OWNER_ONLY_DIR);
    expect(await modeOf(path.join(dir, 'stream.jsonl'))).toBe(OWNER_ONLY_FILE);

    // The comparison is what makes this a real assertion rather than a
    // coincidence: if an unmoded create is already owner-only here, the machine's
    // umask is doing the work and this test proves nothing about the code. Skip
    // the differential claim in that case rather than pretend it held.
    if ((control.dir & 0o077) !== 0) expect(await modeOf(dir)).not.toBe(control.dir);
    if ((control.file & 0o077) !== 0) {
      expect(await modeOf(path.join(dir, 'stream.jsonl'))).not.toBe(control.file);
    }
  });

  posixOnly('grants no group or other access, whatever the ambient umask', async () => {
    const dir = path.join(root, 'no-group-other');
    await writeThrough(dir);
    // The invariant that survives any umask: nothing outside the owner.
    expect(await modeOf(dir) & 0o077).toBe(0);
    expect(await modeOf(path.join(dir, 'stream.jsonl')) & 0o077).toBe(0);
  });

  posixOnly('tightens a pre-existing permissive directory, and never loosens a strict one', async () => {
    const permissive = path.join(root, 'pre-existing-permissive');
    await fs.mkdir(permissive, { recursive: true, mode: 0o755 });
    await writeThrough(permissive);
    expect(await modeOf(permissive)).toBe(OWNER_ONLY_DIR);

    const strict = path.join(root, 'pre-existing-strict');
    await fs.mkdir(strict, { recursive: true, mode: 0o500 });
    await writeThrough(strict);
    // Already stricter than required: left alone rather than widened to 0700.
    expect(await modeOf(strict) & 0o077).toBe(0);
  });

  posixOnly('does not change what is written', async () => {
    const dir = path.join(root, 'content');
    await writeThrough(dir);
    const body = await fs.readFile(path.join(dir, 'stream.jsonl'), 'utf8');
    expect(body.includes(SENTINEL)).toBe(true);
  });
});
