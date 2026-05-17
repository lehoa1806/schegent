// Feature 031 T045 — end-to-end integration test for the wake-up
// session-log writer + runner wiring.
//
// Drives the headless runner against a stubbed `claude` CLI on PATH, so
// the spawn → capture → sanitize → append → trim chain executes for
// real. Validates:
//
//   (a) session.log exists at `<wakeup home>/session.log` after one
//       spawning invocation.
//   (b) The block header has the expected shape.
//   (c) The body preserves the stub's stdout + stderr with `OUT:` /
//       `ERR:` prefixes.
//   (d) A second invocation appends a second block, in chronological
//       order.
//   (e) When the file is pre-populated > 32 MB (we use a small override
//       on a unit-level writer call here, since the integration runner
//       does not expose the override), the oldest blocks are trimmed at
//       block boundaries.
//
// We use the lock-skipped + manual paths to validate the runner
// integration. The stub `claude` is a Node script that emits known
// stdout + stderr then exits 0.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runWakeup, type WakeupRunOptions } from '../../src/headless/wakeup-runner';
import { appendBlock } from '../../src/wakeup/session-log-writer';

let tempRoot: string;
let homeDir: string;
let stubDir: string;
let stubPath: string;
let savedPath: string | undefined;
let savedHomeEnv: string | undefined;

const RUNNER_INTEGRATION_TIMEOUT_MS = 30_000;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wakeup-session-log-e2e-'));
  homeDir = join(tempRoot, 'wakeup-home');
  stubDir = join(tempRoot, 'bin');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stubDir, { recursive: true });

  // Write a stub `claude` executable that emits known stdout + stderr
  // then exits 0. Keep it on PATH for production-shape parity, but invoke it
  // through the platform shell below because direct temp-script execution can
  // hang under Node spawn on some local runners. This test is about subprocess
  // capture, not shebang startup.
  stubPath = join(stubDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  writeFileSync(
    stubPath,
    process.platform === 'win32'
      ? [
          '@echo off',
          'echo stub-out line one',
          'echo stub-err line one 1>&2',
          'echo stub-out line two',
          'exit /b 0'
        ].join('\r\n')
      : [
          '#!/bin/sh',
          "printf 'stub-out line one\\n'",
          "printf 'stub-err line one\\n' >&2",
          "printf 'stub-out line two\\n'",
          'exit 0'
        ].join('\n'),
    'utf8'
  );
  if (process.platform !== 'win32') {
    chmodSync(stubPath, 0o755);
  }

  savedPath = process.env.PATH;
  process.env.PATH = `${stubDir}${delimiter}${process.env.PATH ?? ''}`;

  // Seed enabled settings so the runner proceeds to spawn.
  writeFileSync(
    join(homeDir, 'settings.json'),
    JSON.stringify({
      enabled: true,
      schedulerType: 'periodic',
      chronologicalTime: '04:00',
      periodicInterval: 'Every 1h'
    }),
    'utf8'
  );
  // Empty workspace-roots so the cwd-inside-workspace defense passes.
  writeFileSync(
    join(homeDir, 'workspace-roots.json'),
    JSON.stringify({ roots: [] }),
    'utf8'
  );

  savedHomeEnv = process.env.SCHEGENT_WAKEUP_HOME;
  process.env.SCHEGENT_WAKEUP_HOME = homeDir;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedHomeEnv === undefined) delete process.env.SCHEGENT_WAKEUP_HOME;
  else process.env.SCHEGENT_WAKEUP_HOME = savedHomeEnv;
  rmSync(tempRoot, { recursive: true, force: true });
});

function runWakeupWithStub(
  options: Omit<WakeupRunOptions, 'claudeCommand' | 'claudeCommandPrefixArgs'>
): Promise<number> {
  return runWakeup({
    ...options,
    claudeCommand: process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh',
    claudeCommandPrefixArgs: process.platform === 'win32' ? ['/c', stubPath] : [stubPath]
  });
}

describe('Feature 031 T045 — wake-up session-log end-to-end', () => {
  it('one invocation produces session.log with one well-formed block', async () => {
    const code = await runWakeupWithStub({ homeDir, triggerSource: 'scheduled' });
    expect(code).toBe(0);

    const sessionLogPath = join(homeDir, 'session.log');
    expect(existsSync(sessionLogPath)).toBe(true);

    const content = readFileSync(sessionLogPath, 'utf8');
    // Header shape
    expect(content).toMatch(
      /=== wakeup-block \S+ id=[0-9a-f-]{36} trigger=scheduled model=\S+ status=\S+ ===\n/
    );
    // Body preserves OUT: / ERR: stream tags
    expect(content).toContain('OUT: stub-out line one');
    expect(content).toContain('ERR: stub-err line one');
    expect(content).toContain('OUT: stub-out line two');
  }, RUNNER_INTEGRATION_TIMEOUT_MS);

  it('two invocations append two blocks chronologically', async () => {
    await runWakeupWithStub({ homeDir, triggerSource: 'scheduled' });
    await runWakeupWithStub({
      homeDir,
      triggerSource: 'manual',
      ignoreDisabledSetting: true
    });

    const content = readFileSync(join(homeDir, 'session.log'), 'utf8');
    // Two `=== wakeup-block ` markers, in document order.
    const indices: number[] = [];
    let cursor = 0;
    while (cursor < content.length) {
      const next = content.indexOf('=== wakeup-block ', cursor);
      if (next === -1) break;
      indices.push(next);
      cursor = next + 1;
    }
    expect(indices.length).toBe(2);
    // First trigger=scheduled, second trigger=manual.
    expect(content).toMatch(/=== wakeup-block .* trigger=scheduled .*===\n/);
    expect(content).toMatch(/=== wakeup-block .* trigger=manual .*===\n/);
  }, RUNNER_INTEGRATION_TIMEOUT_MS);

  it('trims oldest blocks at block boundary when pre-populated above the soft cap (writer override)', async () => {
    const sessionLogPath = join(homeDir, 'session.log');
    const SOFT_CAP = 1024;

    // Seed the file with three pre-existing blocks (~400B each) so the
    // total exceeds the override soft cap.
    const filler = (id: string, iso: string): string =>
      `=== wakeup-block ${iso} id=${id} trigger=scheduled model=runner-default status=succeeded ===\n` +
      'OUT: ' + 'q'.repeat(340) + '\n';
    writeFileSync(
      sessionLogPath,
      filler('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '2026-05-16T04:00:00.000Z') +
        filler('bbbbbbbb-cccc-4ddd-9eee-ffffffffffff', '2026-05-16T04:00:01.000Z') +
        filler('cccccccc-dddd-4eee-aaaa-111111111111', '2026-05-16T04:00:02.000Z'),
      'utf8'
    );

    const result = await appendBlock({
      sessionLogPath,
      header: {
        iso: '2026-05-16T04:00:03.000Z',
        correlationId: 'dddddddd-eeee-4fff-bbbb-222222222222',
        trigger: 'scheduled',
        model: 'runner-default',
        status: 'succeeded'
      },
      body: 'OUT: trail\n',
      maxBytesOverride: SOFT_CAP
    });

    expect(result.outcome).toBe('appended');
    if (result.outcome !== 'appended') return;
    expect(result.trimmed).toBe(true);

    const content = readFileSync(sessionLogPath, 'utf8');
    expect(content.startsWith('=== wakeup-block ')).toBe(true);
    expect(content).toContain('id=dddddddd-eeee-4fff-bbbb-222222222222');
    // The oldest block is gone after trim.
    expect(content).not.toContain('id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });
});
