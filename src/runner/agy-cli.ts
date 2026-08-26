import { spawn } from 'node:child_process';
import type { BackendRunner, MonitorSidecarEvent, MonitorSidecarHook } from '../contracts/backend-runner';
import type { Effort } from '../config/pipeline-config';
import { SanitizedLogger } from '../lib/logger';
import { extractCliSessionId } from '../parser/session-id-extractor';
import type { InvocationOutputSink, InvocationRequest, RawInvocationOutput } from './invocation-result';
import { ProcessLifecycleRunner, type ProcessSpawnFn } from './process-lifecycle-runner';
import { buildSpawnEnv } from './spawn-env';
import { planCapabilityEnforcement } from '../services/capability-enforcement-plan';
import { CapabilityNotEnforceableError } from '../services/capability-refusal';
import type { BackendRunnerKind } from '../contracts/backend-kinds';

const HIGH_EFFORT: readonly Effort[] = ['xhigh', 'max'];
export type SpawnFn = ProcessSpawnFn;
export type { MonitorSidecarEvent, MonitorSidecarHook };

function resolveEffort(effort: string | undefined): string | undefined {
  if (!effort?.trim()) return undefined;
  if ((HIGH_EFFORT as readonly string[]).includes(effort.trim())) {
    throw new Error(`agy-cli: effort '${effort.trim()}' is not supported by Antigravity. Supported levels: low, medium, high`);
  }
  return effort.trim();
}

/**
 * The prompt, in the only shape agy actually reads it from stdin.
 *
 * WHY THIS EXISTS. `--print`/`-p` takes the prompt as its ARGUMENT VALUE, so the
 * previous `['-p', '-']` sent the literal string `-` as the prompt and the real
 * prompt went to a stdin nothing was reading. Agy answered the one-character
 * prompt -- a generic greeting -- and exited 0, so nothing above this layer could
 * tell. Measured on agy 1.1.21: `-p -` with the prompt on stdin returns "How can
 * I help you today?"; this envelope returns the answer to the prompt.
 *
 * Agy reads stdin only under `--input-format stream-json`, one NDJSON message per
 * line, and it refuses the combination outright if a command-line prompt is also
 * present ("a prompt given on the command line would be ignored"). The field
 * names are the CLI's, confirmed against its own decode errors: a message
 * without `event` is rejected as `stream input message is missing the "event"
 * field`, and `message.text` as `stream input "user" message has no content`.
 *
 * ARGV IS NOT AN OPTION for the prompt. `--print <prompt>` would work, but it
 * publishes operator content to every local process listing and is bounded by
 * ARG_MAX, and prompts here are neither small nor guaranteed non-sensitive.
 */
function encodeAgyStreamInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

/** Agy adapter; shared lifecycle behavior lives in ProcessLifecycleRunner. */
/**
 * FR-R3-031 / FR-R3-032 — the permission posture, as an unconditional module-scope
 * literal so that "unconditional" is CHECKABLE by reading this file.
 *
 * `tests/lint/backend-permission-posture.test.ts` parses this declaration. That
 * is not incidental: the disclosure those items shipped is only trustworthy while
 * the argv is legible where the spawn happens, and four gates read this source
 * text rather than the runtime argv for exactly that reason.
 *
 * FR-R3-086 narrows it per phase through `capabilityArgs`, and
 * `tests/lint/capability-argv-parity.test.ts` asserts this literal equals
 * `unboundedArgs(kind)` so the plan and the adapter cannot disagree about what
 * "unbounded" means.
 */
const UNBOUNDED_PERMISSION_ARGS = ['--dangerously-skip-permissions'];

/**
 * FR-R3-086 — the argv this backend spawns with, under the phase's declared
 * capability set.
 *
 * WHY THE DEFAULT LITERAL STAYS IN THIS FILE. Four gates read each adapter's
 * SOURCE TEXT to prove the permission posture — `backend-permission-posture`,
 * `backend-containment-policy`, and the two documentation-parity gates — because
 * a posture proven from source cannot be quietly changed by a table somewhere
 * else. Moving the flag into a shared module made all four go red, and they were
 * right to: the FR-R3-031/032 disclosure is only trustworthy while the argv is
 * legible where the spawn happens.
 *
 * So `unbounded` is passed in as a literal from the call site below, and this
 * returns it unchanged whenever the phase declared nothing — which is every
 * phase today. The plan is consulted ONLY to narrow. `capability-argv-parity`
 * asserts the literal each adapter passes equals `unboundedArgs(kind)`, so the
 * two cannot drift.
 *
 * A refusal is thrown rather than returned because there is no invocation to
 * return: the phase must not start.
 */
function capabilityArgs(
  kind: BackendRunnerKind,
  request: InvocationRequest,
  unbounded: readonly string[]
): readonly string[] {
  if (request.capabilities === undefined || request.capabilities.declaredAt === 'default') {
    return unbounded;
  }
  const plan = planCapabilityEnforcement(kind, request.capabilities);
  if (plan.outcome === 'refused') {
    throw new CapabilityNotEnforceableError(plan.kind, plan.unenforceable);
  }
  return plan.args;
}

export class AgyCliRunner implements BackendRunner {
  private readonly lifecycle: ProcessLifecycleRunner;

  constructor(
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    monitorHook: MonitorSidecarHook | null = null,
    logger: SanitizedLogger = new SanitizedLogger()
  ) {
    this.lifecycle = new ProcessLifecycleRunner(spawnFn, monitorHook, logger, 'agy-cli');
  }

  public get hasActiveProcess(): boolean { return this.lifecycle.hasActiveProcess; }

  public async invoke(
    request: InvocationRequest,
    outputSink?: InvocationOutputSink
  ): Promise<RawInvocationOutput> {
    const resume = request.isContinue === true || request.sessionReuse === true;
    const args = [...capabilityArgs('agy', request, UNBOUNDED_PERMISSION_ARGS)];
    if (resume && request.resumeSessionId) args.push('--conversation', request.resumeSessionId);
    args.push('--input-format', 'stream-json');
    if (request.model?.trim()) args.push('--model', request.model);
    const effort = resolveEffort(request.effort);
    if (effort) args.push('--effort', effort);
    args.push('--output-format', 'stream-json');
    const output = await this.lifecycle.invoke({
      request,
      args,
      env: buildSpawnEnv(request),
      commandDisplay: [request.cliPath, ...args].join(' '),
      outputSink,
      stdinPayload: encodeAgyStreamInput(request.prompt)
    });
    const cliSessionId = extractCliSessionId(output.stdoutBuffer.decompressStream()) ?? undefined;
    return { ...output, cliSessionId };
  }

  public cancelActive(): boolean { return this.lifecycle.cancelActive(); }
}
