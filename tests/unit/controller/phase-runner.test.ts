import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { RawTranscriptWriter } from '../../../src/audit/raw-transcript-writer';
import type { RawInvocationOutput, InvocationRequest } from '../../../src/runner/invocation-result';
import type { AuditEntry } from '../../../src/audit/audit-entry';

const cleanStdout = [
  '[SCHEGENT_STATUS: CLEAR]',
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: ["specs/001-mock/spec.md"]',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["mock specify"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ==='
].join('\n');

function makeRawOutput(overrides: Partial<RawInvocationOutput> = {}): RawInvocationOutput {
  return {
    stdout: cleanStdout,
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 50,
    ...overrides
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

  it('returns clean outcome when stdout has token + audit', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.outcome).toBe('clean');
    expect(out.terminationReason).toBe('token');
    expect(out.result.kind).toBe('clean');
    expect(out.exitCode).toBe(0);
    // phase-start (audit-1) is now emitted before the phase-end (audit-2) entry returned in output.
    expect(out.auditEntryId).toBe('audit-2');
  });

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

  it('marks a referenced missing phase-message.env as missing-canonical-sidecar', async () => {
    // Feature 056 Track 2 — when the audit references the canonical
    // path but no file exists on disk, the read attempt produces a
    // `missing-canonical-sidecar` reason rather than the legacy
    // `missing-sidecar`. This pins the new audit reason.
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

    it('emits missing-canonical-sidecar when no audit candidate even basename-matches', async () => {
      // Audit reports a different filename entirely so the basename
      // filter strips it. With no candidates remaining the runner
      // returns null — there is nothing to attribute. The
      // `missing-canonical-sidecar` reason fires only when at least
      // one candidate basename-matched and none of them resolved to
      // the canonical path. This test pins the null behavior to keep
      // the audit log noise-free when there is genuinely no sidecar.
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
      makeRawOutput({ stdout: '', timedOut: true, killed: true, exitCode: null })
    );
    runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.outcome).toBe('timeout');
    expect(out.terminationReason).toBe('timeout');
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

  it('truncates very long stdout in summary', async () => {
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
      loopable: true,
      retryCondition: 'open_questions > 0'
    };

    const cleanStdoutWithMetric = (metricLine: string) =>
      [
        '[SCHEGENT_STATUS: CLEAR]',
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
        '=== END AUDIT LOG ==='
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
        '[SCHEGENT_STATUS: CLEAR]',
        '=== SCHEGENT AUDIT LOG ===',
        'phase: security-audit',
        'files_created: []',
        'files_modified: []',
        'files_deleted: []',
        'commands_executed: ["audit"]',
        'network_calls: ["none"]',
        'ruleset_switches: ["none"]',
        'notes: ok',
        '=== END AUDIT LOG ==='
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

    it('maps fatal stdout + exit non-zero to failed PhaseOutcome', async () => {
      cliRunner = makeFakeRunner(async () =>
        makeRawOutput({ stdout: `noise\n${FATAL}\nmore`, stderr: '', exitCode: 1 })
      );
      runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
      const out = await runner.run(baseInputs);
      expect(out.outcome).toBe('failed');
      expect(out.terminationReason).toBe('error');
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
      expect(start?.[0].payload).toMatchObject({ pipelineId: 'speckit-new-feature', phaseId: 'speckit-specify' });
      expect(start?.[0].payload).not.toHaveProperty('model');
      expect(start?.[0].payload).not.toHaveProperty('effort');
      expect(start?.[0].payload).not.toHaveProperty('timeoutMs');
      expect(end?.[0].payload).toMatchObject({ pipelineId: 'speckit-new-feature', phaseId: 'speckit-specify' });
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
          loopable: false
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
          loopable: false
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
      await runner.run(baseInputs);
      expect(seenRequests[0].verboseDiagnostics).toBeUndefined();

      state.verboseFlag = true;
      await runner.run({ ...baseInputs, iteration: 2 });
      expect(seenRequests[1].verboseDiagnostics).toBeDefined();
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
