// Feature 082 (T066) — a state persisted before this feature must load byte-for
// -byte unchanged.
//
// The justification for leaving `STATE_SCHEMA_VERSION` and
// `AUDIT_SCHEMA_VERSION` unbumped is that every field 082 adds to
// `WorkflowRun.pipeline` is optional and written only when the resolved
// definition carried it (research R8). That is a claim about *reads*, so it is
// worth an actual read: this loads a captured pre-feature memento through the
// real `WorkspaceStateStore.initialize()` path and asserts nothing was
// migrated, injected, or renamed.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION } from '../../../src/contracts/state-schema';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { snapshotPipelineContract } from '../../../src/config/pipeline-snapshot';
import type { PhaseDef, PipelineDef } from '../../../src/config/pipeline-config';

const FIXTURE_PATH = join(__dirname, '../../fixtures/state/pre-082-workspace-state.json');

/** The exact contract keys feature 082 introduced — none may appear on a read. */
const FEATURE_082_PIPELINE_KEYS = [
  'description',
  'version',
  'inputs',
  'outputs',
  'bindings',
  'executionDefaults',
  'recommendedNext'
] as const;

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function loadFixture(): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  delete parsed._comment;
  return parsed;
}

async function seededStore(): Promise<{
  store: WorkspaceStateStore;
  memento: FakeMemento;
  fixture: Record<string, unknown>;
}> {
  const fixture = loadFixture();
  const memento = new FakeMemento();
  for (const [key, value] of Object.entries(fixture)) {
    await memento.update(key, value);
  }
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, memento, fixture };
}

describe('pre-082 persisted state loads unchanged (T066)', () => {
  it('is captured at the schema version this feature leaves alone', () => {
    const fixture = loadFixture();
    expect(fixture[KEYS.schemaVersionNumeric]).toBe(STATE_SCHEMA_VERSION);
    expect(fixture[KEYS.schemaVersion]).toBe(SCHEMA_VERSION);
  });

  it('loads the legacy Run without bumping or rewriting the schema version', async () => {
    const { memento } = await seededStore();
    expect(memento.get<number>(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
    expect(memento.get<string>(KEYS.schemaVersion)).toBe(SCHEMA_VERSION);
  });

  it('returns the persisted pipeline contract byte-for-byte', async () => {
    const { store, fixture } = await seededStore();
    const run = store.getRun();
    const persisted = (fixture[KEYS.run] as { pipeline: unknown }).pipeline;
    expect(run?.pipeline).toEqual(persisted);
  });

  it('injects none of the fields feature 082 added', async () => {
    const { store } = await seededStore();
    const pipeline = store.getRun()?.pipeline;
    if (pipeline === undefined) throw new Error('fixture must persist a Run carrying a pipeline');
    expect(Object.keys(pipeline).sort()).toEqual(['id', 'name', 'phases']);
    for (const key of FEATURE_082_PIPELINE_KEYS) {
      expect(pipeline).not.toHaveProperty(key);
    }
  });

  it('leaves the queue entry that pins a pipelineId alone', async () => {
    const { store, fixture } = await seededStore();
    const persistedQueue = fixture[KEYS.queue] as { requests: readonly unknown[] };
    expect(store.getQueue().requests).toEqual(persistedQueue.requests);
  });

  it('rewrites nothing when the same state is loaded twice', async () => {
    const { memento, fixture } = await seededStore();
    const afterFirst = JSON.stringify(memento.get<WorkflowRun>(KEYS.run));
    const second = new WorkspaceStateStore(memento);
    await second.initialize();
    expect(JSON.stringify(memento.get<WorkflowRun>(KEYS.run))).toBe(afterFirst);
    expect(memento.get<WorkflowRun>(KEYS.run)).toEqual(fixture[KEYS.run]);
  });

  it('re-snapshotting a legacy definition reproduces the persisted shape', async () => {
    // The write side of the same claim: a Pipeline that declares no contract
    // fields must serialize to exactly what the fixture already holds.
    const { store } = await seededStore();
    const persisted = store.getRun()?.pipeline as {
      id: string;
      name: string;
      phases: readonly PhaseDef[];
    };
    const legacyDef: PipelineDef = {
      id: persisted.id,
      name: persisted.name,
      phases: persisted.phases.map((phase) => phase.id)
    };
    expect(snapshotPipelineContract(legacyDef, persisted.phases)).toEqual(persisted);
  });
});
