// Feature 082 (US1, T020) — `pipelineCatalog` snapshot projection.
//
// Pins guarantees C1–C10 of
// `specs/082-pipeline-contracts-builder/contracts/pipeline-catalog-snapshot.md`
// against a real `StateProjector`, so the assertions cover the composer as the
// webview actually receives it rather than a hand-built projection object.
//
// The projection is derived state: `availablePipelines` keeps its runtime
// selection meaning, and `pipelineCatalog` is additive and optional.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { resolvePipelineCatalog, pipelineLayerRevision } from '../../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../../src/config/pipeline-config';

const PHASE_CATALOG = resolvePhaseCatalog({
  builtIn: BUILT_IN_PHASES,
  user: [],
  workspace: []
});

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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-pipeline-projection-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function project(
  layers: {
    user?: readonly unknown[];
    workspace?: readonly unknown[];
    /** FR-002 — omitted entirely by a host with no Workflow references. */
    workflowRefs?: readonly { readonly workflowId: string; readonly pipelineId: string }[];
  },
  sanitize: (value: string | null | undefined) => string = (value) =>
    (value ?? '').replaceAll('SECRET', '[REDACTED]')
) {
  const catalog = resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: layers.user ?? [],
    workspace: layers.workspace ?? [],
    phaseCatalog: PHASE_CATALOG.effective
  });
  const projector = new StateProjector({
    store,
    audit,
    ownerId: 'this-window',
    sanitize,
    getPipelineCatalog: () => catalog,
    ...(layers.workflowRefs !== undefined
      ? { getWorkflowPipelineRefs: () => layers.workflowRefs! }
      : {})
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return { catalog, snapshot, projection: snapshot.pipelineCatalog };
}

// Every `phaseId` must resolve in the effective Phase catalog (FR-011), so the
// fixtures reference built-in Phases only.
const VALID_ROW = {
  id: 'custom-flow',
  name: 'Custom Flow',
  version: 1,
  phases: ['speckit-specify', 'speckit-plan', 'finalize']
};

describe('pipelineCatalog projection — C1 every source row is retained', () => {
  it('projects invalid rows alongside valid ones instead of discarding the layer', () => {
    const { projection } = project({
      workspace: [VALID_ROW, { id: 'BAD ID', name: '', phases: [] }]
    });
    expect(projection?.state).toBe('ready');
    const workspaceRecords = projection!.records.filter((r) => r.scope === 'workspace');
    expect(workspaceRecords).toHaveLength(2);
    const invalid = workspaceRecords.find((r) => r.status === 'invalid');
    expect(invalid).toBeDefined();
    expect(invalid!.definition).toBeNull();
    expect(invalid!.errors.length).toBeGreaterThan(0);
  });

  it('keys each record as `${scope}:${pipelineId}`', () => {
    const { projection } = project({ workspace: [VALID_ROW] });
    const record = projection!.records.find((r) => r.scope === 'workspace')!;
    expect(record.key).toBe('workspace:custom-flow');
  });
});

describe('pipelineCatalog projection — C2/C3 precedence and effectiveness', () => {
  it('marks exactly one record effective per id and shadows the rest', () => {
    const { projection } = project({
      user: [{ ...VALID_ROW, name: 'User Copy' }],
      workspace: [{ ...VALID_ROW, name: 'Workspace Copy' }]
    });
    const forId = projection!.records.filter((r) => r.pipelineId === 'custom-flow');
    expect(forId.filter((r) => r.status === 'effective')).toHaveLength(1);
    expect(forId.find((r) => r.status === 'effective')!.scope).toBe('workspace');
    expect(forId.filter((r) => r.status === 'shadowed').map((r) => r.scope)).toEqual(['user']);
  });

  it('never projects an invalid row into `effective`', () => {
    const { projection } = project({
      user: [VALID_ROW],
      workspace: [{ id: 'custom-flow', name: '', phases: [] }]
    });
    const effectiveIds = projection!.effective.map((d) => d.pipelineId);
    expect(effectiveIds).toContain('custom-flow');
    const effectiveRecord = projection!.records.find(
      (r) => r.pipelineId === 'custom-flow' && r.status === 'effective'
    );
    // The workspace row is invalid, so the valid user row takes effect.
    expect(effectiveRecord!.scope).toBe('user');
    for (const definition of projection!.effective) {
      const record = projection!.records.find(
        (r) => r.pipelineId === definition.pipelineId && r.status === 'effective'
      );
      expect(record).toBeDefined();
      expect(record!.definition).not.toBeNull();
    }
  });
});

describe('pipelineCatalog projection — C4 revisions', () => {
  it('carries the per-layer fingerprints the webview echoes as expectedRevision', () => {
    const { projection } = project({ workspace: [VALID_ROW] });
    expect(projection!.revisions).toEqual({
      user: pipelineLayerRevision([]),
      workspace: pipelineLayerRevision([VALID_ROW])
    });
  });
});

describe('pipelineCatalog projection — C5/C6 sanitization', () => {
  it('sanitizes definitions, display values, warnings, and errors exactly once', () => {
    const { projection } = project({
      workspace: [
        { ...VALID_ROW, name: 'Token SECRET', description: 'Uses SECRET creds' },
        { id: 'broken-SECRET-flow', name: 'Broken', phases: [], version: 1 }
      ]
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).toContain('[REDACTED]');
    const named = projection!.records.find((r) => r.pipelineId === 'custom-flow')!;
    expect(named.definition?.name).toBe('Token [REDACTED]');
    expect(named.display.name).toBe('Token [REDACTED]');
  });

  it('introduces no host filesystem path of its own', () => {
    // C6 binds host-derived strings: the projection must never leak the
    // workspace root, the audit log path, or any other path the host knows.
    // Operator-authored free text is a different matter — the Builder
    // round-trips it back on save (FR-028), so it passes through the shared
    // sanitizer exactly once and is otherwise preserved verbatim. Scrubbing it
    // here would silently rewrite the operator's own description on their next
    // edit.
    const authoredPath = '/Users/someone/workspaces/project';
    const { projection } = project({ workspace: [{ ...VALID_ROW, description: authoredPath }] });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(tmpRoot);
    expect(serialized).not.toContain(audit.logPath);
    const record = projection!.records.find((r) => r.pipelineId === 'custom-flow')!;
    expect(record.definition?.description).toBe(authoredPath);
  });
});

describe('pipelineCatalog projection — C7 bounded errors', () => {
  it('caps errors at 20 per record and truncates each field to its declared length', () => {
    const manyBadFields: Record<string, unknown> = { id: 'noisy-flow', name: 'Noisy', version: 1, phases: ['finalize'] };
    for (let index = 0; index < 30; index++) manyBadFields[`unknownField${index}`] = 'x';
    const { projection } = project({ workspace: [manyBadFields] });
    const record = projection!.records.find((r) => r.pipelineId === 'noisy-flow')!;
    expect(record.errors.length).toBeLessThanOrEqual(20);
    for (const error of record.errors) {
      expect(error.field.length).toBeLessThanOrEqual(32);
      expect(error.code.length).toBeLessThanOrEqual(64);
      expect(error.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('truncates an over-long projected id to 64 characters', () => {
    const { projection } = project({
      workspace: [{ id: `a${'b'.repeat(200)}`, name: 'Long', version: 1, phases: ['finalize'] }]
    });
    for (const record of projection!.records) {
      expect(record.pipelineId.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('pipelineCatalog projection — C8 advisories are warnings, not errors', () => {
  it('keeps an invalid row and a soft-cap breach out of `state: error`', () => {
    const rows = Array.from({ length: 25 }, (_unused, index) => ({
      id: `flow-${index}`,
      name: `Flow ${index}`,
      version: 1,
      phases: ['finalize']
    }));
    const { projection } = project({ workspace: [...rows, { id: 'bad', name: '', phases: [] }] });
    expect(projection!.state).toBe('ready');
    expect(projection!.error).toBeUndefined();
    expect(projection!.warnings.length).toBeGreaterThan(0);
    for (const warning of projection!.warnings) {
      expect(warning.code.length).toBeLessThanOrEqual(64);
      expect(warning.message.length).toBeLessThanOrEqual(512);
    }
  });
});

describe('pipelineCatalog projection — C9 whole-catalog resolution failure', () => {
  it('projects state: error with empty records and a sanitized explanation', () => {
    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      sanitize: (value: string | null | undefined) => (value ?? '').replaceAll('SECRET', '[REDACTED]'),
      getPipelineCatalog: () => {
        throw new Error('catalog read failed for SECRET');
      }
    });
    projector.start();
    const projection = projector.getCurrentSnapshot().pipelineCatalog;
    projector.dispose();
    expect(projection?.state).toBe('error');
    expect(projection?.records).toEqual([]);
    expect(projection?.effective).toEqual([]);
    expect(projection?.error?.code.length).toBeGreaterThan(0);
    expect(JSON.stringify(projection)).not.toContain('SECRET');
  });
});

describe('pipelineCatalog projection — C10 derived state only', () => {
  it('is deeply frozen and leaves availablePipelines untouched', () => {
    const { snapshot, projection } = project({ workspace: [VALID_ROW] });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection!.records)).toBe(true);
    expect(Object.isFrozen(projection!.effective)).toBe(true);
    expect(Object.isFrozen(projection!.warnings)).toBe(true);
    // The runtime selection list is a separate contract and must not change
    // shape just because the authoring catalog is now projected.
    expect(Array.isArray(snapshot.availablePipelines)).toBe(true);
  });
});

// FR-002 — the Library shows what a change would affect. The references come
// from the same host collector gate 13 blocks removals against, so the list an
// operator reads before editing is the list the removal gate will enforce.
describe('pipelineCatalog projection — FR-002 consuming Workflows', () => {
  it('lists the Workflows referencing an id, sorted and deduplicated', () => {
    const { projection } = project({
      workspace: [VALID_ROW],
      workflowRefs: [
        { workflowId: 'wf-z', pipelineId: 'custom-flow' },
        { workflowId: 'wf-a', pipelineId: 'custom-flow' },
        { workflowId: 'wf-a', pipelineId: 'custom-flow' }
      ]
    });
    const record = projection!.records.find((r) => r.key === 'workspace:custom-flow')!;
    expect(record.consumingWorkflowIds).toEqual(['wf-a', 'wf-z']);
  });

  it('reports the same consumers on a shadowed record as on the effective one', () => {
    const { projection } = project({
      user: [{ ...VALID_ROW, name: 'User Copy' }],
      workspace: [VALID_ROW],
      workflowRefs: [{ workflowId: 'wf-a', pipelineId: 'custom-flow' }]
    });
    const forId = projection!.records.filter((r) => r.pipelineId === 'custom-flow');
    expect(forId.map((r) => r.status).sort()).toEqual(['effective', 'shadowed']);
    for (const record of forId) {
      expect(record.consumingWorkflowIds).toEqual(['wf-a']);
    }
  });

  it('omits the field on records nothing references', () => {
    const { projection } = project({
      workspace: [VALID_ROW],
      workflowRefs: [{ workflowId: 'wf-a', pipelineId: 'custom-flow' }]
    });
    const unreferenced = projection!.records.filter((r) => r.pipelineId !== 'custom-flow');
    expect(unreferenced.length).toBeGreaterThan(0);
    for (const record of unreferenced) {
      expect(record.consumingWorkflowIds).toBeUndefined();
    }
  });

  it('omits the field entirely when the host exposes no Workflow references', () => {
    const { projection } = project({ workspace: [VALID_ROW] });
    for (const record of projection!.records) {
      expect(record.consumingWorkflowIds).toBeUndefined();
    }
  });

  it('sanitizes and bounds ids before they reach the webview (C5, C7)', () => {
    const { projection } = project({
      workspace: [VALID_ROW],
      workflowRefs: [{ workflowId: 'wf-SECRET', pipelineId: 'custom-flow' }]
    });
    const record = projection!.records.find((r) => r.key === 'workspace:custom-flow')!;
    expect(record.consumingWorkflowIds).toEqual(['wf-[REDACTED]']);
    expect(Object.isFrozen(record.consumingWorkflowIds)).toBe(true);
  });
});

describe('pipelineCatalog projection — absent projection is tolerated', () => {
  it('omits the field entirely when the host has not resolved a catalog yet (FR-028)', () => {
    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      sanitize: (value: string | null | undefined) => value ?? ''
    });
    projector.start();
    const snapshot = projector.getCurrentSnapshot();
    projector.dispose();
    expect(snapshot.pipelineCatalog).toBeUndefined();
    expect(snapshot.schemaVersion).toBe(3);
  });
});
