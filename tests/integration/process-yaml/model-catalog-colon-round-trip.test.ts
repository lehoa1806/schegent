// Feature 254 (FR-R4-F07, Q-T2; contract Q5; FR-009, US2 AS1, SC-004) — the product's own Model Catalog
// export imports back, including a model id shaped like `ollama:llama3`.
//
// The filing's defect, end to end: a Model Catalog naming `ollama:llama3` was exported as the plain
// sequence item `- ollama:llama3`, which the scanner reads as the start of a mapping and refuses
// (`disallowed-syntax`). So the export of an operator's own catalog could not be imported, and the
// refusal named a line the operator never wrote. The exporter now writes that item double-quoted.
//
// The path is the production one, with only the dialog and the catalog fakes replaced:
//
//   export (selectProcessExportDocument) -> preflight (the sidebar handler) -> commit (the Model
//   Catalog save handler) -> the stored models.
//
// The control case, a catalog naming only `llama3`, is green at baseline: it proves the harness
// imports a Model Catalog at all, so the colon case failing is the colon's doing.

import { describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/model-catalog-colon-round-trip' },
    name: 'model-catalog-colon-round-trip',
    index: 0
  })
}));

import { CMD_PREFLIGHT_PROCESS_YAML, CMD_SAVE_MODELS } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  SaveModelsCommand
} from '../../../src/contracts/sidebar-ipc';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';
import { selectProcessExportDocument } from '../../../src/services/process-yaml/export-service';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveModelsHandler } from '../../../src/ui/sidebar/commands/cmd-save-models';
import { FIXTURE_REVISION } from '../../fixtures/catalog-snapshot-fixture';

const CORRELATION = 'model-catalog-colon-1';

type ModelsConfig = Record<string, readonly string[]>;

/** A fresh installation's Model Catalog: every backend, no models. */
function emptyModels(): ModelsConfig {
  return Object.fromEntries(SUPPORTED_BACKENDS.map((backend) => [backend, [] as readonly string[]]));
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

/** The exported Model Catalog document, from an installation holding `models`. */
function exportedText(models: ModelsConfig): string {
  const selection = selectProcessExportDocument(
    {
      readModelsConfig: () => models,
      logger: { sanitize: (value: string) => value, warn: () => undefined }
    },
    { resourceKind: 'modelCatalog' }
  );
  if (selection.outcome !== 'resolved') throw new Error(`export did not resolve: ${selection.reason}`);
  return selection.text;
}

/** The deps both handlers read: an empty catalog store and the destination's Model Catalog. */
function readDeps(destination: { models: ModelsConfig }) {
  const empty = () => ({ rows: [], revision: FIXTURE_REVISION, ids: new Set<string>() });
  return {
    readPhaseConfig: empty,
    readPipelineConfig: empty,
    readWorkflowConfig: empty,
    readModelsConfig: () => destination.models,
    audit: { append: async () => undefined },
    logger: logger()
  };
}

/** Preflight the document through the sidebar handler, reporting the refusal as the failure. */
async function planFor(destination: { models: ModelsConfig }, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...readDeps(destination),
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(text, 'utf8'))
      })
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;
  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(
    result.outcome,
    result.outcome === 'refused' ? `${result.refusal.code}: ${result.refusal.message}` : ''
  ).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

/** The `import` rows of a Model Catalog plan, grouped by backend. */
function modelDelta(plan: ImportPlan): Record<string, readonly string[]> {
  const delta: Record<string, string[]> = {};
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'modelCatalog') {
      (delta[row.backend] ??= []).push(row.modelId);
    }
  }
  return delta;
}

/** Confirm the plan through the Model Catalog save handler, which writes into `destination`. */
async function commit(destination: { models: ModelsConfig }, plan: ImportPlan): Promise<void> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...readDeps(destination),
      readConfig: () => undefined,
      updateConfig: async (key: string, value: unknown) => {
        if (key !== 'models') throw new Error(`unexpected settings write: ${key}`);
        destination.models = value as ModelsConfig;
      },
      executeCommand: vi.fn()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;
  const revision = plan.computedAgainstModelsRevision;
  expect(revision).toBeDefined();
  await saveModelsHandler(ctx, {
    type: CMD_SAVE_MODELS,
    correlationId: CORRELATION,
    payload: {
      models: modelDelta(plan),
      expectedRevision: revision!,
      mutation: { kind: 'import-package' }
    }
  } as SaveModelsCommand);
  expect(acks).toHaveLength(1);
  expect(acks[0]!.status).toBe('accepted');
}

describe('Feature 254 — a Model Catalog export imports back (Q-T2, Q5, US2 AS1, SC-004)', () => {
  it('stores ollama:llama3 and llama3 exactly, from the product\'s own export', async () => {
    const source: ModelsConfig = { ...emptyModels(), agy: ['ollama:llama3', 'llama3'] };
    const text = exportedText(source);

    const destination = { models: emptyModels() };
    const plan = await planFor(destination, text);
    await commit(destination, plan);

    expect(destination.models.agy).toEqual(['ollama:llama3', 'llama3']);
  });

  it('plans one import row per model, with the model id unchanged', async () => {
    const source: ModelsConfig = { ...emptyModels(), agy: ['ollama:llama3', 'llama3'] };
    const plan = await planFor({ models: emptyModels() }, exportedText(source));
    expect(modelDelta(plan)).toEqual({ agy: ['ollama:llama3', 'llama3'] });
  });

  it('control: a catalog naming only llama3 imports (green at baseline)', async () => {
    const source: ModelsConfig = { ...emptyModels(), agy: ['llama3'] };
    const destination = { models: emptyModels() };
    const plan = await planFor(destination, exportedText(source));
    await commit(destination, plan);
    expect(destination.models.agy).toEqual(['llama3']);
  });
});
