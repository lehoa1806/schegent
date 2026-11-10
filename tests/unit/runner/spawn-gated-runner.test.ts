// FR-R6-F09 T027 -- `SpawnGatedRunner` (contract section 3).
//
// WHAT THIS PINS: `invoke` awaits the gate, then delegates with the same request and sink; a
// refusal leaves the inner runner uncalled, so no child exists; every other member delegates.

import { describe, expect, it } from 'vitest';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import type { SpawnAdmissionRequest, SpawnGate } from '../../../src/contracts/containment-qualification';
import { ContainmentAdmissionRefusedError } from '../../../src/services/containment-qualification/admission-refusal';
import type {
  InvocationOutputSink,
  InvocationRequest,
  RawInvocationOutput
} from '../../../src/runner/invocation-result';
import { SpawnGatedRunner } from '../../../src/runner/spawn-gated-runner';

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
