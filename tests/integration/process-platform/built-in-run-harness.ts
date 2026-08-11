// Feature 089 (T023, T024, US3, FR-018) — the shared harness for the two
// built-in compatibility fixtures.
//
// It exists so `adhoc-compatibility` and `speckit-compatibility` assert the same
// three verbs of FR-018 — resolve, compose, run — against the same seams, and a
// change to one cannot quietly leave the other testing something weaker.
//
// Everything here is the real thing except the queue. `loadCatalog()` with no
// reader is the production path for a workspace that has authored nothing, and
// `launchPipelineRun()` is the headless entrypoint over the same
// `startPipelineRun()` gates the sidebar reaches. Only `guardedRun` is a double,
// and only because the assertion is about what arrives at the queue — the
// request the gates composed — not about what the queue then does with it.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadCatalog, type CatalogConfigReader } from '../../../src/config/pipeline-config-loader';
import type { PipelineCatalog } from '../../../src/config/pipeline-config';
import type { RunRequest } from '../../../src/contracts/run-request';
import { launchPipelineRun } from '../../../src/headless/pipeline-run-api';
import type { NodeRunStartDeps, NodeRunStartResult } from '../../../src/services/workflow-execution/node-run-starter';
import type { GuardedScheduleRequest, GuardedScheduleResult } from '../../../src/services/guarded-run-service';
import type { BoundaryRefusal } from '../../../src/headless/process-api-validators';

/**
 * A workspace that has authored nothing: every layer unset, as VS Code reports
 * a setting nobody has written.
 */
const EMPTY_READER: CatalogConfigReader = {
  getPhases: () => undefined,
  getPipelines: () => undefined,
  getModels: () => undefined,
  getDefaultPipelineId: () => undefined
};

/**
 * The catalog a fresh workspace resolves — built-ins only, through the layered
 * resolution.
 *
 * The reader is supplied deliberately. `loadCatalog()` with no reader short-
 * circuits to the raw `BUILT_IN_CATALOG`, which is a code-resident projection
 * that never passed through `resolvePipelineCatalog` and so carries no hydrated
 * port fields. Activation always passes a reader
 * (`src/activation/catalog-loading.ts`), so this is the production path, and
 * qualifying the other one would qualify a shape no operator ever runs against.
 */
export function builtInCatalog(): ReturnType<typeof loadCatalog> {
  return loadCatalog(EMPTY_READER);
}

/** Records what reached the queue, and answers as the queue would on accept. */
export class RecordingQueue {
  readonly submitted: GuardedScheduleRequest[] = [];

  async scheduleOrEnqueue(request: GuardedScheduleRequest): Promise<GuardedScheduleResult> {
    this.submitted.push(request);
    return { outcome: 'enqueued', queueItemId: `q-${this.submitted.length}` };
  }

  get only(): GuardedScheduleRequest {
    if (this.submitted.length !== 1) {
      throw new Error(`expected exactly one enqueue, saw ${this.submitted.length}`);
    }
    return this.submitted[0]!;
  }
}

export function deps(catalog: PipelineCatalog, queue: RecordingQueue): NodeRunStartDeps {
  return {
    guardedRun: queue,
    getCatalog: () => catalog,
    defaultRunnerKind: 'claude',
    logger: { warn: () => undefined, sanitize: (value: string) => value }
  };
}

/**
 * The request an operator submits for a built-in with no edit: the Pipeline id,
 * their instructions, and nothing else. Empty inputs and outputs are the whole
 * point — a built-in declares no ports, so a run of one supplies no bindings.
 */
export function requestFor(pipelineId: string, instructions: string): RunRequest {
  return { pipelineId, inputs: [], supplemental: [], outputs: [], instructions };
}

/** A real directory, because the gates probe the root before they accept. */
export async function makeWorkspaceRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'schegent-builtin-'));
}

export async function removeWorkspaceRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

/** Compose and start in one call, through the headless entrypoint. */
export async function launch(
  catalog: PipelineCatalog,
  queue: RecordingQueue,
  pipelineId: string,
  workspaceRoot: string,
  instructions: string
): Promise<NodeRunStartResult | BoundaryRefusal> {
  return launchPipelineRun(deps(catalog, queue), {
    request: requestFor(pipelineId, instructions),
    workspaceRoot
  });
}
