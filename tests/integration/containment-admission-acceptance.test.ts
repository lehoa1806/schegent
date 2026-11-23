// FR-R6-F09 T036 & FR-R7-16 (16-15, 16-17) -- containment admission acceptance (F09-AC-01..08).
//
// WHAT THIS DRIVES. The composition the window ships: `wireContainmentAdmission` with the real
// executable resolution and the real `--version` probe, spawning fake CLIs written under the
// vitest temp root (inside `repo/.tmp`), behind the `SpawnGatedRunner` every runner is wrapped in.
// Trust, primacy and the grant set are fakes the test flips; the acceptance bindings live in an
// in-memory memento. Platform cells the host cannot be are driven through the gate and the
// headless inspection with an explicit platform.
//
// ISOLATION (16-17). Zero shared module-level surface buffer exists: `F09-AC-04` is completely
// self-contained and reproducible when executed alone (`-t "F09-AC-04"`), exercising every
// contracted refusal reason, unresolved cause, binding origin/error path, inspection, sidebar
// projection, teardown payload, version/audit projection, and ACP authority receipt surface.
//
// WHAT IS NOT HERE.
//   - NFR-001's p95 is a wall-clock budget, so it lives in the perf tier
//     (`tests/perf/containment-admission-latency.test.ts`), per FR-R3-042: no timing assertion in
//     the hermetic host suite.
//   - F09-AC-01's "the document and the record are equal" is the parity lint's job
//     (`tests/lint/containment-qualification-parity.test.ts`).
//   - F09-AC-03's fixture run needs the real codex CLI; it was run once (research R5) and its
//     result is the evidence matrix. This file pins what that evidence says and leaves unclaimed.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildHostAcpDispatchOptions } from '../../src/activation/acp-execution-wiring';
import { wireContainmentAdmission } from '../../src/activation/containment-admission-wiring';
import { projectAuditPayload } from '../../src/audit/audit-payload';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { BackendRunner, TreeTeardownOutcome, TreeTeardownResult } from '../../src/contracts/backend-runner';
import {
  ACCEPTANCE_BINDINGS_KEY,
  ACCEPTANCE_BINDINGS_MAX_BYTES,
  ACCEPTANCE_ORIGINS,
  CONTAINMENT_REFUSAL_REASONS,
  EXECUTABLE_UNRESOLVED_CAUSES,
  TEARDOWN_OUTCOMES,
  type AcceptanceBinding,
  type BackendIdentity,
  type SpawnGate
} from '../../src/contracts/containment-qualification';
import {
  SHIPPED_DEFAULT_POLICY,
  type ProcessEnvironmentPolicy
} from '../../src/contracts/process-environment-policy';
import { recordTeardownEvidence } from '../../src/controller/host-teardown-recorder';
import {
  InvalidInspectionInputError,
  inspectBackendQualification
} from '../../src/headless/backend-qualification-api';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import {
  CLI_VERSION_MAX_OUTPUT_BYTES,
  CLI_VERSION_TIMEOUT_MS,
  cliVersionFields,
  createCliVersionProbe
} from '../../src/runner/cli-version-probe';
import type { InvocationRequest, RawInvocationOutput } from '../../src/runner/invocation-result';
import { SpawnGatedRunner } from '../../src/runner/spawn-gated-runner';
import type { AcpStdioTransport } from '../../src/services/acp-runtime/stdio-transport';
import type { AcceptanceMementoPort } from '../../src/services/containment-qualification/acceptance-bindings';
import {
  AcceptanceBindingStore,
  AcceptanceBindingsFutureSchemaError
} from '../../src/services/containment-qualification/acceptance-bindings';
import { AcpAuthorityGate } from '../../src/services/containment-qualification/acp-authority-gate';
import { ContainmentAdmissionRefusedError } from '../../src/services/containment-qualification/admission-refusal';
import {
  computeFingerprint,
  environmentPolicyDigestOf
} from '../../src/services/containment-qualification/fingerprint';
import { createSpawnAdmissionGate } from '../../src/services/containment-qualification/spawn-admission-gate';
import type { WorkspaceStateStore } from '../../src/state/workspace-state';
import { projectBackendQualification } from '../../src/ui/sidebar/backend-qualification-projection';

const SEEDED_ENV_NAME = 'SCHEGENT_F09_SEEDED_CREDENTIAL';
/** Built at run time so no literal credential-shaped string is tracked. Letters only: no version. */
const SEEDED_SECRET = `fakecred${randomBytes(12).toString('hex').replace(/[0-9]/g, 'q')}`;
const VERSION_TTL_PAST_MS = 11 * 60 * 1000;
const OVERSIZED_OUTPUT_BYTES = CLI_VERSION_MAX_OUTPUT_BYTES + 6 * 1024;
const CONCURRENT_ADMISSIONS = 20;
const SEEDED_POLICY: ProcessEnvironmentPolicy = Object.freeze({
  mode: 'allowlist',
  inheritProcessEnv: false,
  processEnvAllowlist: Object.freeze([SEEDED_ENV_NAME])
});

class InMemoryMemento implements AcceptanceMementoPort {
  private readonly values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  serialized(): string {
    return JSON.stringify([...this.values]);
  }
}

let root = '';
let previousSeeded: string | undefined;

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A fake CLI: counts its probes in `counter`, then prints `output` as its `--version` answer. */
async function writeFakeCli(name: string, output: string, counter: string): Promise<string> {
  const path = join(root, name);
  const script = ['#!/bin/sh', `echo probed >> ${shellQuote(counter)}`, `printf '%s\\n' ${shellQuote(output)}`, ''];
  await writeFile(path, script.join('\n'), 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function probeCount(counter: string): Promise<number> {
  const text = await readFile(counter, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.length > 0).length;
}

function refusalSurface(error: ContainmentAdmissionRefusedError): string {
  return JSON.stringify({
    message: error.message,
    reason: error.reason,
    consentable: error.consentable,
    fingerprint: error.fingerprint,
    changedComponent: error.changedComponent,
    cause: error.executableCause
  });
}

async function refusalOf(attempt: Promise<unknown>): Promise<ContainmentAdmissionRefusedError> {
  const error = await attempt.then(
    () => undefined,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(ContainmentAdmissionRefusedError);
  return error as ContainmentAdmissionRefusedError;
}

function harness(policy: ProcessEnvironmentPolicy = SHIPPED_DEFAULT_POLICY) {
  const memento = new InMemoryMemento();
  const warnings: string[] = [];
  const state = { trusted: true, primacy: true, granted: new Set<BackendRunnerKind>(), clockMs: 0 };
  const probe = createCliVersionProbe({ monotonicNow: () => state.clockMs, environmentPolicy: () => policy });
  const wiring = wireContainmentAdmission({
    memento,
    logger: { warn: (line) => void warnings.push(line) },
    isTrusted: () => state.trusted,
    hasPrimacy: async () => state.primacy,
    environmentPolicy: policy,
    granted: () => state.granted,
    observeVersion: (cliPath) => probe.observe(cliPath)
  });
  const invoked: string[] = [];
  const inner: BackendRunner = {
    hasActiveProcess: false,
    availabilityAdapter: undefined,
    invoke: async (request) => {
      invoked.push(request.runId ?? 'none');
      return { exitCode: 0 } as unknown as RawInvocationOutput;
    },
    cancelActive: () => false,
    close: () => undefined,
    settleTeardowns: async () => []
  };
  const runner = (kind: BackendRunnerKind) => new SpawnGatedRunner(kind, inner, wiring.spawnGate);
  const request = (cliPath: string, runId?: string) =>
    ({ runId, cliPath, prompt: 'p' }) as unknown as InvocationRequest;
  return { memento, warnings, state, probe, wiring, invoked, runner, request };
}

function identity(over: Partial<BackendIdentity> = {}): BackendIdentity {
  return {
    kind: 'codex',
    executable: 'resolved',
    versionMinor: '0.163',
    os: 'darwin',
    arch: 'arm64',
    environmentPolicyDigest: environmentPolicyDigestOf(SHIPPED_DEFAULT_POLICY),
    ...over
  };
}

function inspect(identities: readonly BackendIdentity[], granted: readonly BackendRunnerKind[] = []) {
  return inspectBackendQualification({ identities, granted, bindings: {} });
}

/** A gate with a platform the host is not, for the cells this machine cannot be. */
function platformGate(platform: { os: string; arch: string }, envDigest: { value: string }): SpawnGate {
  const store = new AcceptanceBindingStore(new InMemoryMemento(), { warn: () => undefined });
  return createSpawnAdmissionGate({
    isTrusted: () => true,
    hasPrimacy: () => true,
    resolveExecutable: async () => 'resolved',
    observeVersion: async () => 'codex-cli 0.163.0',
    granted: () => new Set(),
    bindings: store,
    platform,
    environmentPolicyDigest: () => envDigest.value,
    logger: { warn: () => undefined }
  });
}

function createFakeAcpTransport(hooks: {
  onSessionNew?: () => void;
  onPrompt?: () => void;
} = {}): AcpStdioTransport {
  const stdoutListeners: Array<(chunk: Uint8Array) => void> = [];
  const closeListeners: Array<() => void> = [];
  let closed = false;
  const emit = (obj: unknown): void => {
    const bytes = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
    queueMicrotask(() => {
      for (const listener of stdoutListeners) listener(bytes);
    });
  };
  return {
    pid: undefined,
    write(line: string): void {
      const msg = JSON.parse(line.trim()) as { id?: number; method?: string };
      if (msg.method === 'initialize') {
        emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'agy-fake', version: '1.5.5' },
            agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
          }
        });
      } else if (msg.method === 'session/new') {
        hooks.onSessionNew?.();
        emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-f09-001' } });
      } else if (msg.method === 'session/prompt') {
        hooks.onPrompt?.();
        emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    },
    onStdout(listener) {
      stdoutListeners.push(listener);
    },
    onStderr() {
      // noop
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    async close() {
      if (!closed) {
        closed = true;
        for (const listener of closeListeners) listener();
      }
    },
    isProcessTreeGone: () => true
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'f09-acceptance-'));
  previousSeeded = process.env[SEEDED_ENV_NAME];
  process.env[SEEDED_ENV_NAME] = SEEDED_SECRET;
});

afterAll(async () => {
  if (previousSeeded === undefined) delete process.env[SEEDED_ENV_NAME];
  else process.env[SEEDED_ENV_NAME] = previousSeeded;
  await rm(root, { recursive: true, force: true });
});

describe('FR-R6-F09 T036 -- containment admission acceptance', () => {
  it('F09-AC-01 -- observed, help-only, stale and no-claim cells have distinct outcomes', () => {
    const [observed, stale, helpOnly, noClaim] = inspect([
      identity(),
      identity({ versionMinor: '0.164' }),
      identity({ os: 'linux', arch: 'x64' }),
      identity({ kind: 'claude', versionMinor: '2.1' })
    ]);
    const cell = (entry: typeof observed, effect: string) => entry.record.effects.find((e) => e.effect === effect);

    expect(observed.record.qualified).toBe(true);
    expect(cell(observed, 'fs-write')).toMatchObject({ outcome: 'observed-enforced', basis: 'observed-behavior' });
    expect(stale.record.qualified).toBe(false);
    expect(cell(stale, 'fs-write')?.outcome).toBe('stale');
    expect(helpOnly.record.qualified).toBe(false);
    expect(cell(helpOnly, 'fs-write')).toMatchObject({ outcome: 'unverified', basis: 'help-syntax' });
    expect(noClaim.record).toMatchObject({ qualified: false, key: { mechanism: 'none' } });
    for (const entry of [helpOnly, noClaim]) {
      expect(entry.record.effects.some((e) => e.outcome === 'observed-enforced' && e.basis !== 'observed-behavior')).toBe(false);
    }
  });

  it('F09-AC-01 -- the wired gate observes a real fake CLI and refuses an unqualified version', async () => {
    const h = harness();
    const counter = join(root, 'ac01.count');
    const cli = await writeFakeCli('codex-ac01', 'codex-cli 0.170.0', counter);

    const refusal = await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-ac01')));

    expect(refusal).toMatchObject({ reason: 'containment-unqualified-for-tuple', consentable: true });
    expect(h.invoked).toEqual([]);
    expect(h.wiring.qualification.identityOf('codex')).toMatchObject({ executable: 'resolved', versionMinor: '0.170' });
  });

  it('F09-AC-02 -- revoked trust and lost ownership refuse before any probe or child starts', async () => {
    const h = harness();
    const counter = join(root, 'ac02-race.count');
    const cli = await writeFakeCli('codex-ac02-race', 'codex-cli 0.170.0', counter);
    h.state.granted.add('codex');

    h.state.trusted = false;
    expect((await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-a')))).reason).toBe('workspace-untrusted-at-spawn');
    h.state.trusted = true;
    h.state.primacy = false;
    expect((await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-a')))).reason).toBe('ownership-lost-at-spawn');

    expect(await probeCount(counter)).toBe(0);
    expect(h.invoked).toEqual([]);
  });

  it('F09-AC-02 -- deny precedence: an untrusted workspace refuses for trust, never for qualification', async () => {
    const h = harness();
    const cli = await writeFakeCli('codex-ac02-precedence', 'codex-cli 0.170.0', join(root, 'ac02-p.count'));
    h.state.trusted = false;
    h.state.primacy = false;

    const refusal = await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-p')));

    expect(refusal).toMatchObject({ reason: 'workspace-untrusted-at-spawn', consentable: false });
  });

  it('F09-AC-02 -- an acceptance admits its fingerprint only; a changed version refuses at the UI and headless entries', async () => {
    const h = harness();
    const counter = join(root, 'ac02-accept.count');
    const cli = await writeFakeCli('codex-ac02-accept', 'codex-cli 0.170.0', counter);

    const first = await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-1')));
    expect(first.fingerprint).toBeDefined();
    h.state.granted.add('codex');
    await h.wiring.recordAcceptance('codex', first.fingerprint as NonNullable<typeof first.fingerprint>);
    await h.runner('codex').invoke(h.request(cli, 'run-1'));
    expect(h.invoked).toEqual(['run-1']);
    expect(h.wiring.qualification.bindingOf('codex')).toMatchObject({ origin: 'consent' });

    await writeFakeCli('codex-ac02-accept', 'codex-cli 0.171.0', counter);
    h.state.clockMs += VERSION_TTL_PAST_MS;
    const changed = await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-2')));
    expect(changed).toMatchObject({ reason: 'acceptance-fingerprint-changed', changedComponent: 'version', consentable: true });
    expect(h.invoked).toEqual(['run-1']);

    const observed = h.wiring.qualification.identityOf('codex') as BackendIdentity;
    const binding = h.wiring.qualification.bindingOf('codex') as AcceptanceBinding;
    const [headless] = inspectBackendQualification({ identities: [observed], granted: ['codex'], bindings: { codex: binding } });
    expect(headless.admission).toMatchObject({ outcome: 'refused', reason: 'acceptance-fingerprint-changed' });
  });

  it('F09-AC-02 -- inside one Run a backend whose configuration changes refuses; a new Run admits', async () => {
    const envDigest = { value: environmentPolicyDigestOf(SHIPPED_DEFAULT_POLICY) };
    const gate = platformGate({ os: 'darwin', arch: 'arm64' }, envDigest);
    await gate.admit('codex', { runId: 'run-x', cliPath: 'codex' });

    envDigest.value = environmentPolicyDigestOf(SEEDED_POLICY);
    const refusal = await refusalOf(gate.admit('codex', { runId: 'run-x', cliPath: 'codex' }));

    expect(refusal).toMatchObject({ reason: 'configuration-changed-at-spawn', consentable: false });
    await expect(gate.admit('codex', { runId: 'run-y', cliPath: 'codex' })).resolves.toBeUndefined();
  });

  it('F09-AC-03 -- the observed fs-write and network cells name what was exercised and what was not', () => {
    const [entry] = inspect([identity()]);
    const cell = (effect: string) => entry.record.effects.find((e) => e.effect === effect);

    expect(cell('fs-write')).toMatchObject({ components: ['shell-child'], observedAt: expect.any(String) });
    expect(cell('fs-write')?.residuals).toEqual(
      expect.arrayContaining(['file-tool-unobserved', 'hook-unobserved', 'external-tool-unobserved'])
    );
    expect(cell('network')?.residuals).toEqual(expect.arrayContaining(['no-filtering-claimed', 'dns-unobserved']));
    expect(cell('process-creation')?.outcome).toBe('unsupported');
    expect(cell('credential-exposure')?.outcome).toBe('unsupported');
  });

  it('F09-AC-05 -- recorded teardown rows name a residual or unanswerable; none reads as a release', async () => {
    const appended: { payload: Record<string, unknown> }[] = [];
    const results: TreeTeardownResult[] = ['group-gone', 'tree-unconfirmed', 'bound-elapsed', 'platform-unanswerable'];
    const outcomes: TreeTeardownOutcome[] = results.map((result, index) => ({
      attribution: { runId: 'run-t', phase: 'speckit-implement', iteration: 1 },
      runner: 'codex-cli',
      pid: 5000 + index,
      result
    }));
    await recordTeardownEvidence(
      { outcomes, boundMs: 2_750, elapsedMs: 3_000 },
      {
        treeRecorder: { settled: async () => undefined },
        append: async (entry) => void appended.push({ payload: entry.payload as Record<string, unknown> }),
        logger: { warn: () => undefined }
      }
    );

    expect(appended.map((row) => [row.payload['result'], row.payload['teardownOutcome'], row.payload['residuals']])).toEqual([
      ['bound-elapsed', 'residual', ['bound-elapsed']],
      ['platform-unanswerable', 'unanswerable', []]
    ]);
    expect(TEARDOWN_OUTCOMES.some((word) => /releas|redispatch|clear/i.test(word))).toBe(false);
  });

  it('F09-AC-06 -- concurrent admissions share one probe; the probe is bounded at 5 s and 64 KiB', async () => {
    const h = harness();
    const counter = join(root, 'ac06.count');
    const cli = await writeFakeCli('codex-ac06', 'codex-cli 0.170.0', counter);
    h.state.granted.add('codex');

    const admissions = Array.from({ length: CONCURRENT_ADMISSIONS }, (_, index) =>
      h.runner('codex').invoke(h.request(cli, `run-c${String(index)}`))
    );
    await Promise.all(admissions);
    await h.runner('codex').invoke(h.request(cli, 'run-after'));

    expect(await probeCount(counter)).toBe(1);
    expect(h.invoked).toHaveLength(CONCURRENT_ADMISSIONS + 1);
    expect(CLI_VERSION_TIMEOUT_MS).toBe(5_000);
    expect(CLI_VERSION_MAX_OUTPUT_BYTES).toBe(64 * 1024);
  });

  it('F09-AC-06 -- an answer past the output cap is unverified, never truncated into a version', async () => {
    const h = harness();
    const counter = join(root, 'ac06-cap.count');
    const oversized = `${'x'.repeat(OVERSIZED_OUTPUT_BYTES)} codex-cli 0.163.0`;
    const cli = await writeFakeCli('codex-ac06-cap', oversized, counter);

    const refusal = await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-cap')));

    expect(refusal.reason).toBe('containment-unqualified-for-tuple');
    expect(h.wiring.qualification.identityOf('codex')).toMatchObject({ versionMinor: null });
  });

  it('F09-AC-07 -- linux, windows and darwin/x64 refuse codex without acceptance; darwin/arm64 admits', async () => {
    const envDigest = { value: environmentPolicyDigestOf(SHIPPED_DEFAULT_POLICY) };
    for (const platform of [
      { os: 'linux', arch: 'x64' },
      { os: 'linux', arch: 'arm64' },
      { os: 'win32', arch: 'x64' },
      { os: 'darwin', arch: 'x64' }
    ]) {
      const refusal = await refusalOf(platformGate(platform, envDigest).admit('codex', { runId: 'r', cliPath: 'codex' }));
      expect(refusal).toMatchObject({ reason: 'containment-unqualified-for-tuple', consentable: true });
    }
    const contained = platformGate({ os: 'darwin', arch: 'arm64' }, envDigest);
    await expect(contained.admit('codex', { runId: 'r', cliPath: 'codex' })).resolves.toBeUndefined();
    const claude = await refusalOf(contained.admit('claude', { runId: 'r', cliPath: 'claude' }));
    expect(claude.reason).toBe('containment-unqualified-for-tuple');
  });

  it('F09-AC-08 -- qualification record keys carry ACP posture and production ACP authority handoff enforces live trust, deferred primacy, fence loss, locality, and pre-prompt checks', async () => {
    const kinds: BackendRunnerKind[] = ['claude', 'codex', 'agy'];
    for (const entry of inspect(kinds.map((kind) => identity({ kind })))) {
      expect(entry.record.key.acp).toBe('not-applicable');
    }

    const cli = await writeFakeCli('agy-ac08', '1.5.5', join(root, 'ac08.count'));
    let trusted = true;
    let primacyBehavior: () => Promise<boolean> = async () => true;
    let fenceLostListener: (() => void) | undefined;
    let promptCount = 0;

    const memento = new InMemoryMemento();
    const warnings: string[] = [];
    const probe = createCliVersionProbe({ environmentPolicy: () => SHIPPED_DEFAULT_POLICY });
    const containment = wireContainmentAdmission({
      memento,
      logger: { warn: (line) => void warnings.push(line) },
      isTrusted: () => trusted,
      hasPrimacy: () => primacyBehavior(),
      environmentPolicy: SHIPPED_DEFAULT_POLICY,
      granted: () => new Set<BackendRunnerKind>(['agy']),
      observeVersion: (p) => probe.observe(p)
    });

    const acpDispatch = buildHostAcpDispatchOptions({
      workspaceRoot: root,
      store: {} as WorkspaceStateStore,
      logger: { warn: vi.fn(), info: vi.fn() } as never,
      isWorkspaceTrusted: () => trusted,
      hasPrimacy: () => primacyBehavior(),
      onFenceLost: (listener) => {
        fenceLostListener = listener;
        return { dispose() {} };
      },
      readRemoteName: () => undefined
    });

    const makeGatedAcpRunner = (hooks: { onSessionNew?: () => void } = {}) => {
      const dummyInner: BackendRunner = {
        hasActiveProcess: false,
        invoke: async () => {
          throw new Error('CLI fallback must never execute');
        },
        cancelActive: () => false,
        close: () => undefined,
        settleTeardowns: async () => []
      };
      const acp = new AcpBackedRunner({
        kind: 'agy',
        inner: dummyInner,
        readConfiguredProfile: () => 'agy-acp-native',
        ...(acpDispatch.authorityGate ? { authorityGate: acpDispatch.authorityGate } : {}),
        primaryWorkspaceRoot: root,
        ...(acpDispatch.currentOwnershipGeneration
          ? { currentOwnershipGeneration: acpDispatch.currentOwnershipGeneration }
          : {}),
        ...(acpDispatch.primeAuthority ? { primeAuthority: acpDispatch.primeAuthority } : {}),
        ...(acpDispatch.hostLocality ? { hostLocality: acpDispatch.hostLocality } : {}),
        platform: { os: 'darwin', arch: 'arm64' },
        launchTransport: () =>
          createFakeAcpTransport({
            ...(hooks.onSessionNew ? { onSessionNew: hooks.onSessionNew } : {}),
            onPrompt: () => {
              promptCount += 1;
            }
          })
      });
      return new SpawnGatedRunner('agy', acp, containment.spawnGate);
    };

    const acpReq = (runId: string): InvocationRequest => ({
      cliPath: cli,
      cwd: root,
      prompt: 'verify ACP handoff',
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000,
      runId
    });

    // 1. Healthy trusted primary local turn succeeds.
    const ok = await makeGatedAcpRunner().invoke(acpReq('run-ac08-ok'));
    expect(ok.exitCode).toBe(0);
    expect(promptCount).toBe(1);

    // 2. Live trust revocation blocks spawn gate before ACP launches.
    trusted = false;
    const untrustedRefusal = await refusalOf(makeGatedAcpRunner().invoke(acpReq('run-ac08-untrusted')));
    expect(untrustedRefusal.reason).toBe('workspace-untrusted-at-spawn');
    expect(await acpDispatch.primeAuthority?.()).toBe(false);
    expect(promptCount).toBe(1);

    // 3. Deferred primacy resolving false / throwing blocks spawn gate & authority priming.
    trusted = true;
    primacyBehavior = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5));
    const lostRefusal = await refusalOf(makeGatedAcpRunner().invoke(acpReq('run-ac08-lost')));
    expect(lostRefusal.reason).toBe('ownership-lost-at-spawn');
    expect(await acpDispatch.primeAuthority?.()).toBe(false);

    // 4. Mid-turn trust revocation between session/new and prompt is caught before prompt dispatch.
    primacyBehavior = async () => true;
    const prePromptTrustRevoked = await makeGatedAcpRunner({
      onSessionNew: () => {
        trusted = false;
      }
    }).invoke(acpReq('run-ac08-mid-trust'));
    expect(prePromptTrustRevoked.exitCode).toBe(1);
    expect(prePromptTrustRevoked.diagnosticWarnings).toContain('acp-ownership-unverified');
    expect(promptCount).toBe(1);

    // 5. Mid-turn onFenceLost between session/new and prompt invalidates generation & blocks prompt.
    trusted = true;
    const prePromptFenceLost = await makeGatedAcpRunner({
      onSessionNew: () => {
        fenceLostListener?.();
      }
    }).invoke(acpReq('run-ac08-mid-fence'));
    expect(prePromptFenceLost.exitCode).toBe(1);
    expect(prePromptFenceLost.diagnosticWarnings).toContain('acp-ownership-unverified');
    expect(promptCount).toBe(1);

    // 6. Remote host locality refuses before launching ACP transport.
    const remoteDispatch = buildHostAcpDispatchOptions({
      workspaceRoot: root,
      store: {} as WorkspaceStateStore,
      logger: { warn: vi.fn(), info: vi.fn() } as never,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      readRemoteName: () => 'ssh-remote'
    });
    expect(remoteDispatch.hostLocality).toBe('remote');
    let remoteLaunched = false;
    const remoteRunner = new AcpBackedRunner({
      kind: 'agy',
      inner: {
        hasActiveProcess: false,
        invoke: async () => {
          throw new Error('CLI fallback must never execute');
        },
        cancelActive: () => false,
        close: () => undefined,
        settleTeardowns: async () => []
      },
      readConfiguredProfile: () => 'agy-acp-native',
      ...(remoteDispatch.hostLocality ? { hostLocality: remoteDispatch.hostLocality } : {}),
      platform: { os: 'darwin', arch: 'arm64' },
      launchTransport: () => {
        remoteLaunched = true;
        return createFakeAcpTransport();
      }
    });
    const remoteResult = await remoteRunner.invoke(acpReq('run-ac08-remote'));
    expect(remoteLaunched).toBe(false);
    expect(remoteResult.exitCode).toBe(1);
    expect(remoteResult.diagnosticWarnings).toContain('acp-open-refused:profile-unqualified');
  });

  it('F09-AC-04 -- completely isolated credential and home-path scan across every contracted surface', async () => {
    const localSurfaces: string[] = [];
    const h = harness(SEEDED_POLICY);

    // Prepare fake CLIs under `root` (which lives beneath `homedir()`) carrying `SEEDED_SECRET`.
    const secretOnly = await writeFakeCli(`codex-${SEEDED_SECRET}`, `${SEEDED_SECRET} ${root}`, join(root, 'ac04-a.count'));
    const withVersion = await writeFakeCli(`agy-${SEEDED_SECRET}`, `agy ${SEEDED_SECRET} 1.1.20`, join(root, 'ac04-b.count'));
    const codexV170 = await writeFakeCli(`codex-v170-${SEEDED_SECRET}`, `codex-cli ${SEEDED_SECRET} 0.170.0`, join(root, 'ac04-c.count'));
    const nonExec = join(root, `noexec-${SEEDED_SECRET}`);
    await writeFile(nonExec, '#!/bin/sh\necho 1.0.0\n', 'utf8');
    await chmod(nonExec, 0o644);
    const missingCli = join(root, `missing-${SEEDED_SECRET}`);

    // 1. Exercise ALL 6 CONTAINMENT_REFUSAL_REASONS & BOTH EXECUTABLE_UNRESOLVED_CAUSES:
    // (a) workspace-untrusted-at-spawn
    h.state.trusted = false;
    localSurfaces.push(refusalSurface(await refusalOf(h.runner('codex').invoke(h.request(codexV170, 'run-untrusted')))));

    // (b) ownership-lost-at-spawn
    h.state.trusted = true;
    h.state.primacy = false;
    localSurfaces.push(refusalSurface(await refusalOf(h.runner('codex').invoke(h.request(codexV170, 'run-lost')))));

    // (c) backend-executable-unresolved: both 'not-found' AND 'not-executable'
    h.state.primacy = true;
    const notFoundRefusal = await refusalOf(h.runner('claude').invoke(h.request(missingCli, 'run-nf')));
    expect(notFoundRefusal.executableCause).toBe('not-found');
    localSurfaces.push(refusalSurface(notFoundRefusal));

    const notExecRefusal = await refusalOf(h.runner('claude').invoke(h.request(nonExec, 'run-ne')));
    expect(notExecRefusal.executableCause).toBe('not-executable');
    localSurfaces.push(refusalSurface(notExecRefusal));

    // (d) containment-unqualified-for-tuple (including secret-only stdout -> null / unverified)
    const unqualSecret = await refusalOf(h.runner('codex').invoke(h.request(secretOnly, 'run-unqual-s')));
    localSurfaces.push(refusalSurface(unqualSecret));
    const unqualV170 = await refusalOf(h.runner('codex').invoke(h.request(codexV170, 'run-unqual-v')));
    localSurfaces.push(refusalSurface(unqualV170));

    // 2. Exercise BOTH ACCEPTANCE_ORIGINS ('legacy-first-use' and 'consent') + (e) acceptance-fingerprint-changed
    h.state.granted.add('agy');
    await h.runner('agy').invoke(h.request(withVersion, 'run-legacy-bind'));
    expect(h.wiring.qualification.bindingOf('agy')).toMatchObject({ origin: 'legacy-first-use' });

    h.state.granted.add('codex');
    await h.wiring.recordAcceptance('codex', unqualV170.fingerprint!);
    expect(h.wiring.qualification.bindingOf('codex')).toMatchObject({ origin: 'consent' });
    await h.runner('codex').invoke(h.request(codexV170, 'run-consent-ok'));

    await writeFakeCli(`codex-v170-${SEEDED_SECRET}`, `codex-cli ${SEEDED_SECRET} 0.171.0`, join(root, 'ac04-c.count'));
    h.state.clockMs += VERSION_TTL_PAST_MS;
    const fpChanged = await refusalOf(h.runner('codex').invoke(h.request(codexV170, 'run-fp-changed')));
    localSurfaces.push(refusalSurface(fpChanged));

    // (f) configuration-changed-at-spawn (inside same Run)
    const envDigest = { value: environmentPolicyDigestOf(SHIPPED_DEFAULT_POLICY) };
    const cfgGate = platformGate({ os: 'darwin', arch: 'arm64' }, envDigest);
    await cfgGate.admit('codex', { runId: 'run-cfg', cliPath: 'codex' });
    envDigest.value = environmentPolicyDigestOf(SEEDED_POLICY);
    const cfgChanged = await refusalOf(cfgGate.admit('codex', { runId: 'run-cfg', cliPath: 'codex' }));
    localSurfaces.push(refusalSurface(cfgChanged));

    // 3. Binding store warnings: malformed entry, invalid version with SEEDED_SECRET, unknown kind, oversized, future-schema
    const bindingWarnings: string[] = [];
    const badBindingsMemento = new InMemoryMemento();
    const badStore = new AcceptanceBindingStore(badBindingsMemento, { warn: (line) => void bindingWarnings.push(line) });
    const fakeFp = computeFingerprint(identity({ kind: 'claude', versionMinor: '2.1' }));
    await badBindingsMemento.update(ACCEPTANCE_BINDINGS_KEY, {
      schemaVersion: 1,
      bindings: {
        [SEEDED_SECRET]: { fingerprint: fakeFp, origin: 'consent', boundAt: '2026-11-10T00:00:00.000Z' },
        claude: {
          fingerprint: { ...fakeFp, components: { ...fakeFp.components, version: `${SEEDED_SECRET} ${root}` } },
          origin: 'consent',
          boundAt: '2026-11-10T00:00:00.000Z'
        }
      }
    });
    expect(badStore.read('claude')).toBeNull();
    await badBindingsMemento.update(ACCEPTANCE_BINDINGS_KEY, {
      schemaVersion: 1,
      bindings: {},
      pad: `${SEEDED_SECRET}${'p'.repeat(ACCEPTANCE_BINDINGS_MAX_BYTES)}`
    });
    expect(badStore.read('claude')).toBeNull();
    await badBindingsMemento.update(ACCEPTANCE_BINDINGS_KEY, {
      schemaVersion: 99,
      bindings: { claude: { secret: SEEDED_SECRET, path: root } }
    });
    expect(badStore.read('claude')).toBe('future-schema');
    const futureErr = await badStore.bind('claude', fakeFp, 'consent').then(
      () => null,
      (e: unknown) => e
    );
    expect(futureErr).toBeInstanceOf(AcceptanceBindingsFutureSchemaError);
    localSurfaces.push(...bindingWarnings, String((futureErr as Error).message));

    // 4. Headless inspection: valid output + InvalidInspectionInputError with secret/path input
    const inspectedValid = inspectBackendQualification({
      identities: [
        h.wiring.qualification.identityOf('codex') as BackendIdentity,
        h.wiring.qualification.identityOf('agy') as BackendIdentity,
        h.wiring.qualification.identityOf('claude') as BackendIdentity
      ],
      granted: ['codex', 'agy'],
      bindings: {
        codex: h.wiring.qualification.bindingOf('codex') as AcceptanceBinding,
        agy: h.wiring.qualification.bindingOf('agy') as AcceptanceBinding
      }
    });
    localSurfaces.push(JSON.stringify(inspectedValid));

    let invalidInspectionErr: unknown;
    try {
      inspectBackendQualification({
        identities: [identity({ os: `${SEEDED_SECRET}/${root}` })],
        granted: [],
        bindings: {}
      });
    } catch (e) {
      invalidInspectionErr = e;
    }
    expect(invalidInspectionErr).toBeInstanceOf(InvalidInspectionInputError);
    localSurfaces.push(String((invalidInspectionErr as Error).message));

    // 5. Sidebar qualification projection
    for (const kind of ['codex', 'agy', 'claude'] as const) {
      localSurfaces.push(
        JSON.stringify(projectBackendQualification(kind, h.state.granted, h.wiring.qualification))
      );
    }

    // 6. Teardown evidence audit payloads & warnings
    const teardownSurfaces: string[] = [];
    await recordTeardownEvidence(
      {
        outcomes: [
          { attribution: { runId: 'run-ac04', phase: 'implement', iteration: 1 }, runner: 'codex-cli', pid: 4001, result: 'bound-elapsed' },
          { attribution: { runId: 'run-ac04', phase: 'implement', iteration: 1 }, runner: 'claude-cli', pid: 4002, result: 'platform-unanswerable' }
        ],
        boundMs: 2_750,
        elapsedMs: 3_000
      },
      {
        treeRecorder: { settled: async () => undefined },
        append: async (entry) => void teardownSurfaces.push(JSON.stringify(entry)),
        logger: { warn: (line) => void teardownSurfaces.push(line) }
      }
    );
    localSurfaces.push(...teardownSurfaces);

    // 7. 16-15 version probe, cliVersionFields, and phase-start audit projection
    expect(await h.probe.observe(secretOnly)).toBeNull();
    const versionWarnings: string[] = [];
    const badVersionFields = cliVersionFields(`${SEEDED_SECRET} ${root}`, 'claude', {
      warn: (msg) => void versionWarnings.push(msg)
    });
    const projectedStart = projectAuditPayload('phase-start', {
      phaseId: 'implement',
      runner: 'claude',
      cliVersion: `${SEEDED_SECRET} ${root}`,
      qualifiedCliVersion: '2.1.246',
      ...badVersionFields
    });
    expect(projectedStart.cliVersion).toBeUndefined();
    localSurfaces.push(JSON.stringify(badVersionFields), JSON.stringify(projectedStart), ...versionWarnings);

    // 8. AcpAuthorityGate receipts (allowed + denied with secret/path targetPath)
    let acpTrusted = true;
    let acpPrimacy = true;
    const acpGate = new AcpAuthorityGate({
      isWorkspaceTrusted: () => acpTrusted,
      holdsPrimacy: () => acpPrimacy,
      currentOwnershipGeneration: () => 1
    });
    acpGate.registerScope({
      attemptId: 'att-ac04',
      profileId: 'agy-acp-native',
      acpSessionId: 'sess-ac04',
      connectionGeneration: 1,
      ownershipGeneration: 1,
      executionRoot: root,
      primaryWorkspaceRoot: root
    });
    acpGate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-ac04',
      connectionGeneration: 1,
      attemptId: 'att-ac04',
      mutating: false,
      targetPath: join(root, 'allowed.txt')
    });
    acpGate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-ac04',
      connectionGeneration: 1,
      attemptId: 'att-ac04',
      mutating: false,
      targetPath: join(root, '.env', SEEDED_SECRET)
    });
    acpGate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-ac04',
      connectionGeneration: 1,
      attemptId: 'att-ac04',
      mutating: false,
      targetPath: join(homedir(), SEEDED_SECRET)
    });
    acpTrusted = false;
    acpGate.authorize({
      requestKind: 'permission',
      acpSessionId: 'sess-ac04',
      connectionGeneration: 1,
      attemptId: 'att-ac04',
      mutating: true
    });
    acpTrusted = true;
    acpPrimacy = false;
    acpGate.authorize({
      requestKind: 'terminal',
      acpSessionId: 'sess-ac04',
      connectionGeneration: 1,
      attemptId: 'att-ac04',
      mutating: true
    });
    localSurfaces.push(JSON.stringify(acpGate.listReceipts()));

    // Collect harness memento & warnings
    localSurfaces.push(h.memento.serialized(), ...h.warnings);

    // Verify complete surface coverage AND zero secret / home-path leakage
    const home = homedir();
    expect(home.length).toBeGreaterThan(1);
    expect(root.startsWith(home)).toBe(true);

    const combined = localSurfaces.join('\n');
    for (const reason of CONTAINMENT_REFUSAL_REASONS) {
      expect(combined, `missing refusal reason ${reason}`).toContain(reason);
    }
    for (const cause of EXECUTABLE_UNRESOLVED_CAUSES) {
      expect(combined, `missing unresolved cause ${cause}`).toContain(cause);
    }
    for (const origin of ACCEPTANCE_ORIGINS) {
      expect(combined, `missing binding origin ${origin}`).toContain(origin);
    }

    for (const surface of localSurfaces) {
      expect(surface).not.toContain(SEEDED_SECRET);
      expect(surface).not.toContain(home);
      expect(surface).not.toContain(root);
    }
  });
});
