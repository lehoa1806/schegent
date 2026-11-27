// FR-R6-F09 T027 -- `SpawnGatedRunner` (contract section 3).
//
// WHAT THIS PINS: `invoke` awaits the gate, then delegates with the same request and sink; a
// refusal leaves the inner runner uncalled, so no child exists; every other member delegates.

import { describe, expect, it, vi } from 'vitest';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import type { SpawnAdmissionRequest, SpawnGate } from '../../../src/contracts/containment-qualification';
import { ContainmentAdmissionRefusedError } from '../../../src/services/containment-qualification/admission-refusal';
import { createSpawnAdmissionGate } from '../../../src/services/containment-qualification/spawn-admission-gate';
import type {
  InvocationOutputSink,
  InvocationRequest,
  RawInvocationOutput
} from '../../../src/runner/invocation-result';
import { SpawnGatedRunner } from '../../../src/runner/spawn-gated-runner';
import { SpawnRefusedAfterCloseError } from '../../../src/runner/spawn-refused-after-close';
import { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import { CodexCliRunner } from '../../../src/runner/codex-cli';
import { AgyCliRunner } from '../../../src/runner/agy-cli';
import { AcpBackedRunner } from '../../../src/runner/acp-backed-runner';

const OUTPUT = { exitCode: 0 } as unknown as RawInvocationOutput;
const REQUEST = { runId: 'run-7', cliPath: '/opt/codex', prompt: 'p' } as unknown as InvocationRequest;

function innerRunner(log: string[]): BackendRunner {
  return {
    get hasActiveProcess() {
      log.push('hasActiveProcess');
      return true;
    },
    availabilityAdapter: undefined,
    invoke: async (request, sink) => {
      log.push(`invoke:${request === REQUEST}:${sink === SINK}`);
      return OUTPUT;
    },
    cancelActive: () => {
      log.push('cancelActive');
      return true;
    },
    close: () => {
      log.push('close');
    },
    settleTeardowns: async (deadline) => {
      log.push(`settleTeardowns:${deadline === DEADLINE}`);
      return [];
    }
  };
}

const SINK = {} as InvocationOutputSink;
const DEADLINE = Promise.resolve();

function gateOf(log: string[], refuse = false): SpawnGate {
  return {
    admit: async (kind, request: SpawnAdmissionRequest) => {
      log.push(`admit:${kind}:${request.runId ?? 'none'}:${request.cliPath}`);
      if (refuse) throw new ContainmentAdmissionRefusedError({ kind, reason: 'containment-unqualified-for-tuple' });
    }
  };
}

describe('FR-R6-F09 T027 -- SpawnGatedRunner', () => {
  it('invoke awaits admission, then delegates the same request and sink', async () => {
    const log: string[] = [];
    const runner = new SpawnGatedRunner('codex', innerRunner(log), gateOf(log));
    await expect(runner.invoke(REQUEST, SINK)).resolves.toBe(OUTPUT);
    expect(log).toEqual(['admit:codex:run-7:/opt/codex', 'invoke:true:true']);
  });

  it('a refusal rejects and leaves the inner runner uncalled', async () => {
    const log: string[] = [];
    const runner = new SpawnGatedRunner('claude', innerRunner(log), gateOf(log, true));
    await expect(runner.invoke(REQUEST, SINK)).rejects.toBeInstanceOf(ContainmentAdmissionRefusedError);
    expect(log).toEqual(['admit:claude:run-7:/opt/codex']);
  });

  it('a request with no Run is admitted with runId absent', async () => {
    const log: string[] = [];
    const runner = new SpawnGatedRunner('agy', innerRunner(log), gateOf(log));
    await runner.invoke({ cliPath: '/opt/agy', prompt: 'p' } as unknown as InvocationRequest);
    expect(log.at(0)).toBe('admit:agy:none:/opt/agy');
  });

  it('every other member delegates unchanged', async () => {
    const log: string[] = [];
    const inner = innerRunner(log);
    const runner = new SpawnGatedRunner('codex', inner, gateOf(log));
    expect(runner.hasActiveProcess).toBe(true);
    expect(runner.cancelActive()).toBe(true);
    runner.close();
    await expect(runner.settleTeardowns(DEADLINE)).resolves.toEqual([]);
    expect(runner.availabilityAdapter).toBe(inner.availabilityAdapter);
    expect(log).toEqual(['hasActiveProcess', 'cancelActive', 'close', 'settleTeardowns:true']);
  });
});

describe('FR-R7-16 (16-14) -- cancel and close before or during awaited admission prevent any spawn', () => {
  it('returns cancelled output immediately with zero gate/inner calls when cancellationSignal is already aborted', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const runner = new SpawnGatedRunner('codex', innerRunner(log), gateOf(log));

    const result = await runner.invoke({
      ...REQUEST,
      cancellationSignal: controller.signal
    });

    expect(result.killed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(log).toEqual([]);
  });

  it('settles cancelled with zero inner spawn when cancellationSignal aborts during a delayed fake admission', async () => {
    const log: string[] = [];
    let releaseAdmit!: () => void;
    const delayedGate: SpawnGate = {
      admit: () =>
        new Promise<void>((resolve) => {
          releaseAdmit = resolve;
        })
    };
    const controller = new AbortController();
    const runner = new SpawnGatedRunner('codex', innerRunner(log), delayedGate);

    const pending = runner.invoke({ ...REQUEST, cancellationSignal: controller.signal });
    controller.abort();
    const result = await pending;
    releaseAdmit();
    await Promise.resolve();

    expect(result.killed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(log).toEqual([]);
  });

  it('settles cancelled with zero inner spawn when cancelActive() is called during a delayed fake admission', async () => {
    const log: string[] = [];
    let rejectAdmit!: (err: Error) => void;
    const delayedGate: SpawnGate = {
      admit: () =>
        new Promise<void>((_resolve, reject) => {
          rejectAdmit = reject;
        })
    };
    const runner = new SpawnGatedRunner('claude', innerRunner(log), delayedGate);

    const pending = runner.invoke(REQUEST);
    expect(runner.cancelActive()).toBe(true);
    const result = await pending;
    // Late rejection after cancellation must not leak an unhandled rejection or invoke inner.
    rejectAdmit(new Error('late failure'));
    await Promise.resolve();

    expect(result.killed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(log).toEqual(['cancelActive']);
  });

  it('throws SpawnRefusedAfterCloseError with zero inner spawn when close() fires before or during delayed admission', async () => {
    const log: string[] = [];
    let releaseAdmit!: () => void;
    const delayedGate: SpawnGate = {
      admit: () =>
        new Promise<void>((resolve) => {
          releaseAdmit = resolve;
        })
    };
    const runner = new SpawnGatedRunner('agy', innerRunner(log), delayedGate);

    const pending = runner.invoke(REQUEST);
    runner.close();
    await expect(pending).rejects.toBeInstanceOf(SpawnRefusedAfterCloseError);
    releaseAdmit();
    await Promise.resolve();

    await expect(runner.invoke(REQUEST)).rejects.toBeInstanceOf(SpawnRefusedAfterCloseError);
    expect(log).toEqual(['close']);
  });

  it('belt-and-suspenders: pre-aborted cancellationSignal prevents spawn in ClaudeCliRunner, CodexCliRunner, AgyCliRunner, and AcpBackedRunner', async () => {
    const spawnSpy = vi.fn(() => {
      throw new Error('must never spawn when already aborted');
    });
    const controller = new AbortController();
    controller.abort();
    const abortedReq: InvocationRequest = {
      phase: 'implement',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: '/usr/bin/fake-cli',
      cwd: '/workspace',
      cancellationSignal: controller.signal
    };

    const claudeRes = await new ClaudeCliRunner(spawnSpy as never).invoke(abortedReq);
    const codexRes = await new CodexCliRunner(spawnSpy as never).invoke(abortedReq);
    const agyRes = await new AgyCliRunner(spawnSpy as never).invoke(abortedReq);
    const innerLog: string[] = [];
    const launchTransport = vi.fn(() => {
      throw new Error('must never launch ACP transport when already aborted');
    });
    const acpRes = await new AcpBackedRunner({
      kind: 'claude',
      inner: innerRunner(innerLog),
      launchTransport
    }).invoke({ ...abortedReq, legacyDrain: true });

    for (const res of [claudeRes, codexRes, agyRes]) {
      expect(res.killed).toBe(true);
      expect(res.exitCode).toBeNull();
    }
    expect(acpRes.killed).toBe(true);
    expect(acpRes.exitCode).toBe(130);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(launchTransport).not.toHaveBeenCalled();
    expect(innerLog).toEqual([]);
  });

  it.each(['signal', 'cancelActive', 'close'] as const)(
    'SR-B8: %s during pending hasPrimacy() performs zero --version probes and zero Memento binding writes',
    async (trigger) => {
      const log: string[] = [];
      let releasePrimacy!: (held: boolean) => void;
      const resolveExecutable = vi.fn(async () => 'resolved' as const);
      const observeVersion = vi.fn(async () => '2.1.302');
      const bind = vi.fn(async () => undefined);
      const gate = createSpawnAdmissionGate({
        isTrusted: () => true,
        hasPrimacy: () =>
          new Promise<boolean>((resolve) => {
            releasePrimacy = resolve;
          }),
        resolveExecutable,
        observeVersion,
        granted: () => new Set(['claude'] as const),
        bindings: { read: () => null, bind },
        platform: { os: 'darwin', arch: 'arm64' },
        environmentPolicyDigest: () => 'a'.repeat(64),
        logger: { warn: () => undefined }
      });

      const controller = new AbortController();
      const runner = new SpawnGatedRunner('claude', innerRunner(log), gate);
      const pending = runner.invoke({
        ...REQUEST,
        cancellationSignal: controller.signal
      });

      if (trigger === 'signal') {
        controller.abort();
        const res = await pending;
        expect(res.killed).toBe(true);
        expect(res.exitCode).toBeNull();
      } else if (trigger === 'cancelActive') {
        expect(runner.cancelActive()).toBe(true);
        const res = await pending;
        expect(res.killed).toBe(true);
        expect(res.exitCode).toBeNull();
      } else {
        runner.close();
        await expect(pending).rejects.toBeInstanceOf(SpawnRefusedAfterCloseError);
      }

      // Now let the pending primacy check resolve and flush continuations.
      releasePrimacy(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(resolveExecutable).not.toHaveBeenCalled();
      expect(observeVersion).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(log.filter((entry) => entry.startsWith('invoke:'))).toEqual([]);
    }
  );

  it.each(['cancelActive', 'close'] as const)(
    'SR-B8: %s during pending observeVersion() aborts before Memento legacy-first-use binding write',
    async (trigger) => {
      const log: string[] = [];
      let releaseVersion!: (version: string | null) => void;
      const observeVersion = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            releaseVersion = resolve;
          })
      );
      const bind = vi.fn(async () => undefined);
      const gate = createSpawnAdmissionGate({
        isTrusted: () => true,
        hasPrimacy: () => true,
        resolveExecutable: async () => 'resolved',
        observeVersion,
        granted: () => new Set(['claude'] as const),
        bindings: { read: () => null, bind },
        platform: { os: 'darwin', arch: 'arm64' },
        environmentPolicyDigest: () => 'a'.repeat(64),
        logger: { warn: () => undefined }
      });

      const runner = new SpawnGatedRunner('claude', innerRunner(log), gate);
      const pending = runner.invoke(REQUEST);
      await Promise.resolve();
      await Promise.resolve();

      if (trigger === 'cancelActive') {
        expect(runner.cancelActive()).toBe(true);
        const res = await pending;
        expect(res.killed).toBe(true);
        expect(res.exitCode).toBeNull();
      } else {
        runner.close();
        await expect(pending).rejects.toBeInstanceOf(SpawnRefusedAfterCloseError);
      }

      releaseVersion('2.1.302');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(observeVersion).toHaveBeenCalledTimes(1);
      expect(bind).not.toHaveBeenCalled();
      expect(log.filter((entry) => entry.startsWith('invoke:'))).toEqual([]);
    }
  );
});
