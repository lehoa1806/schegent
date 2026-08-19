import type { Phase, PhaseOutcome } from './phase';
import type { BackendRunner } from '../contracts/backend-runner';
import type { BackendRunnerRegistry } from '../runner/backend-runner-registry';
import { DEFAULT_BACKEND } from '../runner/backend-runner-factory';
import type { PromptBuilder } from '../runner/prompt-builder';
import type { ExecutionEnvelope } from '../contracts/run-request';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { projectAuditPayload } from '../audit/audit-payload';
import type { AuditEntry } from '../audit/audit-entry';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { SanitizedLogger } from '../lib/logger';
import { parseAuditLogBlock, AUDIT_LOG_CLOSE_MARKER } from '../parser/audit-log-parser';
import { parseInvocation, type InvocationResult } from '../parser/stdout-parser';
import { extractInvocationUsageMetrics } from '../parser/invocation-usage';
import { unwrapStreamJson } from '../parser/stream-json-unwrapper';
import { detectCreditError } from '../parser/credit-error-detector';
import type { RawTranscriptMode, TerminationReason } from '../state/workflow-run';
import type { PhaseDef } from '../config/pipeline-config';
import { assertPhaseRunnerPolicy } from '../config/phase-runner-policy';
import type { RawInvocationOutput, VerboseDiagnosticTarget } from '../runner/invocation-result';
import { composeVerboseDiagnosticPath } from '../audit/verbose-diagnostic-path';
import { getEffectiveSignatures } from '../lib/fatal-signature-registry';
import type { PhaseBreakpointAccessor } from './breakpoint-accessor';
import {
  PhaseSidecarReader,
  composePhaseMessagePath,
  type PhaseMessageResult
} from './phase-sidecar-reader';
import { PhaseRetryEvaluator, type LastRetryDecisionSink } from './phase-retry-evaluator';
import {
  failClosedOnTruncatedOutput,
  mapOutcome,
  mapTerminationReason,
  summarize
} from './phase-outcome-mapper';
import { compactClaudeSession } from './session-compactor';
import { RequiredEvidenceUnavailableError } from '../lib/errors';
// Compatibility re-export; canonical owner is phase-sidecar-reader.
export { composePhaseMessagePath };
export type { PhaseMessageResult };

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
  inheritProcessEnv?: boolean;
  processEnvAllowlist?: readonly string[];
  runId: string;
  rawTranscriptMode?: RawTranscriptMode;
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
   * a new task, not a continuation of an interrupted conversation.
   *
   * NOTE: These dispatches MAY set `sessionReuse: true` with a
   * `resumeSessionId` to reuse the Claude CLI session for cost
   * optimization (prompt cache preservation). This is semantically
   * distinct from `isContinue` — it uses the same `--resume` argv
   * but records `sessionReuse: true` in the audit payload.
   */
  isContinue?: boolean;
  /**
   * Session reuse — cost-optimization flag. When `true` AND
   * `resumeSessionId` is set, the runner uses `--resume <id>` to
   * reuse the CLI session's cached context. Semantically distinct
   * from `isContinue`: this starts a new task in the same session,
   * not a continuation of an interrupted conversation. The runner
   * forces auto-compaction (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1) on
   * session-reuse invocations to compact the prior phase's context
   * before processing the new prompt.
   */
  sessionReuse?: boolean;
  /**
   * Session ID capture — optional session ID from a prior CLI invocation.
   * When set AND (`isContinue === true` OR `sessionReuse === true`),
   * forwarded to `InvocationRequest.resumeSessionId` so the runner uses
   * `--resume <id>`. When omitted and `isContinue === true`, the runner
   * falls back to `-c` (most-recent session). When omitted and only
   * `sessionReuse === true`, falls back to a fresh session.
   */
  resumeSessionId?: string;
  /**
   * Optional custom prompt provided by the operator for a resume invocation.
   * When set, bypasses standard prompt generation.
   */
  resumePrompt?: string;
  /**
   * FR-R3-001 (T260) — the accepted request, forwarded whole to the prompt seam.
   *
   * Deliberately one field rather than four. The phase runner does not read the
   * envelope's members and must not start: it is a carrier here, so a field
   * added to the envelope reaches the prompt without touching this file. Absent
   * for a Run started outside the composed path, which is the legacy prompt
   * unchanged.
   */
  envelope?: ExecutionEnvelope;
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
  /**
   * Session ID capture — the CLI session ID extracted from this
   * invocation's stream-json output. Forwarded by the controller to
   * persist on `WorkflowRun.lastCliSessionId`.
   */
  cliSessionId?: string;
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
  private readonly sidecarReader: PhaseSidecarReader;
  private readonly retryEvaluator: PhaseRetryEvaluator;
  private readonly runnerRegistry: BackendRunnerRegistry | null;
  private readonly singleRunner: BackendRunner | null;

  constructor(
    runner: BackendRunner | BackendRunnerRegistry,
    private readonly promptBuilder: PromptBuilder,
    private readonly auditWriter: AuditLogWriter,
    private readonly logger: SanitizedLogger,
    private readonly rawTranscript: RawTranscriptWriter | null = null,
    private readonly verboseAccessor: VerboseDiagnosticsAccessor | null = null,
    private readonly fatalSignaturesAccessor: FatalSignaturesAccessor | null = null,
    private readonly autoCompactOverrideAccessor: AutoCompactOverrideAccessor | null = null,
    private readonly manualPauseAccessor: ManualPauseAccessor | null = null,
    private readonly phaseBreakpointAccessor: PhaseBreakpointAccessor | null = null,
    lastRetryDecisionSink: LastRetryDecisionSink | null = null
  ) {
    // Feature 074 — accept either a BackendRunnerRegistry (per-phase
    // runner resolution) or a plain BackendRunner (backwards compat
    // with existing test mocks and construction sites).
    if ('getOrCreate' in runner) {
      this.runnerRegistry = runner as BackendRunnerRegistry;
      this.singleRunner = null;
    } else {
      this.runnerRegistry = null;
      this.singleRunner = runner as BackendRunner;
    }
    this.sidecarReader = new PhaseSidecarReader(auditWriter, logger);
    this.retryEvaluator = new PhaseRetryEvaluator(
      auditWriter,
      logger,
      undefined,
      undefined,
      lastRetryDecisionSink
    );
  }

  /**
   * Feature 074 — resolve the effective runner for this invocation.
   * When a registry is available, resolves from phaseDef.runner ?? globalDefault.
   * When a single runner was injected (backwards compat), returns it directly.
   */
  private resolveRunner(inputs: PhaseRunInputs): BackendRunner {
    if (this.runnerRegistry) {
      return this.runnerRegistry.getOrCreate(inputs.phaseDef?.runner);
    }
    return this.singleRunner!;
  }

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
    // Feature 098 (T045, FR-034) — six expressions here read
    // `?? BUILT_IN_PIPELINE_ID`; all six omit rather than invent.
    const pipelineAttribution: { pipelineId?: string } =
      inputs.pipelineId === undefined ? {} : { pipelineId: inputs.pipelineId };
    const debugPhaseId = inputs.phaseDef?.id ?? inputs.phase;
    this.logger.debug('phase-runner.lock-acquired', {
      ...pipelineAttribution,
      phaseId: debugPhaseId,
      runId: inputs.runId,
      waitMs: 0
    });
    this.logger.debug('phase-runner.iteration-tick', {
      ...pipelineAttribution,
      phaseId: debugPhaseId,
      runId: inputs.runId,
      iteration: inputs.iteration
    });
    try {
      return await this.runInner(inputs);
    } finally {
      this.logger.debug('phase-runner.lock-released', {
        ...pipelineAttribution,
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
    // paused (no partial side effects). RunDriver consumes
    // `outcome: 'paused-at-breakpoint'` and stamps
    // `manualPauseCause: 'breakpoint-paused'` + `resumeTargetPhaseId`.
    const breakpointPhaseId = inputs.phaseDef?.id ?? inputs.phase;
    const breakpoints =
      this.phaseBreakpointAccessor?.readBreakpointPhaseIds(inputs.runId) ??
      new Set<string>();
    if (breakpoints.has(breakpointPhaseId)) {
      const firedAt = Date.now();
      const auditEntry = await this.appendRequiredAudit({
        runId: inputs.runId,
        phase: inputs.phase,
        iteration: inputs.iteration,
        eventType: 'phase-breakpoint-fired',
        payload: {
          ...(inputs.pipelineId === undefined ? {} : { pipelineId: inputs.pipelineId }),
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
    const prompt = inputs.resumePrompt 
      ? inputs.resumePrompt 
      : this.promptBuilder.build({
          phase: inputs.phase,
          phaseDef: inputs.phaseDef,
          iteration: inputs.iteration,
          iterationCap: inputs.iterationCap,
          featureDescription: inputs.featureDescription,
          featureDir: inputs.featureDir,
          carriedIssues: inputs.carriedIssues,
          phaseMessagePath: inputs.phaseMessagePath ?? null,
          previousPhaseMessage: inputs.previousPhaseMessage ?? null,
          envelope: inputs.envelope
        });
    // Feature 074 — resolve the effective runner kind for audit attribution.
    const effectiveRunnerKind = inputs.phaseDef?.runner
      ?? this.runnerRegistry?.getGlobalDefault()
      ?? DEFAULT_BACKEND;
    // Feature 098 T018 — the declared class is the rule's input, and this is the
    // only site that sees the pair the two save gates cannot: both return early
    // when a Phase declares no runner, so `git` with no runner reaches execution
    // without a verdict and the runner it actually gets is resolved right above.
    const policyPhaseId = inputs.phaseDef?.id ?? inputs.phase;
    assertPhaseRunnerPolicy(policyPhaseId, inputs.phaseDef?.sideEffects, effectiveRunnerKind);

    const startPayload: Record<string, unknown> = {
      ...(inputs.pipelineId === undefined ? {} : { pipelineId: inputs.pipelineId }),
      phaseId: inputs.phaseDef?.id ?? inputs.phase,
      // Feature 074 — always-present runner attribution.
      runner: effectiveRunnerKind,
      // Feature 032 — strict-boolean continuation telemetry. Always
      // present on the payload (never omitted); a missing or
      // non-`=== true` `inputs.isContinue` records `false`. Matches the
      // strict gate used by the runner's `-c` / `--resume` argv append
      // so the audit record and the spawned argv stay in lock-step.
      isContinue: inputs.isContinue === true,
      // Session reuse — strict-boolean cost-optimization telemetry.
      // Always present (never omitted); defaults `undefined` → `false`.
      sessionReuse: inputs.sessionReuse === true,
    };
    if (inputs.phaseDef?.model) startPayload.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) startPayload.effort = inputs.phaseDef.effort;
    if (inputs.phaseDef?.timeoutSeconds) {
      startPayload.timeoutMs = inputs.phaseDef.timeoutSeconds * 1000;
    }
    await this.appendAudit(inputs, 'phase-start', 'info', startPayload);

    this.logger.info(`phase-start ${inputs.phase} iter=${inputs.iteration}`);
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
    if (effectiveRunnerKind === 'claude' && autoCompactPct !== undefined) {
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(autoCompactPct);
      await this.appendAudit(inputs, 'auto-compact-override-applied', 'info', {
        ...this.pipelineMeta(inputs),
        runId: inputs.runId,
        value: autoCompactPct
      });
    }
    // Compact Claude sessions before cross-phase reuse to bound context bleed.
    let effectiveSessionReuse = inputs.sessionReuse === true;
    let effectiveIsContinue = inputs.isContinue === true;
    let effectiveResumeSessionId = inputs.resumeSessionId;
    if (
      effectiveRunnerKind === 'claude' &&
      effectiveSessionReuse &&
      typeof inputs.resumeSessionId === 'string'
    ) {
      try {
        await this.compactSession(inputs);
      } catch (err) {
        effectiveSessionReuse = false;
        effectiveIsContinue = false;
        effectiveResumeSessionId = undefined;
        this.logger.warn('session-compact-failed', {
          phase: inputs.phase,
          iteration: inputs.iteration
        });
        await this.appendRequiredAudit({
          runId: inputs.runId,
          phase: inputs.phase,
          iteration: inputs.iteration,
          eventType: 'warning',
          payload: {
            ...this.pipelineMeta(inputs),
            reasonCode: 'session-compaction-failed-fresh-session'
          },
          outcome: 'failure'
        });
      }
    }
    await this.rawTranscript?.appendStart({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      prompt,
      mode: inputs.rawTranscriptMode
    });
    const rawTranscriptCapture = await this.rawTranscript?.createInvocationCapture?.(
      inputs.runId, inputs.rawTranscriptMode
    ) ?? null;
    // FR-033 — one read per invocation (never cached), shared by both scans.
    const effectiveFatalSignatures =
      getEffectiveSignatures(this.fatalSignaturesAccessor?.readOperatorAdditions() ?? []);
    let raw: RawInvocationOutput;
    try {
      raw = await this.resolveRunner(inputs).invoke({
        effectiveFatalSignatures,
        phase: inputs.phase,
        iteration: inputs.iteration,
        runId: inputs.runId,
        prompt,
        timeoutMs: inputs.timeoutMs,
        completionMarker: AUDIT_LOG_CLOSE_MARKER,
        cliPath: inputs.cliPath,
        cwd: inputs.cwd,
        env,
        ...(inputs.inheritProcessEnv === false ? { inheritProcessEnv: false } : {}),
        ...(inputs.processEnvAllowlist !== undefined
          ? { processEnvAllowlist: inputs.processEnvAllowlist }
          : {}),
        cancellationSignal: inputs.cancellationSignal,
        ...(inputs.phaseDef?.model ? { model: inputs.phaseDef.model } : {}),
        ...(inputs.phaseDef?.effort ? { effort: inputs.phaseDef.effort } : {}),
        ...(verboseDiagnostics ? { verboseDiagnostics } : {}),
        // Feature 032 — forward the controller's session-continuation
        // hint. The runner uses strict `=== true` to gate the `-c` /
        // `--resume` append.
        ...(effectiveIsContinue ? { isContinue: true } : {}),
        // Session reuse — forward the cost-optimization session reuse
        // hint. The runner uses the same `--resume` argv path.
        ...(effectiveSessionReuse ? { sessionReuse: true } : {}),
        // Session ID capture — forward the persisted session ID so the
        // runner uses `--resume <id>` instead of `-c`.
        ...(typeof effectiveResumeSessionId === 'string'
          ? { resumeSessionId: effectiveResumeSessionId }
          : {})
      }, rawTranscriptCapture ?? undefined);
    } catch (err) {
      await rawTranscriptCapture?.dispose();
      throw err;
    }

    await this.appendAudit(inputs, 'cli-invocation', 'info', projectAuditPayload('cli-invocation', {
      runner: effectiveRunnerKind,
      operation: 'phase',
      permissionMode: effectiveRunnerKind === 'codex' ? 'workspace-write' : 'unrestricted',
      continued: effectiveIsContinue,
      sessionReused: effectiveSessionReuse,
      ...(inputs.phaseDef?.model ? { modelId: inputs.phaseDef.model } : {}),
      ...(inputs.phaseDef?.effort ? { effortId: inputs.phaseDef.effort } : {}),
      diagnosticsEnabled: verboseDiagnostics !== undefined
    }));
    await this.rawTranscript?.appendEnd({
      runId: inputs.runId,
      stdout: raw.stdoutBuffer,
      stderr: raw.stderrBuffer,
      exitCode: raw.exitCode,
      killed: raw.killed,
      timedOut: raw.timedOut,
      capture: rawTranscriptCapture,
      mode: inputs.rawTranscriptMode
    });
    const unwrappedStream = unwrapStreamJson(raw.stdoutBuffer);

    // Feature 030 BUG-002 — parse up front so the timeout branch can tell a
    // completed-but-non-exiting run (clean stdout, FR-025) from an idle stall.
    const rateLimit = detectCreditError(raw.stdoutBuffer, raw.stderrBuffer, raw.exitCode);
    const audit = parseAuditLogBlock(unwrappedStream.text);
    const parsedResult = parseInvocation({
      stdout: unwrappedStream.text,
      stderr: typeof raw.stderrBuffer === 'string' ? raw.stderrBuffer : raw.stderrBuffer.getTrailingLines(100),
      exitCode: raw.exitCode,
      rateLimit,
      auditEntry: audit.entry,
      auditWarnings: audit.warnings,
      effectiveFatalSignatures,
      apiError: unwrappedStream.apiError,
      ...(raw.streamFatalMatch ? { streamFatalMatch: raw.streamFatalMatch } : {})
    });
    const result = failClosedOnTruncatedOutput(
      parsedResult,
      raw.stdoutBuffer.truncated || raw.stderrBuffer.truncated
    );

    // Feature 030 BUG-002 — hung-but-clean run = success, not timeout (FR-025).
    if (raw.timedOut && result.kind !== 'clean') {
      const auditEntry = await this.appendAudit(inputs, 'phase-end', 'failure', {
        ...this.pipelineMeta(inputs),
        outcome: 'timeout',
        terminationReason: 'timeout',
        ...this.invocationMetricPayload(raw)
      });
      return {
        result: { kind: 'malformed', warnings: ['timeout'], auditEntry: null },
        outcome: 'timeout',
        terminationReason: 'timeout',
        stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
        stderrSummary: this.logger.sanitize(summarize(typeof raw.stderrBuffer === 'string' ? raw.stderrBuffer : raw.stderrBuffer.getTrailingLines(100))),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        warnings: ['phase timed out'],
        phaseMessage: null
      };
    }

    if (raw.killed && raw.exitCode === null) {
      const auditEntry = await this.appendAudit(inputs, 'cancel', 'info', {
        ...this.pipelineMeta(inputs),
        reason: 'killed'
      });
      return {
        result: { kind: 'malformed', warnings: ['cancelled'], auditEntry: null },
        outcome: 'failed',
        terminationReason: 'cancel',
        stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
        stderrSummary: this.logger.sanitize(summarize(typeof raw.stderrBuffer === 'string' ? raw.stderrBuffer : raw.stderrBuffer.getTrailingLines(100))),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        warnings: ['phase cancelled'],
        phaseMessage: null
      };
    }

    // Feature 013 — T041 (Wave 3): defense-in-depth log. The parser now
    // allows clean results with non-zero exit codes when a clean termination
    // token is present (the CLI can exit non-zero due to error_during_execution
    // while the model completed successfully). Log a warning for observability
    // but do NOT throw — the model's successful completion takes precedence.
    if (result.kind === 'clean' && raw.exitCode !== null && raw.exitCode !== 0) {
      this.logger.warn('phase-runner: clean result with non-zero exit code', {
        phase: inputs.phase,
        iteration: inputs.iteration,
        exitCode: raw.exitCode
      });
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

    const phaseMessage = await this.sidecarReader.parsePhaseMessage(inputs, audit.entry);

    // Feature 010 — FR-017: emit phase.retry_evaluated for every consulted
    // decision. Skipped when the parser outcome is malformed (the malformed
    // path already records the failure via phase-end + cause).
    await this.retryEvaluator.maybeEmit({
      phase: inputs.phase,
      phaseDef: inputs.phaseDef,
      pipelineId: inputs.pipelineId,
      runId: inputs.runId,
      iteration: inputs.iteration,
      result,
      metrics: audit.entry?.metrics ?? {}
    });

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

    const auditEntry = await this.appendAudit(
      inputs,
      'phase-end',
      outcome === 'clean' ? 'success' : outcome === 'failed' ? 'failure' : 'info',
      {
        ...this.pipelineMeta(inputs),
        outcome,
        exitCode: raw.exitCode,
        terminationReason,
        ...this.invocationMetricPayload(raw),
        files_created: audit.entry?.filesCreated ?? [],
        files_modified: audit.entry?.filesModified ?? [],
        commands_executed: audit.entry?.commandsExecuted ?? [],
        warnings: combinedWarnings.length > 0 ? combinedWarnings : undefined,
        // FR-005 — redacted fatal-cause text; audit-log-writer is the
        // single sanitization point (sanitize() runs there on the
        // whole payload).
        ...(fatalCause ? { cause: fatalCause } : {})
      }
    );

    return {
      result,
      outcome,
      terminationReason,
      stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
      stderrSummary: this.logger.sanitize(summarize(typeof raw.stderrBuffer === 'string' ? raw.stderrBuffer : raw.stderrBuffer.getTrailingLines(100))),
      exitCode: raw.exitCode,
      auditEntryId: auditEntry.id,
      warnings: 'warnings' in result ? result.warnings : [],
      phaseMessage,
      cliSessionId: raw.cliSessionId
    };
  }

  private async compactSession(inputs: PhaseRunInputs): Promise<void> {
    await compactClaudeSession({
      runner: this.resolveRunner(inputs),
      rawTranscript: this.rawTranscript,
      rawTranscriptMode: inputs.rawTranscriptMode,
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      cliPath: inputs.cliPath,
      cwd: inputs.cwd,
      inheritProcessEnv: inputs.inheritProcessEnv,
      processEnvAllowlist: inputs.processEnvAllowlist,
      cancellationSignal: inputs.cancellationSignal,
      resumeSessionId: inputs.resumeSessionId!,
      logger: this.logger,
      onCommand: () => this.appendAudit(inputs, 'cli-invocation', 'info', projectAuditPayload('cli-invocation', {
        runner: 'claude',
        operation: 'session-compaction',
        permissionMode: 'unrestricted',
        continued: false,
        sessionReused: true,
        ...(inputs.phaseDef?.model ? { modelId: inputs.phaseDef.model } : {}),
        ...(inputs.phaseDef?.effort ? { effortId: inputs.phaseDef.effort } : {}),
        diagnosticsEnabled: false
      })).then(() => undefined)
    });
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
    // Feature 098 (T045, FR-034) — the Pipeline id is a directory name here, so
    // a substituted one would file a Run's diagnostics under a Pipeline that had
    // nothing to do with it. A path segment cannot be omitted; the whole opt-in
    // declines, as it already does for any path this method cannot trust.
    const pipelineId = inputs.pipelineId;
    if (pipelineId === undefined) return undefined;
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
    // Feature 074 — resolve effective runner kind for audit payloads.
    const effectiveRunnerKind = inputs.phaseDef?.runner
      ?? this.runnerRegistry?.getGlobalDefault()
      ?? DEFAULT_BACKEND;
    const meta: Record<string, unknown> = {
      ...(inputs.pipelineId === undefined ? {} : { pipelineId: inputs.pipelineId }),
      phaseId: inputs.phaseDef?.id ?? inputs.phase,
      runner: effectiveRunnerKind
    };
    if (inputs.phaseDef?.model) meta.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) meta.effort = inputs.phaseDef.effort;
    if (inputs.phaseDef?.timeoutSeconds) {
      meta.timeoutMs = inputs.phaseDef.timeoutSeconds * 1000;
    }
    return meta;
  }

  private invocationMetricPayload(
    raw: Pick<RawInvocationOutput, 'stdoutBuffer' | 'stderrBuffer' | 'durationMs'>
  ): Record<string, unknown> {
    return {
      // Runner timing stays canonical; CLI-reported duration is separate.
      durationMs: raw.durationMs,
      ...(raw.stdoutBuffer.truncated ? { stdoutTruncated: true } : {}),
      ...(raw.stderrBuffer.truncated ? { stderrTruncated: true } : {}),
      ...(extractInvocationUsageMetrics(raw.stdoutBuffer) ?? {})
    };
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
      ...(inputs.pipelineId === undefined ? {} : { pipelineId: inputs.pipelineId }),
      phaseId: inputs.phaseDef?.id ?? inputs.phase,
      runner: inputs.phaseDef?.runner ?? this.runnerRegistry?.getGlobalDefault() ?? DEFAULT_BACKEND,
      outcome: 'failed',
      terminationReason: 'cap-exhausted',
      exitCode: null
    };
    if (inputs.phaseDef?.model) payload.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) payload.effort = inputs.phaseDef.effort;
    if (inputs.phaseDef?.timeoutSeconds) {
      payload.timeoutMs = inputs.phaseDef.timeoutSeconds * 1000;
    }
    await this.appendRequiredAudit({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      eventType: 'phase-end',
      payload,
      outcome: 'failure'
    });
  }

  private async appendAudit(
    inputs: PhaseRunInputs,
    eventType:
      | 'phase-start'
      | 'phase-end'
      | 'cancel'
      | 'fatal-signature-matched'
      | 'auto-compact-override-applied'
      | 'cli-invocation',
    outcome: 'success' | 'failure' | 'info',
    payload: Record<string, unknown>
  ): Promise<AuditEntry> {
    return this.appendRequiredAudit({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      eventType,
      payload,
      outcome
    });
  }

  private async appendRequiredAudit(
    entry: Omit<AuditEntry, 'id' | 'timestamp'>
  ): Promise<AuditEntry> {
    try {
      return await this.auditWriter.append(entry);
    } catch {
      this.logger.warn(
        `phase-runner: required audit evidence unavailable (${entry.eventType})`
      );
      throw new RequiredEvidenceUnavailableError(entry.eventType);
    }
  }
}
