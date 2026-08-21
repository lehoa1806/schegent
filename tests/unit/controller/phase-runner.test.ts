import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type {
  RawTranscriptCapture,
  RawTranscriptWriter
} from '../../../src/audit/raw-transcript-writer';
import type {
  InvocationOutputSink,
  RawInvocationOutput,
  InvocationRequest
} from '../../../src/runner/invocation-result';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { RequiredEvidenceUnavailableError } from '../../../src/lib/errors';

// Feature 107 (T623) — the token trails the audit block, as it always should
// have. `.specify/memory/constitution.md` § Output Formatting & Loop
// Termination has required the token to be "the **last non-empty line** of
// stdout for terminal phases" since the contract was written; this fixture put
// it first, which no compliant run ever emits. The host did not enforce the
// rule until the trailing region landed, so the fixture passed anyway. Moving
// it corrects the fixture rather than accommodating a behavior change.
const cleanStdout = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: ["specs/001-mock/spec.md"]',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["mock specify"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

type MockRawOutput = Omit<Partial<RawInvocationOutput>, 'stdoutBuffer' | 'stderrBuffer'> & { stdout?: string; stderr?: string };

function makeRawOutput(overrides: MockRawOutput = {}): RawInvocationOutput {
  const stdoutStr = overrides.stdout ?? cleanStdout;
  const stderrStr = overrides.stderr ?? '';
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(stdoutStr);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.append(stderrStr);
  stderrBuffer.finalize();

  return {
    stdoutBuffer,
    stderrBuffer,
    exitCode: overrides.exitCode !== undefined ? overrides.exitCode : 0,
    killed: overrides.killed ?? false,
    timedOut: overrides.timedOut ?? false,
    durationMs: overrides.durationMs ?? 50,
    completedAwaitingExit: overrides.completedAwaitingExit,
    diagnosticWarnings: overrides.diagnosticWarnings,
    command: overrides.command,
    cliSessionId: overrides.cliSessionId
  };
}

function makeFakeRunner(invokeImpl: (req: InvocationRequest) => Promise<RawInvocationOutput>): ClaudeCliRunner {
  return {
    invoke: vi.fn(invokeImpl),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

function makeFakeAuditWriter(): AuditLogWriter {
  let counter = 0;
  return {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => ({
      id: `audit-${++counter}`,
      timestamp: '2026-05-08T00:00:00Z',
      ...entry
    })),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

function makeFakeRawTranscript(): RawTranscriptWriter {
  return {
    appendStart: vi.fn(async () => undefined),
    createInvocationCapture: vi.fn(async () => null),
    appendEnd: vi.fn(async () => undefined)
  } as unknown as RawTranscriptWriter;
}

let runner: PhaseRunner;
let cliRunner: ClaudeCliRunner;
let auditWriter: AuditLogWriter;

const baseInputs = {
  phase: 'speckit-specify' as const,
  iteration: 1,
  iterationCap: 10,
  featureDescription: 'desc',
  featureDir: 'specs/001-mock',
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 5_000,
  runId: 'run-1'
};

describe('PhaseRunner.run', () => {
  beforeEach(() => {
    auditWriter = makeFakeAuditWriter();
  });

  it('fails closed before CLI invocation when phase-start audit is not durable', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    vi.mocked(auditWriter.append).mockRejectedValueOnce(
      Object.assign(new Error('sensitive workspace path omitted'), { code: 'ENOSPC' })
    );
    runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger()
    );

    await expect(runner.run(baseInputs)).rejects.toEqual(
      expect.objectContaining<Partial<RequiredEvidenceUnavailableError>>({
        name: 'RequiredEvidenceUnavailableError',
        code: 'audit-evidence-unavailable',
        eventType: 'phase-start'
      })
    );
    expect(cliRunner.invoke).not.toHaveBeenCalled();
  });

  it('returns clean outcome when stdout has token + audit', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.outcome).toBe('clean');
    expect(out.terminationReason).toBe('token');
    expect(out.result.kind).toBe('clean');
    expect(out.exitCode).toBe(0);
    // phase-start and metadata-only cli-invocation precede phase-end.
    expect(out.auditEntryId).toBe('audit-3');
  });

  it('adds runner duration and stream-json usage metrics to phase-end audit payload', async () => {
    const stdout = [
      cleanStdout,
      JSON.stringify({
        type: 'result',
        duration_ms: 1234,
        num_turns: 3,
        total_cost_usd: 0.0042,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 9
        }
      })
    ].join('\n');
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout, durationMs: 99 }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());

    await runner.run(baseInputs);

    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-end',
        payload: expect.objectContaining({
          durationMs: 99,
          cliDurationMs: 1234,
          numTurns: 3,
          totalCostUsd: 0.0042,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 7,
          cacheReadInputTokens: 9
        })
      })
    );
  });

  it('records bounded-output truncation flags on phase-end', async () => {
    const stdoutBuffer = new ZippedStreamBuffer(4, 12);
    stdoutBuffer.append('0123456789ABCDEFGHIJ');
    stdoutBuffer.finalize();
    const stderrBuffer = new ZippedStreamBuffer(4, 12);
    stderrBuffer.finalize();
    cliRunner = makeFakeRunner(async () => ({
      stdoutBuffer,
      stderrBuffer,
      exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 25
    }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());

    await runner.run(baseInputs);

    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const end = appendFn.mock.calls.find((call) => call[0].eventType === 'phase-end');
    expect(end?.[0].payload).toMatchObject({
      runner: 'claude',
      stdoutTruncated: true
    });
    expect(end?.[0].payload).not.toHaveProperty('stderrTruncated');
  });

  it('does not classify truncated head/tail output as clean when fatal evidence may be discarded', async () => {
    const stdoutBuffer = new ZippedStreamBuffer(4, 2_048);
    stdoutBuffer.append(
      [
        'h'.repeat(1_024),
        'error: unknown option --unsafe-middle',
        'm'.repeat(4_096),
        cleanStdout
      ].join('\n')
    );
    stdoutBuffer.finalize();
    const stderrBuffer = new ZippedStreamBuffer(4, 2_048);
    stderrBuffer.finalize();
    expect(stdoutBuffer.truncated).toBe(true);
    expect(stdoutBuffer.getTrailingLines(100)).not.toContain('error: unknown option');
    expect(stdoutBuffer.getTrailingLines(100)).toContain('[SCHEGENT_STATUS: CLEAR]');

    cliRunner = makeFakeRunner(async () => ({
      stdoutBuffer,
      stderrBuffer,
      exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 25
    }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());

    const output = await runner.run(baseInputs);

    expect(output.result).toMatchObject({
      kind: 'malformed',
      warnings: ['output-truncated-unclassifiable']
    });
    // Never advance — but not run-terminal. `transient_error` halts the phase
    // to paused and takes the delayed-retry path; `failed` on a required
    // phase would discard the rest of the pipeline for output volume alone.
    expect(output.outcome).toBe('transient_error');
    expect(output.terminationReason).toBe('error');
  });

  it('classifies a discarded-middle signature as fatal from the runner stream scan', async () => {
    // Companion to the test above: same buffer, same unreachable signature,
    // but the runner reports the incremental scan it now performs over every
    // emitted byte. That recovers the fatal classification the retained
    // head/tail cannot support, so the outcome is terminal on evidence
    // rather than on truncation.
    const stdoutBuffer = new ZippedStreamBuffer(4, 2_048);
    stdoutBuffer.append(
      [
        'h'.repeat(1_024),
        'error: unknown option --unsafe-middle',
        'm'.repeat(4_096),
        cleanStdout
      ].join('\n')
    );
    stdoutBuffer.finalize();
    const stderrBuffer = new ZippedStreamBuffer(4, 2_048);
    stderrBuffer.finalize();
    expect(stdoutBuffer.getTrailingLines(100)).not.toContain('error: unknown option');

    cliRunner = makeFakeRunner(async () => ({
      stdoutBuffer,
      stderrBuffer,
      exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 25,
      streamFatalMatch: {
        matched: true as const,
        signature: 'error: unknown option',
        stream: 'stdout' as const,
        source: 'built-in' as const
      }
    }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());

    const output = await runner.run(baseInputs);

    expect(output.result).toMatchObject({
      kind: 'malformed',
      fatalCause: 'error: unknown option'
    });
    expect(output.outcome).toBe('failed');
    expect(output.terminationReason).toBe('error');
  });

  it.each(['Open questions:', 'Remaining issues:'] as const)(
    'does not advance truncated output classified from %s',
    async (heading) => {
      const stdoutBuffer = new ZippedStreamBuffer(4, 2_048);
      stdoutBuffer.append([
        'h'.repeat(1_024),
        'error: unknown option --discarded-middle',
        'm'.repeat(4_096),
        heading,
        '- retained issue'
      ].join('\n'));
      stdoutBuffer.finalize();
      const stderrBuffer = new ZippedStreamBuffer(4, 2_048);
      stderrBuffer.finalize();
      cliRunner = makeFakeRunner(async () => ({
        stdoutBuffer,
        stderrBuffer,
        exitCode: 0,
        killed: false,
        timedOut: false,
        durationMs: 25
      }));
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger()
      );

      const output = await runner.run({ ...baseInputs, phase: 'speckit-clarify' });

      // Feature 107 (T623, FR-032) — `[constitution] missing audit log` now
      // survives the truncation rewrite. It was always constructed; before this
      // feature `failClosedOnTruncatedOutput` read `warnings` only off the
      // `malformed` variant, so a warning built on any other path was dropped
      // here and this assertion pinned the loss. The truncation marker stays
      // last, because that is the classification the outcome is derived from.
      expect(output.result).toMatchObject({
        kind: 'malformed',
        warnings: ['[constitution] missing audit log', 'output-truncated-unclassifiable']
      });
      expect(output.outcome).toBe('transient_error');
      expect(output.terminationReason).toBe('error');
    }
  );

  it('parses a valid phase-message.env sidecar and emits metadata-only audit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-msg-'));
    // Feature 056 Track 2 — host-computed canonical sidecar path. The
    // sidecar MUST live at the canonical location for the read to be
    // accepted (the canonical-first preference ignores audit-reported
    // paths entirely when the canonical file exists).
    const sidecar = path.join(dir, 'phase-message.env');
    await fs.writeFile(sidecar, 'next_step=continue\nnotes=hello', 'utf8');
    const stdout = cleanStdout.replace(
      'files_created: ["specs/001-mock/spec.md"]',
      `files_created: ["${sidecar}"]`
    );
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, cwd: dir, phaseMessagePath: sidecar });
    expect(out.phaseMessage?.entries).toEqual({ next_step: 'continue', notes: 'hello' });
    expect(out.phaseMessage?.entryCount).toBe(2);
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-message-emitted',
        payload: expect.objectContaining({ entryCount: 2, byteSize: 30 })
      })
    );
  });

  it('returns no phase message when no sidecar is referenced', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.phaseMessage).toBeNull();
    expect(auditWriter.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: expect.stringMatching(/^phase-message-/) })
    );
  });

  it('drops malformed phase-message lines but forwards valid sanitized values', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-msg-'));
    const sidecar = path.join(dir, 'phase-message.env');
    await fs.writeFile(
      sidecar,
      'next_step=continue\nmissing_equals\nbad key=value\nsecret=Bearer abcdefghijklmnopqrstuvwxyz',
      'utf8'
    );
    const stdout = cleanStdout.replace(
      'files_created: ["specs/001-mock/spec.md"]',
      `files_created: ["${sidecar}"]`
    );
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, cwd: dir, phaseMessagePath: sidecar });
    expect(out.phaseMessage?.entries).toEqual({
      next_step: 'continue',
      secret: '[REDACTED]'
    });
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-message-invalid',
        payload: expect.objectContaining({ reason: 'malformed-lines', invalidLines: 1, invalidKeys: 1 })
      })
    );
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-message-emitted',
        payload: expect.objectContaining({ entryCount: 2 })
      })
    );
  });

  it('drops oversized phase-message.env sidecars', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-msg-'));
    const sidecar = path.join(dir, 'phase-message.env');
    await fs.writeFile(sidecar, `x=${'a'.repeat(4095)}`, 'utf8');
    const stdout = cleanStdout.replace(
      'files_created: ["specs/001-mock/spec.md"]',
      `files_created: ["${sidecar}"]`
    );
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, cwd: dir, phaseMessagePath: sidecar });
    expect(out.phaseMessage?.truncated).toBe(true);
    expect(out.phaseMessage?.entryCount).toBe(0);
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'phase-message-truncated' })
    );
  });

  it('emits duplicate-sidecar and accepts only the candidate matching the canonical path', async () => {
    // Feature 056 Track 2 — duplicate-sidecar fires when the audit
    // reports multiple `phase-message.env` candidates AND the canonical
    // file does not exist on disk (otherwise canonical-first ignores
    // audit entirely). Only the candidate equal to the canonical
    // path is accepted; the other is rejected silently and the
    // duplicate-sidecar warning is still emitted as a defense-in-depth
    // record of the operator-influenced ambiguity.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-msg-'));
    const canonical = path.join(dir, 'phase-message.env');
    const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-msg-'));
    const decoy = path.join(secondDir, 'phase-message.env');
    await fs.writeFile(canonical, 'chosen=yes', 'utf8');
    await fs.writeFile(decoy, 'chosen=no', 'utf8');
    // Disable the canonical-first preference for this scenario by
    // pointing `phaseMessagePath` at a path that will exist (the
    // canonical) but the audit reports the decoy first. The
    // canonical-first preference WILL fire because the file exists,
    // so the decoy is never read. To exercise the duplicate-sidecar
    // warning we must force step 2 by ensuring the canonical does not
    // exist. Use a different canonical that does not exist yet.
    const nonexistentCanonical = path.join(dir, 'canonical-not-on-disk.env');
    // After the runner reads via step 2, only canonical-matching
    // candidates are accepted. Point the audit at the canonical (which
    // does not exist on disk) AND a decoy; expect missing-canonical.
    const stdout = cleanStdout.replace(
      'files_created: ["specs/001-mock/spec.md"]',
      `files_created: ["${decoy}", "${canonical}"]`
    );
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run({
      ...baseInputs,
      cwd: dir,
      phaseMessagePath: nonexistentCanonical
    });
    expect(out.phaseMessage?.invalidReason).toBe('path-outside-run-dir');
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-message-invalid',
        payload: expect.objectContaining({ reason: 'duplicate-sidecar', candidateCount: 2 })
      })
    );
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-message-invalid',
        payload: expect.objectContaining({ reason: 'path-outside-run-dir' })
      })
    );
  });

  it('marks a referenced missing phase-message.env as missing-sidecar', async () => {
    // Feature 056 Track 2 — when the audit references the canonical
    // path but no file exists on disk, the final read attempt still
    // uses the legacy `missing-sidecar` reason.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-msg-'));
    const sidecar = path.join(dir, 'phase-message.env');
    const stdout = cleanStdout.replace(
      'files_created: ["specs/001-mock/spec.md"]',
      `files_created: ["${sidecar}"]`
    );
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, cwd: dir, phaseMessagePath: sidecar });
    expect(out.phaseMessage?.invalidReason).toBe('missing-sidecar');
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-message-invalid',
        payload: expect.objectContaining({ reason: 'missing-sidecar' })
      })
    );
  });

  it('rejects duplicate phase-message keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-msg-'));
    const sidecar = path.join(dir, 'phase-message.env');
    await fs.writeFile(sidecar, 'x=1\nx=2', 'utf8');
    const stdout = cleanStdout.replace(
      'files_created: ["specs/001-mock/spec.md"]',
      `files_created: ["${sidecar}"]`
    );
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, cwd: dir, phaseMessagePath: sidecar });
    expect(out.phaseMessage?.invalidReason).toBe('duplicate-keys');
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-message-invalid',
        payload: expect.objectContaining({ reason: 'duplicate-keys' })
      })
    );
  });

  // Feature 056 Track 2 (FR-006..FR-012) — canonical-path containment.
  // The CLI stdout (and therefore the audit `filesCreated` /
  // `filesModified` arrays) is operator-influenced and can contain
  // attacker-controlled paths via a malicious phase prompt or repo file.
  // These tests pin the new canonical-first preference + per-candidate
  // canonical-equality check that closes the F-002 gap.
  describe('Feature 056 Track 2 — canonical-path defense', () => {
    it('prefers canonical sidecar entirely; audit-reported paths are ignored when canonical exists', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-canon-'));
      const canonical = path.join(dir, 'canon-phase-message.env');
      await fs.writeFile(canonical, 'route=canonical', 'utf8');
      const attackerPath = path.join(dir, 'subdir', 'phase-message.env');
      await fs.mkdir(path.dirname(attackerPath), { recursive: true });
      await fs.writeFile(attackerPath, 'route=attacker', 'utf8');
      const stdout = cleanStdout.replace(
        'files_created: ["specs/001-mock/spec.md"]',
        `files_created: ["${attackerPath}"]`
      );
      cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run({
        ...baseInputs,
        cwd: dir,
        phaseMessagePath: canonical
      });
      // The canonical wins — the attacker-named file is ignored.
      expect(out.phaseMessage?.entries).toEqual({ route: 'canonical' });
    });

    it('rejects audit candidates outside the canonical path with path-outside-run-dir', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-canon-'));
      const canonicalThatDoesNotExist = path.join(dir, 'canonical.env');
      // Create an attacker-named sibling with the right basename.
      const attackerPath = path.join(dir, 'attacker', 'phase-message.env');
      await fs.mkdir(path.dirname(attackerPath), { recursive: true });
      await fs.writeFile(attackerPath, 'leak=secret', 'utf8');
      const stdout = cleanStdout.replace(
        'files_created: ["specs/001-mock/spec.md"]',
        `files_created: ["${attackerPath}"]`
      );
      cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run({
        ...baseInputs,
        cwd: dir,
        phaseMessagePath: canonicalThatDoesNotExist
      });
      expect(out.phaseMessage?.invalidReason).toBe('path-outside-run-dir');
      expect(out.phaseMessage?.entries).toEqual({});
      expect(auditWriter.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'phase-message-invalid',
          payload: expect.objectContaining({ reason: 'path-outside-run-dir' })
        })
      );
    });

    it('rejects path-traversal payloads that basename-match phase-message.env', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-canon-'));
      const canonical = path.join(dir, 'canon-phase-message.env');
      // Canonical does not exist on disk; audit reports a `..`-escape
      // candidate with the right basename.
      const traversal = `${dir}/sub/../../phase-message.env`;
      const stdout = cleanStdout.replace(
        'files_created: ["specs/001-mock/spec.md"]',
        `files_created: ["${traversal}"]`
      );
      cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run({
        ...baseInputs,
        cwd: dir,
        phaseMessagePath: canonical
      });
      // The resolved candidate is `<parent-of-dir>/phase-message.env`
      // which does not byte-match the canonical → path-outside-run-dir.
      expect(out.phaseMessage?.invalidReason).toBe('path-outside-run-dir');
    });

    it('returns null with no phase-message audit when no audit candidate basename-matches', async () => {
      // Audit reports a different filename entirely so the basename
      // filter strips it. With no candidates remaining the runner
      // returns null — there is nothing to attribute. The
      // This pins the null behavior to keep the audit log noise-free
      // when there is genuinely no sidecar.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-canon-'));
      const canonical = path.join(dir, 'canon-phase-message.env');
      cliRunner = makeFakeRunner(async () => makeRawOutput());
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run({
        ...baseInputs,
        cwd: dir,
        phaseMessagePath: canonical
      });
      // The default cleanStdout has files_created: ["specs/001-mock/spec.md"]
      // which does not basename-match `phase-message.env`, so the
      // runner returns null with no audit invalid event.
      expect(out.phaseMessage).toBeNull();
    });

    it('does NOT reach phase-message-emitted when audit candidates are rejected', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-canon-'));
      const canonical = path.join(dir, 'canonical-does-not-exist.env');
      const attackerPath = path.join(dir, 'attacker', 'phase-message.env');
      await fs.mkdir(path.dirname(attackerPath), { recursive: true });
      await fs.writeFile(attackerPath, 'route=attacker', 'utf8');
      const stdout = cleanStdout.replace(
        'files_created: ["specs/001-mock/spec.md"]',
        `files_created: ["${attackerPath}"]`
      );
      cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({
        ...baseInputs,
        cwd: dir,
        phaseMessagePath: canonical
      });
      expect(auditWriter.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'phase-message-emitted' })
      );
    });

    it('the canonical-first preference defends against an attacker-named file at a sibling path', async () => {
      // Even though the attacker file exists with the right basename
      // and the audit log references it, the canonical takes
      // precedence and the attacker file is not read.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-canon-'));
      const canonical = path.join(dir, 'canonical-phase-message.env');
      const attackerPath = path.join(dir, '..', 'phase-message.env');
      // Don't actually create the parent-dir file (could collide with
      // other tests); just point the audit at it.
      await fs.writeFile(canonical, 'src=canonical', 'utf8');
      const stdout = cleanStdout.replace(
        'files_created: ["specs/001-mock/spec.md"]',
        `files_created: ["${attackerPath}"]`
      );
      cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run({
        ...baseInputs,
        cwd: dir,
        phaseMessagePath: canonical
      });
      expect(out.phaseMessage?.entries).toEqual({ src: 'canonical' });
    });

    it('rejects a symlink at the canonical sidecar path with path-symlink-redirect', async () => {
      // Audit-gap remediation (HIGH): the Step 1 canonical existence
      // check previously used `fs.stat`, which follows symlinks. A
      // malicious phase prompt could write `<canonical>/phase-message.env`
      // as a symlink to /etc/passwd, a workspace secret, or any other
      // file; `fs.stat` would return isFile=true, and
      // `readAndParsePhaseMessage` would dereference the symlink via
      // `fs.readFile` and parse the link target as key=value pairs that
      // flow into the next phase's prompt.
      //
      // The fix (1) replaces `fs.stat` with `fs.lstat` in Step 1 so
      // symlinks fall through to Step 2 and (2) adds an `lstat()` gate
      // inside `readAndParsePhaseMessage` so the Step 2 audit-accepted
      // path also rejects symlinks with the distinct
      // `path-symlink-redirect` audit reason.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-symlink-'));
      try {
        const target = path.join(dir, 'secret.txt');
        await fs.writeFile(target, 'leak=secret', 'utf8');
        const canonical = path.join(dir, 'phase-message.env');
        await fs.symlink(target, canonical);
        const stdout = cleanStdout.replace(
          'files_created: ["specs/001-mock/spec.md"]',
          `files_created: ["${canonical}"]`
        );
        cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
        runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
        const out = await runner.run({
          ...baseInputs,
          cwd: dir,
          phaseMessagePath: canonical
        });
        // The symlink target is NEVER read — entries stay empty.
        expect(out.phaseMessage?.invalidReason).toBe('path-symlink-redirect');
        expect(out.phaseMessage?.entries).toEqual({});
        expect(auditWriter.append).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'phase-message-invalid',
            payload: expect.objectContaining({ reason: 'path-symlink-redirect' })
          })
        );
        expect(auditWriter.append).not.toHaveBeenCalledWith(
          expect.objectContaining({ eventType: 'phase-message-emitted' })
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a symlink at the canonical path even when audit reports a sibling file', async () => {
      // Defense-in-depth: an attacker may plant a symlink at the
      // canonical path AND write an audit-reported sibling file with
      // the same basename. Step 1's lstat falls through (symlink).
      // Step 2 enumerates candidates; the sibling does NOT match the
      // canonical path by byte-equality so it is rejected as
      // `path-outside-run-dir`. The symlink target is never read.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-phase-symlink-'));
      try {
        const target = path.join(dir, 'secret.txt');
        await fs.writeFile(target, 'leak=secret', 'utf8');
        const canonical = path.join(dir, 'phase-message.env');
        await fs.symlink(target, canonical);
        const siblingDir = path.join(dir, 'sibling');
        await fs.mkdir(siblingDir, { recursive: true });
        const sibling = path.join(siblingDir, 'phase-message.env');
        await fs.writeFile(sibling, 'route=sibling', 'utf8');
        const stdout = cleanStdout.replace(
          'files_created: ["specs/001-mock/spec.md"]',
          `files_created: ["${sibling}"]`
        );
        cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
        runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
        const out = await runner.run({
          ...baseInputs,
          cwd: dir,
          phaseMessagePath: canonical
        });
        expect(out.phaseMessage?.invalidReason).toBe('path-outside-run-dir');
        expect(out.phaseMessage?.entries).toEqual({});
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('returns issues_remain on Open questions block', async () => {
    const stdout = [
      'Open questions:',
      '- need scope clarification',
      '=== SCHEGENT AUDIT LOG ===',
      'phase: speckit-clarify',
      'files_created: []',
      'files_modified: []',
      'files_deleted: []',
      'commands_executed: ["speckit-clarify"]',
      'network_calls: ["none"]',
      'ruleset_switches: ["none"]',
      'notes: outstanding',
      '=== END AUDIT LOG ==='
    ].join('\n');
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, phase: 'speckit-clarify' });
    expect(out.outcome).toBe('issues_remain');
    expect(out.terminationReason).toBe('open_questions');
  });

  it('returns rate_limited when stderr contains rate-limit phrase', async () => {
    cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ stdout: '', stderr: 'error: rate limit reached', exitCode: 1 })
    );
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.outcome).toBe('rate_limited');
    expect(out.terminationReason).toBe('rate_limit');
  });

  it('returns timeout outcome when CLI runner reports timedOut', async () => {
    cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ stdout: '', timedOut: true, killed: true, exitCode: null, durationMs: 321 })
    );
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.outcome).toBe('timeout');
    expect(out.terminationReason).toBe('timeout');
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-end',
        payload: expect.objectContaining({
          outcome: 'timeout',
          terminationReason: 'timeout',
          durationMs: 321
        })
      })
    );
  });

  it('returns failed outcome when killed without exit code', async () => {
    cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ stdout: '', killed: true, exitCode: null })
    );
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.outcome).toBe('failed');
    expect(out.terminationReason).toBe('cancel');
  });

  it('passes the prompt produced by PromptBuilder to the CLI', async () => {
    const seenRequests: InvocationRequest[] = [];
    cliRunner = makeFakeRunner(async (req) => {
      seenRequests.push(req);
      return makeRawOutput();
    });
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run(baseInputs);
    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0];
    expect(req.prompt).toContain('SCHEGENT_PHASE: speckit-specify');
    expect(req.env).toMatchObject({ SCHEGENT_PHASE: 'speckit-specify' });
  });

  it('forwards the strict CLI environment policy to the runner', async () => {
    const seenRequests: InvocationRequest[] = [];
    cliRunner = makeFakeRunner(async (req) => {
      seenRequests.push(req);
      return makeRawOutput();
    });
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run({
      ...baseInputs,
      inheritProcessEnv: false,
      processEnvAllowlist: ['HTTPS_PROXY']
    });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].inheritProcessEnv).toBe(false);
    expect(seenRequests[0].processEnvAllowlist).toEqual(['HTTPS_PROXY']);
    expect(seenRequests[0].env).toMatchObject({ SCHEGENT_PHASE: 'speckit-specify' });
  });

  it('truncates very long stdout in summary', async () => {
    // The head token is deliberate: it is out of region and must not be read as a
    // verdict. `cleanStdout` supplies the in-region one, so the assertion under
    // test (summary truncation) is unaffected either way.
    const huge = 'x'.repeat(10_000) + '\n[SCHEGENT_STATUS: CLEAR]\n' + cleanStdout;
    cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout: huge }));
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.stdoutSummary.length).toBeLessThanOrEqual(4 * 1024);
  });

  it('wraps invocation with rawTranscript appendStart (pre-invoke) and appendEnd (post-invoke) on success (T006, US1)', async () => {
    const invokeOrder: string[] = [];
    cliRunner = makeFakeRunner(async () => {
      invokeOrder.push('invoke');
      return makeRawOutput();
    });
    const rawTranscript = makeFakeRawTranscript();
    (rawTranscript.appendStart as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      invokeOrder.push('appendStart');
    });
    (rawTranscript.appendEnd as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      invokeOrder.push('appendEnd');
    });

    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger(), rawTranscript);
    await runner.run(baseInputs);

    expect(invokeOrder).toEqual(['appendStart', 'invoke', 'appendEnd']);
    expect(rawTranscript.appendStart).toHaveBeenCalledTimes(1);
    expect(rawTranscript.appendEnd).toHaveBeenCalledTimes(1);
    const startArgs = (rawTranscript.appendStart as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(startArgs).toMatchObject({
      runId: 'run-1',
      phase: 'speckit-specify',
      iteration: 1
    });
    expect(typeof startArgs.prompt).toBe('string');
    expect(startArgs.prompt.length).toBeGreaterThan(0);

    const endArgs = (rawTranscript.appendEnd as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(endArgs).toMatchObject({
      runId: 'run-1',
      killed: false,
      timedOut: false,
      exitCode: 0
    });
  });

  it('passes the disk-backed transcript capture to the runner and finalizer', async () => {
    const capture: RawTranscriptCapture = {
      failed: false,
      write: vi.fn(() => true),
      onceDrain: vi.fn(),
      finish: vi.fn(async () => undefined),
      appendStreamTo: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    };
    const invoke = vi.fn(async (
      _request: InvocationRequest,
      _outputSink?: InvocationOutputSink
    ) => makeRawOutput());
    cliRunner = {
      invoke,
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner;
    const rawTranscript = makeFakeRawTranscript();
    (rawTranscript.createInvocationCapture as ReturnType<typeof vi.fn>)
      .mockResolvedValue(capture);
    runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      rawTranscript
    );

    await runner.run(baseInputs);

    expect(invoke.mock.calls[0][1]).toBe(capture);
    expect(rawTranscript.appendEnd).toHaveBeenCalledWith(
      expect.objectContaining({ capture })
    );
  });

  it('still calls rawTranscript.appendEnd on the timeout path (T009, US3)', async () => {
    cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ stdout: '', timedOut: true, killed: true, exitCode: null })
    );
    const rawTranscript = makeFakeRawTranscript();
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger(), rawTranscript);
    await runner.run(baseInputs);

    expect(rawTranscript.appendStart).toHaveBeenCalledTimes(1);
    expect(rawTranscript.appendEnd).toHaveBeenCalledTimes(1);
    const endArgs = (rawTranscript.appendEnd as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(endArgs).toMatchObject({
      runId: 'run-1',
      timedOut: true,
      killed: true,
      exitCode: null
    });
  });

  it('still calls rawTranscript.appendEnd on the cancel path (T010, US3)', async () => {
    cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ stdout: '', killed: true, exitCode: null, timedOut: false })
    );
    const rawTranscript = makeFakeRawTranscript();
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger(), rawTranscript);
    await runner.run(baseInputs);

    expect(rawTranscript.appendStart).toHaveBeenCalledTimes(1);
    expect(rawTranscript.appendEnd).toHaveBeenCalledTimes(1);
    const endArgs = (rawTranscript.appendEnd as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(endArgs).toMatchObject({
      runId: 'run-1',
      killed: true,
      exitCode: null,
      timedOut: false
    });
  });

  describe('phase.retry_evaluated audit event (010, T024, US2)', () => {
    const customPhaseDef = {
      id: 'security-audit',
      name: 'Security Audit',
      instruction: 'Audit the project.',
      
      retryCondition: 'open_questions > 0'
    };

    const cleanStdoutWithMetric = (metricLine: string) =>
      [
        '=== SCHEGENT AUDIT LOG ===',
        'phase: security-audit',
        'files_created: []',
        'files_modified: []',
        'files_deleted: []',
        'commands_executed: ["audit"]',
        'network_calls: ["none"]',
        'ruleset_switches: ["none"]',
        'notes: ok',
        metricLine,
        '=== END AUDIT LOG ===',
        '[SCHEGENT_STATUS: CLEAR]'
      ].join('\n');

    it('emits exactly one phase.retry_evaluated event with expression+metrics+decision (FR-017)', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: cleanStdoutWithMetric('open_questions: 2') })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({
        ...baseInputs,
        phase: 'security-audit',
        pipelineId: 'security',
        phaseDef: customPhaseDef
      });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const retryEvts = appendFn.mock.calls.filter(
        (c) => c[0].eventType === 'phase.retry_evaluated'
      );
      expect(retryEvts).toHaveLength(1);
      const evt = retryEvts[0][0];
      expect(evt.outcome).toBe('info');
      expect(evt.payload).toMatchObject({
        expression: 'open_questions > 0',
        metrics: { open_questions: 2 },
        decision: true,
        pipelineId: 'security',
        phaseId: 'security-audit'
      });
    });

    it('emits decision: false on falsy outcome', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: cleanStdoutWithMetric('open_questions: 0') })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({
        ...baseInputs,
        phase: 'security-audit',
        pipelineId: 'security',
        phaseDef: customPhaseDef
      });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const retryEvts = appendFn.mock.calls.filter(
        (c) => c[0].eventType === 'phase.retry_evaluated'
      );
      expect(retryEvts).toHaveLength(1);
      expect(retryEvts[0][0].payload.decision).toBe(false);
    });

    it('does NOT emit phase.retry_evaluated when phaseDef has no retryCondition', async () => {
      const noRetry = { ...customPhaseDef, retryCondition: undefined };
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: cleanStdoutWithMetric('open_questions: 2') })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({
        ...baseInputs,
        phase: 'security-audit',
        pipelineId: 'security',
        phaseDef: noRetry
      });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const retryEvts = appendFn.mock.calls.filter(
        (c) => c[0].eventType === 'phase.retry_evaluated'
      );
      expect(retryEvts).toHaveLength(0);
    });

    it('does NOT emit phase.retry_evaluated when parser outcome is malformed (FR-017)', async () => {
      const FATAL = "You're out of extra usage";
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: '', stderr: FATAL, exitCode: 1 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({
        ...baseInputs,
        phase: 'security-audit',
        pipelineId: 'security',
        phaseDef: customPhaseDef
      });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const retryEvts = appendFn.mock.calls.filter(
        (c) => c[0].eventType === 'phase.retry_evaluated'
      );
      expect(retryEvts).toHaveLength(0);
    });

    it('records missingKeys via the payload when an identifier is unresolved (FR-012)', async () => {
      const stdoutNoMetric = [
        '=== SCHEGENT AUDIT LOG ===',
        'phase: security-audit',
        'files_created: []',
        'files_modified: []',
        'files_deleted: []',
        'commands_executed: ["audit"]',
        'network_calls: ["none"]',
        'ruleset_switches: ["none"]',
        'notes: ok',
        '=== END AUDIT LOG ===',
        '[SCHEGENT_STATUS: CLEAR]'
      ].join('\n');
      cliRunner = makeFakeRunner(async () => makeRawOutput({ stdout: stdoutNoMetric }));
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({
        ...baseInputs,
        phase: 'security-audit',
        pipelineId: 'security',
        phaseDef: customPhaseDef
      });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const retryEvts = appendFn.mock.calls.filter(
        (c) => c[0].eventType === 'phase.retry_evaluated'
      );
      expect(retryEvts).toHaveLength(1);
      const payload = retryEvts[0][0].payload;
      expect(payload.decision).toBe(false);
      expect(Array.from(payload.missingKeys ?? [])).toContain('open_questions');
    });
  });

  describe('fatal-signature classification (010, T012)', () => {
    const FATAL = "error: unknown option";

    it('maps fatal stderr + exit 0 to a failed PhaseOutcome (FR-002)', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: '', stderr: FATAL, exitCode: 0 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run(baseInputs);
      expect(out.outcome).toBe('failed');
      expect(out.terminationReason).toBe('error');
      expect(out.result.kind).toBe('malformed');
      if (out.result.kind === 'malformed') {
        expect(out.result.fatalCause).toBe(FATAL);
      }
    });

    it('maps fatal stderr + exit non-zero to failed PhaseOutcome', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stderr: `noise\n${FATAL}\nmore`, exitCode: 1 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run(baseInputs);
      expect(out.outcome).toBe('failed');
      expect(out.terminationReason).toBe('error');
    });

    it('does NOT fail on the same text carried on stdout (2026-08-16)', async () => {
      // `error: unknown option` is an argument-parse diagnostic and is
      // stderr-scoped. A stdout occurrence is text the CLI was carrying —
      // a file the agent read — and failing on it cost a 3.6-hour phase.
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: `docs quote: ${FATAL}\n`, exitCode: 0 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run(baseInputs);
      expect(out.outcome).not.toBe('failed');
    });

    it('does NOT fail on a signature quoted inside a stream-json envelope', async () => {
      const envelope = `{"type":"user","content":"quoting \\"${FATAL}\\" from a doc"}\n`;
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: envelope, stderr: envelope, exitCode: 0 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run(baseInputs);
      expect(out.outcome).not.toBe('failed');
    });

    it('records iteration counter = 1 when fatal fires on iteration 1 (FR-004)', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: '', stderr: FATAL, exitCode: 1 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({ ...baseInputs, iteration: 1 });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
      expect(end?.[0].iteration).toBe(1);
    });

    it('records iteration counter = N when fatal fires on iteration N (FR-004)', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: '', stderr: FATAL, exitCode: 1 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({ ...baseInputs, iteration: 3 });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
      expect(end?.[0].iteration).toBe(3);
    });

    it('emits exactly one phase-end audit event with outcome=failure and payload.cause = redacted signature', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: '', stderr: FATAL, exitCode: 1 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run(baseInputs);
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const endCalls = appendFn.mock.calls.filter((c) => c[0].eventType === 'phase-end');
      expect(endCalls).toHaveLength(1);
      expect(endCalls[0][0].outcome).toBe('failure');
      expect(endCalls[0][0].payload).toMatchObject({ cause: FATAL });
    });

    it('does NOT set payload.cause when no fatal signature matches', async () => {
      cliRunner = makeFakeRunner(async () => makeRawOutput());
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run(baseInputs);
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
      expect(end?.[0].payload).not.toHaveProperty('cause');
    });
  });

  describe('dynamic-pipelines audit payload (T025, US1)', () => {
    it('emits phase-start and phase-end with pipelineId/phaseId; omits model/effort/timeoutMs for built-in phases', async () => {
      cliRunner = makeFakeRunner(async () => makeRawOutput());
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({ ...baseInputs, pipelineId: 'speckit-new-feature' });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const start = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-start');
      const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
      expect(start?.[0].payload).toMatchObject({
        pipelineId: 'speckit-new-feature',
        phaseId: 'speckit-specify',
        runner: 'claude'
      });
      expect(start?.[0].payload).not.toHaveProperty('model');
      expect(start?.[0].payload).not.toHaveProperty('effort');
      expect(start?.[0].payload).not.toHaveProperty('timeoutMs');
      expect(end?.[0].payload).toMatchObject({
        pipelineId: 'speckit-new-feature',
        phaseId: 'speckit-specify',
        runner: 'claude'
      });
      expect(end?.[0].payload).not.toHaveProperty('model');
      expect(end?.[0].payload).not.toHaveProperty('effort');
      expect(end?.[0].payload).not.toHaveProperty('timeoutMs');
    });

    it('emits model/effort/timeoutMs on both events when set on the PhaseDef (T032/T043, US2)', async () => {
      const seenRequests: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seenRequests.push(req);
        return makeRawOutput();
      });
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      await runner.run({
        ...baseInputs,
        phase: 'security-audit',
        pipelineId: 'security',
        phaseDef: {
          id: 'security-audit',
          name: 'Security Audit',
          instruction: 'Audit the project for security issues.',
          model: 'claude-opus-4-7',
          effort: 'high',
          timeoutSeconds: 90,
          
        }
      });
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const start = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-start');
      const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
      expect(start?.[0].payload).toMatchObject({
        pipelineId: 'security',
        phaseId: 'security-audit',
        model: 'claude-opus-4-7',
        effort: 'high',
        timeoutMs: 90_000
      });
      expect(end?.[0].payload).toMatchObject({
        pipelineId: 'security',
        phaseId: 'security-audit',
        model: 'claude-opus-4-7',
        effort: 'high',
        timeoutMs: 90_000
      });
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0].model).toBe('claude-opus-4-7');
      expect(seenRequests[0].effort).toBe('high');
    });
  });

  describe('verbose diagnostic target (010, T036, US3)', () => {
    it('builds VerboseDiagnosticTarget under <cwd>/.schegent/sessions/<runId>/ when setting is true (FR-019/020/021)', async () => {
      const seenRequests: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seenRequests.push(req);
        return makeRawOutput();
      });
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        { isVerboseDiagnosticsEnabled: () => true }
      );
      await runner.run({
        ...baseInputs,
        phase: 'security-audit',
        pipelineId: 'security',
        runId: 'run-abc',
        iteration: 2,
        phaseDef: {
          id: 'security-audit',
          name: 'Security Audit',
          instruction: 'Audit.',
          
        }
      });
      expect(seenRequests).toHaveLength(1);
      const vd = seenRequests[0].verboseDiagnostics;
      expect(vd).toBeDefined();
      expect(vd!.directory).toBe('/repo/.schegent/sessions/run-abc/diagnostics/security/security-audit/iter-2');
      expect(vd!.debugFile).toBe(
        '/repo/.schegent/sessions/run-abc/diagnostics/security/security-audit/iter-2/debug.json'
      );
      expect(vd!.streamFile).toBe(
        '/repo/.schegent/sessions/run-abc/diagnostics/security/security-audit/iter-2/stream.jsonl'
      );
      expect(vd!.verboseLogFile).toBe(
        '/repo/.schegent/sessions/run-abc/diagnostics/security/security-audit/iter-2/verbose.log'
      );
    });

    it('omits verboseDiagnostics when setting is false (FR-018 default)', async () => {
      const seenRequests: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seenRequests.push(req);
        return makeRawOutput();
      });
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        { isVerboseDiagnosticsEnabled: () => false }
      );
      await runner.run(baseInputs);
      expect(seenRequests[0].verboseDiagnostics).toBeUndefined();
    });

    it('reads the setting at run() entry so mid-run toggles apply on the next invocation (FR-024)', async () => {
      const seenRequests: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seenRequests.push(req);
        return makeRawOutput();
      });
      const state = { verboseFlag: false };
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        { isVerboseDiagnosticsEnabled: () => state.verboseFlag }
      );
      // Feature 098 (T045, FR-034) — the Pipeline id is supplied explicitly. It
      // is a directory segment in the diagnostics path, and the runner no
      // longer substitutes a built-in id for an absent one, so an invocation
      // that carries none has no path to compose and declines the opt-in. That
      // is the case below; this one is about the setting being re-read.
      const withPipeline = { ...baseInputs, pipelineId: 'security' };
      await runner.run(withPipeline);
      expect(seenRequests[0].verboseDiagnostics).toBeUndefined();

      state.verboseFlag = true;
      await runner.run({ ...withPipeline, iteration: 2 });
      expect(seenRequests[1].verboseDiagnostics).toBeDefined();
    });

    it('declines the opt-in when the invocation supplied no Pipeline id (098 T045, FR-034)', async () => {
      // A path segment cannot be omitted the way a payload key can, so the
      // whole target is. Filing an unattributed Run's diagnostics under an
      // invented Pipeline directory is worse than not writing them: it is a
      // claim about which Pipeline produced them.
      const seenRequests: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seenRequests.push(req);
        return makeRawOutput();
      });
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        { isVerboseDiagnosticsEnabled: () => true }
      );

      await runner.run(baseInputs);

      expect(seenRequests[0].verboseDiagnostics).toBeUndefined();
    });

    it('folds diagnostic-write warnings into the audit entry (FR-025)', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({
          diagnosticWarnings: ['verbose diagnostic stream write failed (...): ENOSPC']
        })
      );
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        { isVerboseDiagnosticsEnabled: () => true }
      );
      await runner.run(baseInputs);
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
      expect(end?.[0].payload.warnings).toEqual(
        expect.arrayContaining(['verbose diagnostic stream write failed (...): ENOSPC'])
      );
    });
  });

  describe('Feature 012 — CLAUDE_AUTOCOMPACT_PCT_OVERRIDE env injection', () => {
    it('injects CLAUDE_AUTOCOMPACT_PCT_OVERRIDE as a string when accessor returns a value', async () => {
      const seen: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seen.push(req);
        return makeRawOutput();
      });
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        null,
        null,
        { readAutoCompactPctOverride: () => 80 }
      );
      await runner.run(baseInputs);
      expect(seen[0].env).toBeDefined();
      expect(seen[0].env!.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('80');
    });

    it('omits the env key entirely when accessor returns undefined', async () => {
      const seen: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seen.push(req);
        return makeRawOutput();
      });
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        null,
        null,
        { readAutoCompactPctOverride: () => undefined }
      );
      await runner.run(baseInputs);
      expect(seen[0].env).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(seen[0].env, 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
      ).toBe(false);
    });

    it('omits the env key when no accessor is supplied (null param)', async () => {
      const seen: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seen.push(req);
        return makeRawOutput();
      });
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger()
      );
      await runner.run(baseInputs);
      expect(
        Object.prototype.hasOwnProperty.call(seen[0].env, 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
      ).toBe(false);
    });

    it('re-reads the accessor at every run() entry (mid-run toggle applies next invocation)', async () => {
      const seen: InvocationRequest[] = [];
      cliRunner = makeFakeRunner(async (req) => {
        seen.push(req);
        return makeRawOutput();
      });
      const state: { value: number | undefined } = { value: 50 };
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        null,
        null,
        { readAutoCompactPctOverride: () => state.value }
      );
      await runner.run(baseInputs);
      expect(seen[0].env!.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50');
      state.value = 30;
      await runner.run({ ...baseInputs, iteration: 2 });
      expect(seen[1].env!.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('30');
      state.value = undefined;
      await runner.run({ ...baseInputs, iteration: 3 });
      expect(
        Object.prototype.hasOwnProperty.call(seen[2].env, 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
      ).toBe(false);
    });

    it('emits an auto-compact-override-applied audit event when value is set', async () => {
      cliRunner = makeFakeRunner(async () => makeRawOutput());
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        null,
        null,
        { readAutoCompactPctOverride: () => 80 }
      );
      await runner.run(baseInputs);
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const found = appendFn.mock.calls.find(
        (c) => c[0].eventType === 'auto-compact-override-applied'
      );
      expect(found).toBeDefined();
      expect(found![0].payload).toMatchObject({
        runId: 'run-1',
        phaseId: 'speckit-specify',
        value: 80
      });
    });

    it('does NOT emit auto-compact-override-applied when accessor returns undefined', async () => {
      cliRunner = makeFakeRunner(async () => makeRawOutput());
      runner = new PhaseRunner(
        cliRunner,
        new PromptBuilder(),
        auditWriter,
        new SanitizedLogger(),
        null,
        null,
        null,
        { readAutoCompactPctOverride: () => undefined }
      );
      await runner.run(baseInputs);
      const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
      const found = appendFn.mock.calls.find(
        (c) => c[0].eventType === 'auto-compact-override-applied'
      );
      expect(found).toBeUndefined();
    });
  });
});

describe('PhaseRunner manual pause accessor', () => {
  it('reads the injected manual-pause accessor without caching', () => {
    let paused = false;
    const localRunner = new PhaseRunner(
      makeFakeRunner(async () => makeRawOutput()),
      new PromptBuilder(),
      makeFakeAuditWriter(),
      new SanitizedLogger(),
      null,
      null,
      null,
      null,
      { isManualPauseRequested: () => paused }
    );

    expect(localRunner.isManualPauseRequested()).toBe(false);
    paused = true;
    expect(localRunner.isManualPauseRequested()).toBe(true);
  });
});


describe('Feature 074 — Multi-Backend Runner Resolution & Session Reset', () => {
  let mockRegistry: any;
  let defaultRunner: any;
  let altRunner: any;

  beforeEach(() => {
    auditWriter = makeFakeAuditWriter();
    
    defaultRunner = makeFakeRunner(async () => makeRawOutput());
    altRunner = makeFakeRunner(async () => makeRawOutput());
    
    mockRegistry = {
      getOrCreate: vi.fn((runnerKind?: string) => {
        if (runnerKind === 'agy') return altRunner;
        return defaultRunner;
      }),
      getGlobalDefault: vi.fn(() => 'claude')
    };
  });

  it('resolves runner from registry per invocation (T020)', async () => {
    runner = new PhaseRunner(mockRegistry, new PromptBuilder(), auditWriter, new SanitizedLogger());
    
    const inputs = {
      ...baseInputs,
      phaseDef: { id: 'phase1', name: 'P1', instruction: '', steps: [], runner: 'agy' as any }
    };

    await runner.run(inputs);
    expect(mockRegistry.getOrCreate).toHaveBeenCalledWith('agy');
    expect(altRunner.invoke).toHaveBeenCalled();
    expect(defaultRunner.invoke).not.toHaveBeenCalled();
    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const start = appendFn.mock.calls.find((call) => call[0].eventType === 'phase-start');
    const end = appendFn.mock.calls.find((call) => call[0].eventType === 'phase-end');
    expect(start?.[0].payload.runner).toBe('agy');
    expect(end?.[0].payload.runner).toBe('agy');
  });

  it('rejects a legacy Codex snapshot for a Git-mutating phase before audit or invocation', async () => {
    mockRegistry.getGlobalDefault.mockReturnValue('codex');
    runner = new PhaseRunner(mockRegistry, new PromptBuilder(), auditWriter, new SanitizedLogger());

    await expect(
      runner.run({
        ...baseInputs,
        phase: 'finalize',
        phaseDef: {
          id: 'finalize',
          name: 'Finalize',
          // Feature 098 T018 — the declaration is what the rule reads now, not
          // the id. This is the shape only the launch site can refuse: the Phase
          // declares `git` and names no runner of its own, so both save gates
          // returned early and the effective runner (`codex`, from the global
          // default above) is resolved here, one line before the assertion.
          sideEffects: 'git',
          instruction: 'Commit and merge the work.'
        }
      })
    ).rejects.toThrow("Phase 'finalize' must explicitly use a Git-capable runner");

    expect(mockRegistry.getOrCreate).not.toHaveBeenCalled();
    expect(auditWriter.append).not.toHaveBeenCalled();
  });

  it('attributes the controller cap-exhaustion terminal event to the effective runner', async () => {
    runner = new PhaseRunner(mockRegistry, new PromptBuilder(), auditWriter, new SanitizedLogger());

    await runner.appendCapExhaustedPhaseEnd({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 10,
      pipelineId: 'custom',
      phaseDef: {
        id: 'phase2',
        name: 'P2',
        instruction: '',
        runner: 'agy'
      }
    });

    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-end',
        outcome: 'failure',
        payload: expect.objectContaining({
          runner: 'agy',
          terminationReason: 'cap-exhausted'
        })
      })
    );
  });

  it('does not invent a resume session for a registry-selected runner', async () => {
    runner = new PhaseRunner(mockRegistry, new PromptBuilder(), auditWriter, new SanitizedLogger());
    
    const inputs = {
      ...baseInputs,
      phaseDef: { id: 'phase2', name: 'P2', instruction: '', steps: [], runner: 'agy' as any }
    };

    await runner.run(inputs);
    
    const invokeCall = altRunner.invoke.mock.calls[0][0];
    expect(invokeCall.resumeSessionId).toBeUndefined();
  });

  it('does not inject or audit Claude auto-compact settings for another runner', async () => {
    runner = new PhaseRunner(
      mockRegistry,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      null,
      null,
      null,
      { readAutoCompactPctOverride: () => 80 }
    );

    await runner.run({
      ...baseInputs,
      phaseDef: {
        id: 'phase-agy',
        name: 'Agy phase',
        instruction: '',
        runner: 'agy'
      }
    });

    expect(altRunner.invoke.mock.calls[0][0].env).not.toHaveProperty(
      'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
    );
    expect(auditWriter.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'auto-compact-override-applied' })
    );
  });

  it('audits failed pre-compaction and continues with a fresh phase session', async () => {
    let invocation = 0;
    cliRunner = makeFakeRunner(async () => {
      invocation += 1;
      return invocation === 1
        ? makeRawOutput({ exitCode: 1, command: 'claude --resume owned-session compact' })
        : makeRawOutput({ command: 'claude --resume owned-session phase' });
    });
    runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger()
    );

    const result = await runner.run({
      ...baseInputs,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    expect(result.outcome).toBe('clean');
    const invocationAudits = (
      auditWriter.append as ReturnType<typeof vi.fn>
    ).mock.calls.filter((call) => call[0].eventType === 'cli-invocation');
    expect(invocationAudits.map((call) => call[0].payload.operation)).toEqual([
      'session-compaction',
      'phase'
    ]);
    const invokeMock = cliRunner.invoke as ReturnType<typeof vi.fn>;
    expect(invokeMock.mock.calls[1][0]).not.toHaveProperty('resumeSessionId');
    expect(invokeMock.mock.calls[1][0]).not.toHaveProperty('sessionReuse');
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'warning',
        payload: expect.objectContaining({
          reasonCode: 'session-compaction-failed-fresh-session'
        })
      })
    );
  });

  it('forwards cancellation to the Claude pre-compaction invocation', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger()
    );
    const cancellationSignal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    await runner.run({
      ...baseInputs,
      sessionReuse: true,
      resumeSessionId: 'owned-session',
      inheritProcessEnv: false,
      processEnvAllowlist: ['HTTPS_PROXY'],
      cancellationSignal
    });

    expect(cliRunner.invoke).toHaveBeenCalledTimes(2);
    const invokeMock = cliRunner.invoke as ReturnType<typeof vi.fn>;
    expect(invokeMock.mock.calls[0][0].cancellationSignal).toBe(
      cancellationSignal
    );
    expect(invokeMock.mock.calls[1][0].cancellationSignal).toBe(
      cancellationSignal
    );
    expect(invokeMock.mock.calls[0][0].processEnvAllowlist).toEqual(['HTTPS_PROXY']);
    expect(invokeMock.mock.calls[1][0].processEnvAllowlist).toEqual(['HTTPS_PROXY']);
  });

  it('records pre-compaction and phase output as separate raw transcript invocations', async () => {
    const compactionCapture: RawTranscriptCapture = {
      failed: false,
      write: vi.fn(() => true),
      onceDrain: vi.fn(),
      finish: vi.fn(async () => undefined),
      appendStreamTo: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    };
    const phaseCapture: RawTranscriptCapture = {
      failed: false,
      write: vi.fn(() => true),
      onceDrain: vi.fn(),
      finish: vi.fn(async () => undefined),
      appendStreamTo: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    };
    const invoke = vi.fn(async (
      _request: InvocationRequest,
      _outputSink?: InvocationOutputSink
    ) => makeRawOutput());
    cliRunner = {
      invoke,
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner;
    const rawTranscript = makeFakeRawTranscript();
    (rawTranscript.createInvocationCapture as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(compactionCapture)
      .mockResolvedValueOnce(phaseCapture);
    runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      rawTranscript
    );

    await runner.run({
      ...baseInputs,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1]).toBe(compactionCapture);
    expect(invoke.mock.calls[1][1]).toBe(phaseCapture);
    expect(rawTranscript.appendStart).toHaveBeenCalledTimes(2);
    expect(rawTranscript.appendEnd).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ capture: compactionCapture })
    );
    expect(rawTranscript.appendEnd).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ capture: phaseCapture })
    );
  });

  it('attributes the compaction invocation to the same Run as the phase', async () => {
    // Feature 093 — census gap found by the concurrent-execution suite. T046
    // gave `InvocationRequest` a `runId` so the monitor can attribute sidecar
    // events per Run, and wired it through `PhaseRunner`; compaction spawns its
    // own CLI subprocess and was missed. Unstamped, its events carry
    // `runId: null` and the monitor drops them — invisible while one Run exists
    // per window, but with two live subprocesses a stalling compaction belongs
    // to a Run nobody can name.
    const invoke = vi.fn(async (
      _request: InvocationRequest,
      _outputSink?: InvocationOutputSink
    ) => makeRawOutput());
    cliRunner = {
      invoke,
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner;
    runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      makeFakeRawTranscript()
    );

    await runner.run({
      ...baseInputs,
      runId: 'run-compaction',
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][0].runId).toBe('run-compaction');
    expect(invoke.mock.calls[1][0].runId).toBe('run-compaction');
  });
});
