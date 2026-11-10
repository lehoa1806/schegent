// FR-R6-F09 T036 -- containment admission acceptance (F09-AC-01..08).
//
// WHAT THIS DRIVES. The composition the window ships: `wireContainmentAdmission` with the real
// executable resolution and the real `--version` probe, spawning fake CLIs written under the
// vitest temp root (inside `repo/.tmp`), behind the `SpawnGatedRunner` every runner is wrapped in.
// Trust, primacy and the grant set are fakes the test flips; the acceptance bindings live in an
// in-memory memento. Platform cells the host cannot be are driven through the gate and the
// headless inspection with an explicit platform.
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireContainmentAdmission } from '../../src/activation/containment-admission-wiring';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { BackendRunner, TreeTeardownOutcome, TreeTeardownResult } from '../../src/contracts/backend-runner';
import {
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
import { inspectBackendQualification } from '../../src/headless/backend-qualification-api';
import {
  CLI_VERSION_MAX_OUTPUT_BYTES,
  CLI_VERSION_TIMEOUT_MS,
  createCliVersionProbe
} from '../../src/runner/cli-version-probe';
import type { InvocationRequest, RawInvocationOutput } from '../../src/runner/invocation-result';
import { SpawnGatedRunner } from '../../src/runner/spawn-gated-runner';
import type { AcceptanceMementoPort } from '../../src/services/containment-qualification/acceptance-bindings';
import { AcceptanceBindingStore } from '../../src/services/containment-qualification/acceptance-bindings';
import { ContainmentAdmissionRefusedError } from '../../src/services/containment-qualification/admission-refusal';
import { environmentPolicyDigestOf } from '../../src/services/containment-qualification/fingerprint';
import { createSpawnAdmissionGate } from '../../src/services/containment-qualification/spawn-admission-gate';

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
/** Every metadata surface a test produced, scanned in the credential test (F09-AC-04, SC-007). */
const surfaces: string[] = [];

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
  const refusal = error as ContainmentAdmissionRefusedError;
  surfaces.push(refusalSurface(refusal));
  return refusal;
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
  const collect = () => {
    surfaces.push(memento.serialized(), ...warnings);
  };
  return { memento, warnings, state, probe, wiring, invoked, runner, request, collect };
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
  const result = inspectBackendQualification({ identities, granted, bindings: {} });
  surfaces.push(JSON.stringify(result));
  return result;
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
    h.collect();
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
    h.collect();
  });

  it('F09-AC-02 -- deny precedence: an untrusted workspace refuses for trust, never for qualification', async () => {
    const h = harness();
    const cli = await writeFakeCli('codex-ac02-precedence', 'codex-cli 0.170.0', join(root, 'ac02-p.count'));
    h.state.trusted = false;
    h.state.primacy = false;

    const refusal = await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-p')));

    expect(refusal).toMatchObject({ reason: 'workspace-untrusted-at-spawn', consentable: false });
    h.collect();
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
    surfaces.push(JSON.stringify(headless));
    expect(headless.admission).toMatchObject({ outcome: 'refused', reason: 'acceptance-fingerprint-changed' });
    h.collect();
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
    h.collect();
  });

  it('F09-AC-06 -- an answer past the output cap is unverified, never truncated into a version', async () => {
    const h = harness();
    const counter = join(root, 'ac06-cap.count');
    const oversized = `${'x'.repeat(OVERSIZED_OUTPUT_BYTES)} codex-cli 0.163.0`;
    const cli = await writeFakeCli('codex-ac06-cap', oversized, counter);

    const refusal = await refusalOf(h.runner('codex').invoke(h.request(cli, 'run-cap')));

    expect(refusal.reason).toBe('containment-unqualified-for-tuple');
    expect(h.wiring.qualification.identityOf('codex')).toMatchObject({ versionMinor: null });
    h.collect();
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

  it('F09-AC-08 -- every record key carries ACP as not applicable', () => {
    const kinds: BackendRunnerKind[] = ['claude', 'codex', 'agy'];
    for (const entry of inspect(kinds.map((kind) => identity({ kind })))) {
      expect(entry.record.key.acp).toBe('not-applicable');
    }
  });

  it('F09-AC-04 -- a seeded credential and the home path reach no refusal, payload, binding or log', async () => {
    const h = harness(SEEDED_POLICY);
    const secretOnly = await writeFakeCli('codex-ac04-secret', SEEDED_SECRET, join(root, 'ac04-a.count'));
    const withVersion = await writeFakeCli('agy-ac04', `agy ${SEEDED_SECRET} 1.1.20`, join(root, 'ac04-b.count'));
    await refusalOf(h.runner('codex').invoke(h.request(secretOnly, 'run-s')));
    await refusalOf(h.runner('agy').invoke(h.request(withVersion, 'run-s')));
    await refusalOf(h.runner('claude').invoke(h.request(join(root, 'missing-claude'), 'run-s')));
    h.state.granted.add('agy');
    await h.runner('agy').invoke(h.request(withVersion, 'run-s'));
    surfaces.push(JSON.stringify(inspect([h.wiring.qualification.identityOf('codex') as BackendIdentity])));
    // Control: the secret did reach the host, so its absence below is the gate dropping it.
    expect(await h.probe.observe(secretOnly)).toContain(SEEDED_SECRET);
    h.collect();

    const home = homedir();
    expect(home.length).toBeGreaterThan(1);
    expect(root.startsWith(home)).toBe(true);
    expect(surfaces.length).toBeGreaterThan(20);
    expect(surfaces.join('\n')).toContain('containment-unqualified-for-tuple');
    for (const surface of surfaces) {
      expect(surface).not.toContain(SEEDED_SECRET);
      expect(surface).not.toContain(home);
    }
  });
});
