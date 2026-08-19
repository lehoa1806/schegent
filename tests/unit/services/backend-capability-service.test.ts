import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKEND_PROBE_OUTPUT_CAP_BYTES,
  BackendCapabilityService,
  DEFAULT_BACKEND_PROBE_TIMEOUT_SECONDS,
  normalizeBackendProbeTimeoutSeconds,
  parseAgyModels
} from '../../../src/services/backend-capability-service';
import type { BackendRunnerKind } from '../../../src/runner/backend-runner-factory';

interface FakeChild extends ChildProcess {
  readonly kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    stdio: [],
    pid: 123,
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    kill: vi.fn(() => true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn()
  });
  return child;
}

function emitClose(child: FakeChild, code: number): void {
  Object.defineProperty(child, 'exitCode', { value: code, configurable: true });
  child.emit('close', code, null);
}

function makeService(input: {
  spawnFn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  backendKinds?: readonly BackendRunnerKind[];
  timeoutSeconds?: unknown;
  onDidChange?: () => void;
}): BackendCapabilityService {
  return new BackendCapabilityService({
    cwd: '/workspace/project',
    resolveCliPath: (kind) => `/configured/${kind}`,
    readTimeoutSeconds: () => input.timeoutSeconds ?? 5,
    buildEnv: () => ({ PATH: '/safe/bin', SCHEGENT_PHASE: 'runner-probe' }),
    logger: { debug: vi.fn(), warn: vi.fn() },
    spawnFn: input.spawnFn,
    backendKinds: input.backendKinds,
    onDidChange: input.onDidChange
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BackendCapabilityService', () => {
  it('normalizes the public 1..30 second timeout setting', () => {
    expect(normalizeBackendProbeTimeoutSeconds(1)).toBe(1);
    expect(normalizeBackendProbeTimeoutSeconds(30)).toBe(30);
    for (const value of [0, 31, 1.5, Number.NaN, '5', null, undefined]) {
      expect(normalizeBackendProbeTimeoutSeconds(value)).toBe(
        DEFAULT_BACKEND_PROBE_TIMEOUT_SECONDS
      );
    }
  });

  it('probes with shell disabled, bounded context, and publishes Agy models in unique CLI order', async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const spawnFn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, args, options });
      const child = makeChild();
      queueMicrotask(() => {
        if (args[0] === 'models') {
          (child.stdout as PassThrough).write(' model-z \nmodel-a\nmodel-z\n\n');
        }
        emitClose(child, 0);
      });
      return child;
    });
    const onDidChange = vi.fn();
    const service = makeService({ spawnFn, backendKinds: ['agy'], onDidChange });

    const snapshot = await service.scan();

    expect(snapshot.availableBackends).toEqual(['agy']);
    expect(snapshot.availableModels.agy).toEqual(['model-z', 'model-a']);
    expect(snapshot.availableModels.claude).toEqual([]);
    expect(snapshot.availableModels.codex).toEqual([]);
    expect(onDidChange).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe('/configured/agy');
      expect(call.options).toMatchObject({
        cwd: '/workspace/project',
        shell: false,
        windowsHide: true,
        env: { PATH: '/safe/bin', SCHEGENT_PHASE: 'runner-probe' }
      });
    }
  });

  // Neither CLI can enumerate models: `claude` and `codex` expose no
  // model-listing subcommand (only a `--model` that TAKES a value), so the
  // lists this service used to publish for them were code-resident
  // constants, not discovered facts. Publishing an invented list is worse
  // than publishing none — it drove the Models editor's seed and the
  // `modelAvailable` advisory, both of which then disagreed with the
  // operator's actual `schegent.models` catalog. Availability is still
  // probed for both; only the model list is empty.
  it('reports no models for Claude and Codex, which cannot enumerate them', async () => {
    const spawnFn = vi.fn(() => {
      const child = makeChild();
      queueMicrotask(() => emitClose(child, 0));
      return child;
    });
    const service = makeService({ spawnFn, backendKinds: ['claude', 'codex'] });

    const snapshot = await service.scan();

    expect(snapshot.availableModels.claude).toEqual([]);
    expect(snapshot.availableModels.codex).toEqual([]);
    // Availability is unaffected — both probed and both answered.
    expect(snapshot.availableBackends).toEqual(['claude', 'codex']);
  });

  it('never spawns a model-enumeration command for Claude or Codex', async () => {
    const calls: Array<readonly string[]> = [];
    const spawnFn = vi.fn((_command: string, args: readonly string[]) => {
      calls.push(args);
      const child = makeChild();
      queueMicrotask(() => emitClose(child, 0));
      return child;
    });
    const service = makeService({ spawnFn, backendKinds: ['claude', 'codex'] });

    await service.scan();

    expect(calls).toEqual([['--help'], ['--help']]);
  });

  it('projects unavailable backends with an empty model list', async () => {
    const spawnFn = vi.fn(() => {
      const child = makeChild();
      queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
      return child;
    });
    const service = makeService({ spawnFn, backendKinds: ['agy'] });

    const snapshot = await service.scan();

    expect(snapshot.availableBackends).toEqual([]);
    expect(snapshot.availableModels.agy).toEqual([]);
  });

  it.each([
    ['ENOENT', 'not-found'],
    ['EACCES', 'not-executable'],
    ['EPERM', 'not-executable'],
    ['OTHER', 'unknown']
  ] as const)('classifies spawn error %s as %s without exposing details', async (code, cause) => {
    const service = makeService({
      spawnFn: () => {
        throw Object.assign(new Error('/secret/operator/path'), { code });
      },
      backendKinds: ['claude']
    });

    await expect(service.probe('claude')).resolves.toEqual({
      runner: 'claude',
      available: false,
      cause
    });
  });

  it('classifies a numeric failing exit without retaining process output', async () => {
    const service = makeService({
      spawnFn: () => {
        const child = makeChild();
        queueMicrotask(() => {
          (child.stderr as PassThrough).write('token=secret /operator/path');
          emitClose(child, 23);
        });
        return child;
      },
      backendKinds: ['claude']
    });

    await expect(service.probe('claude')).resolves.toEqual({
      runner: 'claude',
      available: false,
      cause: 'non-zero-exit',
      exitCode: 23
    });
  });

  it('publishes only the newest overlapping scan generation', async () => {
    const children: FakeChild[] = [];
    const spawnFn = vi.fn(() => {
      const child = makeChild();
      children.push(child);
      return child;
    });
    const service = makeService({ spawnFn, backendKinds: ['claude'] });

    const first = service.scan();
    const second = service.scan();
    expect(children).toHaveLength(2);

    emitClose(children[1], 0);
    const secondSnapshot = await second;
    children[0].emit('error', new Error('late failure'));
    await first;

    expect(secondSnapshot.generation).toBe(2);
    expect(service.getSnapshot().generation).toBe(2);
    expect(service.getAvailableBackends()).toEqual(['claude']);
  });

  it('returns at the configured timeout and escalates TERM to KILL', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const service = makeService({
      spawnFn: () => child,
      backendKinds: ['claude'],
      timeoutSeconds: 1
    });

    const result = service.probeAvailability('claude');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    service.dispose();
  });

  it('caps retained model output at 64 KiB without inventing an Agy fallback model', async () => {
    const spawnFn = vi.fn((_command: string, args: readonly string[]) => {
      const child = makeChild();
      queueMicrotask(() => {
        if (args[0] === 'models') {
          (child.stdout as PassThrough).write('x'.repeat(BACKEND_PROBE_OUTPUT_CAP_BYTES + 1));
          (child.stdout as PassThrough).write('\nmodel-after-cap\n');
        }
        emitClose(child, 0);
      });
      return child;
    });
    const service = makeService({ spawnFn, backendKinds: ['agy'] });

    const snapshot = await service.scan();

    expect(snapshot.availableModels.agy).toEqual([]);
  });
});

describe('parseAgyModels', () => {
  it('drops blanks, duplicates, and identifiers over 128 chars and caps the list at 200', () => {
    const input = [
      'first',
      '',
      'first',
      'x'.repeat(129),
      ...Array.from({ length: 220 }, (_, index) => `model-${index}`)
    ].join('\n');

    const models = parseAgyModels(input);

    expect(models).toHaveLength(200);
    expect(models.slice(0, 3)).toEqual(['first', 'model-0', 'model-1']);
    expect(models).not.toContain('x'.repeat(129));
    expect(Object.isFrozen(models)).toBe(true);
  });

  // `agy models` writes `<id>\t<Display Name>` rows, so keeping the whole
  // line made every detected id unusable — it could never match a model an
  // operator or a Phase actually names.
  it('takes the id from a tab-separated id/display-name row', () => {
    const models = parseAgyModels(
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)'
    );

    expect(models).toEqual(['gemini-3.7-flash-high', 'claude-sonnet-4-6']);
  });

  // The same command prints a status line to stdout before the rows. A model
  // id carries no whitespace, which is what separates a row from prose —
  // and is why the id is taken before the length and duplicate guards run.
  it('drops the status line the command prints before its rows', () => {
    const models = parseAgyModels(
      'Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)'
    );

    expect(models).toEqual(['gemini-3.1-pro-high']);
  });

  it('deduplicates on the extracted id, not on the whole row', () => {
    const models = parseAgyModels('a-model\tFirst Label\na-model\tSecond Label');

    expect(models).toEqual(['a-model']);
  });

  it('reads a recorded `agy models` transcript to exactly its model ids', () => {
    const transcript = [
      'Fetching available models...',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
      ''
    ].join('\n');

    expect(parseAgyModels(transcript)).toEqual([
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-medium',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium'
    ]);
  });
});
