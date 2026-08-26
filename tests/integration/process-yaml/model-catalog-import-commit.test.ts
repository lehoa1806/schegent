// Feature 096 T020 — the CMD_SAVE_MODELS import-confirm gate.
// Contract: specs/096-model-list-import-export/contracts/model-catalog-exchange.md §4.
//
// Two call sites share this one command (contracts §4): the pre-existing
// manual add/remove path (`expectedRevision`/`mutation` both omitted) keeps
// its unconditional write unchanged; the import-confirm path (both present)
// runs the gated sequence below. `phase-import-commit.test.ts` is the
// structural mirror — preflight computes a plan, the plan's revision drives
// the commit — narrowed the way contracts §4 narrows it: one layer
// ('workspace' only, no scope choice), no cross-reference gate, no
// consumer-removal-block gate, no capability-trust gate (none apply to Model
// Catalog per FR-015, Decision 9).

import { describe, expect, it, vi } from 'vitest';

import { modelsLayerRevision } from '../../../src/config/model-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML, CMD_SAVE_MODELS } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  SaveModelsCommand
} from '../../../src/contracts/sidebar-ipc';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveHandler } from '../../../src/ui/sidebar/commands/cmd-save-models';

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

/** Model Catalog's one writable layer (research.md Decision 6). */
interface Installation {
  workspace: ModelsConfig;
}

function installation(workspace: Partial<ModelsConfig> = {}): Installation {
  return { workspace: { claude: [], codex: [], agy: [], ...workspace } };
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

const MODEL_CATALOG_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: ModelCatalog',
  'groups:',
  '  - backend: claude',
  '    models:',
  '      - claude-opus-5',
  '      - claude-sonnet-5',
  ''
].join('\n');

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readModelsConfig: () => inst.workspace,
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
    correlationId: 'model-catalog-import-commit-1'
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: 'model-catalog-import-commit-1',
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * The delta the webview builds from a plan (`process-yaml-api.ts`'s
 * `modelsDeltaByBackend`, mirrored here since that helper is headless-only):
 * only the `import`-outcome rows, grouped by backend — never a pre-merged
 * catalog (contracts §4, Implementation Note 2).
 */
function deltaFromPlan(plan: ImportPlan): Record<string, readonly string[]> {
  const delta: Record<string, string[]> = {};
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'modelCatalog') {
      (delta[row.backend] ??= []).push(row.modelId);
    }
  }
  return delta;
}

/** Every `modelCatalog` plan carries this (T019); absence means the wrong kind planned. */
function revisionOf(plan: ImportPlan): string {
  const { computedAgainstModelsRevision } = plan;
  if (computedAgainstModelsRevision === undefined) throw new Error('unreachable');
  return computedAgainstModelsRevision;
}

function commitCommand(
  models: Record<string, readonly string[]>,
  expectedRevision: string
): SaveModelsCommand {
  return {
    type: CMD_SAVE_MODELS,
    correlationId: 'model-catalog-import-commit-1',
    payload: { models, expectedRevision, mutation: { kind: 'import-package' } }
  };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  readonly writes: number;
}

async function commit(
  inst: Installation,
  command: SaveModelsCommand,
  opts: { readonly writeThrows?: Error } = {}
): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  let writes = 0;
  const ctx = {
    deps: {
      readModelsConfig: () => inst.workspace,
      // Feature 099 (T496f, FR-042) — `updateConfig` lost its scope parameter
      // with the layer tier. The claim it carried is unchanged and now stronger:
      // the command cannot choose a target, because the port has nowhere to name
      // one. The workspace target is pinned once, in the adapter in
      // `src/extension.ts`, so the assertion moves from "it asked for workspace"
      // to "it could not have asked for anything else".
      updateConfig: async (key: string, value: unknown, ...rest: readonly unknown[]) => {
        writes += 1;
        if (opts.writeThrows) throw opts.writeThrows;
        expect(key).toBe('models');
        expect(rest, 'the settings write port takes no target argument').toEqual([]);
        inst.workspace = value as ModelsConfig;
      },
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
    correlationId: 'model-catalog-import-commit-1'
  } as any;

  await saveHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { ack: acks[0]!, writes };
}

describe('Feature 096 — the manual add/remove call site keeps its unconditional write (contracts §4)', () => {
  it('writes without checking a revision when expectedRevision and mutation are both omitted', async () => {
    const inst = installation({ claude: ['claude-opus-5'] });
    const command: SaveModelsCommand = {
      type: CMD_SAVE_MODELS,
      correlationId: 'manual-1',
      payload: { models: { claude: ['claude-opus-5', 'claude-sonnet-5'], codex: [], agy: [] } }
    };

    const { ack, writes } = await commit(inst, command);

    expect(ack).toMatchObject({ status: 'accepted' });
    expect(writes).toBe(1);
    expect(inst.workspace).toEqual({ claude: ['claude-opus-5', 'claude-sonnet-5'], codex: [], agy: [] });
  });
});

describe('Feature 096 — import-confirm: a stale revision commits nothing (contracts §4 step 3)', () => {
  it('rejects with stale-catalog, reports the current revision, and leaves the catalog untouched', async () => {
    const inst = installation({ claude: ['claude-opus-5'] });
    const plan = await planFor(inst, MODEL_CATALOG_DOCUMENT);

    // Someone else writes the layer between the preflight and the confirm, so
    // the revision the plan was computed against no longer describes it.
    inst.workspace = { claude: ['claude-opus-5', 'landed-first'], codex: [], agy: [] };
    const before = inst.workspace;
    const revisionBefore = modelsLayerRevision(inst.workspace);

    const { ack, writes } = await commit(
      inst,
      commitCommand(deltaFromPlan(plan), revisionOf(plan))
    );

    expect(ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(ack.result).toMatchObject({ currentRevision: revisionBefore });
    expect(writes).toBe(0);
    expect(inst.workspace).toBe(before);
    expect(modelsLayerRevision(inst.workspace)).toBe(revisionBefore);
  });
});

describe('Feature 096 — import-confirm: a matching revision merges only the import-outcome rows (contracts §4 steps 4-5)', () => {
  it('merges the delta into the current catalog and reports the merged revision', async () => {
    const inst = installation({ claude: ['claude-opus-5'] });
    const plan = await planFor(inst, MODEL_CATALOG_DOCUMENT);

    const { ack, writes } = await commit(
      inst,
      commitCommand(deltaFromPlan(plan), revisionOf(plan))
    );

    expect(ack).toMatchObject({ status: 'accepted' });
    expect(writes).toBe(1);
    expect(inst.workspace).toEqual({ claude: ['claude-opus-5', 'claude-sonnet-5'], codex: [], agy: [] });
    expect(ack.result).toEqual({
      revision: modelsLayerRevision(inst.workspace),
      mutation: 'import-package'
    });
  });

  it('preserves a delta entry\'s exact whitespace through the commit re-plan (data-model.md: no whitespace-trimming)', async () => {
    // A hand-authored document may carry a double-quoted model id with
    // meaningful surrounding whitespace; two ids differing only by
    // whitespace are distinct entries (spec Edge Cases), so preflight
    // classifies it byte-for-byte against the raw parsed document. The
    // commit's own re-plan (step 4) must classify that same delta the same
    // way, or an entry the preview showed as "will be imported" can vanish
    // (reclassified as already-exists) instead of landing as authored.
    const inst = installation();
    const document = [
      'apiVersion: schegent/v1',
      'kind: ModelCatalog',
      'groups:',
      '  - backend: claude',
      '    models:',
      '      - "  padded-model  "',
      ''
    ].join('\n');
    const plan = await planFor(inst, document);

    const { ack, writes } = await commit(
      inst,
      commitCommand(deltaFromPlan(plan), revisionOf(plan))
    );

    expect(ack).toMatchObject({ status: 'accepted' });
    expect(writes).toBe(1);
    expect(inst.workspace).toEqual({ claude: ['  padded-model  '], codex: [], agy: [] });
  });

  it('does not duplicate a delta entry the current catalog already holds (defense-in-depth re-plan, FR-016)', async () => {
    // A well-behaved client only ever puts `import`-outcome rows in the delta
    // (`modelsDeltaByBackend` groups nothing else), so this delta is
    // hand-built to simulate one that did not. The revision gate cannot catch
    // it — nothing about the layer changed — so the server's own re-plan
    // (step 4) is the only thing standing between this and a duplicated id.
    const inst = installation({ claude: ['claude-opus-5'] });
    const revision = modelsLayerRevision(inst.workspace);

    const { ack, writes } = await commit(
      inst,
      commitCommand({ claude: ['claude-opus-5', 'claude-sonnet-5'] }, revision)
    );

    expect(ack).toMatchObject({ status: 'accepted' });
    expect(writes).toBe(1);
    expect(inst.workspace).toEqual({ claude: ['claude-opus-5', 'claude-sonnet-5'], codex: [], agy: [] });
  });
});

describe('Feature 096 — import-confirm: a write failure commits nothing (contracts §4 step 6)', () => {
  it('rejects with persistence-failed and leaves the catalog untouched', async () => {
    const inst = installation({ claude: ['claude-opus-5'] });
    const plan = await planFor(inst, MODEL_CATALOG_DOCUMENT);
    const before = inst.workspace;

    const { ack, writes } = await commit(
      inst,
      commitCommand(deltaFromPlan(plan), revisionOf(plan)),
      { writeThrows: new Error('EACCES: settings.json is read-only') }
    );

    expect(ack).toMatchObject({ status: 'rejected', reason: 'persistence-failed' });
    expect(writes).toBe(1);
    expect(inst.workspace).toBe(before);
  });
});
