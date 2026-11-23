// FR-R7-16 (16-14, FR-014) -- check workspace trust before probing and cancellation before spawn.
//
// WHAT THIS PINS:
//   - Untrusted BackendCapabilityService (`probe`, `probeAvailability`, `scan`) performs ZERO
//     executable invocations (`--help` or `models`) and does not read/spawn configured paths;
//   - Untrusted BackendRunnerRegistry.observedCliVersion performs ZERO `--version` invocations
//     and does NOT poison the TTL cache when trust is subsequently granted;
//   - Untrusted entry across fresh start, resume, restart recovery, and retry through PhaseRunner
//     + BackendRunnerRegistry + wireContainmentAdmission performs ZERO `--version` probes and
//     ZERO child spawns, refusing with `workspace-untrusted-at-spawn`;
//   - Aborted cancellationSignal skips PhaseRunner's `--version` probe and SpawnGatedRunner's
//     delayed admission with ZERO executable invocations and ZERO child spawns.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { wireContainmentAdmission } from '../../../src/activation/containment-admission-wiring';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import { SHIPPED_DEFAULT_POLICY } from '../../../src/contracts/process-environment-policy';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { SanitizedLogger } from '../../../src/lib/logger';
import { BackendRunnerRegistry } from '../../../src/runner/backend-runner-registry';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { BackendCapabilityService } from '../../../src/services/backend-capability-service';
import type { AcceptanceMementoPort } from '../../../src/services/containment-qualification/acceptance-bindings';
import { ContainmentAdmissionRefusedError } from '../../../src/services/containment-qualification/admission-refusal';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';

const posixIt = process.platform === 'win32' ? it.skip : it;

let root = '';

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

async function writeCountingCli(name: string, counterFile: string): Promise<string> {
  const cliPath = join(root, name);
  const script = [
    '#!/bin/sh',
    `echo invoked >> ${shellQuote(counterFile)}`,
    'echo "2.1.246 (Claude Code)"'
  ].join('\n');
  await writeFile(cliPath, script, 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
}

async function invocationCount(counterFile: string): Promise<number> {
  const content = await readFile(counterFile, 'utf8').catch(() => '');
  return content.split('\n').filter((line) => line.length > 0).length;
}

function makeMemento(): AcceptanceMementoPort {
  const map = new Map<string, unknown>();
  return {
    get: (key) => map.get(key),
    update: async (key, value) => {
      map.set(key, value);
    }
  };
}

function makeFakeAuditWriter(): AuditLogWriter {
  let seq = 0;
  return {
    append: vi.fn(async () => ({
      id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      timestamp: new Date().toISOString()
    }))
  } as unknown as AuditLogWriter;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'schegent-1614-trust-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FR-R7-16 (16-14) -- trust before probing and cancellation before spawn', () => {
  it('BackendCapabilityService executes zero probes when workspace is untrusted', async () => {
    const trusted = false;
    const spawnSpy = vi.fn(() => {
      throw new Error('spawn must never run while untrusted');
    });
    const resolveSpy = vi.fn((kind: BackendRunnerKind) => `/configured/${kind}`);
    const buildEnvSpy = vi.fn(() => ({ PATH: '/usr/bin' }));
    const service = new BackendCapabilityService({
      cwd: root,
      resolveCliPath: resolveSpy,
      readTimeoutSeconds: () => 5,
      buildEnv: buildEnvSpy,
      logger: { debug: vi.fn(), warn: vi.fn() },
      isTrusted: () => trusted,
      spawnFn: spawnSpy as never,
      backendKinds: ['claude', 'codex', 'agy']
    });

    expect(await service.probe('claude')).toEqual({
      runner: 'claude',
      available: false,
      cause: 'unknown'
    });
    expect(await service.probeAvailability('codex')).toBe(false);
    const snap = await service.scan();
    expect(snap.availableBackends).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(buildEnvSpy).not.toHaveBeenCalled();
    service.dispose();
  });

  posixIt('BackendRunnerRegistry and PhaseRunner execute zero probes when untrusted across fresh start, resume, restart recovery, and retry', async () => {
    const counter = join(root, 'untrusted-entry.count');
    const cliPath = await writeCountingCli('fake-claude-1614', counter);

    let trusted = false;
    const warnings: string[] = [];
    const containment = wireContainmentAdmission({
      memento: makeMemento(),
      logger: { warn: (line) => void warnings.push(line) },
      isTrusted: () => trusted,
      hasPrimacy: async () => true,
      environmentPolicy: SHIPPED_DEFAULT_POLICY,
      granted: () => new Set<BackendRunnerKind>(['claude']),
      observeVersion: (p) => registry.observedCliVersion(p)
    });
    const registry = new BackendRunnerRegistry(
      {
        uncontainedGranted: () => new Set<BackendRunnerKind>(['claude']),
        environmentPolicy: SHIPPED_DEFAULT_POLICY,
        isTrusted: () => trusted,
        spawnGate: containment.spawnGate
      },
      'claude'
    );

    const logger = new SanitizedLogger();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.debug = vi.fn();
    const phaseRunner = new PhaseRunner(
      registry,
      new PromptBuilder(),
      makeFakeAuditWriter(),
      logger
    );

    const baseInputs = {
      phase: 'implement',
      iteration: 1,
      iterationCap: 3,
      featureDescription: 'test',
      featureDir: root,
      carriedIssues: [],
      cliPath,
      cwd: root,
      timeoutMs: 5_000,
      rawTranscriptMode: 'off' as const,
      ...{ inheritProcessEnv: false, processEnvAllowlist: [] }
    };

    const entryScenarios = [
      { label: 'fresh start', over: { runId: 'run-fresh-1', iteration: 1 } },
      { label: 'resume', over: { runId: 'run-resume-1', isContinue: true, resumeSessionId: 'sess-1', resumePrompt: 'continue' } },
      { label: 'restart recovery', over: { runId: 'run-restart-1', iteration: 2, continuationNote: 'recovered after restart' } },
      { label: 'retry', over: { runId: 'run-retry-1', iteration: 2, isContinue: true } }
    ];

    for (const scenario of entryScenarios) {
      await expect(
        phaseRunner.run({ ...baseInputs, ...scenario.over }),
        scenario.label
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ContainmentAdmissionRefusedError &&
          err.reason === 'workspace-untrusted-at-spawn'
      );
    }

    // Critical invariant: ZERO executable invocations occurred while untrusted!
    expect(await invocationCount(counter)).toBe(0);

    // Direct registry probe also returns null without poisoning the TTL cache.
    expect(await registry.observedCliVersion(cliPath)).toBeNull();
    expect(await invocationCount(counter)).toBe(0);

    // Once trust is granted, the TTL cache was NOT poisoned and probing succeeds cleanly.
    trusted = true;
    expect(await registry.observedCliVersion(cliPath)).toBe('2.1.246');
    expect(await invocationCount(counter)).toBe(1);
  });

  posixIt('PhaseRunner with already-aborted signal skips version probe and spawns zero processes', async () => {
    const counter = join(root, 'aborted-entry.count');
    const cliPath = await writeCountingCli('fake-claude-aborted', counter);

    let gateAdmitCalls = 0;
    const registry = new BackendRunnerRegistry(
      {
        uncontainedGranted: () => new Set<BackendRunnerKind>(['claude']),
        environmentPolicy: SHIPPED_DEFAULT_POLICY,
        isTrusted: () => true,
        spawnGate: {
          admit: async () => {
            gateAdmitCalls += 1;
          }
        }
      },
      'claude'
    );

    const logger = new SanitizedLogger();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.debug = vi.fn();
    const phaseRunner = new PhaseRunner(
      registry,
      new PromptBuilder(),
      makeFakeAuditWriter(),
      logger
    );

    const controller = new AbortController();
    controller.abort();
    const output = await phaseRunner.run({
      runId: 'run-aborted',
      phase: 'implement',
      iteration: 1,
      iterationCap: 3,
      featureDescription: 'test',
      featureDir: root,
      carriedIssues: [],
      cliPath,
      cwd: root,
      timeoutMs: 5_000,
      cancellationSignal: controller.signal,
      rawTranscriptMode: 'off',
      inheritProcessEnv: false,
      processEnvAllowlist: []
    });

    expect(output.terminationReason).toBe('cancel');
    expect(output.exitCode).toBeNull();
    expect(gateAdmitCalls).toBe(0);
    expect(await invocationCount(counter)).toBe(0);
  });
});
