// FR-R6-F05 US3 (T033, T035, T036; FR-013..FR-015, F05-AC-06) — legacy catalog residue.
//
// Each case builds a real `.schegent/catalog/` under a temp workspace: a manifest naming one
// published version, a version-before-manifest record the manifest does not name (the residue a
// crashed save leaves), and a second unnamed record a frozen consumer still reads. The service
// classifies, previews, quarantines, reconciles, previews re-import and purges; no case may write
// the manifest or synthesize a pointer, so every case ends by comparing the manifest bytes.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  LegacyCatalogConsumer,
  LegacyCatalogVersionRef
} from '../../../src/contracts/artifact-lifecycle/legacy-preservation-types';
import type { CatalogFsPort, Digest } from '../../../src/catalog/ports';
import { contentHashOf } from '../../../src/catalog/content-hash';
import { createCatalogFsAdapter } from '../../../src/host-services/catalog-fs-adapter';
import {
  createLegacyPreservation,
  type LegacyPreservation,
  type LegacyPreservationDependencies
} from '../../../src/services/artifact-lifecycle/legacy-preservation';
import {
  createNodeLegacyPreservationFs,
  type LegacyPreservationFs
} from '../../../src/services/artifact-lifecycle/legacy-preservation-fs';
import type { LifecycleAuditRecord } from '../../../src/services/artifact-lifecycle/mutation-authority';
import { PreviewStore } from '../../../src/services/artifact-lifecycle/previews';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactLifecycleService,
  type LegacyCatalogDependencies
} from '../../../src/services/artifact-lifecycle';
import {
  AtomicTransactionUnitsService,
  BoundedReadConnectionPool,
  CatalogConfigStoreAdapter,
  CutoverAuthorityGuard,
  importLegacyCatalogIntoSqlite,
  MigrationCoordinator,
  NodeSqliteConnection,
  queryLegacySourceStanding,
  SchemaBootstrapService,
  SqliteApplicationStore,
  WriterCoordinator
} from '../../../src/services/sqlite-store';
import { FULL, NOW } from './lifecycle-fixture';

const digest: Digest = {
  sha256: (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
};

const CATALOG = ['.schegent', 'catalog'] as const;
const PUBLISHED_BODY = { name: 'alpha', steps: ['one'] };
const RESIDUE_BODY = { name: 'alpha', steps: ['one', 'two'] };
const FROZEN_BODY = { name: 'beta', steps: ['frozen'] };
const RESIDUE_ID = 'residue:phase:alpha:v2';
const FROZEN_RESIDUE_ID = 'residue:phase:beta:v1';

let workspace = '';
let catalogDir = '';

function hashOf(body: unknown): string {
  const hashed = contentHashOf(body, digest);
  if (hashed.outcome !== 'hashed') throw new Error('fixture body must hash');
  return hashed.contentHash;
}

function recordText(id: string, versionId: string, body: unknown): string {
  return `${JSON.stringify({ versionId, kind: 'phase', id, body }, null, 2)}\n`;
}

function manifestText(versions: readonly { versionId: string; body: unknown }[]): string {
  const entry = {
    kind: 'phase',
    id: 'alpha',
    draftVersionId: null,
    activeVersionId: 'v1',
    createdAt: NOW,
    updatedAt: NOW,
    versions: versions.map((version) => ({
      versionId: version.versionId,
      contentHash: hashOf(version.body),
      createdAt: NOW,
      publishedAt: NOW,
      note: null
    }))
  };
  return `${JSON.stringify({ storeFormatVersion: 1, entries: [entry] }, null, 2)}\n`;
}

async function writeCatalogFile(segments: readonly string[], text: string): Promise<void> {
  const target = path.join(catalogDir, ...segments);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

const residuePath = (): string => path.join(catalogDir, 'phases', 'alpha', 'v2.json');
const frozenPath = (): string => path.join(catalogDir, 'phases', 'beta', 'v1.json');
const manifestPath = (): string => path.join(catalogDir, 'manifest.json');

async function quarantinedCopies(): Promise<readonly string[]> {
  const root = path.join(workspace, '.schegent', 'quarantine');
  if (!(await exists(root))) return [];
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(root);
  return found;
}

/** A catalog fs whose writers fail the test: the service must never call a catalog layer writer. */
function readOnlyCatalog(inner: CatalogFsPort): CatalogFsPort {
  const forbidden = (): never => {
    throw new Error('catalog writer called');
  };
  return {
    readFile: (at) => inner.readFile(at),
    listDirectory: (at) => inner.listDirectory(at),
    checkWritability: () => inner.checkWritability(),
    writeFileAtomic: forbidden,
    writeFileIfAbsent: forbidden,
    removeFile: forbidden
  };
}

interface Harness {
  readonly service: LegacyPreservation;
  readonly conn: NodeSqliteConnection;
  readonly audits: LifecycleAuditRecord[];
  readonly consumers: Map<string, LegacyCatalogConsumer[]>;
}

let previewSequence = 0;

const refKey = (ref: LegacyCatalogVersionRef): string => `${ref.kind}:${ref.id}:${ref.versionId}`;

function harness(files?: LegacyPreservationFs, conn?: NodeSqliteConnection): Harness {
  const connection = conn ?? new NodeSqliteConnection({ databasePath: ':memory:' });
  if (conn === undefined) SchemaBootstrapService.bootstrapAndMigrate(connection, () => NOW);
  const audits: LifecycleAuditRecord[] = [];
  const consumers = new Map<string, LegacyCatalogConsumer[]>([['phase:beta:v1', [{ kind: 'frozen' }]]]);
  let operations = 0;
  const deps: LegacyPreservationDependencies = {
    conn: connection,
    nowMs: () => NOW,
    newId: () => `op-${(operations += 1)}`,
    // Module-wide: a restarted harness shares the connection, so preview ids must not repeat.
    previews: new PreviewStore(connection, () => NOW, () => `preview-${(previewSequence += 1)}`),
    audit: { recordLifecycleMutation: (record) => audits.push(record) },
    catalogRoot: {
      catalog: readOnlyCatalog(createCatalogFsAdapter({ workspaceRoot: workspace, storeRoot: catalogDir })),
      digest,
      segments: CATALOG
    },
    files: files ?? createNodeLegacyPreservationFs(workspace),
    consumers: { consumersOf: (ref) => consumers.get(refKey(ref)) ?? [] }
  };
  return { service: createLegacyPreservation(deps), conn: connection, audits, consumers };
}

async function previewIdFor(service: LegacyPreservation): Promise<string> {
  const classification = await service.classifyLegacyCatalogResidue();
  const preview = await service.previewLegacyQuarantine(classification.basisRevision);
  if (!preview.ok) throw new Error(`preview refused: ${preview.refusal.code}`);
  return preview.value.previewId;
}

function refusalOf(result: { ok: boolean; refusal?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.refusal?.code;
}

let manifestBefore = Buffer.alloc(0);

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f05-legacy-')));
  catalogDir = path.join(workspace, ...CATALOG);
  await writeCatalogFile(['manifest.json'], manifestText([{ versionId: 'v1', body: PUBLISHED_BODY }]));
  await writeCatalogFile(['phases', 'alpha', 'v1.json'], recordText('alpha', 'v1', PUBLISHED_BODY));
  await writeCatalogFile(['phases', 'alpha', 'v2.json'], recordText('alpha', 'v2', RESIDUE_BODY));
  await writeCatalogFile(['phases', 'beta', 'v1.json'], recordText('beta', 'v1', FROZEN_BODY));
  manifestBefore = await fs.readFile(manifestPath());
});

afterEach(async () => {
  // No manifest write and no synthesized pointer, whatever the case did.
  expect(await fs.readFile(manifestPath())).toEqual(manifestBefore);
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('classifyLegacyCatalogResidue (T033)', () => {
  it('reports the manifest generation, the published version and the residue with its consumers', async () => {
    const { service } = harness();
    const classification = await service.classifyLegacyCatalogResidue();

    expect(classification.manifestState).toBe('read');
    expect(classification.manifestGeneration).toBe(
      `sha256:${createHash('sha256').update(manifestBefore).digest('hex')}`
    );
    expect(classification.versions).toEqual([
      expect.objectContaining({
        kind: 'phase',
        id: 'alpha',
        versionId: 'v1',
        contentHash: hashOf(PUBLISHED_BODY),
        pointers: ['active'],
        disposition: 'published'
      })
    ]);
    const byId = new Map(classification.residue.map((entry) => [entry.residueId, entry]));
    expect(byId.get(RESIDUE_ID)).toEqual(
      expect.objectContaining({ versionId: 'v2', disposition: 'unresolved', outcome: 'preserved-in-place', consumers: [] })
    );
    expect(byId.get(RESIDUE_ID)?.digest).toBe(
      `sha256:${createHash('sha256').update(await fs.readFile(residuePath())).digest('hex')}`
    );
    expect(byId.get(FROZEN_RESIDUE_ID)).toEqual(
      expect.objectContaining({ disposition: 'protected', consumers: [{ kind: 'frozen' }] })
    );
  });

  it('never classifies anything as disposable, and moves no file by default', async () => {
    const { service } = harness();
    const classification = await service.classifyLegacyCatalogResidue();
    const dispositions = [...classification.versions, ...classification.residue].map((entry) => entry.disposition);
    expect(dispositions).not.toContain('disposable');
    expect(new Set(classification.residue.map((entry) => entry.outcome))).toEqual(new Set(['preserved-in-place']));
    expect(await exists(residuePath())).toBe(true);
    expect(await exists(frozenPath())).toBe(true);
    expect(await quarantinedCopies()).toEqual([]);
  });
});

describe('quarantineLegacyResidue (T033)', () => {
  it('refuses a stale preview and moves nothing', async () => {
    const { service } = harness();
    const previewId = await previewIdFor(service);
    await writeCatalogFile(['phases', 'alpha', 'v3.json'], recordText('alpha', 'v3', RESIDUE_BODY));

    const result = await service.quarantineLegacyResidue({ previewId, confirmation: 'confirmed', authority: FULL });

    expect(refusalOf(result)).toBe('preview-stale');
    expect(await exists(residuePath())).toBe(true);
    expect(await quarantinedCopies()).toEqual([]);
  });

  it('refuses a preview taken against a different source revision', async () => {
    const { service } = harness();
    expect(refusalOf(await service.previewLegacyQuarantine('not-the-current-revision'))).toBe('preview-stale');
  });

  it('applies the gate in order: authority, preview, confirmation', async () => {
    const { service, audits } = harness();
    const previewId = await previewIdFor(service);
    const untrusted = await service.quarantineLegacyResidue({
      previewId,
      confirmation: 'confirmed',
      authority: { ...FULL, trusted: false }
    });
    expect(refusalOf(untrusted)).toBe('untrusted-workspace');
    const unconfirmed = await service.quarantineLegacyResidue({ previewId, confirmation: undefined, authority: FULL });
    expect(refusalOf(unconfirmed)).toBe('confirmation-required');
    const missing = await service.quarantineLegacyResidue({ previewId: 'nope', confirmation: 'confirmed', authority: FULL });
    expect(refusalOf(missing)).toBe('preview-required');
    expect(audits).toEqual([]);
    expect(await exists(residuePath())).toBe(true);
  });

  it('refuses a referenced version and leaves it in place', async () => {
    const { service } = harness();
    const previewId = await previewIdFor(service);
    const result = await service.quarantineLegacyResidue({
      previewId,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [FROZEN_RESIDUE_ID]
    });
    expect(refusalOf(result)).toBe('protected-reference');
    expect(await exists(frozenPath())).toBe(true);
    expect(await quarantinedCopies()).toEqual([]);
  });

  it('copies, verifies the digest, and only then removes the source', async () => {
    const { service, conn, audits } = harness();
    const original = await fs.readFile(residuePath());
    const previewId = await previewIdFor(service);

    const result = await service.quarantineLegacyResidue({ previewId, confirmation: 'confirmed', authority: FULL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('completed');
    expect(result.value.targets).toEqual([
      expect.objectContaining({ ordinal: 0, outcome: 'quarantined' })
    ]);
    const target = result.value.targets.at(0);
    expect(target?.destinationDigest).toBe(target?.sourceDigest);
    expect(await exists(residuePath())).toBe(false);
    expect(await exists(frozenPath())).toBe(true);
    const copies = await quarantinedCopies();
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(copies.at(0) ?? '')).toEqual(original);
    const rows = conn.all<{ outcome: string; destination_key: string | null }>(
      `SELECT outcome, destination_key FROM preservation_targets WHERE operation_id = ?`,
      result.value.operationId
    );
    expect(rows).toEqual([expect.objectContaining({ outcome: 'quarantined' })]);
    expect(rows.at(0)?.destination_key).not.toBeNull();
    expect(audits).toEqual([
      {
        operationKind: 'legacy-quarantine',
        operationId: result.value.operationId,
        counts: { quarantined: 1, ambiguous: 0, refused: 0 },
        result: 'completed'
      }
    ]);
    // The source manifest revision moved, so the same preview no longer authorizes anything.
    const again = await service.quarantineLegacyResidue({ previewId, confirmation: 'confirmed', authority: FULL });
    expect(refusalOf(again)).toBe('preview-stale');
  });

  it('leaves both files and an ambiguous outcome when interrupted after the copy, and never overwrites', async () => {
    const real = createNodeLegacyPreservationFs(workspace);
    const interrupted: LegacyPreservationFs = {
      readBytes: (segments) => real.readBytes(segments),
      writeExclusive: (segments, bytes) => real.writeExclusive(segments, bytes),
      unlinkContained: () => Promise.reject(new Error('interrupted'))
    };
    const first = harness(interrupted);
    const original = await fs.readFile(residuePath());
    const previewId = await previewIdFor(first.service);

    await expect(
      first.service.quarantineLegacyResidue({ previewId, confirmation: 'confirmed', authority: FULL })
    ).rejects.toThrow('interrupted');

    const copies = await quarantinedCopies();
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(residuePath())).toEqual(original);

    // A restart: a fresh service over the same database reconciles the half-done operation.
    const restarted = harness(undefined, first.conn);
    const reconciled = await restarted.service.reconcilePreservation('op-1');
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.value.state).toBe('ambiguous');
    expect(reconciled.value.targets).toEqual([expect.objectContaining({ outcome: 'ambiguous' })]);
    expect(await fs.readFile(residuePath())).toEqual(original);
    expect(await fs.readFile(copies.at(0) ?? '')).toEqual(original);

    // Ambiguous residue is not quarantined again until an operator resolves it.
    const retryPreview = await previewIdFor(restarted.service);
    const retry = await restarted.service.quarantineLegacyResidue({
      previewId: retryPreview,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    expect(refusalOf(retry)).toBe('ownership-unresolved');
    expect(await quarantinedCopies()).toEqual(copies);
  });

  it('never overwrites an existing destination', async () => {
    const files = createNodeLegacyPreservationFs(workspace);
    const segments = ['.schegent', 'quarantine', 'catalog', 'probe.json'];
    expect(await files.writeExclusive(segments, Buffer.from('first'))).toBe('written');
    expect(await files.writeExclusive(segments, Buffer.from('second'))).toBe('exists');
    expect(await fs.readFile(path.join(workspace, ...segments), 'utf8')).toBe('first');
  });

  it('reports an unknown operation as not-found', async () => {
    const { service } = harness();
    expect(refusalOf(await service.reconcilePreservation('op-404'))).toBe('not-found');
  });
});

describe('previewReimport (T033)', () => {
  async function quarantineResidue(h: Harness): Promise<void> {
    const previewId = await previewIdFor(h.service);
    const result = await h.service.quarantineLegacyResidue({
      previewId,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    if (!result.ok) throw new Error('quarantine refused');
  }

  it('previews a quarantined residue through the injected admission gate and writes nothing', async () => {
    const h = harness();
    await quarantineResidue(h);
    const seen: unknown[] = [];
    const preview = await h.service.previewReimport(RESIDUE_ID, {
      admits: (candidate) => {
        seen.push(candidate);
        return { ok: true, value: true };
      }
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value).toEqual(
      expect.objectContaining({ residueId: RESIDUE_ID, versionId: 'v2', contentHash: hashOf(RESIDUE_BODY), source: 'quarantine' })
    );
    expect(seen).toEqual([expect.objectContaining({ kind: 'phase', id: 'alpha', versionId: 'v2', body: RESIDUE_BODY })]);
    expect(await exists(residuePath())).toBe(false);
  });

  it('passes an admission refusal through', async () => {
    const h = harness();
    const preview = await h.service.previewReimport(RESIDUE_ID, {
      admits: () => ({ ok: false, refusal: { code: 'invalid-input', message: 'definition does not validate' } })
    });
    expect(refusalOf(preview)).toBe('invalid-input');
  });

  it('refuses identity-conflict and content-conflict against the current manifest', async () => {
    const h = harness();
    await quarantineResidue(h);
    const admits = () => ({ ok: true as const, value: true as const });

    // Another writer published v2 since; same content -> identity taken, different -> content conflict.
    await writeCatalogFile(['manifest.json'], manifestText([{ versionId: 'v1', body: PUBLISHED_BODY }, { versionId: 'v2', body: RESIDUE_BODY }]));
    expect(refusalOf(await h.service.previewReimport(RESIDUE_ID, { admits }))).toBe('identity-conflict');
    await writeCatalogFile(['manifest.json'], manifestText([{ versionId: 'v1', body: PUBLISHED_BODY }, { versionId: 'v2', body: FROZEN_BODY }]));
    expect(refusalOf(await h.service.previewReimport(RESIDUE_ID, { admits }))).toBe('content-conflict');

    // Restore the fixture manifest so the shared no-manifest-write check compares like with like.
    await fs.writeFile(manifestPath(), manifestBefore);
  });

  it('refuses an unknown residue as not-found', async () => {
    const h = harness();
    const preview = await h.service.previewReimport('residue:phase:alpha:v9', { admits: () => ({ ok: true, value: true }) });
    expect(refusalOf(preview)).toBe('not-found');
  });
});

describe('MigrationCoordinator.previewLegacyCatalog (T035)', () => {
  it('carries the classification with a preview id and staleness inputs, and writes nothing', async () => {
    const databasePath = path.join(workspace, 'store.sqlite');
    const conn = new NodeSqliteConnection({ databasePath });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
    const h = harness(undefined, conn);
    const classification = await h.service.classifyLegacyCatalogResidue();
    const snapshot = async (): Promise<readonly Buffer[]> =>
      Promise.all(
        ['', '-wal'].map(async (suffix) =>
          (await exists(databasePath + suffix)) ? fs.readFile(databasePath + suffix) : Buffer.alloc(0)
        )
      );
    const before = await snapshot();

    const coordinator = new MigrationCoordinator(conn, () => NOW);
    const section = coordinator.previewLegacyCatalog(classification);

    expect(section.section).toBe('legacy-catalog');
    expect(section.classification).toEqual(classification);
    expect(section.staleness).toEqual({
      manifestGeneration: classification.manifestGeneration,
      basisRevision: classification.basisRevision
    });
    expect(section.previewId).toMatch(/^legacy-catalog-[0-9a-f]{32}$/);
    expect(coordinator.previewLegacyCatalog(classification).previewId).toBe(section.previewId);
    expect(await snapshot()).toEqual(before);
    expect(coordinator.listStageLedger(section.previewId)).toEqual([]);
    expect(new CutoverAuthorityGuard(conn).getSentinel('workspace')).toBeUndefined();
    conn.close();
  });
});

describe('quarantine purge (T036)', () => {
  async function quarantined(h: Harness): Promise<string> {
    const previewId = await previewIdFor(h.service);
    const result = await h.service.quarantineLegacyResidue({
      previewId,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    if (!result.ok) throw new Error('quarantine refused');
    return result.value.operationId;
  }

  async function purgePreviewId(service: LegacyPreservation): Promise<string> {
    const preview = await service.previewQuarantinePurge();
    if (!preview.ok) throw new Error(`purge preview refused: ${preview.refusal.code}`);
    return preview.value.previewId;
  }

  it('refuses without a live purge preview, confirmation or authority', async () => {
    const h = harness();
    await quarantined(h);
    const quarantinePreview = await previewIdFor(h.service);
    const previewId = await purgePreviewId(h.service);

    expect(refusalOf(await h.service.purgeQuarantinedResidue({ previewId: 'nope', confirmation: 'confirmed', authority: FULL }))).toBe(
      'preview-required'
    );
    expect(
      refusalOf(await h.service.purgeQuarantinedResidue({ previewId: quarantinePreview, confirmation: 'confirmed', authority: FULL }))
    ).toBe('preview-stale');
    expect(refusalOf(await h.service.purgeQuarantinedResidue({ previewId, confirmation: undefined, authority: FULL }))).toBe(
      'confirmation-required'
    );
    expect(
      refusalOf(
        await h.service.purgeQuarantinedResidue({ previewId, confirmation: 'confirmed', authority: { ...FULL, primary: false } })
      )
    ).toBe('not-primary-window');
    expect(await quarantinedCopies()).toHaveLength(1);
  });

  it('refuses residue a consumer references', async () => {
    const h = harness();
    await quarantined(h);
    h.consumers.set('phase:alpha:v2', [{ kind: 'live' }]);
    const previewId = await purgePreviewId(h.service);
    const result = await h.service.purgeQuarantinedResidue({
      previewId,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    expect(refusalOf(result)).toBe('protected-reference');
    expect(await quarantinedCopies()).toHaveLength(1);
  });

  it('refuses residue whose preservation is still ambiguous', async () => {
    const real = createNodeLegacyPreservationFs(workspace);
    const first = harness({ ...real, unlinkContained: () => Promise.reject(new Error('interrupted')) });
    const previewId = await previewIdFor(first.service);
    await expect(
      first.service.quarantineLegacyResidue({ previewId, confirmation: 'confirmed', authority: FULL })
    ).rejects.toThrow('interrupted');
    const h = harness(undefined, first.conn);
    await h.service.reconcilePreservation('op-1');

    const purgePreview = await purgePreviewId(h.service);
    const result = await h.service.purgeQuarantinedResidue({
      previewId: purgePreview,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    expect(refusalOf(result)).toBe('ownership-unresolved');
    expect(await quarantinedCopies()).toHaveLength(1);
    expect(await exists(residuePath())).toBe(true);
  });

  it('refuses residue that was never quarantined as not-found', async () => {
    const h = harness();
    const previewId = await purgePreviewId(h.service);
    const result = await h.service.purgeQuarantinedResidue({
      previewId,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    expect(refusalOf(result)).toBe('not-found');
  });

  it('purges a quarantined copy through the contained unlink and records it', async () => {
    const h = harness();
    const quarantineOperation = await quarantined(h);
    const previewId = await purgePreviewId(h.service);

    const result = await h.service.purgeQuarantinedResidue({ previewId, confirmation: 'confirmed', authority: FULL });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(expect.objectContaining({ state: 'completed', purged: 1, refused: 0, ambiguous: 0 }));
    expect(await quarantinedCopies()).toEqual([]);
    expect(await exists(frozenPath())).toBe(true);
    const target = h.conn.get<{ outcome: string; destination_key: string | null; destination_digest: string | null }>(
      `SELECT outcome, destination_key, destination_digest FROM preservation_targets WHERE operation_id = ?`,
      quarantineOperation
    );
    expect(target).toEqual(expect.objectContaining({ outcome: 'quarantined', destination_key: null }));
    expect(target?.destination_digest).not.toBeNull();
    const operation = h.conn.get<{ state: string; preview_id: string }>(
      `SELECT state, preview_id FROM preservation_operations WHERE operation_id = ?`,
      result.value.operationId
    );
    expect(operation).toEqual({ state: 'completed', preview_id: previewId });
    expect(h.audits.at(-1)).toEqual({
      operationKind: 'legacy-quarantine',
      operationId: result.value.operationId,
      counts: { purged: 1, ambiguous: 0, refused: 0 },
      result: 'completed'
    });
    const again = await h.service.purgeQuarantinedResidue({ previewId, confirmation: 'confirmed', authority: FULL });
    expect(refusalOf(again)).toBe('preview-stale');
  });
});

describe('ArtifactLifecycleService facade (FR-021)', () => {
  function facade(legacyCatalog?: LegacyCatalogDependencies): ArtifactLifecycleService {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
    let ids = 0;
    return createArtifactLifecycleService({
      conn,
      nowMs: () => NOW,
      newId: () => `facade-${(ids += 1)}`,
      fs: {
        lstat: () => Promise.resolve(null),
        readdir: () => Promise.resolve([]),
        realpath: (at) => Promise.resolve(at),
        unlink: () => Promise.resolve()
      },
      probe: {
        observe: () => Promise.resolve({ exists: false, sizeBytes: 0, producerIdentity: null, generation: null }),
        digestSha256: () => Promise.resolve(null)
      },
      audit: { recordLifecycleMutation: () => undefined },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      ...(legacyCatalog === undefined ? {} : { legacyCatalog })
    });
  }

  it('answers unavailable for every preservation operation when no legacy catalog is configured', async () => {
    const service = facade();
    const gated = { previewId: 'p', confirmation: 'confirmed' as const, authority: FULL };
    const results = [
      await service.classifyLegacyCatalogResidue(),
      await service.previewLegacyQuarantine('rev'),
      await service.quarantineLegacyResidue(gated),
      await service.reconcilePreservation('op-1'),
      await service.previewLegacyReimport(RESIDUE_ID, { admits: () => ({ ok: true, value: true }) }),
      await service.previewQuarantinePurge(),
      await service.purgeQuarantinedResidue({ ...gated, residueIds: [RESIDUE_ID] })
    ];
    expect(results.map(refusalOf)).toEqual(Array(results.length).fill('unavailable'));
    expect(await exists(residuePath())).toBe(true);
  });

  it('classifies, previews and quarantines through the service with the same gate', async () => {
    const service = facade({
      catalogRoot: {
        catalog: readOnlyCatalog(createCatalogFsAdapter({ workspaceRoot: workspace, storeRoot: catalogDir })),
        digest,
        segments: CATALOG
      },
      files: createNodeLegacyPreservationFs(workspace),
      consumers: { consumersOf: (ref) => (refKey(ref) === 'phase:beta:v1' ? [{ kind: 'frozen' }] : []) }
    });
    const classified = await service.classifyLegacyCatalogResidue();
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const preview = await service.previewLegacyQuarantine(classified.value.basisRevision);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const untrusted = await service.quarantineLegacyResidue({
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: { ...FULL, trusted: false }
    });
    expect(refusalOf(untrusted)).toBe('untrusted-workspace');
    expect(await exists(residuePath())).toBe(true);

    const result = await service.quarantineLegacyResidue({
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL
    });
    expect(result.ok && result.value.state).toBe('completed');
    expect(await exists(residuePath())).toBe(false);
    expect(await exists(frozenPath())).toBe(true);
    expect(await quarantinedCopies()).toHaveLength(1);
  });
});

describe('FR-R7-16 (16-02) removal-boundary ownership recheck & F04 catalog standing', () => {
  const SIBLING_BODY = { name: 'gamma', steps: ['sibling'] };
  const SIBLING_ID = 'residue:phase:gamma:v1';
  const siblingPath = (): string => path.join(catalogDir, 'phases', 'gamma', 'v1.json');

  function seedF04Version(
    conn: NodeSqliteConnection,
    params: {
      readonly definitionId: string;
      readonly slug: string;
      readonly versionId: string;
      readonly versionNumber: number;
      readonly status: 'draft' | 'published' | 'archived';
    }
  ): void {
    conn.run(
      `INSERT OR IGNORE INTO definitions (definition_id, scope, layer, slug, display_name, created_at_ms)
       VALUES (?, 'workspace', 'phase', ?, ?, ?)`,
      params.definitionId,
      params.slug,
      params.slug,
      NOW
    );
    conn.run(
      `INSERT INTO definition_versions
         (definition_version_id, definition_id, version_number, status, canonical_yaml, digest_sha256, schema_version, created_at_ms)
       VALUES (?, ?, ?, ?, 'name: alpha\n', ?, 1, ?)`,
      params.versionId,
      params.definitionId,
      params.versionNumber,
      params.status,
      'a'.repeat(64),
      NOW
    );
  }

  function seedRunRow(conn: NodeSqliteConnection, runId: string): void {
    conn.run(
      `INSERT INTO runs (run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms)
       VALUES (?, 'workspace', 'wf-1', 'running', 1, ?, ?)`,
      runId,
      NOW,
      NOW
    );
  }

  it('syncs activeVersionId/draftVersionId into catalog_heads and classifies F04 standing accurately', async () => {
    // Write a manifest with both activeVersionId and draftVersionId, plus an unreferenced v3 residue.
    await writeCatalogFile(['phases', 'alpha', 'v3.json'], recordText('alpha', 'v3', { name: 'alpha', steps: ['three'] }));
    const customManifest = `${JSON.stringify(
      {
        storeFormatVersion: 1,
        entries: [
          {
            kind: 'phase',
            id: 'alpha',
            activeVersionId: 'v1',
            draftVersionId: 'v2',
            createdAt: NOW,
            updatedAt: NOW,
            versions: [
              { versionId: 'v1', contentHash: hashOf(PUBLISHED_BODY), createdAt: NOW, publishedAt: NOW, note: null },
              { versionId: 'v2', contentHash: hashOf(RESIDUE_BODY), createdAt: NOW, publishedAt: null, note: null }
            ]
          }
        ]
      },
      null,
      2
    )}\n`;
    await writeCatalogFile(['manifest.json'], customManifest);

    const store = SqliteApplicationStore.openInMemory({ nowMs: () => NOW });
    try {
      const legacyFs = createCatalogFsAdapter({ workspaceRoot: workspace, storeRoot: catalogDir });
      await importLegacyCatalogIntoSqlite(store, 'ws', legacyFs, () => NOW);

      // v1 is both catalog-head (published_version_id) and published-version.
      expect(store.catalogConfig.getLegacySourceStanding({ kind: 'phase', id: 'alpha', versionId: 'v1' })).toEqual({
        referenced: true,
        reasons: ['catalog-head', 'published-version']
      });
      // v2 is pointed to by catalog_heads.draft_version_id.
      expect(store.catalogConfig.getLegacySourceStanding({ kind: 'phase', id: 'alpha', versionId: 'v2' })).toEqual({
        referenced: true,
        reasons: ['catalog-head']
      });
      // v3 was imported only as an unpointed draft row -> unreferenced!
      expect(store.catalogConfig.getLegacySourceStanding({ kind: 'phase', id: 'alpha', versionId: 'v3' })).toEqual({
        referenced: false,
        reasons: []
      });

      // Adding a frozen closure root or member pins v3.
      seedRunRow(store.writerConnection, 'run-freeze');
      store.catalogConfig.createFrozenExecutionClosure({
        frozenClosureId: 'closure-1',
        runId: 'run-freeze',
        rootDefinitionVersionId: 'ws:phase:alpha:v1',
        members: [{ memberRole: 'phase-step', definitionVersionId: 'ws:phase:alpha:v3' }]
      });
      expect(queryLegacySourceStanding(store.writerConnection, { kind: 'phase', id: 'alpha', versionId: 'v3' })).toEqual({
        referenced: true,
        reasons: ['frozen-closure']
      });
    } finally {
      store.close();
      await fs.writeFile(manifestPath(), manifestBefore);
    }
  });

  it('refuses unlink and keeps source bytes intact when a consumer is added between classification and unlink, while quarantining and previewing re-import of an eligible sibling', async () => {
    await writeCatalogFile(['phases', 'gamma', 'v1.json'], recordText('gamma', 'v1', SIBLING_BODY));
    const originalAlpha = await fs.readFile(residuePath());
    const real = createNodeLegacyPreservationFs(workspace);
    const afterCopy: { run?: () => void } = {};
    const racingFs: LegacyPreservationFs = {
      readBytes: (segments) => real.readBytes(segments),
      writeExclusive: async (segments, bytes) => {
        const res = await real.writeExclusive(segments, bytes);
        if (segments.at(-2) === 'alpha' && segments.at(-1) === 'v2.json') {
          afterCopy.run?.();
        }
        return res;
      },
      unlinkContained: (segments) => real.unlinkContained(segments)
    };
    const h = harness(racingFs);
    afterCopy.run = () => {
      h.consumers.set('phase:alpha:v2', [{ kind: 'live' }]);
    };
    const previewId = await previewIdFor(h.service);

    const result = await h.service.quarantineLegacyResidue({
      previewId,
      confirmation: 'confirmed',
      authority: FULL
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('completed');
    expect(result.value.targets.map((target) => target.outcome)).toEqual(['refused', 'quarantined']);
    // Alpha stayed intact at its original location and its staging copy was removed.
    expect(await fs.readFile(residuePath())).toEqual(originalAlpha);
    // Sibling gamma was quarantined cleanly and previews re-import from quarantine.
    expect(await exists(siblingPath())).toBe(false);
    const copies = await quarantinedCopies();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain(path.join('phases', 'gamma', 'v1.json'));
    const reimport = await h.service.previewReimport(SIBLING_ID, { admits: () => ({ ok: true, value: true }) });
    expect(reimport.ok && reimport.value).toMatchObject({
      residueId: SIBLING_ID,
      kind: 'phase',
      id: 'gamma',
      versionId: 'v1',
      source: 'quarantine'
    });
  });

  it('refuses unlink when legacy manifest.json gains the residue between classification and unlink', async () => {
    await writeCatalogFile(['phases', 'gamma', 'v1.json'], recordText('gamma', 'v1', SIBLING_BODY));
    const originalAlpha = await fs.readFile(residuePath());
    const real = createNodeLegacyPreservationFs(workspace);
    const racingFs: LegacyPreservationFs = {
      readBytes: (segments) => real.readBytes(segments),
      writeExclusive: async (segments, bytes) => {
        const res = await real.writeExclusive(segments, bytes);
        if (segments.at(-2) === 'alpha' && segments.at(-1) === 'v2.json') {
          await writeCatalogFile(
            ['manifest.json'],
            manifestText([
              { versionId: 'v1', body: PUBLISHED_BODY },
              { versionId: 'v2', body: RESIDUE_BODY }
            ])
          );
        }
        return res;
      },
      unlinkContained: (segments) => real.unlinkContained(segments)
    };
    const h = harness(racingFs);
    try {
      const previewId = await previewIdFor(h.service);
      const result = await h.service.quarantineLegacyResidue({
        previewId,
        confirmation: 'confirmed',
        authority: FULL
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets.map((target) => target.outcome)).toEqual(['refused', 'quarantined']);
      expect(await fs.readFile(residuePath())).toEqual(originalAlpha);
      expect(await exists(siblingPath())).toBe(false);
      expect(await quarantinedCopies()).toHaveLength(1);
    } finally {
      await fs.writeFile(manifestPath(), manifestBefore);
    }
  });

  it.each([
    ['published-version'],
    ['catalog-head'],
    ['frozen-closure-root'],
    ['frozen-closure-member']
  ] as const)(
    'refuses unlink when F04 catalog standing (%s) appears between classification and unlink, while quarantining eligible sibling',
    async (standingKind) => {
      await writeCatalogFile(['phases', 'gamma', 'v1.json'], recordText('gamma', 'v1', SIBLING_BODY));
      const originalAlpha = await fs.readFile(residuePath());
      const real = createNodeLegacyPreservationFs(workspace);
      const afterCopy: { run?: () => void } = {};
      const racingFs: LegacyPreservationFs = {
        readBytes: (segments) => real.readBytes(segments),
        writeExclusive: async (segments, bytes) => {
          const res = await real.writeExclusive(segments, bytes);
          if (segments.at(-2) === 'alpha' && segments.at(-1) === 'v2.json') {
            afterCopy.run?.();
          }
          return res;
        },
        unlinkContained: (segments) => real.unlinkContained(segments)
      };
      const h = harness(racingFs);
      afterCopy.run = () => {
        if (standingKind === 'published-version') {
          seedF04Version(h.conn, {
            definitionId: 'def-alpha',
            slug: 'alpha',
            versionId: 'def-alpha@v2',
            versionNumber: 2,
            status: 'published'
          });
        } else if (standingKind === 'catalog-head') {
          seedF04Version(h.conn, {
            definitionId: 'def-alpha',
            slug: 'alpha',
            versionId: 'def-alpha@v2',
            versionNumber: 2,
            status: 'draft'
          });
          h.conn.run(
            `INSERT INTO catalog_heads (definition_id, published_version_id, draft_version_id, revision, updated_at_ms)
             VALUES ('def-alpha', NULL, 'def-alpha@v2', 1, ?)`,
            NOW
          );
        } else if (standingKind === 'frozen-closure-root') {
          seedF04Version(h.conn, {
            definitionId: 'def-alpha',
            slug: 'alpha',
            versionId: 'def-alpha@v2',
            versionNumber: 2,
            status: 'draft'
          });
          seedRunRow(h.conn, 'run-root');
          const pool = new BoundedReadConnectionPool(':memory:');
          const tx = new AtomicTransactionUnitsService(h.conn, new WriterCoordinator(h.conn, pool, () => NOW), () => NOW);
          new CatalogConfigStoreAdapter(h.conn, tx, () => NOW).createFrozenExecutionClosure({
            frozenClosureId: 'fc-root',
            runId: 'run-root',
            rootDefinitionVersionId: 'def-alpha@v2',
            members: []
          });
          pool.closeAll();
        } else {
          seedF04Version(h.conn, {
            definitionId: 'def-alpha',
            slug: 'alpha',
            versionId: 'def-alpha@v1',
            versionNumber: 1,
            status: 'published'
          });
          seedF04Version(h.conn, {
            definitionId: 'def-alpha',
            slug: 'alpha',
            versionId: 'def-alpha@v2',
            versionNumber: 2,
            status: 'draft'
          });
          seedRunRow(h.conn, 'run-member');
          const pool = new BoundedReadConnectionPool(':memory:');
          const tx = new AtomicTransactionUnitsService(h.conn, new WriterCoordinator(h.conn, pool, () => NOW), () => NOW);
          new CatalogConfigStoreAdapter(h.conn, tx, () => NOW).createFrozenExecutionClosure({
            frozenClosureId: 'fc-member',
            runId: 'run-member',
            rootDefinitionVersionId: 'def-alpha@v1',
            members: [{ memberRole: 'step', definitionVersionId: 'def-alpha@v2' }]
          });
          pool.closeAll();
        }
      };
      const previewId = await previewIdFor(h.service);

      const result = await h.service.quarantineLegacyResidue({
        previewId,
        confirmation: 'confirmed',
        authority: FULL
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets.map((target) => target.outcome)).toEqual(['refused', 'quarantined']);
      expect(await fs.readFile(residuePath())).toEqual(originalAlpha);
      expect(await exists(siblingPath())).toBe(false);
      expect(await quarantinedCopies()).toHaveLength(1);
      const reimport = await h.service.previewReimport(SIBLING_ID, { admits: () => ({ ok: true, value: true }) });
      expect(reimport.ok && reimport.value.source).toBe('quarantine');
    }
  );

  it('fails closed and leaves source bytes intact if the removal-boundary standing lookup throws', async () => {
    const originalAlpha = await fs.readFile(residuePath());
    const connection = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(connection, () => NOW);
    const service = createLegacyPreservation({
      conn: connection,
      nowMs: () => NOW,
      newId: () => 'op-err',
      previews: new PreviewStore(connection, () => NOW, () => 'preview-err'),
      audit: { recordLifecycleMutation: () => undefined },
      catalogRoot: {
        catalog: readOnlyCatalog(createCatalogFsAdapter({ workspaceRoot: workspace, storeRoot: catalogDir })),
        digest,
        segments: CATALOG
      },
      files: createNodeLegacyPreservationFs(workspace),
      consumers: { consumersOf: (ref) => (refKey(ref) === 'phase:beta:v1' ? [{ kind: 'frozen' }] : []) },
      catalogStanding: () => {
        throw new Error('simulated catalog lookup failure');
      }
    });
    const previewId = await previewIdFor(service);

    const result = await service.quarantineLegacyResidue({
      previewId,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('refused');
    expect(result.value.targets).toEqual([expect.objectContaining({ outcome: 'refused', destinationDigest: null })]);
    expect(await fs.readFile(residuePath())).toEqual(originalAlpha);
    expect(await quarantinedCopies()).toEqual([]);
    connection.close();
  });

  it('commits destination purge and refused outcome atomically so crashes before or after the tx never wedge reconciliation in ambiguous', async () => {
    const originalAlpha = await fs.readFile(residuePath());

    // Case 1: Fault INSIDE the atomic refusal transaction (after markDestinationPurged, on setOutcome).
    // SQLite rolls back both writes so destination_key remains non-null and reconciliation sees
    // absent destination + intact source -> preserved-in-place (state: refused), never ambiguous.
    const conn1 = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn1, () => NOW);
    let failRefusedOutcomeOnce = true;
    const faultInsideTx = new Proxy(conn1, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property !== 'run') return (value as (...args: unknown[]) => unknown).bind(target);
        return (sql: string, ...params: unknown[]) => {
          if (
            failRefusedOutcomeOnce &&
            sql.includes('UPDATE preservation_targets SET outcome = ?') &&
            params.at(0) === 'refused'
          ) {
            failRefusedOutcomeOnce = false;
            throw new Error('simulated crash inside atomic refusal tx');
          }
          return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...params]);
        };
      }
    });
    const real = createNodeLegacyPreservationFs(workspace);
    const afterCopy1: { run?: () => void } = {};
    const racingFs1: LegacyPreservationFs = {
      readBytes: (segments) => real.readBytes(segments),
      writeExclusive: async (segments, bytes) => {
        const res = await real.writeExclusive(segments, bytes);
        if (segments.at(-2) === 'alpha' && segments.at(-1) === 'v2.json') afterCopy1.run?.();
        return res;
      },
      unlinkContained: (segments) => real.unlinkContained(segments)
    };
    const h1 = harness(racingFs1, faultInsideTx);
    afterCopy1.run = () => {
      h1.consumers.set('phase:alpha:v2', [{ kind: 'live' }]);
    };
    const preview1 = await previewIdFor(h1.service);
    await expect(
      h1.service.quarantineLegacyResidue({
        previewId: preview1,
        confirmation: 'confirmed',
        authority: FULL,
        residueIds: [RESIDUE_ID]
      })
    ).rejects.toThrow('simulated crash inside atomic refusal tx');

    // Rollback kept destination_key non-null alongside outcome = 'preserved-in-place'.
    const rowAfterRollback = conn1.get<{ outcome: string; destination_key: string | null }>(
      `SELECT outcome, destination_key FROM preservation_targets WHERE operation_id = 'op-1'`
    );
    expect(rowAfterRollback?.outcome).toBe('preserved-in-place');
    expect(rowAfterRollback?.destination_key).not.toBeNull();
    expect(await fs.readFile(residuePath())).toEqual(originalAlpha);
    expect(await quarantinedCopies()).toEqual([]);

    // Restart and reconcile: resolves cleanly as refused/preserved-in-place (not wedged in ambiguous).
    let retryOpSeq1 = 0;
    const restarted1 = createLegacyPreservation({
      conn: conn1,
      nowMs: () => NOW,
      newId: () => `op-retry1-${(retryOpSeq1 += 1)}`,
      previews: new PreviewStore(conn1, () => NOW, () => `preview-${(previewSequence += 1)}`),
      audit: { recordLifecycleMutation: () => undefined },
      catalogRoot: {
        catalog: readOnlyCatalog(createCatalogFsAdapter({ workspaceRoot: workspace, storeRoot: catalogDir })),
        digest,
        segments: CATALOG
      },
      files: createNodeLegacyPreservationFs(workspace),
      consumers: { consumersOf: (ref) => (refKey(ref) === 'phase:beta:v1' ? [{ kind: 'frozen' }] : []) }
    });
    const reconciled1 = await restarted1.reconcilePreservation('op-1');
    expect(reconciled1.ok).toBe(true);
    if (!reconciled1.ok) return;
    expect(reconciled1.value.state).toBe('refused');
    expect(reconciled1.value.targets).toEqual([expect.objectContaining({ outcome: 'preserved-in-place' })]);
    // Because it is not wedged in ambiguous, a later quarantine succeeds once the consumer is gone.
    const retryPreview1 = await previewIdFor(restarted1);
    const retry1 = await restarted1.quarantineLegacyResidue({
      previewId: retryPreview1,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    expect(retry1.ok && retry1.value.state).toBe('completed');
    conn1.close();

    // Restore alpha/v2 and clear quarantine copies for Case 2.
    await writeCatalogFile(['phases', 'alpha', 'v2.json'], recordText('alpha', 'v2', RESIDUE_BODY));
    await fs.rm(path.join(workspace, '.schegent', 'quarantine'), { recursive: true, force: true });

    // Case 2: Fault AFTER the atomic refusal transaction commits (on final operation setState).
    // Both destination_key = NULL and outcome = 'refused' are committed, and setOutcome was called once.
    const conn2 = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn2, () => NOW);
    let refusedOutcomeWrites = 0;
    let failFinalStateOnce = true;
    const faultAfterTx = new Proxy(conn2, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property !== 'run') return (value as (...args: unknown[]) => unknown).bind(target);
        return (sql: string, ...params: unknown[]) => {
          if (sql.includes('UPDATE preservation_targets SET outcome = ?') && params.at(0) === 'refused') {
            refusedOutcomeWrites += 1;
          }
          if (
            failFinalStateOnce &&
            sql.includes('UPDATE preservation_operations SET state = ?') &&
            params.at(0) === 'refused'
          ) {
            failFinalStateOnce = false;
            throw new Error('simulated crash after atomic refusal tx');
          }
          return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...params]);
        };
      }
    });
    const afterCopy2: { run?: () => void } = {};
    const racingFs2: LegacyPreservationFs = {
      readBytes: (segments) => real.readBytes(segments),
      writeExclusive: async (segments, bytes) => {
        const res = await real.writeExclusive(segments, bytes);
        if (segments.at(-2) === 'alpha' && segments.at(-1) === 'v2.json') afterCopy2.run?.();
        return res;
      },
      unlinkContained: (segments) => real.unlinkContained(segments)
    };
    const h2 = harness(racingFs2, faultAfterTx);
    afterCopy2.run = () => {
      h2.consumers.set('phase:alpha:v2', [{ kind: 'live' }]);
    };
    const preview2 = await previewIdFor(h2.service);
    await expect(
      h2.service.quarantineLegacyResidue({
        previewId: preview2,
        confirmation: 'confirmed',
        authority: FULL,
        residueIds: [RESIDUE_ID]
      })
    ).rejects.toThrow('simulated crash after atomic refusal tx');

    expect(refusedOutcomeWrites).toBe(1);
    const rowAfterCommit = conn2.get<{ outcome: string; destination_key: string | null; destination_digest: string | null }>(
      `SELECT outcome, destination_key, destination_digest FROM preservation_targets WHERE operation_id = 'op-1'`
    );
    expect(rowAfterCommit).toEqual({ outcome: 'refused', destination_key: null, destination_digest: null });

    // Restart and reconcile: skips inspect() on already-'refused' target and settles to state 'refused'.
    let retryOpSeq2 = 0;
    const restarted2 = createLegacyPreservation({
      conn: conn2,
      nowMs: () => NOW,
      newId: () => `op-retry2-${(retryOpSeq2 += 1)}`,
      previews: new PreviewStore(conn2, () => NOW, () => `preview-${(previewSequence += 1)}`),
      audit: { recordLifecycleMutation: () => undefined },
      catalogRoot: {
        catalog: readOnlyCatalog(createCatalogFsAdapter({ workspaceRoot: workspace, storeRoot: catalogDir })),
        digest,
        segments: CATALOG
      },
      files: createNodeLegacyPreservationFs(workspace),
      consumers: { consumersOf: (ref) => (refKey(ref) === 'phase:beta:v1' ? [{ kind: 'frozen' }] : []) }
    });
    const reconciled2 = await restarted2.reconcilePreservation('op-1');
    expect(reconciled2.ok).toBe(true);
    if (!reconciled2.ok) return;
    expect(reconciled2.value.state).toBe('refused');
    expect(reconciled2.value.targets).toEqual([
      expect.objectContaining({ outcome: 'refused', destinationDigest: null })
    ]);
    // Not wedged: a later quarantine proceeds cleanly once the consumer is gone.
    const retryPreview2 = await previewIdFor(restarted2);
    const retry2 = await restarted2.quarantineLegacyResidue({
      previewId: retryPreview2,
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [RESIDUE_ID]
    });
    expect(retry2.ok && retry2.value.state).toBe('completed');
    conn2.close();
  });
});

describe('createNodeLegacyPreservationFs.unlinkContained containment hardening (SR-A4)', () => {
  it('refuses lexical traversal (including in-workspace ..), Windows drive segments, control chars, and invalid segments without unlinking targets', async () => {
    const files = createNodeLegacyPreservationFs(workspace);
    const workspaceVictim = path.join(workspace, 'workspace-victim.txt');
    const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sra4-outside-')));
    const outsideVictim = path.join(outsideDir, 'outside-victim.txt');
    try {
      await fs.writeFile(workspaceVictim, 'keep-workspace-victim');
      await fs.writeFile(outsideVictim, 'keep-outside-victim');
      await fs.mkdir(path.join(workspace, '.schegent', 'quarantine'), { recursive: true });

      const invalidCases: readonly (readonly string[])[] = [
        [],
        [''],
        ['.'],
        ['..', path.basename(outsideDir), 'outside-victim.txt'],
        ['.schegent', 'catalog', '..', '..', 'workspace-victim.txt'],
        ['.schegent', 'quarantine', '..', '..', 'workspace-victim.txt'],
        ['.schegent', '.', 'catalog', 'phases', 'alpha', 'v2.json'],
        ['.schegent/catalog', 'phases', 'alpha', 'v2.json'],
        ['.schegent\\catalog', 'phases', 'alpha', 'v2.json'],
        ['.schegent', 'bad\0name.json'],
        ['.schegent', 'bad\nname.json'],
        ['.schegent', 'bad\x7fname.json'],
        ['C:', 'workspace-victim.txt'],
        ['C:workspace-victim.txt'],
        ['.schegent', 'D:foo', 'bar.json'],
        [workspaceVictim]
      ];
      for (const segments of invalidCases) {
        expect(await files.unlinkContained(segments), JSON.stringify(segments)).toBe('refused');
      }
      expect(await fs.readFile(workspaceVictim, 'utf8')).toBe('keep-workspace-victim');
      expect(await fs.readFile(outsideVictim, 'utf8')).toBe('keep-outside-victim');
      expect(await exists(residuePath())).toBe(true);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses intermediate in-workspace symlinks and leaf symlinks without unlinking targets outside catalog or quarantine', async () => {
    const files = createNodeLegacyPreservationFs(workspace);
    const victimDir = path.join(workspace, 'victim-dir');
    const victimFile = path.join(victimDir, 'secret.json');
    await fs.mkdir(victimDir, { recursive: true });
    await fs.writeFile(victimFile, 'do-not-delete');

    // Intermediate symlink inside .schegent/catalog pointing to another in-workspace directory.
    const catalogSymlinkDir = path.join(catalogDir, 'phases', 'linked-dir');
    await fs.symlink(victimDir, catalogSymlinkDir);
    expect(await files.unlinkContained(['.schegent', 'catalog', 'phases', 'linked-dir', 'secret.json'])).toBe('refused');
    expect(await fs.readFile(victimFile, 'utf8')).toBe('do-not-delete');

    // Intermediate symlink inside .schegent/quarantine pointing to another in-workspace directory.
    const quarantineBase = path.join(workspace, '.schegent', 'quarantine', 'catalog');
    await fs.mkdir(quarantineBase, { recursive: true });
    const quarantineSymlinkDir = path.join(quarantineBase, 'linked-op');
    await fs.symlink(victimDir, quarantineSymlinkDir);
    expect(await files.unlinkContained(['.schegent', 'quarantine', 'catalog', 'linked-op', 'secret.json'])).toBe('refused');
    expect(await fs.readFile(victimFile, 'utf8')).toBe('do-not-delete');

    // Leaf symlink pointing to an in-workspace file is also refused (not a regular file).
    const leafLink = path.join(catalogDir, 'phases', 'alpha', 'leaf-link.json');
    await fs.symlink(victimFile, leafLink);
    expect(await files.unlinkContained(['.schegent', 'catalog', 'phases', 'alpha', 'leaf-link.json'])).toBe('refused');
    expect(await fs.readFile(victimFile, 'utf8')).toBe('do-not-delete');
    expect(await exists(leafLink)).toBe(true);

    // Absent paths under real directories still report 'absent', and valid regular files report 'removed'.
    expect(await files.unlinkContained(['.schegent', 'catalog', 'phases', 'alpha', 'missing.json'])).toBe('absent');
    expect(await files.unlinkContained(['.schegent', 'catalog', 'no-such-dir', 'missing.json'])).toBe('absent');
    expect(await files.unlinkContained(['.schegent', 'catalog', 'phases', 'alpha', 'v2.json'])).toBe('removed');
    expect(await exists(residuePath())).toBe(false);
  });
});
