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
  CutoverAuthorityGuard,
  MigrationCoordinator,
  NodeSqliteConnection,
  SchemaBootstrapService
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
