import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import { policyRequestFields } from '../runner/spawn-env';
import type { BackendRunner } from '../contracts/backend-runner';
import type { SanitizedLogger } from '../lib/logger';
import type { RawTranscriptMode } from '../state/workflow-run';

const COMPACTION_PROMPT =
  'Compact the conversation context. Reply with a single word: OK';

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
      // Feature 098 (T051, FR-036) — this pin survives the emptying of the
      // Model catalog, because it is not catalog content. The catalog holds the
      // Models an operator chooses between for their own Phases; this one names
      // the Model the host uses to compact a session on its own behalf, and no
      // Phase, Pipeline or Workflow can reach it. Emptying the built-in layers
      // removes the definitions the product shipped *for the operator*, not the
      // host's internal operational policy. Retained deliberately: an unpinned
      // compaction would run on whatever the CLI defaults to, making the cost
      // and latency of a maintenance task vary with an unrelated default.
      model: 'claude-haiku-4-6'
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
    throw new Error(
      `compaction invocation failed (exit=${raw.exitCode ?? 'signal'}, killed=${raw.killed}, timedOut=${raw.timedOut})`
    );
  }
  inputs.logger.info(
    `session-compact-done phase=${inputs.phase} iter=${inputs.iteration}`
  );
}
