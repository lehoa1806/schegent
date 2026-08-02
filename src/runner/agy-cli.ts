import { spawn } from 'node:child_process';
import type { BackendRunner, MonitorSidecarEvent, MonitorSidecarHook } from '../contracts/backend-runner';
import type { Effort } from '../config/pipeline-config';
import { SanitizedLogger } from '../lib/logger';
import { extractCliSessionId } from '../parser/session-id-extractor';
import type { InvocationOutputSink, InvocationRequest, RawInvocationOutput } from './invocation-result';
import { ProcessLifecycleRunner, type ProcessSpawnFn } from './process-lifecycle-runner';
import { buildSpawnEnv } from './spawn-env';

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

/** Agy adapter; shared lifecycle behavior lives in ProcessLifecycleRunner. */
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
    const args = ['--dangerously-skip-permissions'];
    if (resume && request.resumeSessionId) args.push('--conversation', request.resumeSessionId);
    args.push('-p', '-');
    if (request.model?.trim()) args.push('--model', request.model);
    const effort = resolveEffort(request.effort);
    if (effort) args.push('--effort', effort);
    args.push('--output-format', 'stream-json');
    const output = await this.lifecycle.invoke({
      request,
      args,
      env: buildSpawnEnv(request),
      commandDisplay: [request.cliPath, ...args].join(' '),
      outputSink
    });
    const cliSessionId = extractCliSessionId(output.stdoutBuffer.decompressStream()) ?? undefined;
    return { ...output, cliSessionId };
  }

  public cancelActive(): boolean { return this.lifecycle.cancelActive(); }
}
