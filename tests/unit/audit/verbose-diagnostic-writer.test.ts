import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  VerboseDiagnosticWriter,
  type VerboseDiagnosticTarget
} from '../../../src/audit/verbose-diagnostic-writer';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-verbose-diag-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeTarget(overrides: Partial<VerboseDiagnosticTarget> = {}): VerboseDiagnosticTarget {
  const dir = path.join(
    tmpRoot,
    '.schegent',
    'sessions',
    'run-001',
    'diagnostics',
    'security',
    'security-audit',
    'iter-1'
  );
  return {
    directory: dir,
    debugFile: path.join(dir, 'debug.json'),
    streamFile: path.join(dir, 'stream.jsonl'),
    verboseLogFile: path.join(dir, 'verbose.log'),
    ...overrides
  };
}

describe('VerboseDiagnosticWriter (010, T034, US3)', () => {
  it('writes all three sibling files at the canonical path on success', async () => {
    const writer = new VerboseDiagnosticWriter(new SanitizedLogger());
    const target = makeTarget();
    await writer.prepare(target);
    await writer.teeStream(target, '{"event":"a"}\n');
    await writer.teeStream(target, '{"event":"b"}\n');
    await writer.teeVerbose(target, 'verbose-line-1\n');
    await writer.teeVerbose(target, 'verbose-line-2\n');

    const streamContent = await fs.readFile(target.streamFile, 'utf8');
    const verboseContent = await fs.readFile(target.verboseLogFile, 'utf8');
    expect(streamContent).toBe('{"event":"a"}\n{"event":"b"}\n');
    expect(verboseContent).toBe('verbose-line-1\nverbose-line-2\n');

    // debug.json is owned by the CLI itself via --debug-to-file — the writer
    // only creates the directory so the CLI can write to it. Confirm the
    // directory was created.
    const stat = await fs.stat(path.dirname(target.debugFile));
    expect(stat.isDirectory()).toBe(true);

    expect(writer.result().warnings).toEqual([]);
  });

  it('writes are unredacted — raw bytes match input verbatim', async () => {
    const writer = new VerboseDiagnosticWriter(new SanitizedLogger());
    const target = makeTarget();
    await writer.prepare(target);
    const sensitive = 'sk-secret-1234 Authorization: Bearer abc123';
    await writer.teeStream(target, sensitive);
    await writer.teeVerbose(target, sensitive);

    expect(await fs.readFile(target.streamFile, 'utf8')).toBe(sensitive);
    expect(await fs.readFile(target.verboseLogFile, 'utf8')).toBe(sensitive);
  });

  it('emits one warning when directory creation fails and does not throw', async () => {
    const writer = new VerboseDiagnosticWriter(new SanitizedLogger());
    // Point the target at a path under a regular file — mkdir will fail.
    const file = path.join(tmpRoot, 'a-file');
    await fs.writeFile(file, 'block', 'utf8');
    const dir = path.join(file, 'diagnostics', 'p', 'q', 'iter-1');
    const target: VerboseDiagnosticTarget = {
      directory: dir,
      debugFile: path.join(dir, 'debug.json'),
      streamFile: path.join(dir, 'stream.jsonl'),
      verboseLogFile: path.join(dir, 'verbose.log')
    };

    await expect(writer.prepare(target)).resolves.not.toThrow();
    const warnings = writer.result().warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/diagnostic.*directory|mkdir/i);
  });

  it('emits one warning per failed slot; surviving slots still write', async () => {
    const writer = new VerboseDiagnosticWriter(new SanitizedLogger());
    const target = makeTarget();
    await writer.prepare(target);
    // Replace streamFile with a directory so write fails.
    await fs.mkdir(target.streamFile, { recursive: true });

    await writer.teeStream(target, 'will-fail');
    await writer.teeVerbose(target, 'will-succeed\n');

    const warnings = writer.result().warnings;
    expect(warnings.some((w) => /stream/i.test(w))).toBe(true);
    expect(warnings.filter((w) => /stream/i.test(w))).toHaveLength(1);
    expect(await fs.readFile(target.verboseLogFile, 'utf8')).toBe('will-succeed\n');
  });

  it('repeated write failures on the same slot fold into a single warning', async () => {
    const writer = new VerboseDiagnosticWriter(new SanitizedLogger());
    const target = makeTarget();
    await writer.prepare(target);
    await fs.mkdir(target.streamFile, { recursive: true });

    await writer.teeStream(target, 'a');
    await writer.teeStream(target, 'b');
    await writer.teeStream(target, 'c');

    const warnings = writer.result().warnings;
    const streamWarnings = warnings.filter((w) => /stream/i.test(w));
    expect(streamWarnings).toHaveLength(1);
  });
});
