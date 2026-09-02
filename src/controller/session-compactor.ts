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
 */
export const COMPACTION_MODEL_ID = 'claude-haiku-4-5-20251001';

/** Trailing lines of CLI output carried into a compaction failure message. */
const FAILURE_EXCERPT_LINES = 20;

/** Upper bound on the excerpt, after redaction, so one huge line cannot fill a log. */
const FAILURE_EXCERPT_MAX_CHARS = 600;

/**
 * The CLI's own account of why it declined, bounded and redacted.
 *
 * The throw below used to report `exit=1, killed=false, timedOut=false` and nothing else,
 * and the caller logs only phase and iteration. So the one sentence that named the bad
 * model — "There's an issue with the selected model (claude-haiku-4-6). It may not exist or
 * you may not have access to it." — was discarded twice over, and the same failure could
 * fire ten times in one run without anything an operator reads naming a cause.
 *
 * Stderr first, then stdout: a CLI that has something to say about its own failure says it
 * on stderr, and the compaction invocation's stdout is stream-json whose `result` field
 * carries the message when stderr is empty. Redaction goes through the caller's
 * `sanitize` — the shared pattern set, never a second copy of it.
 */
function failureExcerpt(
  logger: SanitizedLogger,
  stdout: unknown,
  stderr: unknown
): string | null {
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
  const text = (read(stderr).trim() || read(stdout).trim()).replace(/\s+/g, ' ');
  if (text.length === 0) return null;
  const redacted = logger.sanitize(text);
  return redacted.length > FAILURE_EXCERPT_MAX_CHARS
    ? `${redacted.slice(0, FAILURE_EXCERPT_MAX_CHARS)}...`
    : redacted;
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
      timeoutMs: 60_000,
      cliPath: inputs.cliPath,
      cwd: inputs.cwd,
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
    const detail = failureExcerpt(inputs.logger, raw.stdoutBuffer, raw.stderrBuffer);
    throw new Error(
      `compaction invocation failed (exit=${raw.exitCode ?? 'signal'}, killed=${raw.killed}, timedOut=${raw.timedOut})` +
        (detail === null ? '' : `: ${detail}`)
    );
  }
  inputs.logger.info(
    `session-compact-done phase=${inputs.phase} iter=${inputs.iteration}`
  );
}
