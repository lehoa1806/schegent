// Feature 089 (T023, T024, US3, FR-018) — the shared harness for the run
// fixtures in this directory.
//
// Feature 098 (T080) renamed it from `built-in-run-harness`. It existed so
// `adhoc-compatibility` and `speckit-compatibility` asserted the same three
// verbs of FR-018 — resolve, compose, run — against the same seams. Those two
// files covered the three code-resident Pipelines, which this feature removes;
// `imported-compatibility.test.ts` replaced them, making the same three claims
// about definitions that arrived at runtime. The harness itself was never about
// the built-in layer, only about the seams, so it survives the substitution with
// its catalog source parameterized rather than fixed.
//
// Everything here is the real thing except the queue. `loadCatalog()` over a
// reader is the production path — activation always passes one
// (`src/activation/catalog-loading.ts`) — and `launchPipelineRun()` is the
// headless entrypoint over the same `startPipelineRun()` gates the sidebar
// reaches. Only `guardedRun` is a double, and only because the assertion is
// about what arrives at the queue — the request the gates composed — not about
// what the queue then does with it.

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
import {
  FIXTURE_PHASE_DEFINITIONS,
  FIXTURE_PIPELINE_DEFINITIONS,
  FIXTURE_PIPELINE_IDS
} from '../../fixtures/process-catalog-fixture';

/** The authored rows one scope holds, as VS Code hands them back. */
export interface AuthoredLayer {
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly models?: readonly unknown[];
  readonly defaultPipelineId?: string;
}

/**
 * A reader over one authored workspace layer, with `user` unset — the shape a
 * workspace that imported a document into workspace scope reports.
 */
export function workspaceReader(layer: AuthoredLayer): CatalogConfigReader {
  const at = <T>(scope: 'user' | 'workspace', value: T): T | undefined =>
    scope === 'workspace' ? value : undefined;
  return {
    getPhases: (scope) => at(scope, layer.phases),
    getPipelines: (scope) => at(scope, layer.pipelines),
    getModels: (scope) => at(scope, layer.models),
    getDefaultPipelineId: (scope) => at(scope, layer.defaultPipelineId)
  };
}

/**
 * The catalog a workspace resolves once the T005 fixture definitions have been
 * imported into it, through the layered resolution the host runs.
 *
 * Feature 098 (T080) — the predecessor read through a reader whose every scope
 * was unset and called the result "the catalog a fresh workspace resolves". That
 * is now the *empty* catalog, and a fixture asserting resolve/compose/run needs
 * something to resolve. So the definitions arrive the only way they can arrive
 * now: authored into a scope. Nothing else about the path changed.
 */
export function importedCatalog(): ReturnType<typeof loadCatalog> {
  return loadCatalog(
    workspaceReader({
      phases: FIXTURE_PHASE_DEFINITIONS,
      pipelines: FIXTURE_PIPELINE_DEFINITIONS,
      defaultPipelineId: FIXTURE_PIPELINE_IDS.single
    })
  );
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
