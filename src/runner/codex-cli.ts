import { spawn } from 'node:child_process';
import type { BackendRunner, MonitorSidecarEvent, MonitorSidecarHook } from '../contracts/backend-runner';
import { SanitizedLogger } from '../lib/logger';
import type { InvocationOutputSink, InvocationRequest, RawInvocationOutput } from './invocation-result';
import { ProcessLifecycleRunner, type ProcessSpawnFn } from './process-lifecycle-runner';
import { buildSpawnEnv } from './spawn-env';
import { planCapabilityEnforcement } from '../services/capability-enforcement-plan';
import { CapabilityNotEnforceableError } from '../services/capability-refusal';
import type { BackendRunnerKind } from '../contracts/backend-kinds';

export type SpawnFn = ProcessSpawnFn;
export type { MonitorSidecarEvent, MonitorSidecarHook };

/** Codex adapter; shared lifecycle behavior lives in ProcessLifecycleRunner. */
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
const UNBOUNDED_PERMISSION_ARGS = ['--sandbox', 'workspace-write'];

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

export class CodexCliRunner implements BackendRunner {
  private readonly lifecycle: ProcessLifecycleRunner;

  constructor(
    spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    monitorHook: MonitorSidecarHook | null = null,
    logger: SanitizedLogger = new SanitizedLogger()
  ) {
    this.lifecycle = new ProcessLifecycleRunner(spawnFn, monitorHook, logger, 'codex-cli');
  }

  public get hasActiveProcess(): boolean { return this.lifecycle.hasActiveProcess; }

  public async invoke(
    request: InvocationRequest,
    outputSink?: InvocationOutputSink
  ): Promise<RawInvocationOutput> {
    const args = ['exec', '--json', ...capabilityArgs('codex', request, UNBOUNDED_PERMISSION_ARGS)];
    if (request.model?.trim()) args.push('--model', request.model);
    if (request.effort?.trim()) args.push('--config', `model_reasoning_effort=${request.effort}`);
    return this.lifecycle.invoke({
      request,
      args,
      env: buildSpawnEnv(request),
      commandDisplay: [request.cliPath, ...args].join(' '),
      outputSink
    });
  }

  public cancelActive(): boolean { return this.lifecycle.cancelActive(); }
}
