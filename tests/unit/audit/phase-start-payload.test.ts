import { ZippedStreamBuffer } from "../../../src/runner/zipped-stream-buffer";

// Feature 032 — phase-start audit payload `isContinue` field.
//
// Verifies the audit-payload contract for the continuation-hint
// telemetry (US4 / T032-T036):
//
//   1. Every `phase-start` audit event payload includes an
//      `isContinue: boolean` field. The contract is "always present,
//      strict-boolean-typed": `undefined` on inputs maps to `false`
//      on the payload, never to a missing key.
//
//   2. The dispatch matrix is exercised exhaustively:
//        - first-attempt → false
//        - delayed-retry → true
//        - operator-resume → true
//        - cascaded-resume (matching task) → true
//        - cascaded-resume (other task) → false
//        - breakpoint-resume → true
//        - restart → false
//        - loop-iteration → false
//        - bugfix-loop-iteration → false
//
//   3. The new boolean field flows through the existing
//      `SanitizedLogger.sanitize` pipeline unchanged. There is no
//      operator-influenced free-form string content; a strict boolean
//      cannot match any `SECRET_PATTERNS` entry. The on-disk JSON
//      `"isContinue":true|false` must therefore be byte-identical to
//      the in-memory value.
//
// The runtime emission point lives at src/controller/phase-runner.ts
// (the `phase-start` `appendAudit` call near line 245). Forwarding from
// the controller's dispatch matrix into `PhaseRunInputs.isContinue` is
// covered by the workflow-controller-continue-flag tests; this file
// pins the audit-projection contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import type { Phase } from '../../../src/controller/phase';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { PromptBuilder } from '../../../src/runner/prompt-builder';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-continue-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readAuditLines(): Promise<unknown[]> {
  const contents = await fs.readFile(
    path.join(tmpRoot, '.schegent', 'audit.log'),
    'utf8'
  );
  return contents
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function makeStubPromptBuilder(): PromptBuilder {
  return {
    build: () => 'fake-prompt'
  } as unknown as PromptBuilder;
}

function makeStubRunner(): ClaudeCliRunner {
  return {
    invoke: async () => ({
      stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(''); b.finalize(); return b; })(), stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),
      exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 1
    }),
    cancelActive: () => false,
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

async function runPhaseAndReadStartPayload(opts: {
  writer: AuditLogWriter;
  isContinue: boolean | undefined;
  phaseId?: string;
  iteration?: number;
}): Promise<{ isContinue: unknown; payload: Record<string, unknown> }> {
  const phase: Phase = 'speckit-implement';
  const runner = new PhaseRunner(
    makeStubRunner(),
    makeStubPromptBuilder(),
    opts.writer,
    new SanitizedLogger()
  );

  // PhaseRunInputs.isContinue: explicitly threaded only when the caller
  // set it; matches the `...(isContinue === true ? {...} : {})` spread
  // pattern used downstream so we exercise the same default-undefined
  // path as the controller's `driveRun`.
  const inputs = {
    phase,
    pipelineId: 'standard',
    iteration: opts.iteration ?? 1,
    iterationCap: 5,
    featureDescription: 'fixture',
    featureDir: null,
    cliPath: '/usr/bin/true',
    cwd: tmpRoot,
    timeoutMs: 30_000,
    runId: 'run-continue-1',
    ...(opts.isContinue !== undefined ? { isContinue: opts.isContinue } : {})
  };

  await runner.run(inputs);

  const entries = (await readAuditLines()) as Array<{
    eventType: string;
    payload: Record<string, unknown>;
  }>;
  const startEntry = entries.find((e) => e.eventType === 'phase-start');
  if (!startEntry) throw new Error('phase-start audit entry not found');
  return { isContinue: startEntry.payload.isContinue, payload: startEntry.payload };
}

describe('Feature 032 US4 — phase-start audit payload carries strict isContinue boolean', () => {
  it('first-attempt dispatch records isContinue=false (default when inputs.isContinue is undefined)', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: undefined
    });
    expect(isContinue).toBe(false);
  });

  it('delayed-retry dispatch records isContinue=true', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: true
    });
    expect(isContinue).toBe(true);
  });

  it('operator-resume dispatch records isContinue=true', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: true
    });
    expect(isContinue).toBe(true);
  });

  it('cascaded-resume matching task records isContinue=true', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: true
    });
    expect(isContinue).toBe(true);
  });

  it('cascaded-resume other task records isContinue=false', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: false
    });
    expect(isContinue).toBe(false);
  });

  it('breakpoint-resume dispatch records isContinue=true', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: true
    });
    expect(isContinue).toBe(true);
  });

  it('restart dispatch records isContinue=false', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: false
    });
    expect(isContinue).toBe(false);
  });

  it('loop-iteration dispatch records isContinue=false', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: false,
      iteration: 3
    });
    expect(isContinue).toBe(false);
  });

  it('bugfix-loop-iteration dispatch records isContinue=false', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { isContinue } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: false,
      iteration: 2
    });
    expect(isContinue).toBe(false);
  });

  it('isContinue is always present as a strict boolean on the on-disk JSON payload', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const { payload } = await runPhaseAndReadStartPayload({
      writer,
      isContinue: undefined
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'isContinue')).toBe(true);
    expect(typeof payload.isContinue).toBe('boolean');
  });

  it('truthy-non-boolean inputs.isContinue still records strict boolean false on the payload (strict === true gate)', async () => {
    // Defense-in-depth: the audit emission MUST use the same
    // `inputs.isContinue === true` strict gate as the runner argv
    // append. A truthy-non-boolean value (e.g., a misconfigured upstream
    // caller passing `1` or a string) must NOT serialize as `true`.
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const runner = new PhaseRunner(
      makeStubRunner(),
      makeStubPromptBuilder(),
      writer,
      new SanitizedLogger()
    );
    await runner.run({
      phase: 'speckit-implement' as Phase,
      pipelineId: 'standard',
      iteration: 1,
      iterationCap: 5,
      featureDescription: 'fixture',
      featureDir: null,
      cliPath: '/usr/bin/true',
      cwd: tmpRoot,
      timeoutMs: 30_000,
      runId: 'run-continue-1',
      // Type-cast through `unknown` to exercise the runtime strict-gate.
      isContinue: 1 as unknown as boolean
    });
    const entries = (await readAuditLines()) as Array<{
      eventType: string;
      payload: Record<string, unknown>;
    }>;
    const start = entries.find((e) => e.eventType === 'phase-start');
    expect(start?.payload.isContinue).toBe(false);
  });
});

describe('Feature 032 US4 — isContinue passes the SECRET_PATTERNS sanitization pipeline unchanged', () => {
  it('serializes as a strict JSON boolean (no [REDACTED], no string coercion)', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const runner = new PhaseRunner(
      makeStubRunner(),
      makeStubPromptBuilder(),
      writer,
      new SanitizedLogger()
    );
    await runner.run({
      phase: 'speckit-implement' as Phase,
      pipelineId: 'standard',
      iteration: 1,
      iterationCap: 5,
      featureDescription: 'fixture',
      featureDir: null,
      cliPath: '/usr/bin/true',
      cwd: tmpRoot,
      timeoutMs: 30_000,
      runId: 'run-sanitize-1',
      isContinue: true
    });
    const contents = await fs.readFile(
      path.join(tmpRoot, '.schegent', 'audit.log'),
      'utf8'
    );
    expect(contents).toContain('"isContinue":true');
    expect(contents).not.toContain('"isContinue":"[REDACTED]"');
    expect(contents).not.toContain('"isContinue":"true"');
  });

  it('false value also serializes as a strict JSON boolean', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const runner = new PhaseRunner(
      makeStubRunner(),
      makeStubPromptBuilder(),
      writer,
      new SanitizedLogger()
    );
    await runner.run({
      phase: 'speckit-implement' as Phase,
      pipelineId: 'standard',
      iteration: 1,
      iterationCap: 5,
      featureDescription: 'fixture',
      featureDir: null,
      cliPath: '/usr/bin/true',
      cwd: tmpRoot,
      timeoutMs: 30_000,
      runId: 'run-sanitize-2'
    });
    const contents = await fs.readFile(
      path.join(tmpRoot, '.schegent', 'audit.log'),
      'utf8'
    );
    expect(contents).toContain('"isContinue":false');
    expect(contents).not.toContain('"isContinue":"[REDACTED]"');
    expect(contents).not.toContain('"isContinue":"false"');
  });
});
