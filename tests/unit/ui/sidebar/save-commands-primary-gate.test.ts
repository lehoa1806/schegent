// Feature 056 Track 1 (FR-001..FR-005) — Regression tests proving the
// four catalog / general-settings save commands are rejected on
// secondary VS Code windows. The fourth command
// (CMD_SAVE_GENERAL_SETTINGS) is covered by
// tests/unit/ui/sidebar/general-settings-router.test.ts; this file
// covers the three catalog saves.
//
// MUTATING_COMMANDS is the only gate preventing a secondary host from
// rewriting the catalog during a multi-window session (AGENTS.md hard
// rule). These tests pin the new policy in source and would fail loudly
// if anyone reverted message-router.ts.
//
// Feature 099 (T496f, FR-042a) — the write the gate stands in front of used to be
// `updateConfig`; it is `CatalogStore.saveLayer` now. The claim is unchanged: a
// secondary host reaches no write at all.

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { FakeCatalogStore } from '../../../fixtures/fake-catalog-store';
import {
  CMD_ACK,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_PHASES,
  CMD_SAVE_MODELS
} from '../../../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../../../src/ui/sidebar/messages';

/** One stored row, so a `reset` has something to clear and the write is real. */
const PIPELINE_ROW = Object.freeze({
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 1,
  phases: [{ phaseId: 'speckit-specify' }]
});

interface AckCapture {
  posted: CommandAckMessage[];
  post: (msg: CommandAckMessage) => Promise<boolean>;
}

function makeAckCapture(): AckCapture {
  const posted: CommandAckMessage[] = [];
  return {
    posted,
    post: vi.fn(async (msg: CommandAckMessage) => {
      posted.push(msg);
      return true;
    })
  };
}

function makeDeps(store: FakeCatalogStore, overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    executeCommand: vi.fn(async () => undefined as unknown) as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: vi.fn(async () => true) },
    catalogStore: store,
    refreshCatalog: async () => undefined,
    isPrimary: () => false,
    isTrusted: () => true,
    logger: new SanitizedLogger(),
    ...overrides
  } as unknown as RouterDeps;
}

describe('Feature 056 Track 1 — secondary-host gate for catalog saves', () => {
  it('CMD_SAVE_PIPELINES is rejected on a secondary host (FR-002)', async () => {
    const store = new FakeCatalogStore();
    const deps = makeDeps(store);
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_PIPELINES,
        correlationId: 'cid-pipelines-secondary',
        payload: {
          expectedRevision: store.revisionOf('pipeline'),
          mutation: { kind: 'reset' },
          pipelines: []
        }
      },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(store.layerSaves).toEqual([]);
  });

  it('CMD_SAVE_PHASES is rejected on a secondary host (FR-002)', async () => {
    const store = new FakeCatalogStore();
    const deps = makeDeps(store);
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'cid-phases-secondary',
        payload: {
          expectedRevision: 'revision',
          mutation: { kind: 'reset' },
          phases: []
        }
      },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(store.layerSaves).toEqual([]);
  });

  it('CMD_SAVE_MODELS is rejected on a secondary host (FR-002)', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const store = new FakeCatalogStore();
    const deps = makeDeps(store, { updateConfig });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_MODELS,
        correlationId: 'cid-models-secondary',
        payload: { models: { claude: [], codex: [], agy: [] } }
      },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('CMD_SAVE_PIPELINES still works on the primary host (FR-001)', async () => {
    const store = new FakeCatalogStore({ pipelines: [PIPELINE_ROW] });
    const deps = makeDeps(store, {
      isPrimary: () => true,
      readPipelineConfig: () => ({
        rows: store.rowsOf('pipeline'),
        revision: store.revisionOf('pipeline')
      })
    } as unknown as Partial<RouterDeps>);
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_PIPELINES,
        correlationId: 'cid-pipelines-primary',
        payload: {
          expectedRevision: store.revisionOf('pipeline'),
          mutation: { kind: 'reset' },
          pipelines: []
        }
      },
      cap.post
    );

    expect(cap.posted[0].status).toBe('accepted');
    // Feature 099 — the write reaches the one Pipeline catalog. A `reset` names no
    // row, so the seeded row is un-named and the catalog is left empty.
    expect(store.layerSaves).toHaveLength(1);
    expect(store.layerSaves[0]).toMatchObject({ kind: 'pipeline', definitions: [] });
    expect(store.rowsOf('pipeline')).toEqual([]);
  });
});
