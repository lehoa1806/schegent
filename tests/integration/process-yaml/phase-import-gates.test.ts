// Feature 084 T057..T062 — the gates the import commit passes through, and the
// order they run in.
//
// Covers QS-28 through QS-33. The commit reuses a shipped catalog-write command,
// so what these tests pin is not new gate code but that an import is subject to
// every gate an authored Phase is, in the same order.
//
// FR-039 makes the first pair load-bearing rather than incidental: a stale write by
// an untrusted operator must report staleness. If the trust gate ran first, the
// operator would be told to fix their trust settings and would still be stale
// afterwards.
//
// FR-041's gate is the router's `MUTATING_COMMANDS` membership, one level above
// the handler, so the secondary-window test drives the router rather than the
// handler.
//
// Feature 099 (T496f, FR-042a) — the commit writes the catalog store, not a
// settings key, and there is one catalog rather than a user/workspace pair. The
// gate order above is unchanged, and so is every claim below; what moved is the
// write seam each is asserted against.
//
// Feature 100 (T514, FR-047) — the command is `CMD_PUBLISH_PACKAGE`, and the order
// reads:
//
//   revision  →  trust  →  validation
//
// The `mutation intent` gate is gone with the intent algebra (FR-051): the operation
// IS the intent. Validation moved *behind* trust, because it now happens inside
// `publishPackage` where the whole document is validated at once against the active
// catalog with every candidate overlaid (FR-016, FR-017) — a check the handler cannot
// make on its own. That reordering is safe in the direction FR-039 cares about: the
// gate that answers first is still the revision, and a denial still writes nothing.
// Every test below that asserted an order asserts the same order.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
const resolvedScopes = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: (name: string) => resolvedScopes.get(name) ?? 'workspace'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/import-gates' },
    name: 'import-gates',
    index: 0
  })
}));

import { SanitizedLogger } from '../../../src/lib/logger';
import {
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_PACKAGE
} from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  PublishPackageCommand
} from '../../../src/contracts/sidebar-ipc';
import { MessageRouter } from '../../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../../src/ui/sidebar/message-router';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { publishDefinitionPackage } from '../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import { FakeCatalogStore, NO_WRITES, writesOf } from '../../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

function newStore(): FakeCatalogStore {
  return new FakeCatalogStore();
}

/** Another window writing the Phase catalog between the preflight and the commit. */
async function concurrentWrite(
  store: FakeCatalogStore,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  const outcome = await store.saveDraftLayer({
    kind: 'phase',
    expectedRevision: store.revisionOf('phase'),
    definitions: rows.map((row) => ({ id: row.id as string, body: row }))
  });
  expect(outcome.outcome).toBe('saved');
  const published = await store.publishLayer({
    kind: 'phase',
    ids: rows.map((row) => row.id as string),
    expectedRevision: store.revisionOf('phase')
  });
  expect(published.outcome).toBe('published');
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function document(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Phase', ...body, ''].join('\n');
}

const PLAIN_DOCUMENT = document([
  'metadata:',
  '  phaseId: brought-in',
  '  name: Brought In',
  '  version: 2',
  'spec:',
  '  instruction: Do the thing.'
]);

/** The same Phase, declaring a retry condition, so the row-level gate applies. */
const RETRYING_DOCUMENT = document([
  'metadata:',
  '  phaseId: brought-in',
  '  name: Brought In',
  '  version: 2',
  'spec:',
  '  instruction: Do the thing.',
  '  retryCondition: open_questions > 0'
]);

const HELD_ROW = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });

/** A row for a DIFFERENT catalog, used to show the revision gate is per kind. */
const HELD_PIPELINE_ROW = Object.freeze({
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 1,
  phases: [{ phaseId: 'held' }]
});

// ---------------------------------------------------------------------------
// Preflight and commit
// ---------------------------------------------------------------------------

async function planFor(text: string, store: FakeCatalogStore): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      openProcessYamlDocument: async () => ({ outcome: 'read' as const, bytes: bytes(text) }),
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'gates-1'
  } as any;
  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: 'gates-1',
    payload: {}
  };
  await preflightHandler(ctx, command);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

/**
 * The request the webview builds from a plan. Mirrors `buildImportSave` in
 * `webview-ui/src/components/ProcessImport/process-import-state.ts`, which is
 * pinned on its own side; what these tests need from it is a realistic payload
 * to drive the handler with.
 */
function commitCommand(
  plan: ImportPlan,
  overrides: { readonly expectedRevision?: string } = {}
): PublishPackageCommand {
  const row = plan.rows.find(
    (candidate) => candidate.outcome === 'import' && candidate.resourceKind === 'phase'
  );
  expect(row?.outcome).toBe('import');
  if (row?.outcome !== 'import' || row.resourceKind !== 'phase') {
    throw new Error('unreachable');
  }
  const { phaseId, ...declared } = row.definition;
  return {
    type: CMD_PUBLISH_PACKAGE,
    correlationId: 'gates-1',
    payload: {
      layers: [
        {
          kind: 'phase',
          expectedRevision: overrides.expectedRevision ?? plan.computedAgainstRevision,
          definitions: [{ id: phaseId, body: { id: phaseId, ...declared } }]
        }
      ]
    }
  };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  readonly audits: readonly AuditEntry[];
  /** Requests that reached any of the three write ports, accepted or refused. */
  readonly writes: number;
}

function writeTotal(store: FakeCatalogStore): number {
  const counts = writesOf(store);
  return counts.lifecycle + counts.draftLayers + counts.publishLayers;
}

async function commit(command: PublishPackageCommand, store: FakeCatalogStore): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const writesBefore = writeTotal(store);
  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      catalogStore: store,
      catalogLifecycle: fakeCatalogLifecycle(store),
      refreshCatalog: async () => undefined,
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'gates-1'
  } as any;
  await publishDefinitionPackage(ctx, command);
  expect(acks).toHaveLength(1);
  // A store request counts as a write whether the store accepted it or not: the
  // gates below are all asserted to stop BEFORE the store is reached.
  return { ack: acks[0]!, audits, writes: writeTotal(store) - writesBefore };
}

beforeEach(() => {
  capabilities.clear();
  resolvedScopes.clear();
});

// ---------------------------------------------------------------------------
// T057 — the revision gate, and its position relative to the trust gate
// ---------------------------------------------------------------------------

describe('Feature 084 — the revision gate (T057, QS-28, FR-038, SC-011)', () => {
  it('refuses a superseded revision, leaves the catalog untouched, and says to recompute', async () => {
    const store = newStore();
    const plan = await planFor(PLAIN_DOCUMENT, store);

    // The operator authored something else in the catalog between the preflight
    // and the confirmation.
    await concurrentWrite(store, [HELD_ROW]);
    const revisionBefore = store.revisionOf('phase');

    const run = await commit(commitCommand(plan), store);

    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('stale-catalog');
    expect(run.writes).toBe(0);
    expect(store.rowsOf('phase')).toEqual([HELD_ROW]);
    expect(store.revisionOf('phase')).toBe(revisionBefore);

    // Feature 100 — the operator is told which LAYER went stale rather than which
    // revision now holds. A package names several kinds and only some of them can
    // be stale, so the actionable fact is the kind: recompute the plan and the
    // fresh revision comes with it. There is no per-definition token to report
    // either, which is why this refusal carries no `current` record.
    expect(run.ack.result).toEqual({ kind: 'phase' });
  });

  // Feature 099 (T496f, FR-044) — this was "a change to the OTHER layer does not
  // stale the write". The layer pair is gone; the revision gate is still scoped,
  // one axis over: each catalog KIND carries its own revision, so a Pipeline write
  // cannot stale a Phase commit. Same claim, same failure it prevents (a shared
  // revision would make every window's every write stale every other's).
  it('is scoped per catalog — a Pipeline write does not stale a Phase commit', async () => {
    const store = newStore();
    const plan = await planFor(PLAIN_DOCUMENT, store);
    const pipelineWrite = await store.saveDraftLayer({
      kind: 'pipeline',
      expectedRevision: store.revisionOf('pipeline'),
      definitions: [{ id: HELD_PIPELINE_ROW.id, body: HELD_PIPELINE_ROW }]
    });
    expect(pipelineWrite.outcome).toBe('saved');

    const run = await commit(commitCommand(plan), store);
    expect(run.ack.status).toBe('accepted');
    // Feature 100 — two writes, not one: a package publish drafts every layer and
    // then publishes every layer (FR-041). The count is the assertion that both
    // passes ran, which is what makes the imported Phase reachable at all.
    expect(run.writes).toBe(2);
  });

  it('reports staleness, not untrustedness, when both gates would fire (T057, QS-29, FR-039)', async () => {
    capabilities.set('phases', false);
    const store = newStore();
    const plan = await planFor(PLAIN_DOCUMENT, store);
    await concurrentWrite(store, [HELD_ROW]);

    const run = await commit(commitCommand(plan), store);

    // Both conditions hold. The revision gate is the one that answers.
    expect(run.ack.reason).toBe('stale-catalog');
    expect(run.ack.reason).not.toBe('trust-denied');
    expect(run.writes).toBe(0);
    // The log agrees with the answer the operator got. Feature 100 (FR-042)
    // changed how it agrees rather than whether it does: the refused arm now
    // audits every layer it declined, so the claim is no longer "nothing was
    // recorded" but "what was recorded names the staleness". The trust denial is
    // the record that must still be absent — the gate was never reached, and a
    // `trust.capability-denied` here would say the operator was refused for a
    // reason they were not.
    expect(run.audits.map((entry) => entry.eventType)).toEqual([
      'process-exchange-import-refused'
    ]);
    expect(run.audits.map((entry) => entry.eventType)).not.toContain(
      'trust.capability-denied'
    );
    const refusal = run.audits[0]!.payload as { readonly outcomes: readonly string[] };
    expect(refusal.outcomes).toEqual(['stale-catalog']);
  });
});

// ---------------------------------------------------------------------------
// T058 — the `phases` capability
// ---------------------------------------------------------------------------

describe('Feature 084 — the phases capability (T058, QS-30, FR-040)', () => {
  it('writes nothing and reports a capability denial', async () => {
    capabilities.set('phases', false);
    const store = newStore();
    const plan = await planFor(PLAIN_DOCUMENT, store);

    const run = await commit(commitCommand(plan), store);

    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('trust-denied');
    expect(run.writes).toBe(0);
    expect(store.rowsOf('phase')).toEqual([]);

    // The reason names the capability, so the operator can act on it.
    const err = run.ack.result as { kind: string; capability: string; reason: string };
    expect(err.kind).toBe('trust-denied');
    expect(err.capability).toBe('phases');
    expect(err.reason.length).toBeGreaterThan(0);
  });

  it('is the same capability authoring a Phase requires — an import is not a side door', async () => {
    // Allowed: the identical commit lands. Nothing about the import path grants
    // a write the authoring path would not.
    capabilities.set('phases', true);
    const store = newStore();
    const plan = await planFor(PLAIN_DOCUMENT, store);
    const run = await commit(commitCommand(plan), store);
    expect(run.ack.status).toBe('accepted');
    expect(store.rowsOf('phase')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T059 / T060 — the retry-condition capability
// ---------------------------------------------------------------------------

describe('Feature 084 — the retryConditions capability (T059, QS-31, FR-012a, SC-018)', () => {
  it('refuses a document declaring a retryCondition, naming the capability', async () => {
    capabilities.set('retryConditions', false);
    const store = newStore();
    const plan = await planFor(RETRYING_DOCUMENT, store);

    const run = await commit(commitCommand(plan), store);

    expect(run.ack.reason).toBe('trust-denied');
    const err = run.ack.result as { capability: string; rowIndex?: number };
    expect(err.capability).toBe('retryConditions');
    // The row-granular gate names which row, so a multi-row layer is actionable.
    expect(err.rowIndex).toBe(0);
    expect(run.writes).toBe(0);
  });

  it('never stores the Phase with the field stripped', async () => {
    capabilities.set('retryConditions', false);
    const store = newStore();
    const plan = await planFor(RETRYING_DOCUMENT, store);

    await commit(commitCommand(plan), store);

    // SC-018: the refusal is total. A Phase that quietly lost its retry
    // condition would run differently from the one the operator imported.
    expect(store.rowsOf('phase')).toEqual([]);
    expect(JSON.stringify(store.rowsOf('phase'))).not.toContain('brought-in');
  });

  it('lands whole, retryCondition included, once the capability is allowed', async () => {
    capabilities.set('retryConditions', true);
    const store = newStore();
    const plan = await planFor(RETRYING_DOCUMENT, store);

    const run = await commit(commitCommand(plan), store);

    expect(run.ack.status).toBe('accepted');
    expect(store.rowsOf('phase')).toEqual([
      {
        id: 'brought-in',
        name: 'Brought In',
        version: 2,
        instruction: 'Do the thing.',
        retryCondition: 'open_questions > 0'
      }
    ]);
  });

  it('re-reads the capability at commit rather than trusting the preflight (T060, QS-32)', async () => {
    // Allowed during the preflight, so the plan is built with the flag clear of
    // any denial, then denied before the operator confirms.
    capabilities.set('retryConditions', true);
    const store = newStore();
    const plan = await planFor(RETRYING_DOCUMENT, store);

    capabilities.set('retryConditions', false);
    const run = await commit(commitCommand(plan), store);

    expect(run.ack.reason).toBe('trust-denied');
    expect((run.ack.result as { capability: string }).capability).toBe('retryConditions');
    expect(run.writes).toBe(0);
  });

  it('does not gate a Phase that declares no retryCondition', async () => {
    capabilities.set('retryConditions', false);
    const store = newStore();
    const plan = await planFor(PLAIN_DOCUMENT, store);

    const run = await commit(commitCommand(plan), store);
    expect(run.ack.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// T062 — the advisory flag
// ---------------------------------------------------------------------------

describe('Feature 084 — requiresRetryConditionCapability is advisory (T062, FR-012a)', () => {
  function flagFor(plan: ImportPlan): boolean {
    const row = plan.rows[0]!;
    expect(row.outcome).toBe('import');
    // The flag exists only on a Phase import row: feature 085 widened the row to
    // carry Pipelines too, and a Pipeline declares no `retryCondition` of its own.
    if (row.outcome !== 'import' || row.resourceKind !== 'phase') {
      throw new Error('unreachable');
    }
    return row.requiresRetryConditionCapability;
  }

  it('is set when the document declares a retryCondition and clear when it does not', async () => {
    const store = newStore();
    expect(flagFor(await planFor(RETRYING_DOCUMENT, store))).toBe(true);
    expect(flagFor(await planFor(PLAIN_DOCUMENT, store))).toBe(false);
  });

  it('does not answer the gate — it reports the document, not the capability', async () => {
    // The flag is a property of the DOCUMENT, so it reads the same whether the
    // capability is allowed or denied. A UI that warns from it is warning about
    // what the document needs, not about what the host will permit.
    const store = newStore();
    capabilities.set('retryConditions', true);
    const allowed = flagFor(await planFor(RETRYING_DOCUMENT, store));
    capabilities.set('retryConditions', false);
    const denied = flagFor(await planFor(RETRYING_DOCUMENT, store));
    expect(allowed).toBe(denied);
    expect(allowed).toBe(true);
  });

  it('is not what the commit consults — a commit the flag never described is still gated', async () => {
    // A commit assembled without any plan at all, as a compromised or
    // out-of-date webview could send. The gate reads the row's own
    // `retryCondition`, so there is nothing here for a forged flag to bypass.
    capabilities.set('retryConditions', false);
    const store = newStore();
    const forged: PublishPackageCommand = {
      type: CMD_PUBLISH_PACKAGE,
      correlationId: 'gates-1',
      payload: {
        layers: [
          {
            kind: 'phase',
            expectedRevision: store.revisionOf('phase'),
            definitions: [
              {
                id: 'brought-in',
                body: {
                  id: 'brought-in',
                  name: 'Brought In',
                  version: 2,
                  instruction: 'Do the thing.',
                  retryCondition: 'open_questions > 0'
                }
              }
            ]
          }
        ]
      }
    };

    const run = await commit(forged, store);
    expect(run.ack.reason).toBe('trust-denied');
    expect((run.ack.result as { capability: string }).capability).toBe('retryConditions');
    expect(run.writes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T061 — the primary-window gate
// ---------------------------------------------------------------------------

describe('Feature 084 — a secondary window refuses the write (T061, QS-33, FR-041)', () => {
  function routerDeps(
    store: FakeCatalogStore,
    overrides: Partial<RouterDeps> = {}
  ): RouterDeps {
    return {
      executeCommand: vi.fn(
        async () => undefined as unknown
      ) as unknown as RouterDeps['executeCommand'],
      queueRemover: { remove: vi.fn(async () => true) },
      catalogStore: store,
      refreshCatalog: async () => undefined,
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      isPrimary: () => false,
      isTrusted: () => true,
      logger: new SanitizedLogger(),
      // Feature 100 — the commit is a lifecycle operation now, so the router
      // needs the service as well as the store. Wired unconditionally, including
      // on the secondary window: the point of that case is that the gate answers
      // BEFORE the handler is reachable, which is only demonstrated when the
      // handler would otherwise have succeeded.
      catalogLifecycle: fakeCatalogLifecycle(store),
      audit: { append: async () => undefined },
      ...overrides
    } as unknown as RouterDeps;
  }

  /** The forged-free commit the router is asked to carry, in both cases. */
  function packageEnvelope(store: FakeCatalogStore, correlationId: string): PublishPackageCommand {
    return {
      type: CMD_PUBLISH_PACKAGE,
      correlationId,
      payload: {
        layers: [
          {
            kind: 'phase',
            expectedRevision: store.revisionOf('phase'),
            definitions: [
              {
                id: 'brought-in',
                body: { id: 'brought-in', name: 'Brought In', version: 2, instruction: 'Do.' }
              }
            ]
          }
        ]
      }
    };
  }

  it('refuses the import commit with a stated reason and writes nothing', async () => {
    const store = newStore();
    const notifyWarning = vi.fn();
    const router = new MessageRouter(routerDeps(store, { notifyWarning }));
    const posted: CommandAckMessage[] = [];

    await router.dispatch(
      packageEnvelope(store, 'gates-secondary'),
      async (msg: CommandAckMessage) => {
        posted.push(msg);
        return true;
      }
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]!.status).toBe('rejected');
    expect(posted[0]!.reason).toBe('secondary-window-readonly');
    expect(writesOf(store)).toEqual(NO_WRITES);
    // FR-041 requires a STATED reason, and the ack reason alone is not what an
    // operator sees; the router also surfaces it.
    expect(notifyWarning).toHaveBeenCalledTimes(1);
    expect(String(notifyWarning.mock.calls[0]![0])).toContain('window');
  });

  it('lets the same command through on the primary window, so the gate is the window', async () => {
    const store = newStore();
    const router = new MessageRouter(routerDeps(store, { isPrimary: () => true }));
    const posted: CommandAckMessage[] = [];

    await router.dispatch(
      packageEnvelope(store, 'gates-primary'),
      async (msg: CommandAckMessage) => {
        posted.push(msg);
        return true;
      }
    );

    expect(posted).toHaveLength(1);
    // Accepted, not merely "rejected for some other reason" — otherwise this
    // would pass even if the command were unreachable for an unrelated cause,
    // and would not establish that the window is what the gate reads.
    expect(posted[0]!.status).toBe('accepted');
  });
});
