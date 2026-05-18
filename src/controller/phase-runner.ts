import type { Phase, PhaseOutcome } from './phase';
import type { BackendRunner } from '../contracts/backend-runner';
import type { PromptBuilder } from '../runner/prompt-builder';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { SanitizedLogger } from '../lib/logger';
import { parseAuditLogBlock } from '../parser/audit-log-parser';
import { parseInvocation, type InvocationResult } from '../parser/stdout-parser';
import { extractInvocationUsageMetrics } from '../parser/invocation-usage';
import { detectCreditError } from '../parser/credit-error-detector';
import type { TerminationReason } from '../state/workflow-run';
import { BUILT_IN_PIPELINE_ID, type PhaseDef } from '../config/pipeline-config';
import type { RawInvocationOutput, VerboseDiagnosticTarget } from '../runner/invocation-result';
import { composeVerboseDiagnosticPath } from '../audit/verbose-diagnostic-path';
import { getEffectiveSignatures } from '../lib/fatal-signature-registry';
import type { PhaseBreakpointAccessor } from './breakpoint-accessor';
import {
  PhaseSidecarReader,
  composePhaseMessagePath,
  type PhaseMessageResult
} from './phase-sidecar-reader';
import { PhaseRetryEvaluator } from './phase-retry-evaluator';
import {
  mapOutcome,
  mapTerminationReason,
  summarize,
  truncationFields
} from './phase-outcome-mapper';

// Feature 057 — re-export from `phase-sidecar-reader` so existing import
// surfaces (workflow-controller, tests) remain stable; canonical owner moved.
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
  private readonly sidecarReader: PhaseSidecarReader;
  private readonly retryEvaluator: PhaseRetryEvaluator;

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
  ) {
    this.sidecarReader = new PhaseSidecarReader(auditWriter, logger);
    this.retryEvaluator = new PhaseRetryEvaluator(auditWriter, logger);
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
        ...this.invocationMetricPayload(raw),
        ...truncationFields(raw)
      });
      return {
        result: { kind: 'malformed', warnings: ['timeout'], auditEntry: null },
        outcome: 'timeout',
        terminationReason: 'timeout',
        stdoutSummary: this.logger.sanitize(summarize(raw.stdout)),
        stderrSummary: this.logger.sanitize(summarize(raw.stderr)),
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
        stdoutSummary: this.logger.sanitize(summarize(raw.stdout)),
        stderrSummary: this.logger.sanitize(summarize(raw.stderr)),
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

    const phaseMessage = await this.sidecarReader.parsePhaseMessage(inputs, audit.entry);

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
        ...this.invocationMetricPayload(raw),
        files_created: audit.entry?.filesCreated ?? [],
        files_modified: audit.entry?.filesModified ?? [],
        commands_executed: audit.entry?.commandsExecuted ?? [],
        warnings: combinedWarnings.length > 0 ? combinedWarnings : undefined,
        // FR-005 — redacted fatal-cause text; audit-log-writer is the
        // single sanitization point (sanitize() runs there on the
        // whole payload).
        ...(fatalCause ? { cause: fatalCause } : {}),
        ...truncationFields(raw)
      }
    );

    return {
      result,
      outcome,
      terminationReason,
      stdoutSummary: this.logger.sanitize(summarize(raw.stdout)),
      stderrSummary: this.logger.sanitize(summarize(raw.stderr)),
      exitCode: raw.exitCode,
      auditEntryId: auditEntry.id,
      warnings: 'warnings' in result ? result.warnings : [],
      phaseMessage
    };
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

  private invocationMetricPayload(
    raw: Pick<RawInvocationOutput, 'stdout' | 'durationMs'>
  ): Record<string, unknown> {
    return {
      // Trust the runner-owned process timer for the canonical duration.
      // CLI-reported stream-json duration is carried separately as
      // `cliDurationMs` so model/CLI output cannot overwrite host timing.
      durationMs: raw.durationMs,
      ...(extractInvocationUsageMetrics(raw.stdout) ?? {})
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
      | 'fatal-signature-matched'
      | 'auto-compact-override-applied',
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

}

