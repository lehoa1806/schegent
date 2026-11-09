// FR-R6-F05 (T045) — acceptance criteria F05-AC-01..F05-AC-10, one case each.
//
// Every case runs against a real temp workspace: a file-backed SQLite store bootstrapped through
// `SchemaBootstrapService`, a `LifecycleFs` over `node:fs/promises`, and a byte probe that reads
// the real files. A restart is a second connection opened on the same database file. Faults are
// injected only where the filesystem cannot produce them on demand (a full disk, a lost lease, a
// hung unlink); each such seam is named where it is used.
//
// The NFR-001 time and memory budgets are owned by tests/perf/artifact-lifecycle-inventory.test.ts;
// F05-AC-04 here proves the scan and paging bounds on real files and leaves the clocks to that suite.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogFsPort, Digest } from '../../src/catalog/ports';
import { contentHashOf } from '../../src/catalog/content-hash';
import {
  MATERIALIZED_COPY_DEFAULT_TTL_MS,
  type QualifyAccessRequest
} from '../../src/contracts/artifact-lifecycle/access-types';
import type { LegacyCatalogVersionRef } from '../../src/contracts/artifact-lifecycle/legacy-preservation-types';
import {
  INVENTORY_PAGE_MAX_BYTES,
  INVENTORY_PAGE_MAX_ENTRIES,
  SCAN_MAX_DEPTH,
  SCAN_MAX_ENTRIES_PER_PASS,
  type DeletionOperation,
  type DeletionTargetOutcomeKind,
  type MutationAuthority,
  type StorageInventoryEntry
} from '../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  DEFAULT_RETENTION_POLICY,
  type ArchivalQueueInput,
  type ArchivalTaskInput
} from '../../src/contracts/artifact-lifecycle/retention-policy-types';
import type { ControlFrameStatus } from '../../src/contracts/control-ledger';
import { CMD_READ_STORAGE_DETAILS } from '../../src/contracts/sidebar-ipc';
import type { CommandAckMessage, ReadStorageDetailsCommand } from '../../src/contracts/sidebar-ipc';
import {
  createStorageDetailsReader,
  executeArtifactDeletion,
  getStorageInventory,
  getStoragePressure,
  previewArtifactDeletion
} from '../../src/headless/artifact-lifecycle-api';
import { createCatalogFsAdapter } from '../../src/host-services/catalog-fs-adapter';
import {
  ArtifactRecordStore,
  createArtifactLifecycleService,
  createNodeLegacyPreservationFs,
  currentRetentionDecisions,
  DENY_ALL_ACCESS_POLICY,
  F05_LIFECYCLE_DDL,
  F05_LIFECYCLE_MIGRATION_NAME,
  F05_LIFECYCLE_MIGRATION_VERSION,
  PreviewStore,
  ReferenceStore,
  type ArtifactAccessPolicy,
  type ArtifactByteProbe,
  type ArtifactLifecycleService,
  type ArtifactLocator,
  type LegacyCatalogDependencies,
  type LegacyPreservationFs,
  type LifecycleAuditRecord,
  type LifecycleContext,
  type LifecycleFs,
  type LifecycleFsEntry,
  type OwnerResolution,
  type RegisterArtifactInput,
  type StorageScanRoot
} from '../../src/services/artifact-lifecycle';
import { BUILTIN_SCHEMA_MIGRATIONS, NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { handler as readStorageDetails } from '../../src/ui/sidebar/commands/cmd-read-storage-details';

const NOW = 1_800_000_000_000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Past the deletion lease TTL, so a restarted host may take over an interrupted operation. */
const LEASE_TTL_MARGIN_MS = 10 * MINUTE_MS;
const WAIT_LIMIT_MS = 5_000;
const POLL_INTERVAL_MS = 5;
/** A sparse body: its size is reported from `lstat`, never by reading it. */
const LARGE_BODY_BYTES = 64 * 1024 * 1024;
const REGISTERED_FOR_PAGING = INVENTORY_PAGE_MAX_ENTRIES + 5;
const PRIVATE_FILE_MODE = 0o600;
const READ_ONLY_DIR_MODE = 0o500;
const OWNER_DIR_MODE = 0o700;

const FULL: MutationAuthority = { trusted: true, primary: true, auditHealthy: true };
const CHECKPOINT_CLASS = 'transcripts-diagnostics-checkpoints-audit-catalog' as const;
const DETAIL_CLASS = 'new-terminal-execution-usage-detail' as const;
const REPORT_CLASS = 'generated-reports-handoff-exports' as const;

const CHECKPOINT_DIR = ['.schegent', 'checkpoints'] as const;
const REPORT_DIR = ['.schegent', 'reports'] as const;
const DATABASE_SEGMENTS = ['.schegent', 'state.db'] as const;

let workspace = '';
let now = NOW;
let ids = 0;
let openConnections: NodeSqliteConnection[] = [];

const newId = (): string => `id-${(ids += 1)}`;
const sha256Hex = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const inWorkspace = (...segments: readonly string[]): string => path.join(workspace, ...segments);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeBytes(relpath: string, content: string | Buffer): Promise<string> {
  const target = inWorkspace(relpath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

/** `LifecycleFs` over the real filesystem; links are never followed. Hooks inject faults per path. */
class NodeLifecycleFs implements LifecycleFs {
  public readonly unlinkHooks = new Map<string, () => Promise<void> | void>();
  public beforeReaddir: ((absolutePath: string) => void) | undefined;

  public async lstat(absolutePath: string): Promise<LifecycleFsEntry | null> {
    try {
      const st = await fs.lstat(absolutePath);
      const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
      return { kind, sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null;
      throw error;
    }
  }

  public async readdir(absolutePath: string): Promise<readonly string[]> {
    if (this.beforeReaddir !== undefined) this.beforeReaddir(absolutePath);
    return (await fs.readdir(absolutePath)).sort();
  }

  public realpath(absolutePath: string): Promise<string> {
    return fs.realpath(absolutePath);
  }

  public async unlink(absolutePath: string): Promise<void> {
    const hook = this.unlinkHooks.get(absolutePath);
    if (hook !== undefined) await hook();
    await fs.unlink(absolutePath);
  }
}

interface Sidecar {
  readonly producer?: string;
  readonly generation?: number;
}

/** Writer identity and generation live in `<file>.meta.json`, as a growing log's header would carry them. */
async function writeSidecar(target: string, sidecar: Sidecar): Promise<void> {
  await fs.writeFile(`${target}.meta.json`, JSON.stringify(sidecar));
}

async function readSidecar(target: string): Promise<Sidecar> {
  try {
    return JSON.parse(await fs.readFile(`${target}.meta.json`, 'utf8')) as Sidecar;
  } catch {
    return {};
  }
}

const locatorPath = (locator: ArtifactLocator): string => inWorkspace(locator.uriOrRelpath);

/** Observes and hashes the real bytes behind a workspace locator. */
const realProbe: ArtifactByteProbe = {
  async observe(locator) {
    const target = locatorPath(locator);
    const absent = { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
    let st;
    try {
      st = await fs.lstat(target);
    } catch {
      return absent;
    }
    if (!st.isFile()) return absent;
    const sidecar = await readSidecar(target);
    return {
      exists: true,
      sizeBytes: st.size,
      producerIdentity: sidecar.producer ?? null,
      generation: sidecar.generation ?? null
    };
  },
  async digestSha256(locator) {
    try {
      return sha256Hex(await fs.readFile(locatorPath(locator)));
    } catch {
      return null;
    }
  }
};

const byteReader = {
  async read(locator: ArtifactLocator): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(locatorPath(locator));
    } catch {
      return null;
    }
  }
};

function scanRoots(): readonly StorageScanRoot[] {
  return [
    {
      rootId: 'checkpoints',
      root: inWorkspace(...CHECKPOINT_DIR),
      retentionClass: CHECKPOINT_CLASS,
      storeKind: 'checkpoint',
      ownerRunId: (segments) => (segments.length === 2 ? segments.at(0) : undefined)
    },
    {
      rootId: 'reports',
      root: inWorkspace(...REPORT_DIR),
      retentionClass: REPORT_CLASS,
      storeKind: 'report'
    }
  ];
}

function openStore(databasePath: string = inWorkspace(...DATABASE_SEGMENTS)): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath });
  openConnections.push(conn);
  return conn;
}

function closeStore(conn: NodeSqliteConnection): void {
  conn.close();
  openConnections = openConnections.filter((open) => open !== conn);
}

interface BuildOptions {
  readonly conn?: NodeSqliteConnection;
  readonly pinnedRunIds?: ReadonlySet<string>;
  readonly storageTargetBytes?: number;
  readonly accessPolicy?: ArtifactAccessPolicy;
  readonly runFrameStatuses?: (runId: string) => readonly ControlFrameStatus[];
  readonly legacyCatalog?: LegacyCatalogDependencies;
}

interface Harness {
  conn: NodeSqliteConnection;
  readonly files: NodeLifecycleFs;
  readonly audits: LifecycleAuditRecord[];
  readonly owners: Map<string, OwnerResolution>;
  build(options?: BuildOptions): ArtifactLifecycleService;
  /** A host restart: a new connection on the same database file, bootstrapped again. */
  restart(): NodeSqliteConnection;
}

function harness(): Harness {
  const conn = openStore();
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => now);
  const files = new NodeLifecycleFs();
  const audits: LifecycleAuditRecord[] = [];
  const owners = new Map<string, OwnerResolution>();
  const h: Harness = {
    conn,
    files,
    audits,
    owners,
    build(options = {}) {
      const pinned = options.pinnedRunIds ?? new Set<string>();
      return createArtifactLifecycleService({
        conn: options.conn ?? h.conn,
        nowMs: () => now,
        fs: files,
        probe: realProbe,
        audit: { recordLifecycleMutation: (record) => audits.push(record) },
        scanRoots: scanRoots(),
        accessPolicy: options.accessPolicy ?? DENY_ALL_ACCESS_POLICY,
        resolveOwner: (ownerType, ownerId) => owners.get(`${ownerType}:${ownerId}`) ?? 'live',
        newId,
        workspaceRoot: workspace,
        pinnedRunIds: () => pinned,
        byteReader,
        ...(options.storageTargetBytes === undefined ? {} : { storageTargetBytes: options.storageTargetBytes }),
        ...(options.runFrameStatuses === undefined ? {} : { runFrameStatuses: options.runFrameStatuses }),
        ...(options.legacyCatalog === undefined ? {} : { legacyCatalog: options.legacyCatalog })
      });
    },
    restart() {
      const next = openStore();
      SchemaBootstrapService.bootstrapAndMigrate(next, () => now);
      h.conn = next;
      return next;
    }
  };
  return h;
}

function contextOf(h: Harness): LifecycleContext {
  const nowMs = (): number => now;
  return {
    deps: {
      conn: h.conn,
      nowMs,
      fs: h.files,
      probe: realProbe,
      audit: { recordLifecycleMutation: (record) => h.audits.push(record) },
      scanRoots: scanRoots(),
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: () => 'live',
      newId,
      workspaceRoot: workspace
    },
    records: new ArtifactRecordStore(h.conn, nowMs),
    previews: new PreviewStore(h.conn, nowMs, newId),
    references: new ReferenceStore(h.conn, nowMs),
    newId
  };
}

const checkpointRel = (artifactId: string, runId: string): string =>
  path.join(...CHECKPOINT_DIR, runId, `${artifactId}.patch`);

interface SeedOptions extends Partial<RegisterArtifactInput> {
  readonly body?: string;
  readonly relpath?: string;
}

/** Writes real bytes and registers them; defaults to an immutable checkpoint under its run. */
async function seedArtifact(service: ArtifactLifecycleService, artifactId: string, options: SeedOptions = {}): Promise<string> {
  const { body = `bytes of ${artifactId}\n`, relpath, ...overrides } = options;
  const runId = overrides.ownerRunId ?? 'run-1';
  const rel = relpath ?? checkpointRel(artifactId, runId);
  const target = await writeBytes(rel, body);
  const registered = service.registerArtifact({
    artifactId,
    ownerRunId: runId,
    sensitivity: 'content',
    retentionClass: CHECKPOINT_CLASS,
    storeKind: 'checkpoint',
    immutability: 'immutable',
    digest: { algorithm: 'sha256', value: sha256Hex(body) },
    byteSize: Buffer.byteLength(body),
    mediaType: 'text/plain',
    displayName: artifactId,
    producerIdentity: 'writer',
    locator: { storageTier: 'workspace_file', uriOrRelpath: rel },
    ...overrides
  });
  if (!registered.ok) throw new Error(`seed ${artifactId} refused: ${registered.refusal.code}`);
  return target;
}

function refusalOf(result: { readonly ok: boolean; readonly refusal?: { readonly code: string } }): string | undefined {
  if (result.ok || result.refusal === undefined) return undefined;
  return result.refusal.code;
}

function availabilityOf(service: ArtifactLifecycleService, artifactId: string): string | undefined {
  const record = service.getArtifact(artifactId);
  return record.ok ? record.value.availability : undefined;
}

function outcomes(operation: DeletionOperation): Record<string, DeletionTargetOutcomeKind> {
  return Object.fromEntries(operation.targets.map((target) => [target.artifactId ?? '', target.outcome]));
}

async function previewAndExecute(
  service: ArtifactLifecycleService,
  artifactIds: readonly string[] | undefined,
  signal?: AbortSignal
): Promise<DeletionOperation> {
  const selection = artifactIds === undefined ? {} : { artifactIds };
  const preview = service.previewDeletion(selection);
  if (!preview.ok) throw new Error(`deletion preview refused: ${preview.refusal.code}`);
  const result = await service.executeDeletion(
    { ...selection, previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL },
    signal
  );
  if (!result.ok) throw new Error(`deletion refused: ${result.refusal.code}`);
  return result.value;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function setSettledAgo(conn: NodeSqliteConnection, artifactId: string, agoMs: number): void {
  conn.run('UPDATE artifact_lifecycle SET terminal_settled_at_ms = ? WHERE artifact_id = ?', now - agoMs, artifactId);
}

function insertF04Artifact(conn: NodeSqliteConnection, artifactId: string, body: string): void {
  conn.run(
    `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_at_ms)
     VALUES (?, ?, ?, 'text/plain', 'transcript', ?)`,
    artifactId,
    sha256Hex(body),
    Buffer.byteLength(body),
    NOW
  );
  conn.run(
    `INSERT INTO artifact_availability (artifact_id, state, last_verified_at_ms, detail_json) VALUES (?, 'available', ?, '{}')`,
    artifactId,
    NOW
  );
}

function f04Rows(conn: NodeSqliteConnection): unknown {
  return {
    artifacts: conn.all(`SELECT * FROM artifacts WHERE artifact_id LIKE 'f04-%' ORDER BY artifact_id`),
    availability: conn.all(`SELECT * FROM artifact_availability WHERE artifact_id LIKE 'f04-%' ORDER BY artifact_id`)
  };
}

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f05-ac-')));
  await fs.mkdir(inWorkspace('.schegent'), { recursive: true });
  now = NOW;
  ids = 0;
  openConnections = [];
});

afterEach(async () => {
  for (const conn of openConnections) {
    try {
      conn.close();
    } catch {
      // A connection a case already closed through another handle.
    }
  }
  openConnections = [];
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('FR-R6-F05 acceptance (T045)', () => {
  it('F05-AC-01 keeps identity, generation, digest and availability truthful as bytes are replaced, truncated, corrupted and removed', async () => {
    const h = harness();
    const service = h.build();
    const reconcile = async (artifactId: string): Promise<string> => {
      const result = await service.reconcileArtifact(artifactId);
      if (!result.ok) throw new Error(`reconcile ${artifactId} refused: ${result.refusal.code}`);
      return result.value.availability;
    };

    const replaced = await seedArtifact(service, 'imm-replaced', { body: 'immutable body A\n' });
    const resized = await seedArtifact(service, 'imm-resized');
    const foreign = await seedArtifact(service, 'imm-foreign');
    const removed = await seedArtifact(service, 'imm-removed');
    const segment = 'line one\nline two\n';
    const growing = (artifactId: string): SeedOptions => ({
      relpath: path.join('.schegent', 'logs', 'run-1', `${artifactId}.log`),
      body: segment,
      storeKind: 'live-log-segment',
      immutability: 'growing',
      digest: undefined,
      generation: 3,
      extentBytes: Buffer.byteLength(segment),
      producerIdentity: 'log-writer'
    });
    const truncated = await seedArtifact(service, 'log-truncated', growing('log-truncated'));
    const regenerated = await seedArtifact(service, 'log-regenerated', growing('log-regenerated'));
    for (const target of [truncated, regenerated]) await writeSidecar(target, { producer: 'log-writer', generation: 3 });
    const identityBefore = new Map(
      ['imm-replaced', 'imm-resized', 'imm-foreign', 'imm-removed', 'log-truncated', 'log-regenerated'].map((id) => {
        const record = service.getArtifact(id);
        if (!record.ok) throw new Error(`missing ${id}`);
        const { digest, generation, extentBytes, byteSize, immutability, storeKind } = record.value;
        return [id, { digest, generation, extentBytes, byteSize, immutability, storeKind }] as const;
      })
    );

    // Unchanged bytes and an appended growing log both stay present.
    expect(await reconcile('imm-replaced')).toBe('present');
    await fs.appendFile(truncated, 'line three\n');
    expect(await reconcile('log-truncated')).toBe('present');

    // Same size, different bytes: only the digest tells, and it does.
    await fs.writeFile(replaced, 'immutable body B\n');
    expect(await reconcile('imm-replaced')).toBe('corrupt');
    await fs.writeFile(resized, 'a different length entirely\n');
    expect(await reconcile('imm-resized')).toBe('corrupt');
    await writeSidecar(foreign, { producer: 'another-writer' });
    expect(await reconcile('imm-foreign')).toBe('corrupt');
    await fs.truncate(truncated, 4);
    expect(await reconcile('log-truncated')).toBe('corrupt');
    await writeSidecar(regenerated, { producer: 'log-writer', generation: 4 });
    expect(await reconcile('log-regenerated')).toBe('corrupt');
    await fs.rm(removed);
    expect(await reconcile('imm-removed')).toBe('missing');

    // Restored bytes are present again: availability follows the bytes, never sticks.
    await fs.writeFile(replaced, 'immutable body A\n');
    expect(await reconcile('imm-replaced')).toBe('present');
    await fs.writeFile(removed, 'bytes of imm-removed\n');
    expect(await reconcile('imm-removed')).toBe('present');

    // Identity never moved and no record or reference was deleted along the way.
    for (const [id, before] of identityBefore) {
      const record = service.getArtifact(id);
      if (!record.ok) throw new Error(`record ${id} vanished`);
      const { digest, generation, extentBytes, byteSize, immutability, storeKind } = record.value;
      expect({ digest, generation, extentBytes, byteSize, immutability, storeKind }, id).toEqual(before);
    }
    expect(h.conn.scalar<number>('SELECT COUNT(*) FROM artifact_lifecycle')).toBe(identityBefore.size);
  });

  it('F05-AC-02 keeps protected bytes through duplicate pins, a restart, an unknown version, a paused owner and an early release', async () => {
    const h = harness();
    const service = h.build();
    const paused = await seedArtifact(service, 'paused-1', { ownerRunId: 'run-paused' });
    const free = await seedArtifact(service, 'free-1', { ownerRunId: 'run-free' });
    const exported = await seedArtifact(service, 'export-1', { ownerRunId: 'run-export' });
    const pin = {
      artifactId: 'paused-1',
      ownerType: 'run',
      ownerId: 'run-paused',
      purpose: 'paused-recovery',
      protective: true
    } as const;

    // Duplicate pin: one row, one id. Duplicate release: both settle the same row.
    const first = service.addReference(pin);
    const again = service.addReference(pin);
    if (!first.ok || !again.ok) throw new Error('pin refused');
    expect(again.value.referenceId).toBe(first.value.referenceId);
    const lease = { artifactId: 'free-1', ownerType: 'attempt', ownerId: 'attempt-9', purpose: 'phase-context' } as const;
    expect(service.addReference({ ...lease, protective: true }).ok).toBe(true);
    const released = service.releaseReference({ ...lease, reason: 'owner-durable' });
    const releasedAgain = service.releaseReference({ ...lease, reason: 'owner-durable' });
    expect(released.ok && releasedAgain.ok).toBe(true);
    expect(h.conn.scalar<number>(`SELECT COUNT(*) FROM artifact_references WHERE artifact_id = 'paused-1'`)).toBe(1);
    expect(h.conn.scalar<number>(`SELECT COUNT(*) FROM artifact_references WHERE artifact_id = 'free-1'`)).toBe(1);
    service.addReference({ artifactId: 'export-1', ownerType: 'export', ownerId: 'exp-1', purpose: 'report-lease', protective: false });

    // Restart before any sweep; the export owner can no longer be placed.
    h.restart();
    h.owners.set('export:exp-1', 'unresolved');
    const restarted = h.build();
    expect(restarted.isProtected('paused-1')).toEqual({ protected: true, diagnostic: null });
    expect(restarted.isProtected('export-1').diagnostic).toEqual(
      expect.objectContaining({ code: 'ownership-unresolved', artifactId: 'export-1' })
    );
    const preview = restarted.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    expect(preview.value.summary.affectedCount).toBe(1);
    expect(preview.value.summary.protectedExceptions).toEqual(
      expect.arrayContaining([
        { artifactId: 'paused-1', reason: 'preserve-protected' },
        { artifactId: 'export-1', reason: 'preserve-ownership-unresolved' }
      ])
    );
    const swept = await previewAndExecute(restarted, undefined);
    expect(outcomes(swept)).toEqual({ 'free-1': 'deleted' });
    expect(await exists(free)).toBe(false);
    expect(await exists(paused)).toBe(true);
    expect(await exists(exported)).toBe(true);

    // An unknown store version makes every artifact fail closed: nothing is eligible.
    await seedArtifact(restarted, 'free-2', { ownerRunId: 'run-free' });
    h.conn.run(
      `INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at_ms) VALUES (99, 'future', ?, ?)`,
      'f'.repeat(64),
      now
    );
    expect(restarted.isProtected('free-2').diagnostic).toEqual(expect.objectContaining({ code: 'unknown-version' }));
    const blocked = restarted.previewDeletion({});
    expect(blocked.ok && blocked.value.summary.affectedCount).toBe(0);
    h.conn.run('DELETE FROM schema_migrations WHERE version = 99');

    // Early release needs its own preview naming the surrendered capability.
    const referenceId = first.value.referenceId;
    const blind = restarted.releaseReferenceEarly({ referenceId, previewId: 'none', confirmation: 'confirmed', authority: FULL });
    expect(refusalOf(blind)).toBe('preview-required');
    expect(restarted.isProtected('paused-1').protected).toBe(true);
    const releasePreview = restarted.previewEarlyRelease(referenceId);
    if (!releasePreview.ok) throw new Error('early-release preview refused');
    expect(releasePreview.value.summary.notes.join(' ')).toContain('resume of a paused run');
    const early = restarted.releaseReferenceEarly({
      referenceId,
      previewId: releasePreview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL
    });
    expect(early.ok && early.value.releaseReason).toBe('operator-early-release');
    expect(restarted.isProtected('paused-1')).toEqual({ protected: false, diagnostic: null });
    const eligible = restarted.previewDeletion({ artifactIds: ['paused-1'] });
    expect(eligible.ok && eligible.value.summary.affectedCount).toBe(1);
    expect(await exists(paused)).toBe(true);
  });

  it('F05-AC-03 changes only the previewed eligible set when a policy is adopted over legacy, unknown, vendor, audit and new-metadata artifacts', async () => {
    const h = harness();
    const service = h.build();
    const report = (artifactId: string, overrides: SeedOptions = {}): Promise<string> =>
      seedArtifact(service, artifactId, {
        relpath: path.join(...REPORT_DIR, `${artifactId}.json`),
        retentionClass: DETAIL_CLASS,
        storeKind: 'report',
        ...overrides
      });
    await report('detail-old');
    await report('detail-young');
    await report('audit-old', { storeKind: 'audit' });
    await report('vendor-old', { storeKind: 'provider-session', retentionClass: 'provider-owned-session-stores' });
    await report('unknown-old', { storeKind: 'unclassified' });
    await seedArtifact(service, 'checkpoint-old');
    for (const id of ['detail-old', 'audit-old', 'vendor-old', 'unknown-old', 'checkpoint-old']) {
      setSettledAgo(h.conn, id, 100 * DAY_MS);
    }
    setSettledAgo(h.conn, 'detail-young', 10 * DAY_MS);
    insertF04Artifact(h.conn, 'f04-legacy', 'legacy transcript');
    const legacyBefore = f04Rows(h.conn);

    const ctx = contextOf(h);
    const actions = (): Map<string, string> =>
      new Map(currentRetentionDecisions(ctx).map((decision) => [decision.artifactId, decision.action]));
    const collectable = (decided: Map<string, string>): string[] =>
      [...decided].filter(([, action]) => action === 'collect').map(([id]) => id);
    const before = actions();
    expect(collectable(before)).toEqual([]);

    const preview = service.previewRetentionPolicy(DEFAULT_RETENTION_POLICY);
    if (!preview.ok) throw new Error(`policy preview refused: ${preview.refusal.code}`);
    expect(preview.value.kind).toBe('policy-adoption');
    const adopted = service.adoptRetentionPolicy({
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL,
      policy: DEFAULT_RETENTION_POLICY
    });
    expect(adopted.ok && adopted.value.policyRevision).toBe(1);

    const after = actions();
    expect(collectable(after)).toEqual(['detail-old']);
    expect(collectable(after)).toHaveLength(preview.value.summary.affectedCount);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const kept of ['audit-old', 'vendor-old']) expect(after.get(kept), kept).toBe('preserve-never-eligible');
    expect(after.get('unknown-old')).not.toBe('collect');
    // The F04-only row is outside lifecycle management and untouched by adoption.
    expect(after.has('f04-legacy')).toBe(false);
    const legacy = service.getArtifact('f04-legacy');
    expect(legacy.ok && legacy.value.managed).toBe(false);
    expect(f04Rows(h.conn)).toEqual(legacyBefore);
  });

  it('F05-AC-04 bounds a real scan by depth, entry count and cancellation, sizes large bodies without reading them, and pages the inventory', async () => {
    const h = harness();
    const service = h.build();
    const scan = async (signal?: AbortSignal) => {
      const result = await service.scanDeclaredRoots(signal);
      if (!result.ok) throw new Error(`scan refused: ${result.refusal.code}`);
      return result.value;
    };

    // A large sparse body is sized from lstat; LifecycleFs has no read method at all.
    const large = inWorkspace(...CHECKPOINT_DIR, 'run-large', 'large.patch');
    await fs.mkdir(path.dirname(large), { recursive: true });
    await fs.writeFile(large, '');
    await fs.truncate(large, LARGE_BODY_BYTES);
    const complete = await scan();
    expect(complete.coverage).toBe('complete');
    const pressure = service.getPressureReport();
    if (!pressure.ok) throw new Error('pressure refused');
    const checkpointLine = pressure.value.perClass.find((line) => line.retentionClass === CHECKPOINT_CLASS);
    expect(checkpointLine === undefined ? 0 : checkpointLine.totalBytes).toBe(LARGE_BODY_BYTES);

    // A tree deeper than SCAN_MAX_DEPTH is left unread and the scan says so.
    const deepSegments = Array.from({ length: SCAN_MAX_DEPTH + 2 }, (_, level) => `level-${level}`);
    await writeBytes(path.join(...CHECKPOINT_DIR, ...deepSegments, 'deep.patch'), 'deep');
    const shallow = await scan();
    expect(shallow.coverage).toBe('partial');
    expect(shallow.entriesVisited).toBeLessThan(SCAN_MAX_ENTRIES_PER_PASS);

    // A traversal cancelled mid-walk is partial, never reported complete.
    const controller = new AbortController();
    h.files.beforeReaddir = () => controller.abort();
    const cancelled = await scan(controller.signal);
    h.files.beforeReaddir = undefined;
    expect(cancelled.coverage).toBe('partial');

    // More entries than one pass may visit: the pass stops at the bound.
    const bulk = inWorkspace(...CHECKPOINT_DIR, 'run-bulk');
    await fs.mkdir(bulk, { recursive: true });
    for (let index = 0; index <= SCAN_MAX_ENTRIES_PER_PASS; index += 1) {
      await fs.writeFile(path.join(bulk, `entry-${String(index).padStart(5, '0')}.patch`), 'x');
    }
    const bounded = await scan();
    expect(bounded.coverage).toBe('partial');
    expect(bounded.entriesVisited).toBe(SCAN_MAX_ENTRIES_PER_PASS);

    // Registered records and scan entries page within both page bounds, without repeats.
    for (let index = 0; index < REGISTERED_FOR_PAGING; index += 1) {
      const artifactId = `paged-${String(index).padStart(4, '0')}`;
      const registered = service.registerArtifact({
        artifactId,
        ownerRunId: 'run-paged',
        sensitivity: 'metadata',
        retentionClass: CHECKPOINT_CLASS,
        storeKind: 'checkpoint',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: sha256Hex(artifactId) },
        byteSize: artifactId.length,
        mediaType: 'text/plain',
        displayName: artifactId,
        producerIdentity: 'writer',
        locator: { storageTier: 'workspace_file', uriOrRelpath: checkpointRel(artifactId, 'run-paged') }
      });
      if (!registered.ok) throw new Error(`register ${artifactId} refused`);
    }
    const seen: StorageInventoryEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = service.listInventory(cursor === undefined ? {} : { cursor });
      if (!page.ok) throw new Error(`inventory refused: ${page.refusal.code}`);
      pages += 1;
      expect(page.value.entries.length).toBeLessThanOrEqual(INVENTORY_PAGE_MAX_ENTRIES);
      expect(Buffer.byteLength(JSON.stringify(page.value))).toBeLessThanOrEqual(INVENTORY_PAGE_MAX_BYTES);
      expect(page.value.coverage).toBe('partial');
      seen.push(...page.value.entries);
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor !== undefined && pages < 100);
    expect(cursor).toBeUndefined();
    expect(pages).toBeGreaterThan(1);
    const registeredIds = seen.flatMap((entry) => (entry.source === 'registered' && entry.artifactId !== null ? [entry.artifactId] : []));
    expect(new Set(registeredIds).size).toBe(REGISTERED_FOR_PAGING);
    expect(registeredIds).toHaveLength(REGISTERED_FOR_PAGING);
    expect(seen.filter((entry) => entry.source === 'scan').length).toBeGreaterThan(0);
  });

  it('F05-AC-05 survives disk-full, unlink denial, a stale fence, link substitution, cancellation and interruption, then a retry settles every target and spares unrelated evidence', async () => {
    const h = harness();
    let service = h.build();
    const kept = await seedArtifact(service, 'kept-1', { ownerRunId: 'run-kept' });
    service.addReference({ artifactId: 'kept-1', ownerType: 'run', ownerId: 'run-kept', purpose: 'active-recovery', protective: true });
    const audit = await seedArtifact(service, 'audit-1', { ownerRunId: 'run-audit', storeKind: 'audit' });
    const unrelated = await writeBytes(path.join(...CHECKPOINT_DIR, 'run-notes', 'notes.txt'), 'operator notes');
    const outside = await writeBytes(path.join('outside', 'evidence.txt'), 'evidence outside every root');

    // Disk full: the intent write fails, so nothing is unlinked and the operation stays resumable.
    const full = await seedArtifact(service, 'full-1', { ownerRunId: 'run-full' });
    const diskFull = new Proxy(h.conn, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property !== 'run') return (value as (...args: unknown[]) => unknown).bind(target);
        return (sql: string, ...params: unknown[]) => {
          if (sql.includes('UPDATE deletion_targets') && params.includes('executing')) {
            throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          }
          return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...params]);
        };
      }
    });
    const fullService = h.build({ conn: diskFull });
    const fullPreview = fullService.previewDeletion({ artifactIds: ['full-1'] });
    if (!fullPreview.ok) throw new Error('preview refused');
    const fullResult = await fullService.executeDeletion({
      artifactIds: ['full-1'],
      previewId: fullPreview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL
    });
    expect(refusalOf(fullResult)).toBe('unavailable');
    expect(await exists(full)).toBe(true);

    // Unlink denial: a real read-only directory makes unlink fail with EACCES.
    await seedArtifact(service, 'acl-1', { ownerRunId: 'run-acl-ok' });
    const denied = await seedArtifact(service, 'acl-2', { ownerRunId: 'run-acl' });
    const deniedDir = path.dirname(denied);
    await fs.chmod(deniedDir, READ_ONLY_DIR_MODE);
    try {
      const op = await previewAndExecute(service, ['acl-1', 'acl-2']);
      expect(op.state).toBe('partial');
      expect(outcomes(op)).toEqual({ 'acl-1': 'deleted', 'acl-2': 'retained' });
    } finally {
      await fs.chmod(deniedDir, OWNER_DIR_MODE);
    }
    expect(await exists(denied)).toBe(true);
    expect(availabilityOf(service, 'acl-2')).toBe('present');

    // Stale fence: another holder takes the lease mid-operation; the rest are refused.
    const fenced = await seedArtifact(service, 'fence-1', { ownerRunId: 'run-fence' });
    const fencedLater = await seedArtifact(service, 'fence-2', { ownerRunId: 'run-fence' });
    h.files.unlinkHooks.set(fenced, () => {
      h.conn.run(`UPDATE sweep_leases SET holder_id = 'someone-else'`);
    });
    const fenceOp = await previewAndExecute(service, ['fence-1', 'fence-2']);
    h.files.unlinkHooks.delete(fenced);
    expect(outcomes(fenceOp)).toEqual({ 'fence-1': 'deleted', 'fence-2': 'refused' });
    expect(fenceOp.targets.find((target) => target.artifactId === 'fence-2')).toEqual(
      expect.objectContaining({ reasonCode: 'stale-fence' })
    );
    expect(await exists(fencedLater)).toBe(true);
    // The other holder finishes and lets go.
    h.conn.run(`DELETE FROM sweep_leases WHERE holder_id = 'someone-else'`);

    // Link substitution: the planned file becomes a real symlink to evidence outside the root.
    const linkFirst = await seedArtifact(service, 'link-1', { ownerRunId: 'run-link' });
    const linked = await seedArtifact(service, 'link-2', { ownerRunId: 'run-link' });
    h.files.unlinkHooks.set(linkFirst, async () => {
      await fs.rm(linked);
      await fs.symlink(outside, linked);
    });
    const linkOp = await previewAndExecute(service, ['link-1', 'link-2']);
    h.files.unlinkHooks.delete(linkFirst);
    expect(outcomes(linkOp)).toEqual({ 'link-1': 'deleted', 'link-2': 'refused' });
    expect(linkOp.targets.find((target) => target.artifactId === 'link-2')).toEqual(
      expect.objectContaining({ reasonCode: 'containment-violation' })
    );
    expect(await fs.readFile(outside, 'utf8')).toBe('evidence outside every root');
    expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);

    // Cancellation: observed before the next target.
    const cancelFirst = await seedArtifact(service, 'cancel-1', { ownerRunId: 'run-cancel' });
    const cancelRest = [
      await seedArtifact(service, 'cancel-2', { ownerRunId: 'run-cancel' }),
      await seedArtifact(service, 'cancel-3', { ownerRunId: 'run-cancel' })
    ];
    const controller = new AbortController();
    h.files.unlinkHooks.set(cancelFirst, () => controller.abort());
    const cancelOp = await previewAndExecute(service, ['cancel-1', 'cancel-2', 'cancel-3'], controller.signal);
    h.files.unlinkHooks.delete(cancelFirst);
    expect(cancelOp.state).toBe('cancelled');
    expect(outcomes(cancelOp)).toEqual({ 'cancel-1': 'deleted', 'cancel-2': 'refused', 'cancel-3': 'refused' });
    for (const target of cancelRest) expect(await exists(target)).toBe(true);

    // Process interruption: the first unlink never settles; the host restarts past the lease TTL.
    const hungTarget = await seedArtifact(service, 'hung-1', { ownerRunId: 'run-hung' });
    const hungSibling = await seedArtifact(service, 'hung-2', { ownerRunId: 'run-hung' });
    let hung = true;
    h.files.unlinkHooks.set(hungTarget, () => (hung ? new Promise<void>(() => undefined) : undefined));
    const hungPreview = service.previewDeletion({ artifactIds: ['hung-1', 'hung-2'] });
    if (!hungPreview.ok) throw new Error('preview refused');
    void service.executeDeletion({
      artifactIds: ['hung-1', 'hung-2'],
      previewId: hungPreview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL
    });
    const executingRows = (): number =>
      h.conn.scalar<number>(`SELECT COUNT(*) FROM deletion_targets WHERE outcome = 'executing'`) ?? 0;
    await waitFor(() => executingRows() === 1, 'the interrupted unlink');
    hung = false;
    now += LEASE_TTL_MARGIN_MS;
    h.restart();
    service = h.build();

    // Retry: restart reconciliation resumes the interrupted and the disk-full operations under their own ids.
    const reconciled = await service.reconcileAfterRestart(FULL);
    if (!reconciled.ok) throw new Error(`reconcile refused: ${reconciled.refusal.code}`);
    expect(reconciled.value.resumedOperations).toHaveLength(2);
    expect(reconciled.value.diagnostics.map((entry) => entry.detail)).toEqual([
      'deletion operation resumed: completed',
      'deletion operation resumed: completed'
    ]);
    for (const target of [full, hungTarget, hungSibling]) expect(await exists(target)).toBe(false);

    // A fresh preview retries every target left retained or refused once its cause is gone.
    await fs.rm(linked);
    await fs.writeFile(linked, 'bytes of link-2\n');
    const retry = await previewAndExecute(service, undefined);
    expect(retry.state).toBe('completed');
    expect(outcomes(retry)).toEqual({
      'acl-2': 'deleted',
      'cancel-2': 'deleted',
      'cancel-3': 'deleted',
      'fence-2': 'deleted',
      'link-2': 'deleted'
    });
    expect(h.conn.scalar<number>(`SELECT COUNT(*) FROM deletion_operations WHERE state IN ('planned', 'executing')`)).toBe(0);

    // Unrelated evidence: protected, never-eligible, unregistered and outside bytes all remain.
    for (const target of [kept, audit, unrelated, outside]) expect(await exists(target), target).toBe(true);
    expect(availabilityOf(service, 'kept-1')).toBe('present');
    // Records outlive their bytes: every deleted target still answers, truthfully, as deleted.
    const deletedIds = ['full-1', 'acl-1', 'acl-2', 'fence-1', 'fence-2', 'link-1', 'link-2', 'cancel-1', 'cancel-2', 'cancel-3', 'hung-1', 'hung-2'];
    for (const id of deletedIds) expect(availabilityOf(service, id), id).toBe('deleted');
    expect(h.conn.scalar<number>('SELECT COUNT(*) FROM artifact_lifecycle')).toBe(deletedIds.length + 2);
  });

  it('F05-AC-06 preserves legacy version-before-manifest residue without a catalog writer or invented history', async () => {
    const catalogSegments = ['.schegent', 'catalog'] as const;
    const catalogDir = inWorkspace(...catalogSegments);
    const digest: Digest = {
      sha256: (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
    };
    const publishedBody = { name: 'alpha', steps: ['one'] };
    const residueBody = { name: 'alpha', steps: ['one', 'two'] };
    const frozenBody = { name: 'beta', steps: ['frozen'] };
    const residueId = 'residue:phase:alpha:v2';
    const frozenResidueId = 'residue:phase:beta:v1';
    const hashOf = (body: unknown): string => {
      const hashed = contentHashOf(body, digest);
      if (hashed.outcome !== 'hashed') throw new Error('fixture body must hash');
      return hashed.contentHash;
    };
    const recordText = (id: string, versionId: string, body: unknown): string =>
      `${JSON.stringify({ versionId, kind: 'phase', id, body }, null, 2)}\n`;
    const manifestText = (versions: readonly { versionId: string; body: unknown }[]): string =>
      `${JSON.stringify(
        {
          storeFormatVersion: 1,
          entries: [
            {
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
            }
          ]
        },
        null,
        2
      )}\n`;
    const writeCatalog = (segments: readonly string[], text: string): Promise<string> =>
      writeBytes(path.join(...catalogSegments, ...segments), text);
    const manifestPath = await writeCatalog(['manifest.json'], manifestText([{ versionId: 'v1', body: publishedBody }]));
    await writeCatalog(['phases', 'alpha', 'v1.json'], recordText('alpha', 'v1', publishedBody));
    const residuePath = await writeCatalog(['phases', 'alpha', 'v2.json'], recordText('alpha', 'v2', residueBody));
    const frozenPath = await writeCatalog(['phases', 'beta', 'v1.json'], recordText('beta', 'v1', frozenBody));
    const manifestBefore = await fs.readFile(manifestPath);
    const residueBytes = await fs.readFile(residuePath);

    const forbidden = (): never => {
      throw new Error('catalog writer called');
    };
    const inner = createCatalogFsAdapter({ workspaceRoot: workspace, storeRoot: catalogDir });
    const readOnly: CatalogFsPort = {
      readFile: (at) => inner.readFile(at),
      listDirectory: (at) => inner.listDirectory(at),
      checkWritability: () => inner.checkWritability(),
      writeFileAtomic: forbidden,
      writeFileIfAbsent: forbidden,
      removeFile: forbidden
    };
    const refKey = (ref: LegacyCatalogVersionRef): string => `${ref.kind}:${ref.id}:${ref.versionId}`;
    const legacyCatalog = (files: LegacyPreservationFs): LegacyCatalogDependencies => ({
      catalogRoot: { catalog: readOnly, digest, segments: catalogSegments },
      files,
      consumers: { consumersOf: (ref) => (refKey(ref) === 'phase:beta:v1' ? [{ kind: 'frozen' }] : []) }
    });
    const h = harness();
    const service = h.build({ legacyCatalog: legacyCatalog(createNodeLegacyPreservationFs(workspace)) });
    const quarantineRoot = inWorkspace('.schegent', 'quarantine');
    const quarantined = async (): Promise<readonly string[]> => {
      if (!(await exists(quarantineRoot))) return [];
      const entries = await fs.readdir(quarantineRoot, { recursive: true, withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
    };
    const previewId = async (target: ArtifactLifecycleService): Promise<string> => {
      const classified = await target.classifyLegacyCatalogResidue();
      if (!classified.ok) throw new Error(`classify refused: ${classified.refusal.code}`);
      const preview = await target.previewLegacyQuarantine(classified.value.basisRevision);
      if (!preview.ok) throw new Error(`quarantine preview refused: ${preview.refusal.code}`);
      return preview.value.previewId;
    };

    // Import: residue is classified, nothing is disposable, nothing moves by default.
    const classified = await service.classifyLegacyCatalogResidue();
    if (!classified.ok) throw new Error('classify refused');
    const residue = new Map(classified.value.residue.map((entry) => [entry.residueId, entry]));
    expect(residue.get(residueId)).toEqual(expect.objectContaining({ disposition: 'unresolved', outcome: 'preserved-in-place' }));
    expect(residue.get(frozenResidueId)).toEqual(expect.objectContaining({ disposition: 'protected' }));
    expect([...classified.value.versions, ...classified.value.residue].map((entry) => entry.disposition)).not.toContain(
      'disposable'
    );

    // A preview taken before the catalog changed authorizes nothing.
    const stalePreview = await previewId(service);
    const lateRecord = await writeCatalog(['phases', 'alpha', 'v3.json'], recordText('alpha', 'v3', residueBody));
    const stale = await service.quarantineLegacyResidue({ previewId: stalePreview, confirmation: 'confirmed', authority: FULL });
    expect(refusalOf(stale)).toBe('preview-stale');
    await fs.rm(lateRecord);

    // A version a frozen consumer still reads stays protected in place.
    const referenced = await service.quarantineLegacyResidue({
      previewId: await previewId(service),
      confirmation: 'confirmed',
      authority: FULL,
      residueIds: [frozenResidueId]
    });
    expect(refusalOf(referenced)).toBe('protected-reference');
    expect(await exists(frozenPath)).toBe(true);
    expect(await quarantined()).toEqual([]);

    // Re-import cannot invent published history: a version id or content already published refuses.
    const admits = () => ({ ok: true as const, value: true as const });
    const reimport = await service.previewLegacyReimport(residueId, { admits });
    expect(reimport.ok && reimport.value.versionId).toBe('v2');
    await fs.writeFile(
      manifestPath,
      manifestText([{ versionId: 'v1', body: publishedBody }, { versionId: 'v2', body: residueBody }])
    );
    expect(refusalOf(await service.previewLegacyReimport(residueId, { admits }))).toBe('identity-conflict');
    await fs.writeFile(
      manifestPath,
      manifestText([{ versionId: 'v1', body: publishedBody }, { versionId: 'v2', body: frozenBody }])
    );
    expect(refusalOf(await service.previewLegacyReimport(residueId, { admits }))).toBe('content-conflict');
    // Another writer's manifest is put back; the service itself never wrote it.
    await fs.writeFile(manifestPath, manifestBefore);

    // Interrupted after the copy: both files remain, and the restart leaves the residue ambiguous and recoverable.
    const real = createNodeLegacyPreservationFs(workspace);
    const interrupted = h.build({
      legacyCatalog: legacyCatalog({
        readBytes: (segments) => real.readBytes(segments),
        writeExclusive: (segments, bytes) => real.writeExclusive(segments, bytes),
        unlinkContained: () => Promise.reject(new Error('interrupted'))
      })
    });
    await expect(
      interrupted.quarantineLegacyResidue({
        previewId: await previewId(interrupted),
        confirmation: 'confirmed',
        authority: FULL,
        residueIds: [residueId]
      })
    ).rejects.toThrow('interrupted');
    const copies = await quarantined();
    expect(copies).toHaveLength(1);
    h.restart();
    const restarted = h.build({ legacyCatalog: legacyCatalog(createNodeLegacyPreservationFs(workspace)) });
    const reconciled = await restarted.reconcileAfterRestart(FULL);
    if (!reconciled.ok) throw new Error(`reconcile refused: ${reconciled.refusal.code}`);
    expect(reconciled.value.ambiguous).toBeGreaterThanOrEqual(1);
    expect(reconciled.value.diagnostics).toEqual([
      { code: 'ambiguous-preservation', artifactId: null, detail: 'preservation operation reconciled: ambiguous' }
    ]);
    expect(await fs.readFile(residuePath)).toEqual(residueBytes);
    for (const copy of copies) expect(await fs.readFile(copy)).toEqual(residueBytes);

    // No manifest write and no synthesized pointer, whatever happened above.
    expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
  });

  it('F05-AC-07 archives resolved terminal Tasks only after adoption, keeps unresolved ones and summaries, and reports reduced detail on expiry', async () => {
    const h = harness();
    const frames = new Map<string, readonly ControlFrameStatus[]>([['run-blocked', ['completed', 'paused']]]);
    const service = h.build({ runFrameStatuses: (runId) => frames.get(runId) ?? [] });
    const failedOutcome = 'failed: provider exited 137 (Opensend run, "quoted")';
    const task = (taskId: string, overrides: Partial<ArchivalTaskInput> = {}): ArchivalTaskInput => ({
      taskId,
      status: 'completed',
      runId: `run-${taskId}`,
      terminalResolvedAtMs: NOW - 40 * DAY_MS,
      outcome: 'completed',
      summary: { retryCount: 1, pipelineId: 'speckit' },
      retainedReferenceIds: ['ref-1'],
      ...overrides
    });
    const queues: readonly ArchivalQueueInput[] = [
      {
        queueId: 'q1',
        tasks: [
          task('completed-old'),
          task('failed-old', { status: 'failed', outcome: failedOutcome }),
          task('pending', { status: 'pending', terminalResolvedAtMs: null }),
          task('in-flight', { status: 'in-flight' }),
          task('paused', { status: 'paused' }),
          task('blocked', { runId: 'run-blocked' })
        ]
      }
    ];
    const archive = () => {
      const preview = service.previewTaskArchival(queues);
      if (!preview.ok) throw new Error(`archival preview refused: ${preview.refusal.code}`);
      return service.archiveTerminalTasks({ previewId: preview.value.previewId, confirmation: 'confirmed', authority: FULL, queues });
    };

    expect(archive()).toEqual({ ok: true, value: { archived: 0, skipped: 0, removalSet: [] } });

    const policyPreview = service.previewRetentionPolicy(DEFAULT_RETENTION_POLICY);
    if (!policyPreview.ok) throw new Error('policy preview refused');
    const adopted = service.adoptRetentionPolicy({
      previewId: policyPreview.value.previewId,
      confirmation: 'confirmed',
      authority: FULL,
      policy: DEFAULT_RETENTION_POLICY
    });
    expect(adopted.ok).toBe(true);

    const archived = archive();
    if (!archived.ok) throw new Error(`archive refused: ${archived.refusal.code}`);
    expect(archived.value.archived).toBe(2);
    expect(archived.value.skipped).toBe(1);
    expect(archived.value.removalSet.map((entry) => entry.taskId).sort()).toEqual(['completed-old', 'failed-old']);

    const listed = service.listArchivedTasks({ queueId: 'q1' });
    if (!listed.ok) throw new Error('list refused');
    const byTask = new Map(listed.value.entries.map((entry) => [entry.taskId, entry]));
    expect(byTask.get('failed-old')).toEqual(
      expect.objectContaining({
        outcome: failedOutcome,
        summary: { retryCount: 1, pipelineId: 'speckit' },
        retainedReferenceIds: ['ref-1'],
        detailState: 'retained',
        coverage: 'full'
      })
    );
    expect([...byTask.keys()].sort()).toEqual(['completed-old', 'failed-old']);

    // Past the detail expiry the rows remain, labelled, with only their aggregates.
    now = NOW + 60 * DAY_MS;
    const expiredView = service.listArchivedTasks({ queueId: 'q1' });
    if (!expiredView.ok) throw new Error('list refused');
    for (const entry of expiredView.value.entries) {
      expect(entry).toEqual(
        expect.objectContaining({ detailState: 'expired', coverage: 'aggregates-only', summary: {}, retainedReferenceIds: [] })
      );
    }
    expect(service.expireArchivedDetail()).toEqual({ ok: true, value: { expired: 2 } });
    const afterExpiry = service.listArchivedTasks({ queueId: 'q1' });
    if (!afterExpiry.ok) throw new Error('list refused');
    expect(afterExpiry.value.entries.map((entry) => entry.outcome).sort()).toEqual(['completed', failedOutcome].sort());
  });

  it('F05-AC-08 deletes no protected bytes when storage is full of pinned artifacts, makes admission explicit, and keeps settlement possible', async () => {
    const h = harness();
    const pinnedRuns = new Set(['run-pinned']);
    const service = h.build({ pinnedRunIds: pinnedRuns, storageTargetBytes: 16 });
    const targets = [
      await seedArtifact(service, 'pinned-1', { ownerRunId: 'run-pinned' }),
      await seedArtifact(service, 'pinned-2', { ownerRunId: 'run-pinned' }),
      await seedArtifact(service, 'held-1', { ownerRunId: 'run-held' })
    ];
    const hold = { artifactId: 'held-1', ownerType: 'run', ownerId: 'run-held', purpose: 'active-recovery' } as const;
    expect(service.addReference({ ...hold, protective: true }).ok).toBe(true);

    const report = service.getPressureReport();
    if (!report.ok) throw new Error('pressure refused');
    expect(report.value.overTarget).toBe(true);
    expect(report.value.admission).toEqual(
      expect.objectContaining({ behavior: 'shared-admission', evictsRecoveryDependencies: false, settlementReservePreserved: true })
    );
    expect(report.value.admission.sharedAdmission).toContain('checkPinQuotaAdmission');
    expect(report.value.perClass.reduce((sum, line) => sum + line.reclaimableBytes, 0)).toBe(0);

    const preview = service.previewDeletion({});
    if (!preview.ok) throw new Error('preview refused');
    expect(preview.value.summary.affectedCount).toBe(0);
    expect(preview.value.summary.protectedCount).toBe(3);
    const op = await previewAndExecute(service, undefined);
    expect(op.targets).toEqual([]);
    for (const target of targets) expect(await exists(target)).toBe(true);

    // Settlement still writes: a new record registers and an owner releases its hold.
    await seedArtifact(service, 'settlement-1', { ownerRunId: 'run-pinned', retentionClass: DETAIL_CLASS, storeKind: 'report' });
    expect(service.releaseReference({ ...hold, reason: 'owner-durable' }).ok).toBe(true);
    const relieved = service.getPressureReport();
    expect(relieved.ok && relieved.value.admission.behavior).toBe('reclaim-eligible-only');
  });

  it('F05-AC-09 gives the sidebar and headless API one answer, refuses an untrusted workspace, survives a restart mid-migration and preserves a future-version store', async () => {
    const h = harness();
    const service = h.build();
    const uiTarget = await seedArtifact(service, 'ui-1');
    await seedArtifact(service, 'ui-2', { ownerRunId: 'run-2' });
    await writeBytes(path.join(...CHECKPOINT_DIR, 'run-3', 'loose.patch'), 'loose');
    const scanned = await service.scanDeclaredRoots();
    expect(scanned.ok).toBe(true);

    const viaSidebar = async (cursor?: string): Promise<CommandAckMessage> => {
      const acks: CommandAckMessage[] = [];
      const ctx = {
        deps: {
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: (s: string) => s },
          storageDetails: createStorageDetailsReader(service)
        },
        postAck: async (msg: CommandAckMessage) => {
          acks.push(msg);
          return true;
        },
        correlationId: 'acceptance-1'
      } as unknown as Parameters<typeof readStorageDetails>[0];
      const command = {
        type: CMD_READ_STORAGE_DETAILS,
        correlationId: 'acceptance-1',
        payload: cursor === undefined ? {} : { cursor }
      } as ReadStorageDetailsCommand;
      await readStorageDetails(ctx, command);
      const ack = acks.at(0);
      if (acks.length !== 1 || ack === undefined) throw new Error('expected exactly one ack');
      return ack;
    };
    const resultOf = (ack: CommandAckMessage): unknown => (ack as unknown as { result: unknown }).result;

    const pressure = getStoragePressure(service);
    const page = getStorageInventory(service);
    if (!pressure.ok || !page.ok) throw new Error('headless read refused');
    expect(resultOf(await viaSidebar())).toEqual({ ok: true, value: { pressure: pressure.value, page: page.value } });
    const badCursor = getStorageInventory(service, { cursor: 'not_a_real_cursor' });
    expect(badCursor.ok).toBe(false);
    expect(resultOf(await viaSidebar('not_a_real_cursor'))).toEqual(badCursor);

    // An untrusted workspace may read but never mutate.
    const preview = previewArtifactDeletion(service, { artifactIds: ['ui-1'] });
    if (!preview.ok) throw new Error('preview refused');
    const untrusted = await executeArtifactDeletion(service, {
      artifactIds: ['ui-1'],
      previewId: preview.value.previewId,
      confirmation: 'confirmed',
      authority: { ...FULL, trusted: false }
    });
    expect(refusalOf(untrusted)).toBe('untrusted-workspace');
    expect(await exists(uiTarget)).toBe(true);
    expect(h.conn.scalar<number>('SELECT COUNT(*) FROM deletion_operations')).toBe(0);

    // Restart during the index migration: v1 holds F04 rows; migration 2 dies part-way; a re-open completes it.
    const migratingPath = inWorkspace('.schegent', 'migrating.db');
    const body = 'f04 transcript body\n';
    const bodyPath = await writeBytes(path.join('.schegent', 'artifacts', 'f04-1.txt'), body);
    const v1Only = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version === 1);
    const firstOpen = openStore(migratingPath);
    expect(SchemaBootstrapService.bootstrapAndMigrate(firstOpen, () => now, v1Only).appliedMigrations).toEqual([1]);
    insertF04Artifact(firstOpen, 'f04-1', body);
    const rowsBefore = f04Rows(firstOpen);
    const dying = [
      ...v1Only,
      {
        version: F05_LIFECYCLE_MIGRATION_VERSION,
        name: F05_LIFECYCLE_MIGRATION_NAME,
        ddlStatements: [...F05_LIFECYCLE_DDL.slice(0, 2), 'CREATE TABLE interrupted_here (']
      }
    ];
    expect(() => SchemaBootstrapService.bootstrapAndMigrate(firstOpen, () => now, dying)).toThrow();
    closeStore(firstOpen);

    const reopened = openStore(migratingPath);
    const tableNamed = (name: string): number =>
      reopened.scalar<number>(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name) ?? -1;
    expect(tableNamed('artifact_lifecycle')).toBe(0);
    expect(SchemaBootstrapService.bootstrapAndMigrate(reopened, () => now).appliedMigrations).toEqual([2]);
    expect(tableNamed('artifact_lifecycle')).toBe(1);
    expect(f04Rows(reopened)).toEqual(rowsBefore);
    expect(reopened.scalar<string>(`SELECT content_sha256 FROM artifacts WHERE artifact_id = 'f04-1'`)).toBe(
      sha256Hex(await fs.readFile(bodyPath))
    );

    // A store written by a newer schema is refused and left exactly as it was.
    reopened.run(`UPDATE schema_meta SET meta_value = '3' WHERE meta_key = 'schema_version'`);
    closeStore(reopened);
    const future = openStore(migratingPath);
    expect(() => SchemaBootstrapService.bootstrapAndMigrate(future, () => now)).toThrow(/UNSUPPORTED_FUTURE_SCHEMA_VERSION/);
    expect(future.scalar<string>(`SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`)).toBe('3');
    expect(f04Rows(future)).toEqual(rowsBefore);
  });

  it('F05-AC-10 delivers a pinned report only to the authorized attempt and session, and leaves no permanent pin', async () => {
    const attemptId = 'attempt-1';
    const sessionId = 'session-1';
    const policy: ArtifactAccessPolicy = {
      admits: (request) => request.attemptId === attemptId && request.sessionId === sessionId
    };
    const h = harness();
    const service = h.build({ accessPolicy: policy });
    const body = 'phase report body\n';
    const reportRel = path.join(...REPORT_DIR, 'report-1.md');
    const reportPath = await seedArtifact(service, 'report-1', {
      relpath: reportRel,
      body,
      retentionClass: REPORT_CLASS,
      storeKind: 'report'
    });
    const added = service.addReference({
      artifactId: 'report-1',
      ownerType: 'attempt',
      ownerId: attemptId,
      purpose: 'phase-context',
      protective: true
    });
    expect(added.ok).toBe(true);
    const referencesBefore = h.conn.scalar<number>('SELECT COUNT(*) FROM artifact_references');
    const request: QualifyAccessRequest = {
      artifactId: 'report-1',
      expectedDigest: { algorithm: 'sha256', value: sha256Hex(body) },
      attemptId,
      sessionId,
      mode: 'embed'
    };

    const embedded = await service.qualifyAccess(request);
    if (!embedded.ok) throw new Error(`qualify refused: ${embedded.refusal.code}`);
    expect(embedded.value).toEqual(
      expect.objectContaining({ artifactId: 'report-1', mode: 'embed', sessionScope: { attemptId, sessionId } })
    );
    const read = await service.qualifyAccess({ ...request, mode: 'read' });
    expect(read.ok && read.value.mode).toBe('read');

    expect(refusalOf(await service.qualifyAccess({ ...request, sessionId: 'session-2' }))).toBe('access-denied');
    const forgedUri = { ...request, artifactId: `file://${reportPath}` };
    expect(refusalOf(await service.qualifyAccess(forgedUri))).toBe('invalid-input');
    const smuggledUri = { ...request, uri: `file://${reportPath}` } as unknown as QualifyAccessRequest;
    expect(refusalOf(await service.qualifyAccess(smuggledUri))).toBe('invalid-input');

    const copies = inWorkspace('.schegent', 'copies');
    await fs.mkdir(copies, { recursive: true });
    const copy = await service.materializeCopy(embedded.value, copies);
    if (!copy.ok) throw new Error(`copy refused: ${copy.refusal.code}`);
    expect(copy.value.expiresAtMs).toBe(now + MATERIALIZED_COPY_DEFAULT_TTL_MS);
    const copyPath = path.join(copies, copy.value.fileName);
    expect(await fs.readFile(copyPath, 'utf8')).toBe(body);
    expect((await fs.stat(copyPath)).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    const forgedHandle = { ...embedded.value, sessionScope: { attemptId: 'attempt-2', sessionId } };
    expect(refusalOf(await service.materializeCopy(forgedHandle, copies))).toBe('access-denied');

    // No session history leaves a reference row or a pin without an expiry.
    expect(h.conn.scalar<number>('SELECT COUNT(*) FROM artifact_references')).toBe(referencesBefore);
    expect(h.conn.scalar<number>('SELECT COUNT(*) FROM artifact_pins WHERE expires_at_ms IS NULL')).toBe(0);

    now = copy.value.expiresAtMs;
    expect(refusalOf(service.resolveMaterializedCopy(copy.value.copyId))).toBe('unavailable');

    // Changed bytes on disk: the expected digest no longer matches what is stored.
    await fs.writeFile(reportPath, 'phase report BODY\n');
    expect(refusalOf(await service.qualifyAccess(request))).toBe('content-conflict');
    expect(availabilityOf(service, 'report-1')).toBe('corrupt');
  });
});
