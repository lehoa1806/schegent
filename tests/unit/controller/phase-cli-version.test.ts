// FR-R3-104 (FR-054) — the running CLI's version reaches the record, and its PATH does not.
//
// WHY BOTH HALVES ARE ONE TEST. The value is useful because it identifies the binary's protocol
// surface, and it is safe because it is not the binary's location. `cliPath` is documented as
// never routed into an audit payload (`InvocationRequest.command` carries it and says so), and
// the easiest way to record a version is to record the string the CLI printed — which on some
// tools includes the install path. Asserting the presence without asserting the absence would let
// a future `--version` banner leak a home directory into the evidence record.
import { describe, expect, it, vi } from 'vitest';
import {
  CLI_VERSION_TTL_MS,
  createCliVersionProbe,
  normalizeCliVersion,
  observedVersionOf
} from '../../../src/runner/cli-version-probe';
import { projectAuditPayload } from '../../../src/audit/audit-payload';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { AgentConfigAckGate } from '../../../src/controller/agent-config-ack-gate';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { BackendRunnerRegistry } from '../../../src/runner/backend-runner-registry';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { AgentConfigAcknowledgementRefusedError } from '../../../src/services/agent-config-ack-refusal';
import { UncontainedBackendRefusedError } from '../../../src/services/backend-containment-policy';
import { computeAgentConfigFingerprint } from '../../../src/services/repo-agent-config-scanner';

describe('normalizing a --version answer', () => {
  it('reduces each backend\'s real answer to its version token', () => {
    // The three observed on 2026-08-26, verbatim from the canary's own log entry.
    expect(normalizeCliVersion('2.1.246 (Claude Code)')).toBe('2.1.246');
    expect(normalizeCliVersion('codex-cli 0.149.0')).toBe('0.149.0');
    expect(normalizeCliVersion('1.1.20')).toBe('1.1.20');
  });

  it('rejects unparseable or out-of-grammar lines as null (16-15: zero raw stdout fallback)', () => {
    expect(normalizeCliVersion('some-cli (nightly)')).toBeNull();
    expect(normalizeCliVersion('x'.repeat(200))).toBeNull();
    expect(normalizeCliVersion('SECRET_TOKEN /Users/alice/.local/bin/claude')).toBeNull();
    expect(normalizeCliVersion('1234567.0.0')).toBeNull();
  });

  it('answers null for nothing at all', () => {
    expect(normalizeCliVersion('')).toBeNull();
    expect(normalizeCliVersion('\n\n')).toBeNull();
  });

  it('reads only the FIRST line, so a chatty CLI cannot smuggle a path in', () => {
    const chatty = '2.1.246 (Claude Code)\ninstalled at /Users/someone/.local/bin/claude';
    const version = normalizeCliVersion(chatty);
    expect(version).toBe('2.1.246');
    expect(version).not.toContain('/Users/');
  });
});

describe('the probe spends at most one process per path per window', () => {
  it('caches an observed version for the TTL and probes again after it', async () => {
    let clock = 0;
    const probe = vi.fn().mockResolvedValue('2.1.246 (Claude Code)');
    const versions = createCliVersionProbe({ probe, monotonicNow: () => clock });

    expect(await versions.observe('claude')).toBe('2.1.246');
    expect(await versions.observe('claude')).toBe('2.1.246');
    expect(probe, 'a second read inside the window must not spawn').toHaveBeenCalledTimes(1);

    clock += CLI_VERSION_TTL_MS - 1;
    await versions.observe('claude');
    expect(probe).toHaveBeenCalledTimes(1);

    // Past the window: a mid-session upgrade is what this exists to notice.
    clock += 2;
    await versions.observe('claude');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent first reads into one probe', async () => {
    // Twenty phases starting together must not spawn twenty processes for one answer.
    let release: (value: string) => void = () => undefined;
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const versions = createCliVersionProbe({ probe, monotonicNow: () => 0 });
    const reads = [versions.observe('codex'), versions.observe('codex'), versions.observe('codex')];
    // The probe body runs on a microtask (a synchronously-throwing probe must not escape), so
    // its resolver is assigned one turn after `observe` is called.
    await Promise.resolve();
    release('codex-cli 0.149.0');
    expect(await Promise.all(reads)).toEqual(['0.149.0', '0.149.0', '0.149.0']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('caches a FAILED probe too, so a missing CLI is not probed every phase', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const versions = createCliVersionProbe({ probe, monotonicNow: () => 0 });
    expect(await versions.observe('nope')).toBeNull();
    expect(await versions.observe('nope')).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('never throws out of a phase, whatever the probe does', async () => {
    const versions = createCliVersionProbe({
      probe: () => {
        throw new Error('exploded synchronously');
      },
      monotonicNow: () => 0
    });
    await expect(versions.observe('boom')).resolves.toBeNull();
    await expect(observedVersionOf(null, 'anything')).resolves.toBeNull();
    await expect(
      observedVersionOf(
        {
          observedCliVersion: () => {
            throw new Error('registry exploded');
          }
        },
        'anything'
      )
    ).resolves.toBeNull();
  });
});

describe('what the payload records', () => {
  it('carries the version and never the path', async () => {
    // The end-to-end claim, checked on the payload construction path rather than on intent:
    // `phase-runner.ts` reads `this.observedCliVersion` into both records, and the value it holds
    // came through `normalizeCliVersion`, which cannot return a path unless the CLI printed one
    // on its first line ahead of its version — and the case above pins that too.
    const probe = vi.fn().mockResolvedValue('2.1.246 (Claude Code)');
    const versions = createCliVersionProbe({ probe, monotonicNow: () => 0 });
    const observed = await versions.observe('/Users/someone/.local/bin/claude');
    expect(observed).toBe('2.1.246');
    expect(observed).not.toContain('/');
  });

  it('observedVersionOf skips probing when aborted and rejects non-version values (16-14, 16-15)', async () => {
    const observedCliVersion = vi.fn().mockResolvedValue('raw-secret-line');
    const aborted = new AbortController();
    aborted.abort();
    expect(await observedVersionOf({ observedCliVersion }, '/bin/cli', aborted.signal)).toBeNull();
    expect(observedCliVersion).not.toHaveBeenCalled();

    expect(await observedVersionOf({ observedCliVersion }, '/bin/cli')).toBeNull();
    expect(observedCliVersion).toHaveBeenCalledTimes(1);
  });

  it('projectAuditPayload drops non-matching cliVersion/qualifiedCliVersion on phase-start (16-15)', () => {
    const projected = projectAuditPayload('phase-start', {
      phaseId: 'implement',
      runner: 'claude',
      cliVersion: 'SECRET /Users/alice/raw-stdout',
      qualifiedCliVersion: 'not-a-version'
    });
    expect(projected.cliVersion).toBeUndefined();
    expect(projected.qualifiedCliVersion).toBeUndefined();
    expect(projected.phaseId).toBe('implement');

    const valid = projectAuditPayload('phase-start', {
      phaseId: 'implement',
      runner: 'claude',
      cliVersion: '2.1.246',
      qualifiedCliVersion: '2.1.240'
    });
    expect(valid.cliVersion).toBe('2.1.246');
    expect(valid.qualifiedCliVersion).toBe('2.1.240');
  });
});

describe('SR-B8 -- PhaseRunner skips --version probe when pre-spawn containment or agent-config ack refuses', () => {
  const baseInputs = {
    runId: 'run-srb8',
    phase: 'implement' as const,
    iteration: 1,
    iterationCap: 3,
    featureDescription: 'test',
    featureDir: '/tmp/feat',
    carriedIssues: [],
    cliPath: '/usr/local/bin/claude',
    cwd: '/tmp/ws',
    timeoutMs: 5_000,
    rawTranscriptMode: 'off' as const
  };

  function makeRecordingAudit(): {
    writer: AuditLogWriter;
    entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>>;
  } {
    let seq = 0;
    const entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>> = [];
    const writer = {
      append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => {
        entries.push(entry);
        return { id: `audit-${++seq}`, timestamp: '2026-11-23T00:00:00.000Z', ...entry };
      })
    } as unknown as AuditLogWriter;
    return { writer, entries };
  }

  function makeSilentLogger(): SanitizedLogger {
    const logger = new SanitizedLogger();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.debug = vi.fn();
    return logger;
  }

  it('performs zero observedCliVersion calls when resolveRunner refuses an uncontained backend', async () => {
    const { writer, entries } = makeRecordingAudit();
    const observedCliVersion = vi.fn(async () => '2.1.246');
    const refusal = new UncontainedBackendRefusedError('claude', 'uncontained refused');
    const registry = {
      getGlobalDefault: () => 'claude' as const,
      getOrCreate: vi.fn(() => {
        throw refusal;
      }),
      observedCliVersion
    } as unknown as BackendRunnerRegistry;

    const runner = new PhaseRunner({
      runner: registry,
      promptBuilder: new PromptBuilder(),
      auditWriter: writer,
      logger: makeSilentLogger()
    });
    await expect(runner.run(baseInputs)).rejects.toBe(refusal);

    expect(observedCliVersion).not.toHaveBeenCalled();
    expect(entries.filter((e) => e.eventType === 'phase-start')).toHaveLength(1);
    const phaseEnd = entries.find((e) => e.eventType === 'phase-end');
    expect(phaseEnd?.payload).toMatchObject({ terminationReason: 'pre_spawn_refusal' });
  });

  it('performs zero observedCliVersion calls when agentConfigAckGate denies execution', async () => {
    const { writer, entries } = makeRecordingAudit();
    const observedCliVersion = vi.fn(async () => '2.1.246');
    const invoke = vi.fn();
    const registry = {
      getGlobalDefault: () => 'claude' as const,
      getOrCreate: vi.fn(() => ({
        hasActiveProcess: false,
        invoke,
        cancelActive: () => false,
        close: () => undefined,
        settleTeardowns: async () => []
      })),
      observedCliVersion
    } as unknown as BackendRunnerRegistry;

    const scanEntries = [
      {
        name: '.claude/settings.json',
        status: 'present' as const,
        size: 32,
        digest: 'a'.repeat(64),
        hookEvents: ['PreToolUse']
      }
    ];
    const ackGate = new AgentConfigAckGate({
      scan: async () => ({
        backend: 'claude' as const,
        entries: scanEntries,
        fingerprint: computeAgentConfigFingerprint('claude', scanEntries, false),
        persistable: true,
        scanError: false
      }),
      hasGrant: () => false,
      latestGrantForBackend: () => null,
      persistGrant: vi.fn(async () => undefined),
      request: async () => 'denied',
      appendAudit: async (entry) => writer.append(entry),
      logger: { warn: vi.fn() }
    });

    const runner = new PhaseRunner({
      runner: registry,
      promptBuilder: new PromptBuilder(),
      auditWriter: writer,
      logger: makeSilentLogger(),
      agentConfigAckGate: ackGate
    });

    await expect(runner.run(baseInputs)).rejects.toBeInstanceOf(
      AgentConfigAcknowledgementRefusedError
    );

    expect(observedCliVersion).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(entries.filter((e) => e.eventType === 'phase-start')).toHaveLength(1);
    const phaseEnd = entries.find((e) => e.eventType === 'phase-end');
    expect(phaseEnd?.payload).toMatchObject({ terminationReason: 'pre_spawn_refusal' });
  });

  it('control: still probes observedCliVersion and records cliVersion on phase-start when preflight succeeds', async () => {
    const { writer, entries } = makeRecordingAudit();
    const observedCliVersion = vi.fn(async () => '2.1.246');
    const stdoutBuffer = new ZippedStreamBuffer();
    stdoutBuffer.append(
      'PHASE_STATUS: CLEAN\n```json\n{"files_created":[],"files_modified":[],"files_deleted":[],"commands_executed":[]}\n```\n'
    );
    stdoutBuffer.finalize();
    const stderrBuffer = new ZippedStreamBuffer();
    stderrBuffer.finalize();
    const registry = {
      getGlobalDefault: () => 'claude' as const,
      getOrCreate: vi.fn(() => ({
        hasActiveProcess: false,
        invoke: vi.fn(async () => ({
          stdoutBuffer,
          stderrBuffer,
          exitCode: 0,
          killed: false,
          timedOut: false,
          durationMs: 5,
          command: baseInputs.cliPath
        })),
        cancelActive: () => false,
        close: () => undefined,
        settleTeardowns: async () => []
      })),
      observedCliVersion
    } as unknown as BackendRunnerRegistry;

    const runner = new PhaseRunner({
      runner: registry,
      promptBuilder: new PromptBuilder(),
      auditWriter: writer,
      logger: makeSilentLogger()
    });
    await runner.run(baseInputs);

    expect(observedCliVersion).toHaveBeenCalledTimes(1);
    const phaseStart = entries.find((e) => e.eventType === 'phase-start');
    expect(phaseStart?.payload).toMatchObject({ cliVersion: '2.1.246' });
  });
});
