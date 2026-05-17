// Feature 031 T017 — unit tests for the runner's spawn args.
//
// The runner reads `model` from the settings mirror at fire time
// (031 §FR-002 + tasks T022) and translates the operator's selection
// into a CLI flag:
//   - `'runner-default'`            → omit the flag (the CLI uses its own default).
//   - known member of registry      → prepend `--model <id>` to args.
//   - unknown identifier            → omit the flag AND mark the invocation
//                                     record with `requestedModel: <verbatim>`,
//                                     `actualModel: 'runner-default'`.
//
// We mock `node:child_process.spawn` to capture the args verbatim. The
// runner module MUST stay `vscode`-import-free (014 hard rule) so the
// import path is plain `src/headless/wakeup-runner`.

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi
} from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as realTmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { runWakeup as RunWakeupType } from '../../../src/headless/wakeup-runner';
import type { InvocationLog as InvocationLogType } from '../../../src/wakeup/invocation-log';

const spawnCalls: Array<{
  cmd: string;
  args: readonly string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
}> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process'
  );
  return {
    ...actual,
    default: actual,
    spawn: ((
      cmd: string,
      args: readonly string[],
      opts?: { cwd?: string; env?: NodeJS.ProcessEnv }
    ) => {
      spawnCalls.push({ cmd, args, opts });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: (s: string) => void; end: () => void };
        kill: (sig?: string) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => undefined, end: () => undefined };
      child.kill = () => undefined;
      setImmediate(() => child.emit('exit', 0));
      return child as unknown as ReturnType<typeof actual.spawn>;
    }) as unknown as typeof actual.spawn
  };
});

let runWakeup: typeof RunWakeupType;
let InvocationLog: typeof InvocationLogType;

interface SettingsForMirror {
  enabled: boolean;
  schedulerType: 'chronological' | 'periodic';
  chronologicalTime: string;
  periodicInterval: string;
  model?: string;
}

describe('Feature 031 T017 — wakeup-runner spawn args carry --model', () => {
  let tempRoot: string;
  let homeDir: string;
  let savedHomeEnv: string | undefined;

  beforeAll(async () => {
    ({ runWakeup } = await import('../../../src/headless/wakeup-runner.js'));
    ({ InvocationLog } = await import('../../../src/wakeup/invocation-log.js'));
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(realTmpdir(), 'schegent-wakeup-spawn-'));
    homeDir = path.join(tempRoot, 'wakeup-home');
    mkdirSync(homeDir, { recursive: true });
    savedHomeEnv = process.env.SCHEGENT_WAKEUP_HOME;
    process.env.SCHEGENT_WAKEUP_HOME = homeDir;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    if (savedHomeEnv === undefined) delete process.env.SCHEGENT_WAKEUP_HOME;
    else process.env.SCHEGENT_WAKEUP_HOME = savedHomeEnv;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeSettingsMirror(settings: SettingsForMirror): void {
    writeFileSync(
      path.join(homeDir, 'settings.json'),
      JSON.stringify(settings),
      'utf8'
    );
    writeFileSync(
      path.join(homeDir, 'workspace-roots.json'),
      JSON.stringify({ roots: [] }),
      'utf8'
    );
  }

  it('passes `--model claude-sonnet-4-6` when the mirror selects sonnet', async () => {
    writeSettingsMirror({
      enabled: true,
      schedulerType: 'chronological',
      chronologicalTime: '04:00',
      periodicInterval: 'Every 4h',
      model: 'claude-sonnet-4-6'
    });

    const code = await runWakeup();
    expect(code).toBe(0);

    const claudeCalls = spawnCalls.filter((c) => c.cmd === 'claude');
    expect(claudeCalls.length).toBe(1);
    expect(claudeCalls[0].args).toContain('--model');
    expect(claudeCalls[0].args).toContain('claude-sonnet-4-6');
    // The existing `'-p', '.'` args MUST still be present.
    expect(claudeCalls[0].args).toContain('-p');
    expect(claudeCalls[0].args).toContain('.');
  });

  it('passes `--model claude-opus-4-7` when the mirror selects opus', async () => {
    writeSettingsMirror({
      enabled: true,
      schedulerType: 'chronological',
      chronologicalTime: '04:00',
      periodicInterval: 'Every 4h',
      model: 'claude-opus-4-7'
    });

    const code = await runWakeup();
    expect(code).toBe(0);

    const claudeCalls = spawnCalls.filter((c) => c.cmd === 'claude');
    expect(claudeCalls.length).toBe(1);
    const args = claudeCalls[0].args;
    const flagIdx = args.indexOf('--model');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(args[flagIdx + 1]).toBe('claude-opus-4-7');
  });

  it('passes `--model claude-haiku-4-6` when the mirror selects haiku', async () => {
    writeSettingsMirror({
      enabled: true,
      schedulerType: 'chronological',
      chronologicalTime: '04:00',
      periodicInterval: 'Every 4h',
      model: 'claude-haiku-4-6'
    });

    const code = await runWakeup();
    expect(code).toBe(0);

    const claudeCalls = spawnCalls.filter((c) => c.cmd === 'claude');
    expect(claudeCalls.length).toBe(1);
    expect(claudeCalls[0].args).toContain('claude-haiku-4-6');
  });

  it('omits `--model` when the mirror selects `runner-default`', async () => {
    writeSettingsMirror({
      enabled: true,
      schedulerType: 'chronological',
      chronologicalTime: '04:00',
      periodicInterval: 'Every 4h',
      model: 'runner-default'
    });

    const code = await runWakeup();
    expect(code).toBe(0);

    const claudeCalls = spawnCalls.filter((c) => c.cmd === 'claude');
    expect(claudeCalls.length).toBe(1);
    expect(claudeCalls[0].args).not.toContain('--model');
  });

  it('omits `--model` for legacy mirrors with no `model` field', async () => {
    // Pre-031 mirror: no `model` key. The runner must treat this as
    // `runner-default` (per coerceWakeUpModel) and emit no flag.
    writeSettingsMirror({
      enabled: true,
      schedulerType: 'chronological',
      chronologicalTime: '04:00',
      periodicInterval: 'Every 4h'
    });

    const code = await runWakeup();
    expect(code).toBe(0);

    const claudeCalls = spawnCalls.filter((c) => c.cmd === 'claude');
    expect(claudeCalls.length).toBe(1);
    expect(claudeCalls[0].args).not.toContain('--model');
  });
});

describe('Feature 031 T017 — unknown model falls back to runner-default', () => {
  let tempRoot: string;
  let homeDir: string;
  let savedHomeEnv: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(realTmpdir(), 'schegent-wakeup-spawn-fallback-'));
    homeDir = path.join(tempRoot, 'wakeup-home');
    mkdirSync(homeDir, { recursive: true });
    savedHomeEnv = process.env.SCHEGENT_WAKEUP_HOME;
    process.env.SCHEGENT_WAKEUP_HOME = homeDir;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    if (savedHomeEnv === undefined) delete process.env.SCHEGENT_WAKEUP_HOME;
    else process.env.SCHEGENT_WAKEUP_HOME = savedHomeEnv;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('omits `--model` when the mirror selects an unknown model AND records the fallback pair on the JSONL', async () => {
    writeFileSync(
      path.join(homeDir, 'settings.json'),
      JSON.stringify({
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 4h',
        model: 'claude-bogus-9000'
      }),
      'utf8'
    );
    writeFileSync(
      path.join(homeDir, 'workspace-roots.json'),
      JSON.stringify({ roots: [] }),
      'utf8'
    );

    const code = await runWakeup();
    expect(code).toBe(0);

    const claudeCalls = spawnCalls.filter((c) => c.cmd === 'claude');
    expect(claudeCalls.length).toBe(1);
    // Unknown models do NOT make it to the CLI — defense-in-depth
    // against a future registry mismatch on the operator side.
    expect(claudeCalls[0].args).not.toContain('--model');
    expect(claudeCalls[0].args).not.toContain('claude-bogus-9000');

    // The JSONL record carries the fallback pair so operators can see
    // their selection was unhonored.
    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records.length).toBe(1);
    expect(records[0].requestedModel).toBe('claude-bogus-9000');
    expect(records[0].actualModel).toBe('runner-default');
  });
});

describe('Feature 031 T017 — JSONL records carry requestedModel/actualModel', () => {
  let tempRoot: string;
  let homeDir: string;
  let savedHomeEnv: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(realTmpdir(), 'schegent-wakeup-spawn-record-'));
    homeDir = path.join(tempRoot, 'wakeup-home');
    mkdirSync(homeDir, { recursive: true });
    savedHomeEnv = process.env.SCHEGENT_WAKEUP_HOME;
    process.env.SCHEGENT_WAKEUP_HOME = homeDir;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    if (savedHomeEnv === undefined) delete process.env.SCHEGENT_WAKEUP_HOME;
    else process.env.SCHEGENT_WAKEUP_HOME = savedHomeEnv;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('records requested=actual when the mirror selects a known model', async () => {
    writeFileSync(
      path.join(homeDir, 'settings.json'),
      JSON.stringify({
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 4h',
        model: 'claude-haiku-4-6'
      }),
      'utf8'
    );
    writeFileSync(
      path.join(homeDir, 'workspace-roots.json'),
      JSON.stringify({ roots: [] }),
      'utf8'
    );

    await runWakeup();

    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records.length).toBe(1);
    expect(records[0].requestedModel).toBe('claude-haiku-4-6');
    expect(records[0].actualModel).toBe('claude-haiku-4-6');
  });

  it('records requested=actual=runner-default for a legacy mirror', async () => {
    writeFileSync(
      path.join(homeDir, 'settings.json'),
      JSON.stringify({
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 4h'
      }),
      'utf8'
    );
    writeFileSync(
      path.join(homeDir, 'workspace-roots.json'),
      JSON.stringify({ roots: [] }),
      'utf8'
    );

    await runWakeup();

    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records.length).toBe(1);
    expect(records[0].requestedModel).toBe('runner-default');
    expect(records[0].actualModel).toBe('runner-default');
  });
});
