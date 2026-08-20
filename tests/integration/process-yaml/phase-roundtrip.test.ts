// Feature 084 T042 — the loop closes.
//
// QS-37: export a Phase carrying every portable field, import the document into
// a clean installation, export the same id again — byte-identical. This is the
// end-to-end statement of SC-003, and the only test that exercises all four
// commands over one document. It is also what makes the `import` mutation intent
// observable as a requirement rather than a preference: a `create` renumbers the
// version to 1, and the second document then differs by one line.
//
// QS-38: nothing links the imported Phase to the file it came from. The document
// is read exactly once, and the bytes on the harness's "disk" are rewritten after
// the commit to prove that a later read is not happening.
//
// Feature 099 (T496f, FR-042) — an installation is one catalog per kind rather
// than a user/workspace pair, so the commit no longer picks a target. Both claims
// are unchanged: the loop still has to close byte-for-byte, and the imported row
// still has to carry nothing that points back at the file.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/phase-roundtrip' },
    name: 'phase-roundtrip',
    index: 0
  })
}));

import { CMD_EXPORT_PROCESS_YAML, CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ExportProcessYamlResult,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand } from '../../../src/ui/sidebar/messages';
import { FakeCatalogStore } from '../../fixtures/fake-catalog-store';

/** One installation: the Phase catalog it holds. Nothing else persists. */
function installation(phases: readonly unknown[] = []): FakeCatalogStore {
  return new FakeCatalogStore({ phases });
}

/** The Phase catalog exactly as stored. */
function stored(store: FakeCatalogStore): readonly unknown[] {
  return store.rowsOf('phase');
}

/**
 * Every portable field at once, with an authored `version` that is not 1 so a
 * renumbering commit would be visible in the second document, and a
 * `retryCondition` because FR-012 names it as the field most likely to be
 * dropped on the way through.
 */
const EVERY_PORTABLE_FIELD = Object.freeze({
  phaseId: 'round-trip',
  name: 'Round Trip',
  version: 6,
  description: 'Carries every portable field.',
  instruction: 'Do the whole thing, carefully.',
  runner: 'claude',
  model: 'claude-opus-5',
  effort: 'high',
  timeoutSeconds: 1200,
  loopable: true,
  isRequired: false,
  retryCondition: 'open_questions > 0'
});

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
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

/** Export `resourceId` from `store` and return the document text. */
async function exportDocument(store: FakeCatalogStore, resourceId: string): Promise<string> {
  const saved: string[] = [];
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      saveProcessYamlDocument: async (request: { suggestedFileName: string; text: string }) => {
        saved.push(request.text);
        return { outcome: 'saved' } as Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>;
      },
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'roundtrip-export'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: ExportProcessYamlCommand = {
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: 'roundtrip-export',
    payload: { resourceKind: 'phase', resourceId }
  };
  await exportHandler(ctx, command);
  expect(acks[0]?.status, JSON.stringify(acks[0]?.result)).toBe('accepted');
  expect(saved).toHaveLength(1);
  return saved[0]!;
}

/**
 * A document on the harness's "disk". `text` is mutable so a test can rewrite
 * the source after a commit; `reads` counts every time a handler asked for it.
 */
interface SourceFile {
  text: string;
  reads: number;
}

/** Preflight `file` against `store`, returning the plan. */
async function preflight(store: FakeCatalogStore, file: SourceFile) {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      catalogStore: store,
      refreshCatalog: async () => undefined,
      openProcessYamlDocument: async () => {
        file.reads += 1;
        return { outcome: 'read' as const, bytes: bytes(file.text) };
      },
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'roundtrip-preflight'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: 'roundtrip-preflight',
    payload: {}
  };
  await preflightHandler(ctx, command);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome, JSON.stringify(result)).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

/**
 * Commit the plan's single import row. This is the request the webview builds;
 * its construction is pinned as pure logic in
 * `webview-ui/src/components/__tests__/process-import-state.test.ts`.
 */
async function commit(
  store: FakeCatalogStore,
  plan: Awaited<ReturnType<typeof preflight>>
): Promise<CommandAckMessage> {
  const row = plan.rows.find(
    (candidate) => candidate.outcome === 'import' && candidate.resourceKind === 'phase'
  );
  expect(row?.outcome).toBe('import');
  if (row?.outcome !== 'import' || row.resourceKind !== 'phase') {
    throw new Error('unreachable');
  }
  const { phaseId, ...declared } = row.definition;

  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      catalogStore: store,
      refreshCatalog: async () => undefined,
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'roundtrip-commit'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: SavePhasesCommand = {
    type: CMD_SAVE_PHASES,
    correlationId: 'roundtrip-commit',
    payload: {
      expectedRevision: plan.computedAgainstRevision,
      mutation: { kind: 'import', phaseId },
      phases: [...stored(store), { id: phaseId, ...declared }]
    }
  };
  await saveHandler(ctx, command);
  expect(acks[0]?.status, JSON.stringify(acks[0]?.result)).toBe('accepted');
  return acks[0]!;
}

beforeEach(() => capabilities.clear());

describe('Feature 084 QS-37 — export, import, export is byte-identical', () => {
  it('closes the loop with every portable field carried, retryCondition included', async () => {
    const source = installation([EVERY_PORTABLE_FIELD]);
    const first = await exportDocument(source, 'round-trip');
    // Every portable field really is in the document, so a byte comparison of
    // two empty-ish documents cannot pass this test vacuously.
    for (const key of [
      'phaseId',
      'name',
      'version',
      'description',
      'instruction',
      'runner',
      'model',
      'effort',
      'timeoutSeconds',
      'loopable',
      'isRequired',
      'retryCondition'
    ]) {
      expect(first, `${key} must be in the exported document`).toContain(`${key}:`);
    }

    const destination = installation();
    const plan = await preflight(destination, { text: first, reads: 0 });
    await commit(destination, plan);

    const second = await exportDocument(destination, 'round-trip');
    expect(second).toBe(first);
  });

  it('would not close if the version were renumbered, which is why import is a distinct intent', async () => {
    // The negative control for the assertion above: the same loop with the
    // version reset to 1 produces a document that differs, and differs only
    // there. If `import` ever collapses back into `create`, the test above
    // fails and this one explains why.
    const source = installation([EVERY_PORTABLE_FIELD]);
    const authored = await exportDocument(source, 'round-trip');
    const renumbered = await exportDocument(
      installation([{ ...EVERY_PORTABLE_FIELD, version: 1 }]),
      'round-trip'
    );

    expect(renumbered).not.toBe(authored);
    const differing = authored
      .split('\n')
      .filter((line, index) => line !== renumbered.split('\n')[index]);
    expect(differing).toEqual(['  version: 6']);
  });
});

describe('Feature 084 QS-38 — the imported Phase has no link to the source file', () => {
  it('reads the document once and ignores every later edit to it (FR-045, SC-014)', async () => {
    const source = installation([EVERY_PORTABLE_FIELD]);
    const file: SourceFile = { text: await exportDocument(source, 'round-trip'), reads: 0 };

    const destination = installation();
    const plan = await preflight(destination, file);
    await commit(destination, plan);

    const afterCommit = JSON.stringify(stored(destination));
    const revisionAfterCommit = destination.revisionOf('phase');
    const exportedAfterCommit = await exportDocument(destination, 'round-trip');

    // The operator edits the file they imported from. On a design that kept a
    // reference, this is the change that would leak through.
    file.text = file.text
      .replace('name: Round Trip', 'name: Edited After Import')
      .replace('version: 6', 'version: 99')
      .replace('timeoutSeconds: 1200', 'timeoutSeconds: 30');

    expect(JSON.stringify(stored(destination))).toBe(afterCommit);
    expect(destination.revisionOf('phase')).toBe(revisionAfterCommit);
    expect(await exportDocument(destination, 'round-trip')).toBe(exportedAfterCommit);
    // One read, at preflight. No re-read at commit, and none since.
    expect(file.reads).toBe(1);
  });

  it('stores no path, file name, or format marker on the imported row (FR-045)', async () => {
    const source = installation([EVERY_PORTABLE_FIELD]);
    const file: SourceFile = { text: await exportDocument(source, 'round-trip'), reads: 0 };

    const destination = installation();
    await commit(destination, await preflight(destination, file));

    const persisted = stored(destination)[0] as Record<string, unknown>;
    // Exactly the portable set, under the catalog's own identity key.
    expect(Object.keys(persisted).sort()).toEqual([
      'description',
      'effort',
      'id',
      'instruction',
      'isRequired',
      'loopable',
      'model',
      'name',
      'retryCondition',
      'runner',
      'timeoutSeconds',
      'version'
    ]);
    const serialized = JSON.stringify(stored(destination));
    for (const marker of ['.yaml', '.phase', 'apiVersion', 'schegent/v1', '/tmp', 'sourcePath']) {
      expect(serialized, `${marker} must not be persisted`).not.toContain(marker);
    }
  });
});
