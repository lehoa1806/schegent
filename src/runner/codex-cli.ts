import { spawn } from 'node:child_process';
import type { BackendRunner, MonitorSidecarEvent, MonitorSidecarHook } from '../contracts/backend-runner';
import { SanitizedLogger } from '../lib/logger';
import type { InvocationOutputSink, InvocationRequest, RawInvocationOutput } from './invocation-result';
import { ProcessLifecycleRunner, type ProcessSpawnFn } from './process-lifecycle-runner';
import { buildSpawnEnv } from './spawn-env';

export type SpawnFn = ProcessSpawnFn;
export type { MonitorSidecarEvent, MonitorSidecarHook };

/** Codex adapter; shared lifecycle behavior lives in ProcessLifecycleRunner. */
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
    const args = ['exec', '--json', '--sandbox', 'workspace-write'];
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
