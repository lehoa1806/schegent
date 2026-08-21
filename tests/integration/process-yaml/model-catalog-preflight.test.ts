// Feature 096 T019 — Model Catalog preflight, end to end through the sidebar
// command shared with Phase/Pipeline/Workflow (FR-055a: the request carries no
// resource kind, the document's declared `kind: ModelCatalog` is what routes
// it to `planModelCatalogImport`).
//
// `pipeline-preflight.test.ts` is the mirror this harness follows. Two things
// are specific to this kind rather than restated from it:
//
//   1. There is no layer split to report. `computedAgainstPipelineRevision`
//      and `computedAgainstWorkflowRevision` are absent from every Pipeline/
//      Workflow plan's OWN fields, but a ModelCatalog plan must not carry
//      either of them either — and it carries `computedAgainstModelsRevision`
//      instead, which no other kind's plan has (data-model.md Decision 6).
//   2. Row classification is plan-time, not document-level: an unrecognized
//      backend skips a row rather than refusing the document (contracts §2),
//      which T018 pins at the planner unit; this pins it through the whole
//      command.

import { describe, expect, it, vi } from 'vitest';

import { modelsLayerRevision } from '../../../src/config/model-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { FakeCatalogStore, NO_WRITES, writesOf } from '../../fixtures/fake-catalog-store';

type OpenResult =
  | { outcome: 'read'; bytes: Uint8Array }
  | { outcome: 'canceled' }
  | { outcome: 'failed'; message: string };

/**
 * Seeded so a plan's revision can be asserted against a value this file names,
 * rather than against whatever the read happened to return.
 */
const SEEDED_PHASE_REVISION = 'rev-phase-preflight-seed';

interface Harness {
  readonly ctx: Parameters<typeof preflightHandler>[0];
  readonly acks: CommandAckMessage[];
  readonly store: FakeCatalogStore;
  readonly updateConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
}

function buildHarness(
  opts: {
    text?: string;
    models?: Record<string, readonly string[]>;
    withModelsReader?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const store = new FakeCatalogStore({ revisions: { phase: SEEDED_PHASE_REVISION } });
  const updateConfig = vi.fn();
  const executeCommand = vi.fn();

  const openProcessYamlDocument = async (): Promise<OpenResult> => ({
    outcome: 'read',
    bytes: new Uint8Array(Buffer.from(opts.text ?? '', 'utf8'))
  });

  const ctx = {
    deps: {
      readPhaseConfig: () => ({ rows: [], revision: store.revisionOf('phase') }),
      ...(opts.withModelsReader === false ? {} : { readModelsConfig: () => opts.models ?? {} }),
      catalogStore: store,
      refreshCatalog: async () => undefined,
      updateConfig,
      executeCommand,
      openProcessYamlDocument,
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
    correlationId: 'model-catalog-preflight-1'
  } as any;

  return { ctx, acks, store, updateConfig, executeCommand };
}

/** No resource kind, no scope, no bytes — the document says what it is. */
const COMMAND: PreflightProcessYamlCommand = Object.freeze({
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'model-catalog-preflight-1',
  payload: {}
});

function resultOf(h: Harness): PreflightProcessYamlResult {
  expect(h.acks).toHaveLength(1);
  return h.acks[0]!.result as PreflightProcessYamlResult;
}

async function preflight(opts: Parameters<typeof buildHarness>[0]): Promise<{
  readonly harness: Harness;
  readonly result: PreflightProcessYamlResult;
}> {
  const harness = buildHarness(opts);
  await preflightHandler(harness.ctx, COMMAND);
  return { harness, result: resultOf(harness) };
}

const MODEL_CATALOG_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: ModelCatalog',
  'groups:',
  '  - backend: claude',
  '    models:',
  '      - claude-opus-5',
  '      - claude-sonnet-5',
  '  - backend: codex',
  '    models:',
  '      - gpt-6-codex',
  '  - backend: unknown-backend',
  '    models:',
  '      - foo-model',
  ''
].join('\n');

describe('Feature 096 — Model Catalog preflight dispatches on the declared kind (FR-055a)', () => {
  it('routes a ModelCatalog document to the modelCatalog path', async () => {
    const { result } = await preflight({ text: MODEL_CATALOG_DOCUMENT });

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows.every((row) => row.resourceKind === 'modelCatalog')).toBe(true);
  });

  it('writes nothing while planning a Model Catalog import', async () => {
    const { harness } = await preflight({ text: MODEL_CATALOG_DOCUMENT });

    expect(writesOf(harness.store)).toEqual(NO_WRITES);
    expect(harness.updateConfig).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });
});

describe('Feature 096 — Model Catalog import row classification (contracts §2)', () => {
  it('imports a new id, skips one already present, and skips one under an unrecognized backend', async () => {
    const { result } = await preflight({
      text: MODEL_CATALOG_DOCUMENT,
      models: { claude: ['claude-opus-5'], codex: [], agy: [] }
    });

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(result.plan.rows).toEqual([
      {
        outcome: 'skip',
        resourceKind: 'modelCatalog',
        resourceId: 'claude-opus-5',
        backend: 'claude',
        modelId: 'claude-opus-5',
        reason: 'already-exists'
      },
      {
        outcome: 'import',
        resourceKind: 'modelCatalog',
        resourceId: 'claude-sonnet-5',
        backend: 'claude',
        modelId: 'claude-sonnet-5'
      },
      {
        outcome: 'import',
        resourceKind: 'modelCatalog',
        resourceId: 'gpt-6-codex',
        backend: 'codex',
        modelId: 'gpt-6-codex'
      },
      {
        outcome: 'skip',
        resourceKind: 'modelCatalog',
        resourceId: 'foo-model',
        backend: 'unknown-backend',
        modelId: 'foo-model',
        reason: 'unrecognized-backend'
      }
    ]);
  });

  it('counts one bucket per outcome, summing to the row count (FR-028)', async () => {
    const { result } = await preflight({
      text: MODEL_CATALOG_DOCUMENT,
      models: { claude: ['claude-opus-5'], codex: [], agy: [] }
    });

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const { counts, rows } = result.plan;
    expect(counts.import + counts.skip + counts.blocked + counts.invalid).toBe(rows.length);
    expect(counts).toEqual({ import: 2, skip: 2, blocked: 0, invalid: 0 });
  });

  it('plans against an empty catalog when no models reader is wired', async () => {
    const { result } = await preflight({ text: MODEL_CATALOG_DOCUMENT, withModelsReader: false });

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    // No prior config to collide with, so nothing is already-exists; the
    // unrecognized backend still skips (that check needs no reader at all).
    expect(result.plan.rows.map((row) => row.outcome)).toEqual(['import', 'import', 'import', 'skip']);
  });
});

describe("Feature 096 — a ModelCatalog plan carries the models layer's own revision", () => {
  it('reports computedAgainstRevision and computedAgainstModelsRevision, and omits the Pipeline/Workflow fields', async () => {
    const models = { claude: ['claude-opus-5'], codex: [], agy: [] };
    const { result } = await preflight({ text: MODEL_CATALOG_DOCUMENT, models });

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(Object.keys(result.plan).sort()).toEqual(
      ['rows', 'counts', 'computedAgainstRevision', 'computedAgainstModelsRevision'].sort()
    );
    // Feature 099 (FR-042) — the Phase catalog reports one revision, not a map of
    // layer names. The Model catalog is out of scope for that collapse and keeps
    // its own layer revision, asserted exactly below.
    expect(result.plan.computedAgainstRevision).toBe(SEEDED_PHASE_REVISION);
    // The exact revision the config layer would compute from the same input,
    // not merely a non-empty string — a stale-looking token would still pass
    // a weaker assertion.
    expect(result.plan.computedAgainstModelsRevision).toBe(modelsLayerRevision(models));
  });

  it('changes when the configured catalog differs', async () => {
    const a = await preflight({ text: MODEL_CATALOG_DOCUMENT, models: { claude: [], codex: [], agy: [] } });
    const b = await preflight({
      text: MODEL_CATALOG_DOCUMENT,
      models: { claude: ['claude-opus-5'], codex: [], agy: [] }
    });

    if (a.result.outcome !== 'planned' || b.result.outcome !== 'planned') {
      throw new Error('expected both preflights to plan');
    }
    expect(a.result.plan.computedAgainstModelsRevision).not.toBe(
      b.result.plan.computedAgainstModelsRevision
    );
  });
});

describe('Feature 096 — a ModelCatalog document refusal survives the whole command path', () => {
  const MISSING_BACKEND = [
    'apiVersion: schegent/v1',
    'kind: ModelCatalog',
    'groups:',
    '  - models:',
    '      - m1',
    ''
  ].join('\n');

  it('refuses a group missing backend, with no plan', async () => {
    const { harness, result } = await preflight({ text: MISSING_BACKEND });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.code).toBe('disallowed-syntax');
    expect(Object.keys(result).sort()).toEqual(['outcome', 'refusal']);
    expect(harness.acks[0]!.status).toBe('rejected');
    expect(harness.acks[0]!.reason).toBe('refused');
  });

  it('writes nothing, because a refusal never reaches a save', async () => {
    const { harness } = await preflight({ text: MISSING_BACKEND });
    expect(writesOf(harness.store)).toEqual(NO_WRITES);
    expect(harness.updateConfig).not.toHaveBeenCalled();
  });
});
