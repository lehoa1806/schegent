import * as path from 'path';
import * as fs from 'fs/promises';
import type { Phase, PhaseOutcome } from './phase';
import type { BackendRunner } from '../contracts/backend-runner';
import type { PromptBuilder } from '../runner/prompt-builder';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { AuditEntryFields } from '../audit/audit-entry';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { SanitizedLogger } from '../lib/logger';
import { parseAuditLogBlock } from '../parser/audit-log-parser';
import { parseInvocation, type InvocationResult } from '../parser/stdout-parser';
import { extractInvocationUsageMetrics } from '../parser/invocation-usage';
import { detectCreditError } from '../parser/credit-error-detector';
import type { TerminationReason } from '../state/workflow-run';
import { BUILT_IN_PIPELINE_ID, type PhaseDef } from '../config/pipeline-config';
import type { VerboseDiagnosticTarget } from '../runner/invocation-result';
import { composeVerboseDiagnosticPath } from '../audit/verbose-diagnostic-path';
import {
  validate as validateRetryCondition,
  evaluate as evaluateRetryCondition
} from '../lib/retry-condition';
import { getEffectiveSignatures } from '../lib/fatal-signature-registry';
import type { PhaseBreakpointAccessor } from './breakpoint-accessor';

const STDOUT_SUMMARY_LIMIT = 4 * 1024;

/**
 * Single source of truth for the canonical `phase-message.env` sidecar
 * path. Mirrors the verbose-diagnostic iter-N directory composition so
 * the host controller (which passes `inputs.phaseMessagePath` into the
 * runner) and the runner's audit-candidate Step-2 dedup logic both
 * resolve to the same absolute path.
 *
 * Previously the same composition lived inline in two places:
 *   - `SchegentWorkflowController.driveRun()` built it with
 *     `run.currentPhase` and `run.pipeline.id`.
 *   - `PhaseRunner.canonicalSidecarPath()` built it with
 *     `inputs.phaseDef?.id ?? inputs.phase` and `inputs.pipelineId`.
 *
 * For built-in phases (where `phaseDef.id === phase`) the two agreed,
 * but for custom-phase pipelines a divergence in the inputs would
 * produce two paths and silently bypass the Track 2 byte-equality
 * defense. This helper collapses the composition to one expression.
 *
 * Both callers now share `BUILT_IN_PIPELINE_ID` as the fallback when
 * the caller-supplied `pipelineId` is missing. The previous literal
 * `'standard'` on the runner side drifted away from the controller's
 * `BUILT_IN_PIPELINE_ID` ('speckit-new-feature') and broke the
 * byte-equality match whenever a caller skipped the optional field.
 *
 * Returns the absolute composed path (does NOT touch the filesystem;
 * existence is probed by the caller via `fs.open(..., O_NOFOLLOW)`).
 */
export function composePhaseMessagePath(args: {
  cwd: string;
  runId: string;
  pipelineId: string;
  phaseId: string;
  iteration: number;
}): string {
  return path.join(
    args.cwd,
    '.schegent',
    'sessions',
    args.runId,
    'diagnostics',
    args.pipelineId,
    args.phaseId,
    `iter-${args.iteration}`,
    'phase-message.env'
  );
}

/**
 * Feature 042 — surface `RawInvocationOutput.stdoutTruncated` /
 * `stderrTruncated` onto `phase-end` audit payloads, but only when the
 * flag is `true`. Omitting the field on `false` keeps the on-disk
 * payload shape identical to the legacy (pre-042) record for the
 * non-truncated common case.
 */
function truncationFields(raw: {
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}): Record<string, true> {
  const out: Record<string, true> = {};
  if (raw.stdoutTruncated === true) out.stdoutTruncated = true;
  if (raw.stderrTruncated === true) out.stderrTruncated = true;
  return out;
}

export interface PhaseRunInputs {
  phase: Phase;
  phaseDef?: PhaseDef;
  pipelineId?: string;
  iteration: number;
  iterationCap: number;
  featureDescription: string;
  featureDir: string | null;
  carriedIssues?: Array<{ tag?: string; summary: string }> | string[];
  cliPath: string;
  cwd: string;
  timeoutMs: number;
  runId: string;
  perPhaseRulesPath?: string | null;
  phaseMessagePath?: string | null;
  previousPhaseMessage?: Readonly<Record<string, string>> | null;
  cancellationSignal?: { aborted: boolean; addEventListener(event: 'abort', cb: () => void): void };
  /**
   * Feature 032 — controller-set hint that the next invocation is a
   * CONTINUATION of an interrupted conversation (delayed retry, operator
   * resume, cascaded resume of a queue-paused-mid-run task, or breakpoint-
   * paused resume). When `true`, `PhaseRunner.run()` forwards it into
   * `InvocationRequest.isContinue` and the runner appends `-c` to the
   * spawned argv. When `false`, `undefined`, or omitted, the runner does
   * NOT append `-c`.
   *
   * The runner MUST NOT compute, override, or invert the value; it is
   * set EXCLUSIVELY by the controller's dispatch paths. The same value
   * also flows into the `phase-start` audit payload's strict
   * `isContinue: boolean` field (defaulting `undefined` → `false`).
   *
   * Loop iterations, bugfix-loop iterations, restart-active-phase, and
   * first-attempt dispatches MUST NOT set this field to `true`. Each is
   * a fresh conversation, not a continuation.
   */
  isContinue?: boolean;
}

export interface PhaseMessageResult {
  readonly fromPhaseId: string;
  readonly entryCount: number;
  readonly byteSize: number;
  readonly entries: Readonly<Record<string, string>>;
  readonly truncated: boolean;
  readonly invalidReason: string | null;
}

export interface PhaseRunOutput {
  result: InvocationResult;
  outcome: PhaseOutcome;
  terminationReason: TerminationReason;
  stdoutSummary: string;
  stderrSummary: string;
  exitCode: number | null;
  auditEntryId: string | null;
  warnings: string[];
  phaseMessage?: PhaseMessageResult | null;
}

export interface VerboseDiagnosticsAccessor {
  /**
   * Read at every `run()` entry — never cached on a long-lived object
   * — so toggling the workspace setting mid-run applies to the next
   * phase invocation (010 FR-024).
   */
  isVerboseDiagnosticsEnabled(): boolean;
}

export interface FatalSignaturesAccessor {
  /**
   * Read at every `run()` entry — never cached — so operator edits to
   * `schegent.fatalSignatures` take effect on the next CLI invocation
   * (011 FR-033). Returns the validated operator-defined list; the
   * built-in floor is merged in by `getEffectiveSignatures()`.
   */
  readOperatorAdditions(): readonly string[];
}

export interface AutoCompactOverrideAccessor {
  /**
   * Read at every `run()` entry — never cached — so toggling
   * `schegent.claude.autoCompactPctOverride` mid-run applies to the
   * **next** phase invocation only (012 FR-006). Returns the validated
   * integer in `[1, 100]` or `undefined` when the setting is unset /
   * malformed. When `undefined`, the caller MUST omit the env-var key
   * from the subprocess env entirely — never inject an empty string or
   * the literal `"undefined"`.
   */
  readAutoCompactPctOverride(): number | undefined;
}

export interface ManualPauseAccessor {
  /**
   * Read at dispatch boundaries by controller-side tests and future runner
   * integrations. Mirrors the non-cached settings accessor pattern: callers
   * inject a live read function instead of caching pause state on the runner.
   */
  isManualPauseRequested(): boolean;
}

export class PhaseRunner {
  constructor(
    private readonly runner: BackendRunner,
    private readonly promptBuilder: PromptBuilder,
    private readonly auditWriter: AuditLogWriter,
    private readonly logger: SanitizedLogger,
    private readonly rawTranscript: RawTranscriptWriter | null = null,
    private readonly verboseAccessor: VerboseDiagnosticsAccessor | null = null,
    private readonly fatalSignaturesAccessor: FatalSignaturesAccessor | null = null,
    private readonly autoCompactOverrideAccessor: AutoCompactOverrideAccessor | null = null,
    private readonly manualPauseAccessor: ManualPauseAccessor | null = null,
    private readonly phaseBreakpointAccessor: PhaseBreakpointAccessor | null = null
  ) {}

  public isManualPauseRequested(): boolean {
    return this.manualPauseAccessor?.isManualPauseRequested() ?? false;
  }

  public async run(inputs: PhaseRunInputs): Promise<PhaseRunOutput> {
    // Feature 019 — DEBUG instrumentation. The WorkflowController owns
    // the lock; by the time `run()` is reached the lock is already
    // held, so `waitMs` is 0 from PhaseRunner's vantage. `holdMs` is
    // measured to the end of this method (or to the early return on a
    // timeout / failure path).
    const phaseRunStartMs = Date.now();
    const debugPipelineId = inputs.pipelineId ?? BUILT_IN_PIPELINE_ID;
    const debugPhaseId = inputs.phaseDef?.id ?? inputs.phase;
    this.logger.debug('phase-runner.lock-acquired', {
      pipelineId: debugPipelineId,
      phaseId: debugPhaseId,
      runId: inputs.runId,
      waitMs: 0
    });
    this.logger.debug('phase-runner.iteration-tick', {
      pipelineId: debugPipelineId,
      phaseId: debugPhaseId,
      runId: inputs.runId,
      iteration: inputs.iteration
    });
    try {
      return await this.runInner(inputs);
    } finally {
      this.logger.debug('phase-runner.lock-released', {
        pipelineId: debugPipelineId,
        phaseId: debugPhaseId,
        holdMs: Date.now() - phaseRunStartMs
      });
    }
  }

  private async runInner(inputs: PhaseRunInputs): Promise<PhaseRunOutput> {
    // Feature 028 — US2: future-phase breakpoint check. Read the accessor at
    // the dispatch boundary (never cached on the runner) so a breakpoint
    // added via the sidebar mid-run applies to the very next phase
    // invocation. The check fires BEFORE any CLI spawn, BEFORE prompt build,
    // and BEFORE the `phase-start` audit so the marked phase is genuinely
    // paused (no partial side effects). The controller (driveRun) consumes
    // `outcome: 'paused-at-breakpoint'` and stamps
    // `manualPauseCause: 'breakpoint-paused'` + `resumeTargetPhaseId`.
    const breakpointPhaseId = inputs.phaseDef?.id ?? inputs.phase;
    const breakpoints =
      this.phaseBreakpointAccessor?.readBreakpointPhaseIds(inputs.runId) ??
      new Set<string>();
    if (breakpoints.has(breakpointPhaseId)) {
      const firedAt = Date.now();
      const auditEntry = await this.auditWriter.append({
        runId: inputs.runId,
        phase: inputs.phase,
        iteration: inputs.iteration,
        eventType: 'phase-breakpoint-fired',
        payload: {
          pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
          phaseId: breakpointPhaseId,
          iterationN: inputs.iteration,
          timestamp: firedAt
        },
        outcome: 'info'
      });
      this.logger.info(
        `phase-breakpoint-fired ${breakpointPhaseId} iter=${inputs.iteration}`
      );
      return {
        result: {
          kind: 'malformed',
          warnings: ['breakpoint-paused'],
          auditEntry: null
        },
        outcome: 'paused-at-breakpoint',
        terminationReason: 'cancel',
        stdoutSummary: '',
        stderrSummary: '',
        exitCode: null,
        auditEntryId: auditEntry.id,
        warnings: ['breakpoint-paused'],
        phaseMessage: null
      };
    }

    const prompt = this.promptBuilder.build({
      phase: inputs.phase,
      phaseDef: inputs.phaseDef,
      iteration: inputs.iteration,
      iterationCap: inputs.iterationCap,
      featureDescription: inputs.featureDescription,
      featureDir: inputs.featureDir,
      carriedIssues: inputs.carriedIssues,
      perPhaseRulesPath: inputs.perPhaseRulesPath ?? null,
      phaseMessagePath: inputs.phaseMessagePath ?? null,
      previousPhaseMessage: inputs.previousPhaseMessage ?? null
    });

    const startPayload: Record<string, unknown> = {
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: inputs.phaseDef?.id ?? inputs.phase,
      // Feature 032 — strict-boolean continuation telemetry. Always
      // present on the payload (never omitted); a missing or
      // non-`=== true` `inputs.isContinue` records `false`. Matches the
      // strict gate used by the runner's `-c` argv append so the audit
      // record and the spawned argv stay in lock-step.
      isContinue: inputs.isContinue === true
    };
    if (inputs.phaseDef?.model) startPayload.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) startPayload.effort = inputs.phaseDef.effort;
    if (inputs.phaseDef?.timeoutSeconds) {
      startPayload.timeoutMs = inputs.phaseDef.timeoutSeconds * 1000;
    }
    await this.appendAudit(inputs, 'phase-start', 'info', startPayload);

    this.logger.info(`phase-start ${inputs.phase} iter=${inputs.iteration}`);
    await this.rawTranscript?.appendStart({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      prompt
    });
    // Feature 010 FR-024: read schegent.logging.verbose at run() entry
    // (never cached on the runner) so a mid-run toggle applies on the
    // next invocation. The accessor is the workspace-setting read site.
    const verboseDiagnostics = this.buildVerboseTarget(inputs);
    // Feature 012 FR-006 — read schegent.claude.autoCompactPctOverride at
    // run() entry (never cached). When set, inject as the env var the
    // Claude CLI reads to override its auto-compaction threshold; when
    // undefined, the key MUST NOT appear in the env map (no empty-string
    // fallback, no "undefined" literal).
    const autoCompactPct =
      this.autoCompactOverrideAccessor?.readAutoCompactPctOverride();
    const env: Record<string, string> = {
      SCHEGENT_PHASE: inputs.phase,
      SCHEGENT_ITERATION: String(inputs.iteration)
    };
    if (autoCompactPct !== undefined) {
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(autoCompactPct);
      // Feature 012 — optional `auto-compact-override-applied` audit event.
      // Emitted only when the override is active; the parser warns-and-
      // preserves unknown event types so this is additive (no schema bump).
      await this.appendAudit(inputs, 'auto-compact-override-applied', 'info', {
        runId: inputs.runId,
        phaseId: inputs.phaseDef?.id ?? inputs.phase,
        value: autoCompactPct
      });
    }
    const raw = await this.runner.invoke({
      phase: inputs.phase,
      iteration: inputs.iteration,
      prompt,
      timeoutMs: inputs.timeoutMs,
      cliPath: inputs.cliPath,
      cwd: inputs.cwd,
      env,
      cancellationSignal: inputs.cancellationSignal,
      ...(inputs.phaseDef?.model ? { model: inputs.phaseDef.model } : {}),
      ...(inputs.phaseDef?.effort ? { effort: inputs.phaseDef.effort } : {}),
      ...(verboseDiagnostics ? { verboseDiagnostics } : {}),
      // Feature 032 — forward the controller's session-continuation
      // hint. The runner uses strict `=== true` to gate the `-c` append.
      ...(inputs.isContinue === true ? { isContinue: true } : {})
    });

    if (raw.timedOut) {
      await this.rawTranscript?.appendEnd({
        runId: inputs.runId,
        stdout: raw.stdout,
        stderr: raw.stderr,
        exitCode: raw.exitCode,
        killed: raw.killed,
        timedOut: raw.timedOut
      });
      const auditEntry = await this.appendAudit(inputs, 'phase-end', 'failure', {
        ...this.pipelineMeta(inputs),
        reason: 'timeout',
        ...truncationFields(raw)
      });
      return {
        result: { kind: 'malformed', warnings: ['timeout'], auditEntry: null },
        outcome: 'timeout',
        terminationReason: 'timeout',
        stdoutSummary: this.summarize(raw.stdout),
        stderrSummary: this.summarize(raw.stderr),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        warnings: ['phase timed out'],
        phaseMessage: null
      };
    }

    if (raw.killed && raw.exitCode === null) {
      await this.rawTranscript?.appendEnd({
        runId: inputs.runId,
        stdout: raw.stdout,
        stderr: raw.stderr,
        exitCode: raw.exitCode,
        killed: raw.killed,
        timedOut: raw.timedOut
      });
      const auditEntry = await this.appendAudit(inputs, 'cancel', 'info', {
        ...this.pipelineMeta(inputs),
        reason: 'killed'
      });
      return {
        result: { kind: 'malformed', warnings: ['cancelled'], auditEntry: null },
        outcome: 'failed',
        terminationReason: 'cancel',
        stdoutSummary: this.summarize(raw.stdout),
        stderrSummary: this.summarize(raw.stderr),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        warnings: ['phase cancelled'],
        phaseMessage: null
      };
    }

    const rateLimit = detectCreditError(raw.stderr, raw.exitCode);
    const audit = parseAuditLogBlock(raw.stdout);
    // Feature 011 FR-033 — read operator-additive fatal signatures
    // per-invocation (never cached). The built-in floor is preserved
    // by `getEffectiveSignatures()`; operator additions can extend but
    // not subtract from it (FR-038).
    const operatorAdditions =
      this.fatalSignaturesAccessor?.readOperatorAdditions() ?? [];
    const effectiveFatalSignatures = getEffectiveSignatures(operatorAdditions);
    const result = parseInvocation({
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      rateLimit,
      auditEntry: audit.entry,
      auditWarnings: audit.warnings,
      effectiveFatalSignatures
    });

    // Feature 013 — T041 (Wave 3): defense-in-depth assertion. The parser
    // hoists the exit-code check above the contract-block branches, but a
    // future refactor could regress that ordering. This pre-persist guard
    // makes the precedence rule a code-level invariant: clean outcomes are
    // impossible while the CLI exited non-zero, regardless of stdout
    // content. The throw is preferable to silently downgrading because the
    // condition indicates a parser bug, not a runtime failure.
    if (result.kind === 'clean' && raw.exitCode !== null && raw.exitCode !== 0) {
      throw new Error(
        'phase-runner: parser returned clean with non-zero exit — precedence rule violated'
      );
    }

    const outcome = mapOutcome(result, raw.exitCode);
    const terminationReason = mapTerminationReason(result, raw.exitCode);
    const fatalCause = result.kind === 'malformed' ? result.fatalCause : undefined;
    const fatalSource = result.kind === 'malformed' ? result.fatalSource : undefined;

    // Feature 011 FR-037 — emit `fatal-signature-matched` with the
    // matched signature and its registry attribution. The single
    // sanitization point in `appendAudit` still redacts `signature`.
    if (fatalCause && fatalSource) {
      await this.appendAudit(inputs, 'fatal-signature-matched', 'failure', {
        ...this.pipelineMeta(inputs),
        signature: fatalCause,
        source: fatalSource
      });
    }

    const phaseMessage = await this.parsePhaseMessage(inputs, audit.entry);

    await this.rawTranscript?.appendEnd({
      runId: inputs.runId,
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      killed: raw.killed,
      timedOut: raw.timedOut
    });

    // Feature 010 — FR-017: emit phase.retry_evaluated for every consulted
    // decision. Skipped when the parser outcome is malformed (the malformed
    // path already records the failure via phase-end + cause).
    await this.maybeEmitRetryEvaluated(inputs, result, audit.entry?.metrics ?? {});

    // FR-025: fold any diagnostic-write warnings emitted by the runner into
    // the audit entry's warnings field, so the persisted record carries the
    // best-effort failure signal alongside the parser/result warnings.
    const combinedWarnings: string[] = [];
    if ('warnings' in result && result.warnings) {
      combinedWarnings.push(...result.warnings);
    }
    if (raw.diagnosticWarnings && raw.diagnosticWarnings.length > 0) {
      combinedWarnings.push(...raw.diagnosticWarnings);
    }

    const usageMetrics = extractInvocationUsageMetrics(raw.stdout);
    const auditEntry = await this.appendAudit(
      inputs,
      'phase-end',
      outcome === 'clean' ? 'success' : outcome === 'failed' ? 'failure' : 'info',
      {
        ...this.pipelineMeta(inputs),
        outcome,
        exitCode: raw.exitCode,
        durationMs: raw.durationMs,
        files_created: audit.entry?.filesCreated ?? [],
        files_modified: audit.entry?.filesModified ?? [],
        commands_executed: audit.entry?.commandsExecuted ?? [],
        warnings: combinedWarnings.length > 0 ? combinedWarnings : undefined,
        // FR-005 — redacted fatal-cause text; audit-log-writer is the
        // single sanitization point (sanitize() runs there on the
        // whole payload).
        ...(fatalCause ? { cause: fatalCause } : {}),
        ...(usageMetrics ?? {}),
        ...truncationFields(raw)
      }
    );

    return {
      result,
      outcome,
      terminationReason,
      stdoutSummary: this.summarize(raw.stdout),
      stderrSummary: this.summarize(raw.stderr),
      exitCode: raw.exitCode,
      auditEntryId: auditEntry.id,
      warnings: 'warnings' in result ? result.warnings : [],
      phaseMessage
    };
  }

  private summarize(text: string): string {
    return this.logger.sanitize(text.slice(0, STDOUT_SUMMARY_LIMIT));
  }

  private async parsePhaseMessage(
    inputs: PhaseRunInputs,
    auditEntry: AuditEntryFields | null
  ): Promise<PhaseMessageResult | null> {
    // Feature 056 Track 2 (FR-006..FR-012) — Canonical-path defense.
    //
    // The CLI stdout (and therefore the audit `filesCreated` /
    // `filesModified` arrays) is operator-influenced and can contain
    // attacker-supplied paths via a malicious phase prompt or repo
    // file. The previous implementation filtered candidates only by
    // basename, which let `/private/var/.../phase-message.env` slip
    // through. Track 2 closes that gap:
    //
    //   1. Prefer the host-computed canonical path entirely. When the
    //      file at `inputs.phaseMessagePath` exists on disk, read it
    //      and ignore every audit-reported candidate.
    //   2. Otherwise, audit candidates are checked against the
    //      canonical path with `path.resolve` (handles `..`, relative
    //      paths). Anything that does not byte-match the canonical
    //      path is rejected with `path-outside-run-dir`. If no
    //      candidate matches, emit `missing-canonical-sidecar`.
    const canonicalPath = this.canonicalSidecarPath(inputs);
    if (!canonicalPath) {
      // No canonical path available (legacy inputs without runId etc.).
      // Fall back to the prior basename behavior so existing tests
      // that omit phaseMessagePath continue to pass. This branch is
      // only reachable in test fixtures.
      const fallback = [
        ...(auditEntry?.filesCreated ?? []),
        ...(auditEntry?.filesModified ?? [])
      ].filter((file) => path.basename(file) === 'phase-message.env');
      if (fallback.length === 0) return null;
      return this.readAndParsePhaseMessage(inputs, fallback[0]);
    }
    // Step 1: try the canonical path directly. The open() IS the probe
    // — a separate `fs.lstat` prelude would only re-open a TOCTOU race
    // it could not close (an attacker could swap the file between the
    // probe and the open). When `silentOnFailure` is on, any failure
    // (ENOENT, ELOOP / symlink, EACCES, type-mismatch) returns `null`
    // with no audit emission so Step 2 can make the definitive call
    // from the audit candidates; a `null` return is therefore "Step 1
    // declined" and never reflects a successful-but-invalid parse.
    const canonicalResult = await this.readAndParsePhaseMessage(
      inputs,
      canonicalPath,
      { silentOnFailure: true }
    );
    if (canonicalResult !== null) return canonicalResult;
    // Step 2: examine audit candidates by canonical-path equality.
    //
    // Symlink-tolerant canonical-path resolution. The host-composed
    // `canonicalPath` is a lexical join under `inputs.cwd`. On macOS
    // dev boxes the system tmpdir and any `/var/...` workspace anchor
    // realpath to `/private/var/...`; on some Linux distros `/var/run`
    // realpaths to `/run`. The CLI subprocess realpath()-resolves its
    // own cwd before reporting `filesCreated` / `filesModified` back,
    // so its candidates carry the realpath-resolved prefix while our
    // canonical keeps the symlink-side prefix. A naive byte-equality
    // would reject the legitimate sidecar.
    //
    // Resolve the canonical once per call. ENOENT (the file doesn't
    // exist yet on disk) falls back to the lexical canonical — the
    // candidate scan below realpaths each candidate, and a non-realpath
    // candidate that matches lexically still wins. Other errors
    // (EACCES, ELOOP) also fall back: a hostile parent component
    // returns to the existing `path-outside-run-dir` rejection path.
    let canonicalRealpath: string;
    try {
      canonicalRealpath = await fs.realpath(canonicalPath);
    } catch {
      canonicalRealpath = canonicalPath;
    }
    // Dedup by realpath where possible: the CLI commonly reports the
    // same sidecar in BOTH `filesCreated` and `filesModified` (a file
    // that is created and then written within the same phase), and a
    // raw concat would tally that as `candidateCount = 2` and emit a
    // false-positive `duplicate-sidecar` audit. Realpath also collapses
    // parent-component-symlink variants and case-insensitive FS
    // variants. When realpath fails (file doesn't exist on disk, or
    // permission denied), we fall back to the lexically-resolved path
    // as the dedup key — same-string entries still dedup correctly.
    const candidateDedup = new Map<string, string>();
    for (const file of [
      ...(auditEntry?.filesCreated ?? []),
      ...(auditEntry?.filesModified ?? [])
    ]) {
      if (path.basename(file) !== 'phase-message.env') continue;
      const resolved = path.resolve(inputs.cwd, file);
      let key = resolved;
      try {
        key = await fs.realpath(resolved);
      } catch {
        // Lexical key fallback — the resolved path is already
        // normalized, so byte-identical inputs still collapse.
      }
      if (!candidateDedup.has(key)) {
        candidateDedup.set(key, resolved);
      }
    }
    const auditCandidates = Array.from(candidateDedup.entries());
    if (auditCandidates.length === 0) return null;
    if (auditCandidates.length > 1) {
      await this.emitPhaseMessageInvalid(inputs, 'duplicate-sidecar', {
        candidateCount: auditCandidates.length
      });
    }
    // Resolve each audit candidate to an absolute path (handles ..
    // and relative segments) and require a byte-for-byte match with
    // the canonical path. The comparison happens at TWO points:
    //   1. Lexical: `resolved === canonicalPath` — preserves the prior
    //      behavior for unit tests that pin the lexical equality.
    //   2. Realpath: `key === canonicalRealpath` — catches the
    //      `/var` → `/private/var` and `/var/run` → `/run` symlink
    //      cases the lexical compare cannot.
    let acceptedCandidate: string | null = null;
    let rejectedOutside = false;
    for (const [key, resolved] of auditCandidates) {
      if (resolved === canonicalPath || key === canonicalRealpath) {
        acceptedCandidate = resolved;
        break;
      }
      rejectedOutside = true;
    }
    if (acceptedCandidate === null) {
      const reason = rejectedOutside
        ? 'path-outside-run-dir'
        : 'missing-canonical-sidecar';
      await this.emitPhaseMessageInvalid(inputs, reason);
      return this.invalidPhaseMessage(inputs, reason);
    }
    // Step 2 callsite — `silentOnFailure` defaults to `false` so any
    // failure here is the final word and emits a definitive audit; the
    // forwarded `null` branch is unreachable but the wrapping function
    // already returns `PhaseMessageResult | null` so forwarding the
    // narrower union is type-safe.
    return this.readAndParsePhaseMessage(inputs, acceptedCandidate);
  }

  /**
   * Build the boilerplate `PhaseMessageResult` returned on every
   * invalid-reason branch. Centralizing the literal keeps the
   * `fromPhaseId` derivation (which depends on phaseDef availability)
   * in a single place and stops the previous five copy-pasted
   * objects from drifting in shape.
   */
  private invalidPhaseMessage(
    inputs: PhaseRunInputs,
    reason: string
  ): PhaseMessageResult {
    return {
      fromPhaseId: inputs.phaseDef?.id ?? inputs.phase,
      entryCount: 0,
      byteSize: 0,
      entries: {},
      truncated: false,
      invalidReason: reason
    };
  }

  /**
   * Audit-emission helper for the `phase-message-invalid` envelope.
   * Every call site shared the same `pipelineMeta(inputs)` spread; the
   * helper inlines that boilerplate so additional payload fields
   * (e.g. `candidateCount`, `invalidLines`) can be appended via the
   * optional `extra` argument.
   */
  private async emitPhaseMessageInvalid(
    inputs: PhaseRunInputs,
    reason: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    await this.appendAudit(inputs, 'phase-message-invalid', 'info', {
      ...this.pipelineMeta(inputs),
      reason,
      ...extra
    });
  }

  /**
   * Feature 056 Track 2 — compute the canonical host-computed sidecar
   * path. Mirrors the verbose-diagnostic iter-N directory composition
   * so a single source of truth governs both diagnostic and sidecar
   * paths. Returns `null` when required inputs (runId, iteration) are
   * absent — exists only to keep legacy test fixtures working.
   */
  private canonicalSidecarPath(inputs: PhaseRunInputs): string | null {
    if (inputs.phaseMessagePath) return path.resolve(inputs.phaseMessagePath);
    if (!inputs.runId || !inputs.iteration) return null;
    return composePhaseMessagePath({
      cwd: inputs.cwd,
      runId: inputs.runId,
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: inputs.phaseDef?.id ?? inputs.phase,
      iteration: inputs.iteration
    });
  }

  private async readAndParsePhaseMessage(
    inputs: PhaseRunInputs,
    absolutePath: string,
    options: { silentOnFailure?: boolean } = {}
  ): Promise<PhaseMessageResult | null> {
    // Feature 056 Track 2 (FR-006..FR-012) — symlink-safe read, TOCTOU-closed.
    //
    // Earlier revisions split this into `fs.lstat()` (detect symlink) +
    // `fs.readFile()` (read content). That sequence has a TOCTOU race: an
    // attacker controlling the CLI subprocess could `unlink(canonical) &&
    // symlink(/etc/passwd, canonical)` between the two syscalls; the kernel
    // resolves `readFile` against the current dentry, follows the symlink,
    // and the parser ingests the target as key=value pairs.
    //
    // The fix: `fs.open(path, O_RDONLY | O_NOFOLLOW)` then read via the FD.
    //   - `O_NOFOLLOW` makes the kernel atomically reject the open with
    //     ELOOP if the FINAL path component is a symlink — no separate
    //     "check then act" window for an attacker to exploit.
    //   - `handle.stat()` binds to the FD (fstat semantics), not the path,
    //     so any post-open swap cannot deceive the size/type check.
    //   - `handle.readFile()` reads from the FD, not the path.
    //
    // Platform note: `O_NOFOLLOW` is a POSIX constant. On Windows it is
    // not present; we OR with `0` (identity) and rely on Windows' own
    // symlink-creation ACL (admin or Developer Mode) for partial defense.
    // The fstat-after-open pattern still closes the type-confusion window
    // on every platform.
    //
    // `options.silentOnFailure` (Step 1 only): on any open / type / symlink
    // failure, return `null` with no audit emission so the caller can fall
    // through to Step 2 (audit candidates). Step 2's own callsite uses the
    // default (false) so a failure there emits the definitive audit reason.
    const silent = options.silentOnFailure === true;
    const NOFOLLOW: number =
      (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    let handle: fs.FileHandle | null = null;
    let bytes: Buffer;
    try {
      handle = await fs.open(
        absolutePath,
        fs.constants.O_RDONLY | NOFOLLOW
      );
      const stat = await handle.stat();
      if (!stat.isFile()) {
        if (silent) return null;
        await this.emitPhaseMessageInvalid(inputs, 'missing-sidecar');
        return this.invalidPhaseMessage(inputs, 'missing-sidecar');
      }
      bytes = await handle.readFile();
      // Windows defense-in-depth: `O_NOFOLLOW` is a POSIX constant. On
      // Windows we OR with `0` (identity), so the kernel does NOT
      // refuse a symlinked final component — `open` happily resolves
      // it and `handle.readFile()` returns the symlink target's bytes.
      // The fstat-via-FD pattern above catches type confusion (a
      // post-open swap to a non-regular file) but cannot detect that
      // the OPEN itself followed a symlink at the dentry level.
      //
      // After the read, `fs.lstat` on the same path reports the link
      // type WITHOUT dereferencing the final component. If it says
      // symbolic-link, we know the FD we just read from was bound to a
      // symlink target, not the file we asked for. Reject with the
      // same `path-symlink-redirect` reason the POSIX ELOOP branch
      // below uses. On Linux/macOS the open() above would have failed
      // with ELOOP before reaching this point, so this check is a
      // no-op there.
      try {
        const lstAfterRead = await fs.lstat(absolutePath);
        if (lstAfterRead.isSymbolicLink()) {
          if (silent) return null;
          await this.emitPhaseMessageInvalid(inputs, 'path-symlink-redirect');
          return this.invalidPhaseMessage(inputs, 'path-symlink-redirect');
        }
      } catch {
        // lstat failed (e.g. file vanished mid-read). Falling through
        // means we trust the bytes we already read — they came from a
        // FD opened with our O_RDONLY flags before the dentry changed.
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'ELOOP' || code === 'EMLINK') {
        // POSIX O_NOFOLLOW rejection. Linux returns ELOOP; some BSDs
        // historically returned EMLINK. Both mean: the final component
        // is a symlink and we refused to follow it.
        if (silent) return null;
        await this.emitPhaseMessageInvalid(inputs, 'path-symlink-redirect');
        return this.invalidPhaseMessage(inputs, 'path-symlink-redirect');
      }
      // ENOENT / EACCES / EISDIR / other open failures collapse to
      // the existing `missing-sidecar` audit reason. Legacy tests
      // pinning that reason continue to pass.
      if (silent) return null;
      await this.emitPhaseMessageInvalid(inputs, 'missing-sidecar');
      return this.invalidPhaseMessage(inputs, 'missing-sidecar');
    } finally {
      await handle?.close();
    }
    const byteSize = bytes.byteLength;
    if (byteSize > 4096) {
      await this.appendAudit(inputs, 'phase-message-truncated', 'info', {
        ...this.pipelineMeta(inputs),
        byteSize
      });
      return {
        fromPhaseId: inputs.phaseDef?.id ?? inputs.phase,
        entryCount: 0,
        byteSize,
        entries: {},
        truncated: true,
        invalidReason: null
      };
    }
    const parsed = this.parsePhaseMessageEnv(bytes.toString('utf8'));
    if (parsed.duplicateKey) {
      await this.emitPhaseMessageInvalid(inputs, 'duplicate-keys');
      return { ...this.invalidPhaseMessage(inputs, 'duplicate-keys'), byteSize };
    }
    if (parsed.invalidLines > 0 || parsed.invalidKeys > 0) {
      await this.emitPhaseMessageInvalid(inputs, 'malformed-lines', {
        invalidLines: parsed.invalidLines,
        invalidKeys: parsed.invalidKeys
      });
    }
    const sanitized = this.logger.sanitizeRecord(parsed.entries) as Record<string, string>;
    const entryCount = Object.keys(sanitized).length;
    await this.appendAudit(inputs, 'phase-message-emitted', 'info', {
      ...this.pipelineMeta(inputs),
      entryCount,
      byteSize
    });
    return {
      fromPhaseId: inputs.phaseDef?.id ?? inputs.phase,
      entryCount,
      byteSize,
      entries: sanitized,
      truncated: false,
      invalidReason: entryCount === 0 ? 'unparseable' : null
    };
  }

  private parsePhaseMessageEnv(text: string): {
    entries: Record<string, string>;
    invalidLines: number;
    invalidKeys: number;
    duplicateKey: boolean;
  } {
    const entries: Record<string, string> = {};
    let invalidLines = 0;
    let invalidKeys = 0;
    let duplicateKey = false;
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.trim().length === 0) continue;
      const sep = rawLine.indexOf('=');
      if (sep <= 0) {
        invalidLines++;
        continue;
      }
      const key = rawLine.slice(0, sep);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) {
        invalidKeys++;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(entries, key)) {
        duplicateKey = true;
        continue;
      }
      entries[key] = rawLine.slice(sep + 1);
    }
    return { entries, invalidLines, invalidKeys, duplicateKey };
  }

  // Feature 010 FR-019/020/021: construct the absolute paths to the three
  // sibling diagnostic files under
  //   <cwd>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
  // Returns undefined when the operator has not opted in (FR-018 default).
  //
  // Feature 044 — delegate the actual path composition to
  // `composeVerboseDiagnosticPath`, which validates each path component
  // against `^[A-Za-z0-9._-]{1,128}$` and asserts the result does not
  // escape `<cwd>/.schegent/sessions/`. A rejected tuple silently
  // disables the verbose-diag opt-in for this invocation (one-shot
  // warning, no audit-pipeline impact). See specs/044-verbose-diag-path-defense.
  private buildVerboseTarget(inputs: PhaseRunInputs): VerboseDiagnosticTarget | undefined {
    if (!this.verboseAccessor) return undefined;
    if (!this.verboseAccessor.isVerboseDiagnosticsEnabled()) return undefined;
    const pipelineId = inputs.pipelineId ?? BUILT_IN_PIPELINE_ID;
    const phaseId = inputs.phaseDef?.id ?? inputs.phase;
    try {
      return composeVerboseDiagnosticPath({
        workspaceRoot: inputs.cwd,
        runId: inputs.runId,
        pipelineId,
        phaseId,
        iterationN: inputs.iteration
      });
    } catch (err) {
      this.logger.warn('verbose-diagnostic-path-rejected', {
        pipelineId,
        phaseId,
        runId: inputs.runId,
        iteration: inputs.iteration,
        error: (err as Error).message
      });
      return undefined;
    }
  }

  private pipelineMeta(inputs: PhaseRunInputs): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: inputs.phaseDef?.id ?? inputs.phase
    };
    if (inputs.phaseDef?.model) meta.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) meta.effort = inputs.phaseDef.effort;
    if (inputs.phaseDef?.timeoutSeconds) {
      meta.timeoutMs = inputs.phaseDef.timeoutSeconds * 1000;
    }
    return meta;
  }

  // Feature 010 — FR-010 cap-exhaustion path. The controller calls this when
  // the transition decision is `halt(failed, cap_exhausted)` so the audit log
  // carries a terminal `phase-end` with `outcome: 'failure'` and `payload.cause:
  // 'cap_exhausted'` (see specs/010-pipeline-resilience/contracts/audit-events.md
  // §"phase-end — new payload.cause field"). The PhaseRunner already emitted
  // a success-shaped `phase-end` for the LLM-level outcome; this is the
  // controller-level addendum that records the cap-exhaustion verdict.
  public async appendCapExhaustedPhaseEnd(inputs: {
    runId: string;
    phase: Phase;
    iteration: number;
    pipelineId?: string;
    phaseDef?: PhaseDef;
  }): Promise<void> {
    const payload: Record<string, unknown> = {
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: inputs.phaseDef?.id ?? inputs.phase,
      outcome: 'failed',
      cause: 'cap_exhausted'
    };
    if (inputs.phaseDef?.model) payload.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) payload.effort = inputs.phaseDef.effort;
    if (inputs.phaseDef?.timeoutSeconds) {
      payload.timeoutMs = inputs.phaseDef.timeoutSeconds * 1000;
    }
    await this.auditWriter.append({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      eventType: 'phase-end',
      payload,
      outcome: 'failure'
    });
  }

  private appendAudit(
    inputs: PhaseRunInputs,
    eventType:
      | 'phase-start'
      | 'phase-end'
      | 'cancel'
      | 'phase.retry_evaluated'
      | 'fatal-signature-matched'
      | 'auto-compact-override-applied'
      | 'phase-message-emitted'
      | 'phase-message-truncated'
      | 'phase-message-invalid',
    outcome: 'success' | 'failure' | 'info',
    payload: Record<string, unknown>
  ) {
    return this.auditWriter.append({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      eventType,
      payload,
      outcome
    });
  }

  // Feature 010 — FR-017. Emit one phase.retry_evaluated record per consulted
  // decision. The envelope `outcome` is always `'info'`; the loop-vs-advance
  // boolean lives at `payload.decision` to avoid colliding with the envelope
  // field (see contracts/audit-events.md Naming note).
  private async maybeEmitRetryEvaluated(
    inputs: PhaseRunInputs,
    result: InvocationResult,
    metrics: Readonly<Record<string, number>>
  ): Promise<void> {
    const expression = inputs.phaseDef?.retryCondition;
    if (typeof expression !== 'string' || expression.trim().length === 0) return;
    // FR-017 — do not emit when the parser outcome is malformed; that path
    // already records the failure via phase-end (with `cause` when fatal).
    // Feature 011 — transient_error and rate_limited likewise route through
    // a dedicated delayed-retry audit channel (`retry-scheduled`); do not
    // double-count via phase.retry_evaluated.
    if (
      result.kind === 'malformed' ||
      result.kind === 'transient_error' ||
      result.kind === 'rate_limited'
    ) {
      return;
    }

    const phaseDefId = inputs.phaseDef?.id ?? inputs.phase;
    const basePayload = {
      pipelineId: inputs.pipelineId ?? BUILT_IN_PIPELINE_ID,
      phaseId: phaseDefId,
      expression,
      metrics
    };

    const parsed = validateRetryCondition(expression);
    if (!parsed.ok) {
      const errorMessage = parsed.error;
      this.logger.warn(`retryCondition parse error on ${phaseDefId}: ${errorMessage}`);
      await this.appendAudit(inputs, 'phase.retry_evaluated', 'info', {
        ...basePayload,
        decision: false,
        evaluationError: true,
        errorMessage
      });
      return;
    }

    const evalResult = evaluateRetryCondition(parsed.expression, metrics);
    if (!evalResult.ok) {
      const errorMessage = evalResult.error.error;
      this.logger.warn(`retryCondition evaluation error on ${phaseDefId}: ${errorMessage}`);
      await this.appendAudit(inputs, 'phase.retry_evaluated', 'info', {
        ...basePayload,
        decision: false,
        evaluationError: true,
        errorMessage
      });
      return;
    }

    const payload: Record<string, unknown> = {
      ...basePayload,
      decision: evalResult.evaluation.value
    };
    if (evalResult.evaluation.missingKeys.length > 0) {
      const missing = [...evalResult.evaluation.missingKeys];
      payload.missingKeys = missing;
      this.logger.warn(
        `retryCondition missing metric(s) on ${phaseDefId}: ${missing.join(', ')}`
      );
    }
    await this.appendAudit(inputs, 'phase.retry_evaluated', 'info', payload);
  }
}

function mapOutcome(result: InvocationResult, exitCode: number | null): PhaseOutcome {
  switch (result.kind) {
    case 'clean':
      return 'clean';
    case 'open_questions':
    case 'remaining_issues':
      return 'issues_remain';
    case 'rate_limited':
      return 'rate_limited';
    // Feature 011 — T019: parser-classified transient error maps to the
    // controller's delayed-retry path via PhaseOutcome.transient_error.
    case 'transient_error':
      return 'transient_error';
    case 'malformed':
      // Feature 010 FR-004: a fatal-classification result terminates the
      // phase on the current invocation regardless of exit code.
      if (result.fatalCause) return 'failed';
      return exitCode !== null && exitCode !== 0 ? 'failed' : 'issues_remain';
  }
}

function mapTerminationReason(result: InvocationResult, exitCode: number | null): TerminationReason {
  switch (result.kind) {
    case 'clean':
      return 'token';
    case 'open_questions':
      return 'open_questions';
    case 'remaining_issues':
      return 'remaining_issues';
    case 'rate_limited':
      return 'rate_limit';
    case 'transient_error':
      // Feature 011 — surface as 'error' for the persisted TerminationReason
      // (the queue/history pipeline treats this the same as a generic error;
      // the controller's pendingRetryCause is the load-bearing distinguisher).
      return 'error';
    case 'malformed':
      if (result.fatalCause) return 'error';
      return exitCode !== null && exitCode !== 0 ? 'error' : 'remaining_issues';
  }
}
