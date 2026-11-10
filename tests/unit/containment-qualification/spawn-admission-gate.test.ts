// FR-R6-F09 T026 -- the spawn admission gate (contract section 2; research R11).
//
// WHAT THIS PINS:
//   - trust and primacy refuse before any probe starts;
//   - an unresolved executable, an unqualified tuple and a changed fingerprint refuse with the
//     judgement's reason, and nothing starts the version probe for a missing executable;
//   - a `legacy-first-use` binding is written before `admit` resolves;
//   - inside one Run, a backend whose fingerprint changes refuses `configuration-changed-at-spawn`;
//     the check is per backend, and the per-Run map holds at most 256 Runs, oldest evicted;
//   - any other dependency failure is rethrown unchanged and never admits;
//   - every observed identity reaches the identity cache.

import { describe, expect, it } from 'vitest';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import type {
  AcceptanceOrigin,
  BindingInput,
  ExecutableUnresolvedCause,
  FingerprintRecord
} from '../../../src/contracts/containment-qualification';
import { ContainmentAdmissionRefusedError } from '../../../src/services/containment-qualification/admission-refusal';
import { computeFingerprint } from '../../../src/services/containment-qualification/fingerprint';
import { BackendIdentityCache } from '../../../src/services/containment-qualification/identity-cache';
import {
  PER_RUN_FINGERPRINT_CAPACITY,
  createSpawnAdmissionGate,
  type SpawnAdmissionGateDeps
} from '../../../src/services/containment-qualification/spawn-admission-gate';

const ENV_A = 'a'.repeat(64);
const ENV_B = 'b'.repeat(64);
const PLATFORM = { os: 'darwin', arch: 'arm64' } as const;

interface Fakes {
  trusted: boolean;
  primacy: boolean;
  executable: 'resolved' | ExecutableUnresolvedCause;
  version: string | null;
  versionFailure: Error | null;
  granted: BackendRunnerKind[];
  envDigest: string;
  stored: Map<BackendRunnerKind, BindingInput>;
  resolveCalls: number;
  versionCalls: number;
  binds: { kind: BackendRunnerKind; origin: AcceptanceOrigin; settled: boolean }[];
  warnings: string[];
}

function fakes(over: Partial<Fakes> = {}): Fakes {
  return {
    trusted: true,
    primacy: true,
    executable: 'resolved',
    version: 'codex-cli 0.163.0',
    versionFailure: null,
    granted: [],
    envDigest: ENV_A,
    stored: new Map(),
    resolveCalls: 0,
    versionCalls: 0,
    binds: [],
    warnings: [],
    ...over
  };
}

function depsOf(state: Fakes, cache?: BackendIdentityCache): SpawnAdmissionGateDeps {
  return {
    isTrusted: () => state.trusted,
    hasPrimacy: () => state.primacy,
    resolveExecutable: async () => {
      state.resolveCalls += 1;
      return state.executable;
    },
    observeVersion: async () => {
      state.versionCalls += 1;
      if (state.versionFailure !== null) throw state.versionFailure;
      return state.version;
    },
    granted: () => new Set(state.granted),
    bindings: {
      read: (kind) => state.stored.get(kind) ?? null,
      bind: async (kind, fingerprint, origin) => {
        const entry = { kind, origin, settled: false };
        state.binds.push(entry);
        await Promise.resolve();
        state.stored.set(kind, { fingerprint, origin, boundAt: '2026-11-10T00:00:00.000Z' });
        entry.settled = true;
      }
    },
    platform: PLATFORM,
    environmentPolicyDigest: () => state.envDigest,
    ...(cache === undefined ? {} : { identityCache: cache }),
    logger: { warn: (line) => state.warnings.push(line) }
  };
}

async function refusalOf(promise: Promise<void>): Promise<ContainmentAdmissionRefusedError> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  if (!(error instanceof ContainmentAdmissionRefusedError)) throw new Error('expected a containment refusal');
  return error;
}

function fingerprintOf(kind: BackendRunnerKind, versionMinor: string, env = ENV_A): FingerprintRecord {
  return computeFingerprint({ kind, executable: 'resolved', versionMinor, ...PLATFORM, environmentPolicyDigest: env });
}

const REQUEST = { runId: 'run-1', cliPath: '/opt/cli/bin' } as const;

describe('FR-R6-F09 T026 -- trust and primacy come before any probe', () => {
  it('an untrusted workspace refuses workspace-untrusted-at-spawn and starts nothing', async () => {
    const state = fakes({ trusted: false });
    const refusal = await refusalOf(createSpawnAdmissionGate(depsOf(state)).admit('codex', REQUEST));
    expect(refusal.reason).toBe('workspace-untrusted-at-spawn');
    expect(refusal.consentable).toBe(false);
    expect([state.resolveCalls, state.versionCalls]).toEqual([0, 0]);
  });

  it('a window without primacy refuses ownership-lost-at-spawn and starts nothing', async () => {
    const state = fakes({ primacy: false });
    const refusal = await refusalOf(createSpawnAdmissionGate(depsOf(state)).admit('codex', REQUEST));
    expect(refusal.reason).toBe('ownership-lost-at-spawn');
    expect([state.resolveCalls, state.versionCalls]).toEqual([0, 0]);
  });

  it('an asynchronous primacy answer is awaited -- the lock answers with a promise', async () => {
    const state = fakes();
    const gate = createSpawnAdmissionGate({ ...depsOf(state), hasPrimacy: () => Promise.resolve(false) });
    const refusal = await refusalOf(gate.admit('codex', REQUEST));
    expect(refusal.reason).toBe('ownership-lost-at-spawn');
    expect([state.resolveCalls, state.versionCalls]).toEqual([0, 0]);
  });
});

describe('FR-R6-F09 T026 -- the judgement refusals', () => {
  it('an unresolved executable refuses with its cause and skips the version probe', async () => {
    const state = fakes({ executable: 'not-found' });
    const refusal = await refusalOf(createSpawnAdmissionGate(depsOf(state)).admit('codex', REQUEST));
    expect(refusal.reason).toBe('backend-executable-unresolved');
    expect(refusal.executableCause).toBe('not-found');
    expect(state.versionCalls).toBe(0);
  });

  it('an ungranted claude refuses containment-unqualified-for-tuple, consentable, with the fingerprint', async () => {
    const state = fakes({ version: '2.1.302 (Claude Code)' });
    const refusal = await refusalOf(createSpawnAdmissionGate(depsOf(state)).admit('claude', REQUEST));
    expect(refusal.reason).toBe('containment-unqualified-for-tuple');
    expect(refusal.consentable).toBe(true);
    expect(refusal.fingerprintDigest).toBe(fingerprintOf('claude', '2.1').digest);
  });

  it('a granted claude whose binding names another version refuses acceptance-fingerprint-changed', async () => {
    const stored = new Map<BackendRunnerKind, BindingInput>([
      ['claude', { fingerprint: fingerprintOf('claude', '2.0'), origin: 'consent', boundAt: '2026-11-01T00:00:00.000Z' }]
    ]);
    const state = fakes({ version: '2.1.302', granted: ['claude'], stored });
    const refusal = await refusalOf(createSpawnAdmissionGate(depsOf(state)).admit('claude', REQUEST));
    expect(refusal.reason).toBe('acceptance-fingerprint-changed');
    expect(refusal.changedComponent).toBe('version');
    expect(state.binds).toHaveLength(0);
  });

  it('the refusal message carries no path', async () => {
    const state = fakes({ executable: 'not-executable' });
    const refusal = await refusalOf(createSpawnAdmissionGate(depsOf(state)).admit('agy', REQUEST));
    expect(refusal.message.includes(REQUEST.cliPath)).toBe(false);
  });
});

describe('FR-R6-F09 T026 -- admission', () => {
  it('a qualified codex is admitted with no binding write', async () => {
    const state = fakes();
    await expect(createSpawnAdmissionGate(depsOf(state)).admit('codex', REQUEST)).resolves.toBeUndefined();
    expect(state.binds).toHaveLength(0);
  });

  it('a granted claude with no binding is bound legacy-first-use before admit resolves', async () => {
    const state = fakes({ version: '2.1.302', granted: ['claude'] });
    await createSpawnAdmissionGate(depsOf(state)).admit('claude', REQUEST);
    expect(state.binds).toEqual([{ kind: 'claude', origin: 'legacy-first-use', settled: true }]);
  });

  it('a granted claude with an equal binding is admitted and not rebound', async () => {
    const stored = new Map<BackendRunnerKind, BindingInput>([
      ['claude', { fingerprint: fingerprintOf('claude', '2.1'), origin: 'consent', boundAt: '2026-11-01T00:00:00.000Z' }]
    ]);
    const state = fakes({ version: '2.1.302', granted: ['claude'], stored });
    await createSpawnAdmissionGate(depsOf(state)).admit('claude', REQUEST);
    expect(state.binds).toHaveLength(0);
  });
});

describe('FR-R6-F09 T026 -- the per-Run check', () => {
  it('a changed fingerprint inside one Run refuses configuration-changed-at-spawn', async () => {
    const state = fakes();
    const gate = createSpawnAdmissionGate(depsOf(state));
    await gate.admit('codex', REQUEST);
    state.envDigest = ENV_B;
    const refusal = await refusalOf(gate.admit('codex', REQUEST));
    expect(refusal.reason).toBe('configuration-changed-at-spawn');
    expect(refusal.consentable).toBe(false);
    await expect(gate.admit('codex', { ...REQUEST, runId: 'run-2' })).resolves.toBeUndefined();
  });

  it('a no-claim backend whose version starts or stops reading inside one Run is not refused (review R2, FR-013)', async () => {
    const state = fakes({ granted: ['claude'], version: null });
    const gate = createSpawnAdmissionGate(depsOf(state));
    await gate.admit('claude', REQUEST);
    state.version = '2.1.302';
    await expect(gate.admit('claude', REQUEST)).resolves.toBeUndefined();
    state.version = null;
    await expect(gate.admit('claude', REQUEST)).resolves.toBeUndefined();
    expect(state.binds.map((entry) => entry.origin)).toEqual(['legacy-first-use', 'legacy-first-use']);
    const bound = state.stored.get('claude');
    if (bound === undefined || bound === null || bound === 'future-schema') throw new Error('expected a binding');
    expect(bound.fingerprint.components.version).toBe('2.1');
  });

  it('a no-claim backend still refuses a changed environment once its version reads', async () => {
    const state = fakes({ granted: ['claude'], version: null });
    const gate = createSpawnAdmissionGate(depsOf(state));
    await gate.admit('claude', REQUEST);
    state.version = '2.1.302';
    state.envDigest = ENV_B;
    const refusal = await refusalOf(gate.admit('claude', REQUEST));
    expect(refusal.reason).toBe('acceptance-fingerprint-changed');
    expect(refusal.changedComponent).toBe('environment-policy');
  });

  it('a codex version that first reads inside one Run still refuses configuration-changed-at-spawn', async () => {
    const state = fakes({ granted: ['codex'], version: null });
    const gate = createSpawnAdmissionGate(depsOf(state));
    await gate.admit('codex', REQUEST);
    state.version = 'codex-cli 0.163.0';
    const refusal = await refusalOf(gate.admit('codex', REQUEST));
    expect(refusal.reason).toBe('configuration-changed-at-spawn');
  });

  it('two backends in one Run are judged apart', async () => {
    const state = fakes({ granted: ['claude'] });
    const gate = createSpawnAdmissionGate(depsOf(state));
    await gate.admit('codex', REQUEST);
    state.version = '2.1.302';
    await expect(gate.admit('claude', REQUEST)).resolves.toBeUndefined();
  });

  it('a spawn outside a Run is never held to a per-Run fingerprint', async () => {
    const state = fakes();
    const gate = createSpawnAdmissionGate(depsOf(state));
    await gate.admit('codex', { runId: undefined, cliPath: REQUEST.cliPath });
    state.envDigest = ENV_B;
    await expect(gate.admit('codex', { runId: undefined, cliPath: REQUEST.cliPath })).resolves.toBeUndefined();
  });

  it(`holds at most ${PER_RUN_FINGERPRINT_CAPACITY} Runs, oldest evicted`, async () => {
    const state = fakes();
    const gate = createSpawnAdmissionGate(depsOf(state));
    for (let index = 0; index <= PER_RUN_FINGERPRINT_CAPACITY; index += 1) {
      await gate.admit('codex', { runId: `run-${index}`, cliPath: REQUEST.cliPath });
    }
    state.envDigest = ENV_B;
    await expect(gate.admit('codex', { runId: 'run-0', cliPath: REQUEST.cliPath })).resolves.toBeUndefined();
    const refusal = await refusalOf(
      gate.admit('codex', { runId: `run-${PER_RUN_FINGERPRINT_CAPACITY}`, cliPath: REQUEST.cliPath })
    );
    expect(refusal.reason).toBe('configuration-changed-at-spawn');
  });
});

describe('FR-R6-F09 T026 -- failures and the identity cache', () => {
  it('a dependency failure other than a refusal is rethrown unchanged and never admits', async () => {
    const failure = new Error('probe crashed');
    const state = fakes({ versionFailure: failure });
    await expect(createSpawnAdmissionGate(depsOf(state)).admit('codex', REQUEST)).rejects.toBe(failure);
  });

  it('a bind failure is rethrown unchanged', async () => {
    const failure = new Error('memento unavailable');
    const state = fakes({ version: '2.1.302', granted: ['claude'] });
    const deps = depsOf(state);
    const gate = createSpawnAdmissionGate({
      ...deps,
      bindings: { read: deps.bindings.read, bind: async () => Promise.reject(failure) }
    });
    await expect(gate.admit('claude', REQUEST)).rejects.toBe(failure);
  });

  it('each observed identity reaches the cache, refused or admitted', async () => {
    const cache = new BackendIdentityCache();
    const state = fakes({ executable: 'not-executable' });
    await refusalOf(createSpawnAdmissionGate(depsOf(state, cache)).admit('agy', REQUEST));
    expect(cache.read('agy')).toEqual({
      kind: 'agy',
      executable: 'not-executable',
      versionMinor: null,
      ...PLATFORM,
      environmentPolicyDigest: ENV_A
    });
    state.executable = 'resolved';
    await createSpawnAdmissionGate(depsOf(state, cache)).admit('codex', REQUEST);
    expect(cache.read('codex')?.versionMinor).toBe('0.163');
  });

  it('trust and primacy refusals leave the cache untouched', async () => {
    const cache = new BackendIdentityCache();
    await refusalOf(createSpawnAdmissionGate(depsOf(fakes({ trusted: false }), cache)).admit('codex', REQUEST));
    expect(cache.read('codex')).toBeNull();
  });
});
