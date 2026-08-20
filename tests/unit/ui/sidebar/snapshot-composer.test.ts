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
import type { WorkflowPipelineReference } from '../../../../src/ui/sidebar/commands/router-types';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { resolvePipelineCatalog } from '../../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { SPECKIT_PHASE_DEFS } from '../../../fixtures/speckit-catalog-fixture';

// Feature 098 (T080) — the Pipelines projected below name `speckit-specify`,
// `speckit-plan` and `finalize`, which used to resolve out of the built-in Phase
// layer. Nothing is projected for free now, so the rows arrive as stored rows.
// Without them every projected Pipeline is `invalid` and no case here reaches the
// projection it is about. See the fixture header for why the ids are the real
// Spec Kit ones.
const PHASE_CATALOG = resolvePhaseCatalog({
  rows: SPECKIT_PHASE_DEFS,
  revision: 'rev-phase-projection'
});

/**
 * Feature 099 (T496f, FR-044) — the store's revision for the Pipeline catalog.
 * Named rather than derived, so C4 below asserts the projection carries THIS
 * string through rather than asserting a fingerprint against its own recompute.
 */
const SEEDED_PIPELINE_REVISION = 'rev-pipeline-projection';

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
    rows?: readonly unknown[];
    /** FR-002 — omitted entirely by a host with no Workflow references. */
    workflowRefs?: readonly WorkflowPipelineReference[];
  },
  sanitize: (value: string | null | undefined) => string = (value) =>
    (value ?? '').replaceAll('SECRET', '[REDACTED]')
) {
  const catalog = resolvePipelineCatalog({
    rows: layers.rows ?? [],
    revision: SEEDED_PIPELINE_REVISION,
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
  it('projects invalid rows alongside valid ones instead of discarding the catalog', () => {
    const { projection } = project({
      rows: [VALID_ROW, { id: 'BAD ID', name: '', phases: [] }]
    });
    expect(projection?.state).toBe('ready');
    expect(projection!.records).toHaveLength(2);
    const invalid = projection!.records.find((r) => r.status === 'invalid');
    expect(invalid).toBeDefined();
    expect(invalid!.definition).toBeNull();
    expect(invalid!.errors.length).toBeGreaterThan(0);
  });

  // Feature 099 (T496f, FR-043) — the key was `${scope}:${pipelineId}`, unique
  // because no layer could hold one id twice. The key is the resolver's own
  // `${pipelineId}::${index}` now, and the property it exists for is unchanged
  // and load-bearing in exactly the case that used to be impossible: two rows
  // claiming one id must still be two distinct records the operator can tell
  // apart and address separately.
  it('keys each record by id and position, so two rows claiming one id stay distinct', () => {
    const { projection } = project({
      rows: [VALID_ROW, { ...VALID_ROW, name: 'Second Claim' }]
    });
    const keys = projection!.records.map((r) => r.key);
    expect(keys).toEqual(['custom-flow::0', 'custom-flow::1']);
    expect(new Set(keys).size).toBe(2);
  });
});

// Feature 099 (T496f, FR-042) — C2 was layer precedence: the higher layer wins
// and the loser is `shadowed`. One layer has no precedence, and `shadowed` is
// gone with it. C3 — an id resolves to at most one definition, and never to an
// invalid one — is untouched, and it is now the whole of the contract: an id two
// rows contend for resolves to NEITHER, which is the one-catalog analogue of the
// case precedence used to settle.
describe('pipelineCatalog projection — C3 effectiveness', () => {
  it('marks exactly one record effective for an id exactly one row claims', () => {
    const { projection } = project({ rows: [VALID_ROW] });
    const forId = projection!.records.filter((r) => r.pipelineId === 'custom-flow');
    expect(forId.filter((r) => r.status === 'effective')).toHaveLength(1);
    expect(projection!.effective.map((d) => d.pipelineId)).toEqual(['custom-flow']);
  });

  it('marks no record effective when two rows contend for one id', () => {
    const { projection } = project({
      rows: [{ ...VALID_ROW, name: 'First Claim' }, { ...VALID_ROW, name: 'Second Claim' }]
    });
    const forId = projection!.records.filter((r) => r.pipelineId === 'custom-flow');
    expect(forId).toHaveLength(2);
    expect(forId.map((r) => r.status)).toEqual(['invalid', 'invalid']);
    for (const record of forId) expect(record.definition).toBeNull();
    // Neither claim is silently preferred, so the id resolves to nothing at all.
    expect(projection!.effective.map((d) => d.pipelineId)).not.toContain('custom-flow');
  });

  it('never projects an invalid row into `effective`', () => {
    const { projection } = project({
      rows: [VALID_ROW, { id: 'broken-flow', name: '', phases: [] }]
    });
    const effectiveIds = projection!.effective.map((d) => d.pipelineId);
    expect(effectiveIds).toContain('custom-flow');
    expect(effectiveIds).not.toContain('broken-flow');
    for (const definition of projection!.effective) {
      const record = projection!.records.find(
        (r) => r.pipelineId === definition.pipelineId && r.status === 'effective'
      );
      expect(record).toBeDefined();
      expect(record!.definition).not.toBeNull();
    }
  });
});

describe('pipelineCatalog projection — C4 revision', () => {
  // Feature 099 (T496f, FR-044) — one layer, one revision. It is the store's,
  // carried through untouched rather than recomputed from the rows, so the
  // webview echoes back the same string the store handed the host.
  it('carries the store revision the webview echoes as expectedRevision', () => {
    const { catalog, projection } = project({ rows: [VALID_ROW] });
    expect(projection!.revision).toBe(SEEDED_PIPELINE_REVISION);
    expect(projection!.revision).toBe(catalog.revision);
    expect(projection).not.toHaveProperty('revisions');
  });
});

describe('pipelineCatalog projection — C5/C6 sanitization', () => {
  it('sanitizes definitions, display values, warnings, and errors exactly once', () => {
    const { projection } = project({
      rows: [
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
    const { projection } = project({ rows: [{ ...VALID_ROW, description: authoredPath }] });
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
    const { projection } = project({ rows: [manyBadFields] });
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
      rows: [{ id: `a${'b'.repeat(200)}`, name: 'Long', version: 1, phases: ['finalize'] }]
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
    const { projection } = project({ rows: [...rows, { id: 'bad', name: '', phases: [] }] });
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
    const { snapshot, projection } = project({ rows: [VALID_ROW] });
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
      rows: [VALID_ROW],
      workflowRefs: [
        { workflowId: 'wf-z', pipelineId: 'custom-flow', kind: 'run-request' },
        { workflowId: 'wf-a', pipelineId: 'custom-flow', kind: 'run-request' },
        { workflowId: 'wf-a', pipelineId: 'custom-flow', kind: 'run-request' }
      ]
    });
    const record = projection!.records.find((r) => r.pipelineId === 'custom-flow')!;
    expect(record.consumingWorkflowIds).toEqual(['wf-a', 'wf-z']);
  });

  // Feature 099 (T496f) — the second record was `shadowed`; it is `invalid` now,
  // for the same underlying reason (a second row claiming the id). The claim is
  // unchanged and matters more here: a reference names an ID, so every record
  // carrying that id reports the same consumers regardless of its status — the
  // operator of a record that is NOT in effect is the one most likely to need to
  // know who depends on the id.
  it('reports the same consumers on every record claiming the id', () => {
    const { projection } = project({
      rows: [{ ...VALID_ROW, name: 'First Claim' }, VALID_ROW],
      workflowRefs: [{ workflowId: 'wf-a', pipelineId: 'custom-flow', kind: 'run-request' }]
    });
    const forId = projection!.records.filter((r) => r.pipelineId === 'custom-flow');
    expect(forId).toHaveLength(2);
    expect(forId.every((r) => r.status !== 'effective')).toBe(true);
    for (const record of forId) {
      expect(record.consumingWorkflowIds).toEqual(['wf-a']);
    }
  });

  it('omits the field on records nothing references', () => {
    // Feature 098 (T080) — the unreferenced record used to be a built-in Pipeline,
    // projected alongside the workspace row for free. Nothing is projected for free
    // now, so the case authors the row it needs: one referenced Pipeline and one
    // that nothing names.
    const { projection } = project({
      rows: [VALID_ROW, { ...VALID_ROW, id: 'unreferenced-flow', name: 'Unreferenced' }],
      workflowRefs: [{ workflowId: 'wf-a', pipelineId: 'custom-flow', kind: 'run-request' }]
    });
    const unreferenced = projection!.records.filter((r) => r.pipelineId !== 'custom-flow');
    expect(unreferenced.length).toBeGreaterThan(0);
    for (const record of unreferenced) {
      expect(record.consumingWorkflowIds).toBeUndefined();
    }
  });

  it('omits the field entirely when the host exposes no Workflow references', () => {
    const { projection } = project({ rows: [VALID_ROW] });
    for (const record of projection!.records) {
      expect(record.consumingWorkflowIds).toBeUndefined();
    }
  });

  it('sanitizes and bounds ids before they reach the webview (C5, C7)', () => {
    const { projection } = project({
      rows: [VALID_ROW],
      workflowRefs: [{ workflowId: 'wf-SECRET', pipelineId: 'custom-flow', kind: 'run-request' }]
    });
    const record = projection!.records.find((r) => r.pipelineId === 'custom-flow')!;
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
    // Feature 092 (T090) — the envelope version this optional field is tolerated
    // at; the per-queue reshape moved it 3 -> 4.
    expect(snapshot.schemaVersion).toBe(4);
  });
});
