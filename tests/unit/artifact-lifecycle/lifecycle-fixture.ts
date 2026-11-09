// FR-R6-F05 (US2) — shared fixture for the inventory, pressure and deletion
// suites: an in-memory SQLite store, a fake `LifecycleFs` that records every
// call and can inject faults, and a service builder.
//
// The fake keeps one map of absolute paths. A symlink resolves one level to
// its `linkTo`; a missing path makes `realpath` throw ENOENT, as Node does.

import type { RunFrameStatusLookup } from '../../../src/contracts/artifact-lifecycle/retention-policy-types';
import * as path from 'node:path';
import type { MutationAuthority } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactLifecycleService,
  type LifecycleAuditRecord,
  type LifecycleFs,
  type LifecycleFsEntry,
  type OwnerResolution,
  type RegisterArtifactInput,
  type StorageScanRoot
} from '../../../src/services/artifact-lifecycle';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

export const NOW = 1_800_000_000_000;
export const FULL: MutationAuthority = { trusted: true, primary: true, auditHealthy: true };
export const WORKSPACE_ROOT = '/ws';
export const CHECKPOINT_ROOT = '/ws/.schegent/checkpoints';
export const SESSION_ROOT = '/ws/.schegent/sessions';
export const CHECKPOINT_CLASS = 'transcripts-diagnostics-checkpoints-audit-catalog' as const;

/** Checkpoint layout: `<root>/<runId>/<file>`; anything else matches no pattern. */
export const CHECKPOINT_SCAN_ROOT: StorageScanRoot = {
  rootId: 'checkpoints',
  root: CHECKPOINT_ROOT,
  retentionClass: CHECKPOINT_CLASS,
  storeKind: 'checkpoint',
  ownerRunId: (segments) => (segments.length === 2 ? segments.at(0) : undefined)
};

interface FakeNode {
  readonly kind: 'file' | 'symlink' | 'other';
  readonly sizeBytes: number;
  readonly linkTo?: string;
}

export type FsCall = readonly [op: 'lstat' | 'readdir' | 'realpath' | 'unlink', target: string];

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** In-memory `LifecycleFs`. Directories are implied by the files below them, or added explicitly. */
export class FakeFs implements LifecycleFs {
  public readonly calls: FsCall[] = [];
  public readonly unlinked: string[] = [];
  /** Per-path unlink behaviour; the hook runs before the default removal. */
  public readonly unlinkHooks = new Map<string, () => Promise<void> | void>();
  public readonly readdirErrors = new Set<string>();
  /** Runs before each `readdir`; a test aborts a scan mid-walk from here. */
  public beforeReaddir: ((absolutePath: string) => void) | undefined;
  private readonly nodes = new Map<string, FakeNode>();
  private readonly dirs = new Set<string>();

  public file(absolutePath: string, sizeBytes = 40): this {
    this.nodes.set(absolutePath, { kind: 'file', sizeBytes });
    this.addParents(absolutePath);
    return this;
  }

  public symlink(absolutePath: string, linkTo: string): this {
    this.nodes.set(absolutePath, { kind: 'symlink', sizeBytes: 12, linkTo });
    this.addParents(absolutePath);
    return this;
  }

  public dir(absolutePath: string): this {
    this.dirs.add(absolutePath);
    this.addParents(absolutePath);
    return this;
  }

  public remove(absolutePath: string): void {
    this.nodes.delete(absolutePath);
  }

  public has(absolutePath: string): boolean {
    return this.nodes.has(absolutePath);
  }

  public lstat(absolutePath: string): Promise<LifecycleFsEntry | null> {
    this.calls.push(['lstat', absolutePath]);
    const node = this.nodes.get(absolutePath);
    if (node !== undefined) return Promise.resolve({ kind: node.kind, sizeBytes: node.sizeBytes, mtimeMs: NOW });
    if (this.dirs.has(absolutePath)) return Promise.resolve({ kind: 'directory', sizeBytes: 0, mtimeMs: NOW });
    return Promise.resolve(null);
  }

  public readdir(absolutePath: string): Promise<readonly string[]> {
    this.calls.push(['readdir', absolutePath]);
    this.beforeReaddir?.(absolutePath);
    if (this.readdirErrors.has(absolutePath)) return Promise.reject(errno('EACCES'));
    const names = new Set<string>();
    for (const candidate of [...this.nodes.keys(), ...this.dirs]) {
      if (path.dirname(candidate) === absolutePath) names.add(path.basename(candidate));
    }
    return Promise.resolve([...names].sort());
  }

  public realpath(absolutePath: string): Promise<string> {
    this.calls.push(['realpath', absolutePath]);
    const node = this.nodes.get(absolutePath);
    if (node?.linkTo !== undefined) return Promise.resolve(node.linkTo);
    if (node !== undefined || this.dirs.has(absolutePath)) return Promise.resolve(absolutePath);
    return Promise.reject(errno('ENOENT'));
  }

  public async unlink(absolutePath: string): Promise<void> {
    this.calls.push(['unlink', absolutePath]);
    const hook = this.unlinkHooks.get(absolutePath);
    if (hook !== undefined) await hook();
    if (!this.nodes.has(absolutePath)) throw errno('ENOENT');
    this.nodes.delete(absolutePath);
    this.unlinked.push(absolutePath);
  }

  public touched(absolutePath: string): boolean {
    return this.calls.some(([, target]) => target === absolutePath);
  }

  private addParents(absolutePath: string): void {
    let current = path.dirname(absolutePath);
    while (current !== path.dirname(current)) {
      this.dirs.add(current);
      current = path.dirname(current);
    }
    this.dirs.add(current);
  }
}

export function fsError(code: string): Error {
  return errno(code);
}

export interface BuildOptions {
  readonly scanRoots?: readonly StorageScanRoot[];
  readonly pinnedRunIds?: ReadonlySet<string>;
  readonly storageTargetBytes?: number;
  readonly nowMs?: number;
  readonly conn?: NodeSqliteConnection;
  readonly runFrameStatuses?: RunFrameStatusLookup;
}

export interface LifecycleFixture {
  readonly conn: NodeSqliteConnection;
  readonly fs: FakeFs;
  readonly audits: LifecycleAuditRecord[];
  readonly owners: Map<string, OwnerResolution>;
  build(options?: BuildOptions): ArtifactLifecycleService;
}

export function lifecycleFixture(): LifecycleFixture {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  const fs = new FakeFs();
  const audits: LifecycleAuditRecord[] = [];
  const owners = new Map<string, OwnerResolution>();
  let next = 0;
  const build = (options: BuildOptions = {}): ArtifactLifecycleService => {
    const pinned = options.pinnedRunIds ?? new Set<string>();
    const now = options.nowMs ?? NOW;
    return createArtifactLifecycleService({
      conn: options.conn ?? conn,
      nowMs: () => now,
      fs,
      probe: {
        observe: () => Promise.resolve({ exists: true, sizeBytes: 40, producerIdentity: 'writer', generation: null }),
        digestSha256: () => Promise.resolve(null)
      },
      audit: { recordLifecycleMutation: (record) => audits.push(record) },
      scanRoots: options.scanRoots ?? [CHECKPOINT_SCAN_ROOT],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: (ownerType, ownerId) => owners.get(`${ownerType}:${ownerId}`) ?? 'live',
      newId: () => `id-${(next += 1)}`,
      workspaceRoot: WORKSPACE_ROOT,
      pinnedRunIds: () => pinned,
      ...(options.storageTargetBytes === undefined ? {} : { storageTargetBytes: options.storageTargetBytes }),
      ...(options.runFrameStatuses === undefined ? {} : { runFrameStatuses: options.runFrameStatuses })
    });
  };
  return { conn, fs, audits, owners, build };
}

/** A registered checkpoint artifact whose bytes sit at `<CHECKPOINT_ROOT>/<runId>/<artifactId>.patch`. */
export function checkpointArtifact(
  artifactId: string,
  overrides: Partial<RegisterArtifactInput> = {}
): RegisterArtifactInput {
  const runId = overrides.ownerRunId ?? 'run-1';
  return {
    artifactId,
    ownerRunId: runId,
    sensitivity: 'content',
    retentionClass: CHECKPOINT_CLASS,
    storeKind: 'checkpoint',
    immutability: 'immutable',
    digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    byteSize: 40,
    mediaType: 'application/octet-stream',
    displayName: 'checkpoint',
    producerIdentity: 'writer',
    locator: { storageTier: 'workspace_file', uriOrRelpath: `.schegent/checkpoints/${runId}/${artifactId}.patch` },
    ...overrides
  };
}

export function checkpointPath(artifactId: string, runId = 'run-1'): string {
  return `${CHECKPOINT_ROOT}/${runId}/${artifactId}.patch`;
}

/** Registers the artifact and creates its bytes in the fake filesystem. */
export function seedCheckpoint(
  service: ArtifactLifecycleService,
  fs: FakeFs,
  artifactId: string,
  overrides: Partial<RegisterArtifactInput> = {}
): void {
  const input = checkpointArtifact(artifactId, overrides);
  const registered = service.registerArtifact(input);
  if (!registered.ok) throw new Error(`seed failed: ${registered.refusal.code}`);
  fs.file(path.resolve(WORKSPACE_ROOT, input.locator.uriOrRelpath), input.byteSize);
}
