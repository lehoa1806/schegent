import { isSafeArgvValue } from '../contracts/argv-value';
import type { Phase, PhaseOutcome } from './phase';
import { policyRequestFields } from '../runner/spawn-env';
import type { BackendRunner } from '../contracts/backend-runner';
import type { BackendRunnerRegistry } from '../runner/backend-runner-registry';
import { DEFAULT_BACKEND, type BackendRunnerKind } from '../contracts/backend-kinds';
import type { PromptBuilder } from '../runner/prompt-builder';
import type { ExecutionEnvelope } from '../contracts/run-request';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import {
  CAP_EXHAUSTED_CAUSE,
  PRE_SPAWN_REFUSAL_CAUSE,
  projectAuditPayload
} from '../audit/audit-payload';
import {
  PhaseAttemptRecorder,
  type PhaseAttempt
} from './phase-attempt-recorder';
import type { AuditEntry, AuditEntryFields } from '../audit/audit-entry';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { SanitizedLogger } from '../lib/logger';
import { parseAuditLogBlock } from '../parser/audit-log-parser';
import { parseInvocation, type InvocationResult } from '../parser/stdout-parser';
import { extractInvocationUsageMetrics } from '../parser/invocation-usage';
import { cliVersionFields, observedVersionOf } from '../runner/cli-version-probe';
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
  BackendPostureRecorder,
  type BackendPostureAccessor
} from './backend-posture-recorder';
import type { CapabilityRefusalEventType } from '../contracts/audit-events';
import { isCapabilityRefusal } from '../services/capability-refusal';
import { isUncontainedBackendRefusal } from '../services/backend-containment-policy';
import { authoredPhaseTimeoutMs, effectivePhaseTimeoutMs } from './effective-phase-timeout';
import {
  capabilityRequestFields,
  recordCapabilityDecision
} from './capability-decision-recorder';
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
import { resolveHostVerification } from '../config/phase-runner-policy';
import { COMPACTION_MODEL_ID, compactClaudeSession, compactionFailureRecord } from './session-compactor';
import { RequiredEvidenceUnavailableError } from '../lib/errors';
// Compatibility re-export; canonical owner is phase-sidecar-reader.
export { composePhaseMessagePath };
export type { PhaseMessageResult };

/**
 * FR-R3-058 / FR-R3-117 — does this Phase require the host's own evidence to
 * advance, and which basis judged it? Read on every call, never cached: a
 * definition can be re-published mid-run.
 *
 * FR-R3-117 changed what an ABSENT field means, and the freeze resolves it, so a
 * phase from a frozen plan arrives explicit. `resolveHostVerification` runs anyway
 * for a definition that did not come through a freeze, so the two paths cannot
 * disagree. `verdictBasisOf` reads the same call, so the RECORDED basis cannot
 * disagree with the applied one; no definition records `model-token`, because
 * nothing was declared to resolve.
 */
function requiresHostVerification(inputs: PhaseRunInputs): boolean {
  const def = inputs.phaseDef;
  if (def === undefined) return false;
  return resolveHostVerification(def.hostVerification, def.sideEffects) === 'exit-code';
}

function verdictBasisOf(inputs: PhaseRunInputs): 'exit-code' | 'model-token' {
  return requiresHostVerification(inputs) ? 'exit-code' : 'model-token';
}

/**
 * FR-009 (BUG-001) — is this exit status one the BACKEND produced?
 *
 * `exit-code` is a proxy for the host's verdict, and a proxy is only as good as
 * its provenance. Schegent produces an exit status of its own: when the backend
 * emits its terminal result and then does not exit, the runner grace-terminates
 * the lingering process on feature 030's FR-025 settle window and the process
 * tree reports SIGTERM's `128 + 15`. Failing a phase on that number is the runner
 * reporting its own signal back to itself as the host's evidence — the
 * self-certification FR-R3-058 exists to prevent, inverted.
 *
 * A derived rule rather than a conjunct per arm (plan D5): the next
 * runner-authored termination reason is a one-line change here. Narrow by
 * construction — the flag requires an OBSERVED terminal result, so it cannot
 * reach the timeout or deadline arms above, which fail deliberately and
 * correctly. See specs/145-host-verifiable-gates/contracts/host-verification.md.
 */
function hostExitStatusIsAttributable(raw: RawInvocationOutput): boolean {
  return raw.completedAwaitingExit !== true;
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
  /** FR-R3-075 — absolute per-invocation wall-clock bound. */
  maxDurationMs?: number;
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
  /**
   * Feature 194 (FR-010, contract C3.3) — the consecutive-unchanged count
   * `PhaseRetryEvaluator.maybeEmit()` computed for this iteration, one
   * optional numeric field. Threaded into `transition()`'s `stalledCount`
   * (via `PhaseSequencer.decideAfterPhase()`) so the cap warning and the
   * `phase.retry_evaluated` payload render the same number from the one
   * computation. Absent under the same rule `stalled` is absent under.
   */
  stalledCount?: number;
  /**
   * Feature 212 (FR-006) — did the backend produce its end-of-invocation result
   * envelope? Carried onto the persisted `PhaseResult` so a run that ended with
   * no envelope stays distinguishable, after the fact, from one that ended with
   * a verdict — the distinction the deadline arm used to erase.
   *
   * ABSENT MEANS UNKNOWN (FR-014). A backend that does not report the fact omits
   * this, and no reader may read the omission as `'absent'`; `'absent'` is the
   * positive claim that the invocation ran and no envelope arrived.
   */
  resultEnvelope?: 'received' | 'absent';
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

/**
 * Feature 212 (FR-001) — the in-flight attempt, shared between `run()`'s
 * `finally` and the `runInner` body that opens and closes it.
 *
 * `attempt` is null only before the `phase-start` row exists: a phase refused
 * before that point was never recorded as attempted, so there is nothing to
 * pair and nothing to report (FR-002).
 */
interface AttemptRef {
  attempt: PhaseAttempt | null;
  /**
   * Set ONLY on the two error types that are provably a refusal, never on
   * position. It read "did control reach `invoke()`" before, making
   * `pre_spawn_refusal` the default for the whole window between `begin()` and
   * the spawn — and that window is not policy: two audit appends live in it, the
   * raw-transcript start, the capture handle, the fatal-signature read. Each
   * throws on its own account, and `appendRequiredAudit` converts a refused write
   * into `RequiredEvidenceUnavailableError`, so an outage of the evidence sink
   * was recorded — durably — as an operator's containment policy stopping the
   * phase. Naming the refusals leaves every other throw `error`, which is what an
   * unclassified failure has always meant.
   */
  preSpawnRefusal: boolean;
  /**
   * Written ONCE, where the invocation returns, so a path that never got an answer
   * reports the unknown it has. Raw — `envelopeField` derives the published reading.
   * `| undefined` is deliberate: only an audit payload tells unset and `undefined` apart.
   */
  sawTerminalResult?: boolean | undefined;
}

export class PhaseRunner {
  /** FR-R3-064 — see `BackendPostureRecorder`; this shell only calls it. */
  private readonly postureRecorder: BackendPostureRecorder;

  /** Feature 212 (FR-001, FR-015) — see `PhaseAttemptRecorder`; this shell only calls it. */
  private readonly attemptRecorder: PhaseAttemptRecorder;

  private readonly sidecarReader: PhaseSidecarReader;
  private readonly retryEvaluator: PhaseRetryEvaluator;
  private readonly runnerRegistry: BackendRunnerRegistry | null;
  /** FR-R3-104 — version observed at the current phase's start; see `cli-version-probe.ts`. */
  private observedCliVersion: string | null = null;
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
    lastRetryDecisionSink: LastRetryDecisionSink | null = null,
    /**
     * FR-R3-064 — optional in the SIGNATURE, mandatory in PRODUCTION, and the
     * difference is stated rather than implied. FR-R3-049/056 preferred a required
     * option so `tsc` enumerates every construction site; that is the better
     * mechanism and not available cheaply here, because 109 test harnesses
     * construct this class positionally. Enforcement is therefore a gate —
     * `tests/lint/backend-posture-emission-funnel.test.ts` fails on a production
     * `new PhaseRunner(` that omits this. Absent, nothing is recorded: writing
     * `false` for a posture it cannot read would be a lie.
     */
    backendPostureAccessor: BackendPostureAccessor | null = null,
    /**
     * FR-R3-080 (T1075) — where a refused evidence write becomes an
     * operator-visible phase-end warning.
     *
     * Positional and defaulted for the same reason `backendPostureAccessor`
     * above is: 109 test harnesses construct this class positionally, so a
     * required parameter is not available cheaply here. Absent, the phase-end
     * record carries no refusal codes — which is exactly the state this item
     * exists to leave, so production wiring is what makes it true, and the
     * warnings themselves are the observable proof.
     */
    private readonly evidenceHealthDrain: { drainPathRefusals(): readonly string[] } | null = null
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
    this.postureRecorder = new BackendPostureRecorder(backendPostureAccessor, (entry) =>
      this.appendRequiredAudit(entry)
    );
    // Feature 212 (FR-001, FR-010) — one writer, injected. The recorder owns
    // both ends of an attempt; it opens no second path to disk.
    this.attemptRecorder = new PhaseAttemptRecorder(
      (entry) => this.appendRequiredAudit(entry),
      logger
    );
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
    // Feature 212 (FR-001) — the attempt, reachable from the `finally` below.
    // A holder rather than a field on `this`: `runInner` is where the attempt is
    // opened and this is the only construct that survives the re-throw out of the
    // catch around `invoke()`, so the two need a reference in common and nothing
    // else does. State on the instance would outlive the phase that owns it.
    const attemptRef: AttemptRef = { attempt: null, preSpawnRefusal: false };
    try {
      return await this.runInner(inputs, attemptRef);
    } finally {
      // The seam AMENDS; it does not duplicate. Five arms below write their own
      // `phase-end` and return normally through here, and each claims the attempt
      // as it writes — so `close()` on an already-closed attempt does nothing.
      // What reaches this call is the set of paths that wrote nothing: the throws.
      //
      // `close()` never throws, and that is load-bearing rather than tidy: an
      // exception raised inside a `finally` REPLACES the one already propagating,
      // so a failed audit append here would swallow the very refusal the record
      // exists to report and hand the caller an audit error instead.
      await attemptRef.attempt?.close({
        outcome: 'failed',
        // `pre_spawn_refusal` only for a throw that NAMED itself one. Everything
        // else — a failure after `invoke()` that may have left a child alive, and
        // every incidental throw before it — is `error`: under-claiming, never
        // claiming a refusal that did not happen. See `AttemptRef`.
        terminationReason: attemptRef.preSpawnRefusal ? 'pre_spawn_refusal' : 'error',
        // WHATEVER WAS MEASURED, and nothing when nothing was (FR-014). Not
        // `'absent'` on the pre-spawn branch: three contracts define that value as
        // the positive claim that the INVOCATION RAN and no envelope arrived
        // (`PhaseRunOutput.resultEnvelope` here, `invocation-result.ts`,
        // `workflow-run.ts`), so writing it
        // where no child ever existed puts refusals into the very population
        // FR-007 counts. Unknown is the honest reading, and `cause` below carries
        // the fact that is actually known. Spread, not `resultEnvelope: <maybe
        // undefined>`: a key written as `undefined` is a key somebody answered.
        ...this.envelopeField(attemptRef),
        payload: {
          ...this.pipelineMeta(inputs),
          // EXPLICIT `null`. The projection reads an ABSENT `exitCode` as `0`
          // (`audit-payload.ts`), which would record a clean exit for a phase
          // that never produced one — the same false zero as the counts below.
          exitCode: null,
          ...(attemptRef.preSpawnRefusal ? { cause: PRE_SPAWN_REFUSAL_CAUSE } : {})
          // No `verdictBasis`: it names the basis on which a verdict was formed,
          // and no verdict was formed. No file or command counts either — absent
          // is what makes the projection omit all three rather than record the
          // `{0,0,0}` that reads as "demonstrably changed nothing" (FR-009).
        }
      });
      this.logger.debug('phase-runner.lock-released', {
        ...pipelineAttribution,
        phaseId: debugPhaseId,
        holdMs: Date.now() - phaseRunStartMs
      });
    }
  }

  private async runInner(inputs: PhaseRunInputs, attemptRef: AttemptRef): Promise<PhaseRunOutput> {
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
    // FR-R3-064 — the per-run posture record, deliberately before `phase-start`:
    // the posture a phase ran under is context for that phase's record, not a
    // footnote after it. Every route that drives a Run dispatches through this
    // method, which is why the record sits here; see `BackendPostureRecorder`.
    await this.postureRecorder.recordOnce(inputs, effectiveRunnerKind);
    // FR-R3-086 — refuse before `phase-start`; see `capability-decision-recorder`.
    await recordCapabilityDecision(inputs, effectiveRunnerKind, this.appendAudit.bind(this));

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
    const authoredStartpayloadTimeoutMs = authoredPhaseTimeoutMs(inputs.phaseDef);
    if (authoredStartpayloadTimeoutMs !== undefined) startPayload.timeoutMs = authoredStartpayloadTimeoutMs;
    // FR-R3-104 (FR-054) — which CLI this phase drives. A VERSION, never a path; the leaf owns
    // the probe, its TTL cache and its failure handling.
    this.observedCliVersion = await observedVersionOf(this.runnerRegistry, inputs.cliPath);
    Object.assign(startPayload, cliVersionFields(this.observedCliVersion, effectiveRunnerKind, this.logger));
    // Feature 212 (FR-002) — the attempt identifier is this row's own
    // `AuditEntry.id`, which the writer already mints and this line already
    // received and discarded. Nothing new is generated: a second identifier is a
    // second thing that can disagree. Failure semantics are unchanged — the
    // recorder appends through `appendRequiredAudit`, exactly as before, and a
    // phase whose attempt cannot be recorded still does not proceed.
    attemptRef.attempt = await this.attemptRecorder.begin(
      { runId: inputs.runId, phase: inputs.phase, iteration: inputs.iteration },
      startPayload
    );

    this.logger.info(`phase-start ${inputs.phase} iter=${inputs.iteration}`);
    // Feature 010 FR-024: read schegent.logging.verbose at run() entry
    // (never cached on the runner) so a mid-run toggle applies on the
    // next invocation. The accessor is the workspace-setting read site.
    const verboseDiagnostics = this.buildVerboseTarget(inputs);
    const authoredModel = inputs.phaseDef?.model; // FR-R3-105 — read once, checked once.
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
        // Two different failures arrive here. Which one is decided ONCE, in the
        // compactor, and read here as a record — never re-derived from the message.
        const failure = compactionFailureRecord(err);
        // `detail` is the CLI's own account of the refusal, already bounded and
        // redacted by `boundedExcerpt`; without it this line named a phase and no
        // cause. The message, never `err` — a stack does not belong in this sink.
        this.logger.warn(failure.warning, {
          phase: inputs.phase,
          iteration: inputs.iteration,
          detail: err instanceof Error ? err.message : 'unknown error'
        });
        await this.appendRequiredAudit({
          runId: inputs.runId,
          phase: inputs.phase,
          iteration: inputs.iteration,
          eventType: 'warning',
          payload: {
            ...this.pipelineMeta(inputs),
            reasonCode: failure.reasonCode
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
      // Split from the `invoke()` call deliberately. `resolveRunner` is where a
      // containment refusal is thrown (`backend-runner-factory.ts`); the catch
      // below is where both refusals are named. Kept as two statements because
      // the split is what makes the two throw sites separable at all.
      const backendRunner = this.resolveRunner(inputs);
      raw = await backendRunner.invoke({
        effectiveFatalSignatures,
        phase: inputs.phase,
        iteration: inputs.iteration,
        runId: inputs.runId,
        prompt,
        // The AUTHORED per-phase bound, not the workspace default. This line used
        // to read `inputs.timeoutMs` while four records claimed the phase value.
        timeoutMs: effectivePhaseTimeoutMs(inputs),
        ...(inputs.maxDurationMs !== undefined ? { maxDurationMs: inputs.maxDurationMs } : {}),
        cliPath: inputs.cliPath,
        cwd: inputs.cwd,
        env,
        // FR-R3-049 — via the shared helper; see its docstring for why.
        ...policyRequestFields(inputs),
        cancellationSignal: inputs.cancellationSignal,
        // FR-R3-105 (FR-063) — the defensive half; a frozen plan can predate the bound.
        // Dropped, never rewritten; `contracts/argv-value.ts` states why. `effort` needs
        // no check: it is enum-closed at every validator.
        ...(isSafeArgvValue(authoredModel) ? { model: authoredModel } : {}),
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
          : {}),
        // FR-R3-086 — without this the adapter never sees the declared set.
        ...capabilityRequestFields(inputs)
      }, rawTranscriptCapture ?? undefined);
    } catch (err) {
      // THE two refusals, and the only place either is claimed. A containment
      // refusal comes from `resolveRunner` above, before any runner exists; a
      // capability refusal is raised while the argv is being ASSEMBLED — every
      // adapter calls `capabilityArgs` before it spawns (claude-cli `:336` vs
      // `:390`, codex-cli `:84`, agy-cli `:121`). Neither can have left a child,
      // which is exactly what `PRE_SPAWN_REFUSAL_CAUSE` asserts. By error type,
      // not by position: see `AttemptRef` for what position got wrong.
      if (isCapabilityRefusal(err) || isUncontainedBackendRefusal(err)) {
        attemptRef.preSpawnRefusal = true;
      }
      await rawTranscriptCapture?.dispose();
      throw err;
    }

    // Feature 212 (FR-005) — the one place the envelope fact is read, at the one
    // point every arm below is downstream of. Raw here because `undefined` is a
    // backend that does not report the fact; `envelopeField` makes it a reading.
    attemptRef.sawTerminalResult = raw.sawTerminalResult;

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
      ...(raw.deadlineExceeded === true ? { deadlineExceeded: true } : {}),
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
      evidencePolicy: inputs.phaseDef?.evidencePolicy, // S12 — its first reader
      // FR-R3-096 — the provenance that decides whether `required` may withhold.
      // `phaseDef` here is the frozen pipeline snapshot (`phase-sequencer.ts`
      // resolves it from `run.pipeline.phases`), which is the only place the
      // origin is written, so a run started before this field simply passes
      // `undefined` and behaves exactly as it did.
      evidencePolicyDeclaredAt: inputs.phaseDef?.evidencePolicyDeclaredAt,
      region: audit.region, // FR-003 — bounds where a token may be read; see T25
      effectiveFatalSignatures,
      apiError: unwrappedStream.apiError,
      ...(raw.streamFatalMatch ? { streamFatalMatch: raw.streamFatalMatch } : {})
    });
    const result = failClosedOnTruncatedOutput(
      parsedResult,
      raw.stdoutBuffer.truncated || raw.stderrBuffer.truncated
    );

    // FR-R3-047 (H-04) — checked FIRST, and no arm below moved to make room.
    //
    // Gated on a CLEAN result, deliberately narrowed after review. The rule this
    // arm enforces is "a success claim on a truncated prompt is not evidence" —
    // that is the whole harm, and it is only reachable when the parse came back
    // clean. It does NOT extend to a backend that refused before reading: a stale
    // --resume id, a bad flag, an auth or credit refusal all exit fast and EPIPE
    // an undrained prompt, and there the backend's own diagnostic is the true
    // cause while the EPIPE is downstream noise. Firing here regardless swallowed
    // `rate_limited` — losing its reset-scheduled retry in phase-sequencer — and
    // dropped fatal-signature classification. The condition stays on the
    // invocation result either way, so diagnostics keep it. The payload's warnings
    // lead with the delivery code and then keep the invocation's own: a clean parse
    // still reports `[constitution]` findings, and pinning that list to one element
    // erased them. specs/132-child-stdin-completion/contracts/stdin-delivery.md.
    if (raw.stdinDeliveryFailed && result.kind === 'clean') {
      const auditEntry = await this.appendPhaseEnd(attemptRef, inputs, 'failure', {
        ...this.pipelineMeta(inputs),
        outcome: 'failed',
        verdictBasis: verdictBasisOf(inputs),
        // Explicit: the projection defaults an absent `exitCode` to 0, recording
        // a clean exit for a killed (`null`) or failed run.
        exitCode: raw.exitCode,
        terminationReason: 'error',
        warnings: ['stdin-delivery-failed', ...(result.warnings ?? []), ...(raw.diagnosticWarnings ?? [])],
        ...this.invocationMetricPayload(raw, effectiveRunnerKind),
        // The parse was clean, so the audit block WAS read: a run that changed the
        // workspace while answering a truncated prompt must not record {0,0,0}.
        // Feature 212 (FR-009): "clean parse" and "block present" are still two
        // facts, and `?? []` here claimed the second from the first.
        ...this.auditEvidenceFields(audit.entry)
      });
      return {
        result: { kind: 'malformed', warnings: ['stdin-delivery-failed'], auditEntry: audit.entry },
        outcome: 'failed',
        terminationReason: 'error',
        stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
        stderrSummary: this.logger.sanitize(summarize(typeof raw.stderrBuffer === 'string' ? raw.stderrBuffer : raw.stderrBuffer.getTrailingLines(100))),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        ...this.envelopeField(attemptRef),
        // The errno, never the prompt. The prompt is operator content.
        warnings: [`prompt delivery to the backend failed (${raw.stdinErrorCode ?? 'unknown'})`],
        phaseMessage: null
      };
    }

    // FR-R3-075 — the absolute invocation deadline, checked AHEAD of the idle
    // arm so the two can never both claim a run (the runner already clears
    // `timedOut` when the deadline wins in one tick; the arm order is the same
    // rule one layer up). Same FR-025 posture as the idle arm: a clean,
    // non-host-verification-sensitive result stays a success. Unlike the idle
    // arm this one records the exit code — the omission documented there is a
    // pre-existing defect this new arm does not replicate.
    if (
      raw.deadlineExceeded === true &&
      (result.kind !== 'clean' || requiresHostVerification(inputs))
    ) {
      const auditEntry = await this.appendPhaseEnd(attemptRef, inputs, 'failure', {
        ...this.pipelineMeta(inputs),
        outcome: 'deadline',
        verdictBasis: verdictBasisOf(inputs),
        terminationReason: 'deadline',
        warnings: raw.diagnosticWarnings,
        ...this.invocationMetricPayload(raw, effectiveRunnerKind),
        // Feature 212 (FR-008) — the salvage this feature is named for. A phase
        // killed at its deadline had usually done real work first, and this arm
        // carried no evidence of it at all: the record showed a phase that
        // started and ended, and nothing in between. Where the block was read,
        // what it says survives the kill.
        ...this.auditEvidenceFields(audit.entry)
      });
      return {
        result: { kind: 'malformed', warnings: ['deadline'], auditEntry: null },
        outcome: 'failed',
        terminationReason: 'deadline',
        stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
        stderrSummary: this.logger.sanitize(
          summarize(
            typeof raw.stderrBuffer === 'string'
              ? raw.stderrBuffer
              : raw.stderrBuffer.getTrailingLines(100)
          )
        ),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        ...this.envelopeField(attemptRef),
        warnings: ['phase exceeded its absolute invocation deadline'],
        phaseMessage: null
      };
    }

    // Feature 030 BUG-002 — hung-but-clean run = success, not timeout (FR-025),
    // unless the Phase marked itself sensitive (FR-R3-058). See
    // specs/145-host-verifiable-gates/contracts/host-verification.md.
    if (raw.timedOut && (result.kind !== 'clean' || requiresHostVerification(inputs))) {
      const auditEntry = await this.appendPhaseEnd(attemptRef, inputs, 'failure', {
        ...this.pipelineMeta(inputs),
        outcome: 'timeout',
        verdictBasis: verdictBasisOf(inputs),
        terminationReason: 'timeout',
        // FR-R3-047 — this feature's own recording channel, and the ONLY change
        // it makes to a pre-existing arm. The contract claims a delivery failure
        // is recorded on every failing invocation; without this the claim is
        // false for a timed-out run, because `diagnosticWarnings` would reach no
        // payload. Allowlist-filtered by the phase-end projection, so only
        // code-resident literals survive.
        //
        // FR-R3-075 (feature 152) closed this arm's documented exitCode
        // omission the general way: the code now rides
        // `invocationMetricPayload`, so no arm can omit it again.
        warnings: raw.diagnosticWarnings,
        ...this.invocationMetricPayload(raw, effectiveRunnerKind),
        // Feature 212 (FR-008) — same salvage as the deadline arm above. Listed
        // here too rather than hoisted: the two arms are adjacent and
        // near-identical, which is exactly the shape where one gets a fix and
        // the other silently keeps the defect.
        ...this.auditEvidenceFields(audit.entry)
      });
      return {
        result: { kind: 'malformed', warnings: ['timeout'], auditEntry: null },
        outcome: 'timeout',
        terminationReason: 'timeout',
        stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
        stderrSummary: this.logger.sanitize(summarize(typeof raw.stderrBuffer === 'string' ? raw.stderrBuffer : raw.stderrBuffer.getTrailingLines(100))),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        ...this.envelopeField(attemptRef),
        warnings: ['phase timed out'],
        phaseMessage: null
      };
    }

    if (raw.killed && raw.exitCode === null) {
      const auditEntry = await this.appendAudit(inputs, 'cancel', 'info', {
        ...this.pipelineMeta(inputs),
        reason: 'killed'
      });
      // Feature 212 (FR-001) — the `cancel` row above is left exactly as it was. It is not a
      // terminal record: nothing reading `phase-end` rows sees it, which is how a cancelled phase
      // came to have an attempt and no outcome. This adds the terminal record beside it rather
      // than converting it.
      //
      // Through `appendPhaseEnd` like the other five arms, NOT `close()`. `close()` swallows a
      // failed append on purpose — it is reached from a `finally`, where a throw would replace the
      // error already propagating — and this arm is not in one. Borrowing that swallow here would
      // drop the terminal record, mark the attempt closed so the seam will not retry, and report
      // the phase as merely cancelled: the exact `phase-start`-with-no-`phase-end` gap FR-001
      // exists to close, reopened on the one path that had to be fixed to notice it. The `cancel`
      // row above already fails the phase on an append failure; this one now does too.
      //
      // `'info'` is the audit outcome `terminalAuditOutcome` maps `cancel` to, and stays the
      // reference for the seam's own call.
      await this.appendPhaseEnd(attemptRef, inputs, 'info', {
        ...this.pipelineMeta(inputs),
        outcome: 'failed',
        terminationReason: 'cancel',
        verdictBasis: verdictBasisOf(inputs),
        // `null` on this path by construction (the arm's own condition), and
        // passed explicitly for the same reason as the seam: an ABSENT
        // `exitCode` would project to `0`.
        exitCode: raw.exitCode,
        // Conditional, never `?? []`. An empty array is a MEASUREMENT — it
        // says the phase demonstrably created nothing — and a kill before the
        // audit block was parsed measured nothing at all (FR-009).
        ...this.auditEvidenceFields(audit.entry)
      });
      return {
        result: { kind: 'malformed', warnings: ['cancelled'], auditEntry: null },
        outcome: 'failed',
        terminationReason: 'cancel',
        stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
        stderrSummary: this.logger.sanitize(summarize(typeof raw.stderrBuffer === 'string' ? raw.stderrBuffer : raw.stderrBuffer.getTrailingLines(100))),
        exitCode: raw.exitCode,
        auditEntryId: auditEntry.id,
        ...this.envelopeField(attemptRef),
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
      // FR-R3-058 — for a sensitive Phase the exit status decides. A warning was
      // the whole enforcement before: logged, and advanced anyway.
      //
      // FR-009 (BUG-001) — and only if the status is the BACKEND's. A
      // runner-authored one falls through to the warning below and is classified
      // on its parsed outcome, which is what `invocation-result.ts` has always
      // specified for `completedAwaitingExit` under BOTH bases.
      if (requiresHostVerification(inputs) && hostExitStatusIsAttributable(raw)) {
        const verificationEntry = await this.appendPhaseEnd(attemptRef, inputs, 'failure', {
          ...this.pipelineMeta(inputs),
          outcome: 'failed',
          verdictBasis: verdictBasisOf(inputs),
          exitCode: raw.exitCode,
          terminationReason: 'error',
          warnings: ['host-verification-failed', ...(result.warnings ?? [])],
          ...this.invocationMetricPayload(raw, effectiveRunnerKind),
          ...this.auditEvidenceFields(audit.entry)
        });
        this.logger.warn('phase-runner: host verification failed on a sensitive phase', {
          phase: inputs.phase,
          iteration: inputs.iteration,
          exitCode: raw.exitCode
        });
        return {
          result: {
            kind: 'malformed',
            warnings: ['host-verification-failed'],
            auditEntry: audit.entry
          },
          outcome: 'failed',
          terminationReason: 'error',
          stdoutSummary: this.logger.sanitize(summarize(unwrappedStream.text)),
          stderrSummary: this.logger.sanitize(
            summarize(
              typeof raw.stderrBuffer === 'string'
                ? raw.stderrBuffer
                : raw.stderrBuffer.getTrailingLines(100)
            )
          ),
          exitCode: raw.exitCode,
          auditEntryId: verificationEntry.id,
          ...this.envelopeField(attemptRef),
          // The exit code, never output content. The number is the finding.
          warnings: [`host verification failed: exit code ${raw.exitCode}`],
          phaseMessage: null
        };
      }
      // FR-009 — the flag rides this log because the two cases reaching it are
      // otherwise indistinguishable where an operator sees them: a backend that
      // ran the work and exited non-zero, and one terminated for lingering.
      this.logger.warn('phase-runner: clean result with non-zero exit code', {
        phase: inputs.phase,
        iteration: inputs.iteration,
        exitCode: raw.exitCode,
        completedAwaitingExit: raw.completedAwaitingExit === true
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
    // Feature 194 (T017) — the returned count is the SAME computation the
    // payload's `stalled` field came from; carried on PhaseRunOutput so the
    // cap warning renders it too, rather than a second, possibly-disagreeing
    // computation downstream.
    const stalledCount = await this.retryEvaluator.maybeEmit({
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
    // FR-R3-080 (T1075) — every evidence write REFUSED during this phase, as a
    // warning on the phase's own record.
    //
    // Drained rather than read: each refusal is reported against the phase it
    // happened in and is not repeated on every phase after it. The codes are
    // allowlist-filtered by the phase-end projection like every other warning
    // here, so only the code-resident literals survive — which is what keeps a
    // sink from putting a path in one.
    combinedWarnings.push(...(this.evidenceHealthDrain?.drainPathRefusals() ?? []));

    const auditEntry = await this.appendPhaseEnd(
      attemptRef,
      inputs,
      outcome === 'clean' ? 'success' : outcome === 'failed' ? 'failure' : 'info',
      {
        ...this.pipelineMeta(inputs),
        outcome,
        verdictBasis: verdictBasisOf(inputs),
        exitCode: raw.exitCode,
        terminationReason,
        ...this.invocationMetricPayload(raw, effectiveRunnerKind),
        ...this.auditEvidenceFields(audit.entry),
        warnings: combinedWarnings.length > 0 ? combinedWarnings : undefined,
        // FR-005 — redacted fatal-cause text. It no longer reaches disk: feature
        // 194's `projectPhaseEnd()` narrows `payload.cause` to two code-resident
        // literals; the writer drops this one, the reason survives in terminationReason.
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
      ...this.envelopeField(attemptRef),
      warnings: ('warnings' in result ? result.warnings : []) ?? [],
      phaseMessage,
      cliSessionId: raw.cliSessionId,
      ...(stalledCount !== undefined ? { stalledCount } : {})
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
        // The COMPACTION's model and no effort, never the Phase's — see the constant.
        modelId: COMPACTION_MODEL_ID,
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
    const authoredMetaTimeoutMs = authoredPhaseTimeoutMs(inputs.phaseDef);
    if (authoredMetaTimeoutMs !== undefined) meta.timeoutMs = authoredMetaTimeoutMs;
    return meta;
  }

  private invocationMetricPayload(
    raw: Pick<RawInvocationOutput, 'stdoutBuffer' | 'stderrBuffer' | 'durationMs' | 'exitCode'>,
    backend: BackendRunnerKind
  ): Record<string, unknown> {
    return {
      // Runner timing stays canonical; CLI-reported duration is separate.
      durationMs: raw.durationMs,
      // FR-R3-075 (feature 152) — the exit code rides the SHARED payload so no
      // termination arm can omit it again: the idle-timeout arm used to leave
      // it out, and the projection defaulted the absence to 0, recording a run
      // our own SIGTERM killed (exitCode null) as having exited cleanly.
      exitCode: raw.exitCode,
      ...(raw.stdoutBuffer.truncated ? { stdoutTruncated: true } : {}),
      ...(raw.stderrBuffer.truncated ? { stderrTruncated: true } : {}),
      ...(extractInvocationUsageMetrics(raw.stdoutBuffer, backend) ?? {}),
      // FR-R3-104 — the version observed at this phase's START, not re-probed here.
      ...(this.observedCliVersion === null ? {} : { cliVersion: this.observedCliVersion })
    };
  }

  // Feature 194 (FR-009, T019) — forwards to the `PhaseRetryEvaluator`
  // instance this runner owns. `RunDriver` holds only this `PhaseRunner`, not
  // the evaluator directly, so it calls here when `PostPhaseDecision.
  // evictStagnationTracker` is true. An omitted `phaseId` means the whole Run
  // (SC-007): its `drive()` returned, so no phase of it can be compared again.
  public evictStagnationTracker(runId: string, phaseId?: string): void {
    if (phaseId === undefined) this.retryEvaluator.evictRunStagnationTrackers(runId);
    else this.retryEvaluator.evictStagnationTracker(runId, phaseId);
  }

  // Feature 010 — FR-010 cap-exhaustion path. The controller calls this when
  // the transition decision is `halt(failed, cap_exhausted)` so the audit log
  // carries a terminal `phase-end` with `outcome: 'failure'` and `payload.cause:
  // 'cap_exhausted'` (see specs/010-pipeline-resilience/contracts/audit-events.md
  // §"phase-end — new payload.cause field"). The PhaseRunner already emitted
  // a success-shaped `phase-end` for the LLM-level outcome; this is the
  // controller-level addendum that records the cap-exhaustion verdict.
  //
  // This comment described the intended contract since feature 010, but the
  // literal below omitted `cause` until feature 194 (T005) added it — and
  // that alone was still not sufficient: `src/audit/audit-payload.ts`
  // `projectPhaseEnd()` is what decides what actually reaches `audit.log`,
  // and it had no `cause` field at all, so this function's payload literal
  // could be entirely correct and the persisted record would still lack the
  // field. Both are now fixed; see `projectPhaseEnd()`'s own docblock for why
  // the fix there is scoped to the literal `cap_exhausted` value rather than
  // a generic passthrough.
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
      // The constant, not the literal: `projectPhaseEnd()` gates this field on
      // identity with it (`payload.cause === CAP_EXHAUSTED_CAUSE`), and this
      // payload is typed `Record<string, unknown>`, so a literal here couples
      // the sole producer to the projection allowlist through an unchecked
      // string. Changing the constant's value would silently strip the field
      // again — the Delta 1 defect this function's note above describes.
      cause: CAP_EXHAUSTED_CAUSE,
      exitCode: null
    };
    if (inputs.phaseDef?.model) payload.model = inputs.phaseDef.model;
    if (inputs.phaseDef?.effort) payload.effort = inputs.phaseDef.effort;
    const authoredTimeoutMs = authoredPhaseTimeoutMs(inputs.phaseDef);
    if (authoredTimeoutMs !== undefined) payload.timeoutMs = authoredTimeoutMs;
    await this.appendRequiredAudit({
      runId: inputs.runId,
      phase: inputs.phase,
      iteration: inputs.iteration,
      eventType: 'phase-end',
      payload,
      outcome: 'failure'
    });
  }

  /**
   * Feature 212 (FR-003) — append a `phase-end` row AND claim the attempt it
   * closes, so the seam in `run()` knows this path already reported.
   *
   * The two halves are one call deliberately. Split apart, an arm that appended
   * and forgot to claim would produce a second terminal record from the seam —
   * and the pairing FR-002 asserts would be satisfied twice, which reads as an
   * ambiguity rather than as the gap it actually is.
   *
   * `attemptRef.attempt` is nullable so the arms need no null-guard of their
   * own: a run that reaches an arm always has one, and one that somehow does not
   * still writes its row.
   *
   * The whole ref rather than the attempt alone, because the envelope fact
   * belongs on every one of these rows and reaches them all from here — five
   * arms each remembering to spread it is five chances to forget.
   *
   * CLAIMED BEFORE THE APPEND, never after. The append is bounded for the caller
   * and a rejection does not mean the row was abandoned (`src/lib/io-barrier.ts`),
   * so claiming on success would leave the attempt open for a row already on its
   * way to disk — and the seam would then write a second terminal record for it.
   * `close()` orders itself the same way, for the same reason.
   */
  private async appendPhaseEnd(
    attemptRef: AttemptRef,
    inputs: PhaseRunInputs,
    outcome: 'success' | 'failure' | 'info',
    payload: Record<string, unknown>
  ): Promise<AuditEntry> {
    const attempt = attemptRef.attempt;
    attempt?.markClosedBy(null);
    const entry = await this.appendAudit(inputs, 'phase-end', outcome, {
      ...payload,
      ...this.envelopeField(attemptRef),
      ...(attempt ? { attemptId: attempt.attemptId } : {})
    });
    attempt?.recordTerminalEntryId(entry.id);
    return entry;
  }

  /**
   * Feature 212 (FR-014) — the envelope fact as a spreadable, OMITTED when
   * unknown. Never `{ resultEnvelope: undefined }`: on an audit payload the two
   * differ, and a present key reads as a value somebody reported.
   *
   * Derived HERE so the guard and the value it guards are one name on one line —
   * the only shape the gate checks; `ASSIGNMENT` in its test file says why.
   */
  private envelopeField(attemptRef: AttemptRef): { resultEnvelope?: 'received' | 'absent' } {
    const saw = attemptRef.sawTerminalResult;
    const resultEnvelope = saw === undefined ? undefined : saw ? 'received' : 'absent';
    return resultEnvelope !== undefined ? { resultEnvelope } : {};
  }

  /**
   * Feature 212 (FR-008, FR-009) — the phase's file and command evidence, or
   * NOTHING. There is no third option here and in particular `?? []` is not one.
   *
   * `auditBlockParsed()` in the phase-end projection decides whether to record
   * counts by asking whether any of these four values is an array. An empty
   * array is therefore not a neutral default: it is the evidence that the block
   * WAS read, and it makes the projection write `{created: 0, modified: 0,
   * deleted: 0}` and `omittedFileEvidenceCount: 0` for a phase nobody measured.
   * Every one of those fields is then a false statement — "demonstrably changed
   * nothing" where the truth is "killed before we could look".
   *
   * The distinction the feature turns on, one layer up from the projection:
   * absence says nobody looked, zero says somebody looked and found nothing.
   * Only a parsed block can say the second, so only a parsed block gets to
   * write the keys at all.
   */
  private auditEvidenceFields(entry: AuditEntryFields | null | undefined): {
    files_created?: string[];
    files_modified?: string[];
    commands_executed?: string[];
  } {
    return entry
      ? {
          files_created: entry.filesCreated,
          files_modified: entry.filesModified,
          commands_executed: entry.commandsExecuted
        }
      : {};
  }

  private async appendAudit(
    inputs: PhaseRunInputs,
    eventType:
      | 'phase-start'
      | 'phase-end'
      | 'cancel'
      | 'fatal-signature-matched'
      | 'auto-compact-override-applied'
      | CapabilityRefusalEventType // FR-R3-086; the contract owns this set
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
