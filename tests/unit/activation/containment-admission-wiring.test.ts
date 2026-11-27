// FR-R6-F09 T032 -- the containment admission wiring: one binding store, one identity cache, one
// gate, shared by the spawn path, the sidebar and the consent modal.
//
// WHAT THIS PINS. The consent modal's acceptance is written to the same store the gate reads, with
// origin `consent`, so the retry it triggers is admitted; the identity the gate observed is what
// the sidebar reads; the platform is this host's. The executable is this Node binary, a real file
// named by absolute path, so resolution needs no PATH.

import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wireContainmentAdmission } from '../../../src/activation/containment-admission-wiring';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import { SHIPPED_DEFAULT_POLICY } from '../../../src/contracts/process-environment-policy';
import { createCliVersionProbe } from '../../../src/runner/cli-version-probe';
import { ContainmentAdmissionRefusedError } from '../../../src/services/containment-qualification/admission-refusal';

const REQUEST = { runId: 'run-1', cliPath: process.execPath };

function memento() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    }
  };
}

function wiringWith(granted: Set<BackendRunnerKind>, primacy = true) {
  const warnings: string[] = [];
  const wiring = wireContainmentAdmission({
    memento: memento(),
    logger: { warn: (line) => warnings.push(line) },
    isTrusted: () => true,
    hasPrimacy: async () => primacy,
    environmentPolicy: SHIPPED_DEFAULT_POLICY,
    granted: () => granted,
    observeVersion: async () => '2.1.321'
  });
  return { wiring, warnings };
}

async function refusalOf(promise: Promise<void>): Promise<ContainmentAdmissionRefusedError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  if (!(error instanceof ContainmentAdmissionRefusedError)) throw new Error('expected an admission refusal');
  return error;
}

describe('FR-R6-F09 T032 -- wireContainmentAdmission', () => {
  it.skipIf(process.platform === 'win32')('re-probes the executable after a same-path upgrade within the version TTL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schegent-admission-version-'));
    try {
      const cli = join(directory, 'fake-cli');
      const script = (version: string) => '#!/bin/sh\necho ' + version + '\n';
      await writeFile(cli, script('1.1.0'), { mode: 0o700 });
      const probe = createCliVersionProbe();
      const gate = wireContainmentAdmission({
        memento: memento(), logger: { warn: () => undefined }, isTrusted: () => true,
        hasPrimacy: async () => true, environmentPolicy: SHIPPED_DEFAULT_POLICY,
        granted: () => new Set(['claude']), observeVersion: probe.observe
      }).spawnGate;
      const request = { runId: 'upgrade', cliPath: 'fake-cli', env: { PATH: directory } };
      const first = await gate.admitWithDecision!('claude', request);
      expect(first.resolvedExecutablePath).toBe(cli);
      expect(first.executableFileStamp).toBeTruthy();
      expect(first.fingerprint.components.version).toBe('1.1');
      await writeFile(cli + '.new', script('1.2.0'), { mode: 0o700 });
      await rename(cli + '.new', cli);
      await expect(gate.admit('claude', request)).rejects.toMatchObject({
        reason: 'acceptance-fingerprint-changed', changedComponent: 'version'
      });
      expect(await probe.observe(cli)).toBe('1.2.0');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('leaves identity and consent unbound if the file changes during observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schegent-admission-observe-'));
    try {
      const cli = join(directory, 'fake-cli');
      await writeFile(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const wiring = wireContainmentAdmission({
        memento: memento(),
        logger: { warn: () => undefined },
        isTrusted: () => true,
        hasPrimacy: async () => true,
        environmentPolicy: SHIPPED_DEFAULT_POLICY,
        granted: () => new Set(['claude']),
        observeVersion: async () => {
          await writeFile(cli + '.new', '#!/bin/sh\nexit 0\n', { mode: 0o700 });
          await rename(cli + '.new', cli);
          return '1.1.0';
        }
      });
      await expect(wiring.spawnGate.admit('claude', { runId: 'changed', cliPath: cli })).rejects.toMatchObject({
        reason: 'configuration-changed-at-spawn'
      });
      expect(wiring.qualification.identityOf('claude')).toBeNull();
      expect(wiring.qualification.bindingOf('claude')).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('a consent acceptance binds with origin consent, and the retried spawn is admitted', async () => {
    const granted = new Set<BackendRunnerKind>();
    const { wiring } = wiringWith(granted);
    const refusal = await refusalOf(wiring.spawnGate.admit('claude', REQUEST));
    expect(refusal.consentable).toBe(true);
    if (refusal.fingerprint === undefined) throw new Error('a consentable refusal carries its fingerprint');

    granted.add('claude');
    await wiring.recordAcceptance('claude', refusal.fingerprint);
    const binding = wiring.qualification.bindingOf('claude');
    expect(binding !== null && binding !== 'future-schema' ? binding.origin : binding).toBe('consent');
    await expect(wiring.spawnGate.admit('claude', REQUEST)).resolves.toBeUndefined();
  });

  // Recorded whether or not the spawn is admitted: codex at `2.1` has no evidence row, so it is
  // refused here, and the sidebar must still show what was observed.
  it('the identity the gate observed is the one the sidebar reads, on this platform', async () => {
    const { wiring } = wiringWith(new Set());
    expect(wiring.qualification.identityOf('codex')).toBeNull();
    await refusalOf(wiring.spawnGate.admit('codex', REQUEST));
    expect(wiring.qualification.identityOf('codex')).toMatchObject({
      kind: 'codex',
      executable: 'resolved',
      versionMinor: '2.1',
      os: process.platform,
      arch: process.arch
    });
  });

  it('a window without primacy refuses through the same gate', async () => {
    const { wiring, warnings } = wiringWith(new Set(), false);
    expect((await refusalOf(wiring.spawnGate.admit('codex', REQUEST))).reason).toBe('ownership-lost-at-spawn');
    expect(warnings).toEqual(['spawn admission: refused kind=codex reason=ownership-lost-at-spawn']);
  });
});
