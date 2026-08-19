// Feature 083 (US1, T032) — `workflowCatalog` is additive on the sidebar
// snapshot envelope. Contract:
// `specs/083-workflow-graph-builder/contracts/workflow-catalog-snapshot.md`
// ("Additive and optional… `SCHEMA_VERSION` does not change").
//
// The task text says "extend"; no file existed at this path, so this creates it.
// The projection guarantees themselves live in
// `tests/unit/ui/sidebar/workflow-catalog-projector.test.ts` — what is pinned
// here is only the envelope tolerance, against a real `StateProjector` so the
// assertions cover the snapshot as the webview actually receives it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../src/config/pipeline-config';
import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { resolvePipelineCatalog } from '../../src/config/pipeline-catalog';
import { resolveWorkflowCatalog } from '../../src/config/workflow-catalog';
import { SanitizedLogger } from '../../src/lib/logger';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { SCHEMA_VERSION, buildIdleSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { SPECKIT_PHASE_DEFS } from '../fixtures/speckit-catalog-fixture';

// Feature 098 (T080) — `PORTED_PIPELINE` names `speckit-specify` and
// `speckit-plan`, which used to resolve out of the built-in Phase layer. That layer
// stays wired in because the product still resolves it, but it is empty, so the
// rows arrive as a configured layer. Without them the Pipeline is `invalid`, the
// Workflow that binds it resolves to nothing, and the projection under test is
// empty. See the fixture header for why the ids are the real Spec Kit ones.
const PHASE_CATALOG = resolvePhaseCatalog({
  builtIn: BUILT_IN_PHASES,
  user: [],
  workspace: SPECKIT_PHASE_DEFS
});

/**
 * A user-scope Pipeline that declares ports — the built-ins declare none, so a
 * node bound to one derives nothing and could not show the ports flow through.
 */
const PORTED_PIPELINE = {
  id: 'ported',
  name: 'Ported',
  version: 1,
  phases: ['speckit-specify', 'speckit-plan'],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
  outputs: [{ portId: 'spec', label: 'Spec out', type: 'markdown' }],
  bindings: [
    { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'brief' } },
    { kind: 'output', phaseIndex: 0, portId: 'spec', outputKey: 'spec' }
  ]
};

const PIPELINE_CATALOG = resolvePipelineCatalog({
  builtIn: BUILT_IN_PIPELINES,
  user: [PORTED_PIPELINE],
  workspace: [],
  phaseCatalog: PHASE_CATALOG.effective
});

const WORKFLOW_ROW = {
  id: 'release-train',
  name: 'Release Train',
  version: 1,
  nodes: [{ nodeId: 'draft', pipelineId: 'ported' }],
  connections: [],
  startNodeIds: ['draft']
};

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-workflow-snapshot-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function project(deps: Record<string, unknown>) {
  const projector = new StateProjector({
    store,
    audit,
    ownerId: 'this-window',
    sanitize: (value: string | null | undefined) => value ?? '',
    ...deps
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

describe('sidebar snapshot — workflowCatalog is additive (feature 083)', () => {
  it('omits the field entirely on a pre-083 host that supplies no accessor', () => {
    const snapshot = project({ getPipelineCatalog: () => PIPELINE_CATALOG });
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect('workflowCatalog' in snapshot).toBe(false);
    expect(snapshot.workflowCatalog).toBeUndefined();
    expect(snapshot.pipelineCatalog).toBeDefined();
  });

  it('omits the field while the host has not resolved a catalog yet', () => {
    const snapshot = project({
      getPipelineCatalog: () => PIPELINE_CATALOG,
      getWorkflowCatalog: () => undefined
    });
    expect('workflowCatalog' in snapshot).toBe(false);
  });

  it('carries the projection without moving SCHEMA_VERSION once a catalog resolves', () => {
    const snapshot = project({
      getPipelineCatalog: () => PIPELINE_CATALOG,
      getWorkflowCatalog: () =>
        resolveWorkflowCatalog({
          builtIn: [],
          user: [WORKFLOW_ROW],
          workspace: [],
          pipelineCatalog: PIPELINE_CATALOG
        })
    });
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snapshot.workflowCatalog?.state).toBe('ready');
    expect(snapshot.workflowCatalog?.effective.map((w) => w.workflowId)).toEqual(['release-train']);
    expect(snapshot.workflowCatalog?.records[0]?.derivedInputs.length).toBeGreaterThan(0);
    // The run sense of "Workflow" is untouched (FR-046): the catalog arrives on
    // its own key, and the runtime Pipeline list keeps its own meaning.
    expect(Array.isArray(snapshot.availablePipelines)).toBe(true);
    expect(snapshot.availablePipelines).not.toBe(snapshot.workflowCatalog?.effective);
  });

  it('keeps the idle snapshot free of the field at the current SCHEMA_VERSION', () => {
    const idle = buildIdleSnapshot({ isPrimary: true });
    expect(idle.schemaVersion).toBe(SCHEMA_VERSION);
    expect('workflowCatalog' in idle).toBe(false);
  });
});
