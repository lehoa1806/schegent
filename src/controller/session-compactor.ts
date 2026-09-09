import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import { policyRequestFields } from '../runner/spawn-env';
import type { BackendRunner } from '../contracts/backend-runner';
import type { SanitizedLogger } from '../lib/logger';
import type { RawTranscriptMode } from '../state/workflow-run';

const COMPACTION_PROMPT =
  'Compact the conversation context. Reply with a single word: OK';

/**
 * The Model the host compacts a session with, on its own behalf.
 *
 * Feature 098 (T051, FR-036) — this pin survives the emptying of the Model catalog, because
 * it is not catalog content. The catalog holds the Models an operator chooses between for
 * their own Phases; this one names the Model the host uses to compact a session on its own
 * behalf, and no Phase, Pipeline or Workflow can reach it. Emptying the built-in layers
 * removes the definitions the product shipped *for the operator*, not the host's internal
 * operational policy. Retained deliberately: an unpinned compaction would run on whatever
 * the CLI defaults to, making the cost and latency of a maintenance task vary with an
 * unrelated default.
 *
 * A named export rather than a literal at the call site, because the value it held for its
 * first months — `claude-haiku-4-6` — was not a model. There is no such id. Every phase
 * boundary in every run compacted against it, the CLI declined, the session was dropped,
 * and the next phase started cold: measured at $77.21 and eight hours for a single feature
 * in the workspace where it was found. A literal buried in a comment block is a value
 * nothing can pin; this one is pinned by `session-compactor.test.ts`.
 *
 * THIS is what the compaction's `cli-invocation` audit event records, and the reason the
 * export is read from `phase-runner.ts` as well as from here. That payload stamped
 * `inputs.phaseDef.model` — the PHASE's model — on an invocation the host spawns against
 * this pin, so the audit log attributed compaction's cost and latency to the wrong model
 * at every phase boundary of every run, and the two were never even the same size of
 * model. It stamped `phaseDef.effort` too, for a request that passes no `effort` at all;
 * that field is now absent rather than corrected, because there is no value to put there.
 */
export const COMPACTION_MODEL_ID = 'claude-haiku-4-5-20251001';

/**
 * How long the compaction child may be silent before the runner terminates it.
 *
 * MUST exceed `MONITOR_STALL_THRESHOLD_MS`, and that is the whole reason this is a
 * named constant. The value here was `60_000` against a 90_000 stall threshold, so
 * every silent compaction child was killed thirty seconds before the watchdog could
 * declare it stalled: a phase that had already emitted `phase-start` spent its first
 * minute inside a window nothing could report. Measured in the workspace that filed
 * it — four phase-log reads returning `entryCount: 0` in 37 seconds while a child ran
 * under the phase's name, then a kill at 62_080 ms.
 *
 * Sized for a workload whose upper end has never been observed. The six compactions
 * that succeeded at that run's phase boundaries took 4–7 s and the one that failed was
 * still silent at 62 s, so this is not a percentile of anything: it is long enough that
 * the stall is DECLARED and read (at 90 s, with 3.5 minutes of runway left) before the
 * bound acts, and short enough to stay distinguishable from unbounded. The cost when
 * compaction is genuinely wedged is five minutes at a phase boundary instead of one,
 * against the cold-start path it prevents — $77.21 and eight hours for one feature.
 *
 * Not a setting, for the reason `COMPACTION_MODEL_ID` gives above: the catalog holds
 * what an operator chooses between for their Phases, and this bounds a maintenance task
 * on the host's own behalf that no Phase, Pipeline or Workflow can reach.
 */
export const COMPACTION_IDLE_TIMEOUT_MS = 300_000;

/**
 * The absolute wall-clock bound on the compaction invocation, armed at spawn.
 *
 * Compaction previously passed NO `maxDurationMs`, so a child that emitted one byte
 * inside every idle window reset the only timer it had, forever. The idle bound above
 * is what catches silence; this is what catches chatter.
 *
 * Written as a multiple rather than a second literal. 4x is the ratio the
 * operator-facing phase bounds already stand in (`schegent.invocation.idleTimeoutSeconds`
 * 5400, `schegent.invocation.maxDurationSeconds` 21600), and two independent literals
 * that happen to stand in the right relation is precisely the defect the constant above
 * exists to prevent one layer up.
 */
export const COMPACTION_MAX_DURATION_MS = COMPACTION_IDLE_TIMEOUT_MS * 4;

/** Trailing lines of CLI output carried into a compaction failure message. */
const FAILURE_EXCERPT_LINES = 20;

/** Upper bound on the excerpt, after redaction, so one huge line cannot fill a log. */
const FAILURE_EXCERPT_MAX_CHARS = 600;

/**
 * What the CLI said about itself, from a window of trailing output.
 *
 * ONE decision, made per stream rather than per line: is this stream-json, or is it the
 * CLI talking? In stream-json the only field that carries an account is `result` — an
 * `init` handshake, an `assistant` frame and a `system` notice are output, not
 * explanations — so the newest non-empty `result` is returned and everything else is
 * discarded, `null` included when there is no such field. Anything else is a CLI that
 * died before or outside the stream, and then the whole trimmed text is what it said.
 *
 * The stream-json arm is the fix. This read trailing LINES and never parsed anything,
 * while its docstring claimed it read `result`, so a compaction child killed after
 * writing only its handshake reported 600 characters of `cwd`, tool list and model as
 * the reason it failed. Nothing was wrong with the bound or the redaction: the field
 * added to name a cause was selecting the one line that names none.
 *
 * Per stream and not per line because a partial verdict is the wrong shape. One plain
 * line among the envelopes means the CLI printed something the stream does not carry,
 * and returning that line alone would drop the `result` beside it while returning the
 * `result` alone would drop the line — so a stream that is not wholly stream-json is
 * reported whole, bounded and redacted by the caller as it always was.
 */
function cliAccount(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n').filter((line) => line.trim().length > 0);
  // Code-review finding (efficiency) — one forward pass: every line still has
  // to parse as a JSON object or the whole stream bails to raw text (same
  // early-return as before), but the newest non-empty `result` is just the
  // last one seen walking forward, so there is no need to collect envelopes
  // into an array and re-scan it in reverse.
  let latestResult: string | null = null;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return trimmed;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return trimmed;
    }
    const result = (parsed as Record<string, unknown>).result;
    if (typeof result === 'string' && result.trim().length > 0) latestResult = result.trim();
  }
  return latestResult;
}

/**
 * The CLI's own account of why it declined, whole and unredacted.
 *
 * The throw below used to report `exit=1, killed=false, timedOut=false` and nothing else,
 * and the caller logs only phase and iteration. So the one sentence that named the bad
 * model — "There's an issue with the selected model (claude-haiku-4-6). It may not exist or
 * you may not have access to it." — was discarded twice over, and the same failure could
 * fire ten times in one run without anything an operator reads naming a cause.
 *
 * Stderr first, then stdout: a CLI that has something to say about its own failure says it
 * on stderr, and the compaction invocation's stdout is stream-json whose `result` field
 * carries the message when stderr is empty. `null` when neither has one — a child whose
 * only output was a handshake has no account of itself, and the process facts alone read
 * correctly.
 *
 * WHOLE AND UNREDACTED IS THE POINT, and is why this is separate from the bounding below.
 * Two things read this account: a log line, which must be short and redacted, and the
 * classification, which is a verdict about what happened. Deriving the verdict from the
 * bounded string would make it depend on where in its own output the CLI put the sentence.
 * Whitespace is collapsed HERE so both readers see the same text — a refusal that wrapped
 * is the same refusal, and matching across a line break is the whole reason the collapse
 * cannot live on the display side alone.
 */
function failureAccount(stdout: unknown, stderr: unknown): string | null {
  const read = (stream: unknown): string => {
    if (typeof stream === 'string') return stream;
    if (
      stream !== null &&
      typeof stream === 'object' &&
      typeof (stream as { getTrailingLines?: unknown }).getTrailingLines === 'function'
    ) {
      return (stream as { getTrailingLines(n: number): string }).getTrailingLines(
        FAILURE_EXCERPT_LINES
      );
    }
    return '';
  };
  const account = cliAccount(read(stderr)) ?? cliAccount(read(stdout));
  return account === null ? null : account.replace(/\s+/g, ' ');
}

/**
 * The account cut to a log line's size and put through the shared redaction set —
 * `logger.sanitize`, never a second copy of the patterns.
 */
function boundedExcerpt(logger: SanitizedLogger, account: string): string {
  const redacted = logger.sanitize(account);
  return redacted.length > FAILURE_EXCERPT_MAX_CHARS
    ? `${redacted.slice(0, FAILURE_EXCERPT_MAX_CHARS)}...`
    : redacted;
}

/**
 * Which of the two compaction failures happened.
 *
 * `invocation-failed` — compaction RAN and did not finish. Killed, timed out, or exited
 * non-zero with something else to say. The bound was reached or the child broke.
 *
 * `session-too-large` — the CLI would not ADMIT the session, so there was no compaction
 * to bound. This is the failure the host's pre-phase compaction exists to prevent and
 * cannot: the request carries the oversized transcript PLUS a new prompt, so a session
 * already past the limit is refused at the door. It is refused in seconds with the bound
 * untouched — 74 s of a 300 s window on the run this was filed from.
 */
export type CompactionFailureKind = 'invocation-failed' | 'session-too-large';

/**
 * The sentence Claude Code uses when it declines to admit a request at all.
 *
 * Matched case-insensitively against the collapsed account, and it is the vendor's
 * wording rather than a contract — so this is a best-effort read of someone else's text,
 * and the failure mode when that wording changes is stated rather than guarded: the
 * refusal classifies as `invocation-failed` and the record says exactly what it said
 * before this distinction existed. Degrading to the previous behaviour is the reason a
 * marker is acceptable here at all.
 */
const SESSION_TOO_LARGE_MARKER = 'prompt is too long';

/** The compaction failure, carrying which of the two it was. */
export class SessionCompactionError extends Error {
  readonly kind: CompactionFailureKind;

  constructor(message: string, kind: CompactionFailureKind) {
    super(message);
    this.name = 'SessionCompactionError';
    this.kind = kind;
  }
}

/**
 * What the caller records for a compaction failure: one reason code, one warning line.
 *
 * ONE resolution site. The caller reads the fields off this record and never inspects the
 * message, so the sentence above is matched in exactly one place; a second reader that
 * re-derived the kind from the text would be a second oracle, and the two would disagree
 * the first time the vendor rephrased anything.
 *
 * Anything that is not this compactor's own error falls to the general record — the
 * runner's `invoke` can throw before there is any account to read, and the code that was
 * already on record is the honest answer for a failure nothing classified. The general
 * code is unchanged from the day it was added, so records written before this split, and
 * `docs/reference/settings.md`, still mean what they say.
 */
export function compactionFailureRecord(err: unknown): {
  readonly reasonCode: string;
  readonly warning: string;
} {
  const kind = err instanceof SessionCompactionError ? err.kind : 'invocation-failed';
  return kind === 'session-too-large'
    ? {
        reasonCode: 'session-too-large-to-compact-fresh-session',
        warning:
          'session-too-large-to-compact (refused before the bound; phase starts cold, ' +
          'and starting cold is what clears it)'
      }
    : {
        reasonCode: 'session-compaction-failed-fresh-session',
        warning: 'session-compact-failed (phase starts cold: no prior context)'
      };
}

export interface SessionCompactionInputs {
  readonly runner: BackendRunner;
  readonly rawTranscript: RawTranscriptWriter | null;
  readonly rawTranscriptMode?: RawTranscriptMode;
  readonly runId: string;
  readonly phase: Parameters<RawTranscriptWriter['appendStart']>[0]['phase'];
  readonly iteration: number;
  readonly cliPath: string;
  readonly cwd: string;
  readonly inheritProcessEnv?: boolean;
  readonly processEnvAllowlist?: readonly string[];
  readonly cancellationSignal?: {
    aborted: boolean;
    addEventListener(event: 'abort', cb: () => void): void;
  };
  readonly resumeSessionId: string;
  readonly onCommand: (command: string) => Promise<void>;
  readonly logger: SanitizedLogger;
}

/** Run and record Claude pre-compaction as its own transcript invocation. */
export async function compactClaudeSession(inputs: SessionCompactionInputs): Promise<void> {
  // The window this opens is the first thing a Phase does and the last thing anything
  // said about it: `session-compact-done` was logged on the way out and nothing on the
  // way in, so the runtime log — the sink an operator watching a stuck Phase actually
  // reads — carried no record that a compaction was in progress. `phase-start` had
  // already been emitted and the phase-log directory did not exist yet, and the two
  // together read as a Phase doing nothing.
  inputs.logger.info(
    `session-compact-start phase=${inputs.phase} iter=${inputs.iteration}`
  );
  await inputs.rawTranscript?.appendStart({
    runId: inputs.runId,
    phase: inputs.phase,
    iteration: inputs.iteration,
    prompt: COMPACTION_PROMPT,
    mode: inputs.rawTranscriptMode
  });
  const capture = await inputs.rawTranscript?.createInvocationCapture(
    inputs.runId,
    inputs.rawTranscriptMode
  ) ?? null;
  let raw;
  try {
    raw = await inputs.runner.invoke({
      phase: inputs.phase,
      iteration: inputs.iteration,
      // Feature 093 (T046 census gap) — compaction spawns a real CLI subprocess
      // on this Run's behalf, so its monitor sidecar events need the same
      // attribution the phase invocation gets. Left unstamped, they carry
      // `runId: null` and the monitor drops them, which is only harmless while
      // one Run exists per window: with two live subprocesses a stalling
      // compaction is invisible to the Run it is stalling. Stamping affects
      // nothing but those events — never argv, env, or any spawn decision.
      runId: inputs.runId,
      prompt: COMPACTION_PROMPT,
      timeoutMs: COMPACTION_IDLE_TIMEOUT_MS,
      maxDurationMs: COMPACTION_MAX_DURATION_MS,
      cliPath: inputs.cliPath,
      cwd: inputs.cwd,
      // Feature 012 FR-009 — a host-internal maintenance invocation may set this
      // key without reading `schegent.claude.autoCompactPctOverride`, and this
      // call is the closed set's one member. The value is fixed rather than read
      // because the setting answers a different question: it says at what fill
      // level the CLI should compact on its own, and this invocation exists only
      // where the host has already decided to compact now. An operator threshold
      // applied here would defeat the call rather than tune it. The reason the
      // runner forces compaction at all is in the `sessionReuse` contract in
      // `phase-runner.ts`, and is not restated here.
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' },
      // FR-R3-049 — via the shared helper.
      ...policyRequestFields(inputs),
      cancellationSignal: inputs.cancellationSignal,
      sessionReuse: true,
      resumeSessionId: inputs.resumeSessionId,
      // See `COMPACTION_MODEL_ID` for why the host pins a Model here at all.
      model: COMPACTION_MODEL_ID
    }, capture ?? undefined);
  } catch (err) {
    await capture?.dispose();
    throw err;
  }
  await inputs.rawTranscript?.appendEnd({
    runId: inputs.runId,
    stdout: raw.stdoutBuffer,
    stderr: raw.stderrBuffer,
    exitCode: raw.exitCode,
    killed: raw.killed,
    timedOut: raw.timedOut,
    capture,
    mode: inputs.rawTranscriptMode
  });
  if (typeof raw.command === 'string' && raw.command.length > 0) {
    await inputs.onCommand(raw.command);
  }
  if (raw.exitCode !== 0 || raw.killed || raw.timedOut) {
    const account = failureAccount(raw.stdoutBuffer, raw.stderrBuffer);
    const detail = account === null ? null : boundedExcerpt(inputs.logger, account);
    throw new SessionCompactionError(
      `compaction invocation failed (exit=${raw.exitCode ?? 'signal'}, killed=${raw.killed}, timedOut=${raw.timedOut})` +
        (detail === null ? '' : `: ${detail}`),
      // Absence of the sentence is not a refusal. A silent child said nothing, and the
      // more specific of the two claims must not be the one made on no evidence.
      account !== null && account.toLowerCase().includes(SESSION_TOO_LARGE_MARKER)
        ? 'session-too-large'
        : 'invocation-failed'
    );
  }
  inputs.logger.info(
    `session-compact-done phase=${inputs.phase} iter=${inputs.iteration}`
  );
}
