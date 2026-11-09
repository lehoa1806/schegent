import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PINS_PER_OWNER_MAX,
  LIFECYCLE_DIAGNOSTIC_DETAIL_MAX_CHARS,
  type MutationAuthority
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactLifecycleService,
  type LifecycleAuditRecord,
  type OwnerResolution,
  type RegisterArtifactInput
} from '../../../src/services/artifact-lifecycle';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const FULL: MutationAuthority = { trusted: true, primary: true, auditHealthy: true };

interface Harness {
  readonly conn: NodeSqliteConnection;
  readonly audits: LifecycleAuditRecord[];
  readonly owners: Map<string, OwnerResolution>;
  build(): ArtifactLifecycleService;
}

function harness(): Harness {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  const audits: LifecycleAuditRecord[] = [];
  const owners = new Map<string, OwnerResolution>();
  let next = 0;
  const build = (): ArtifactLifecycleService =>
    createArtifactLifecycleService({
      conn,
      nowMs: () => NOW,
      fs: {
        lstat: () => Promise.resolve(null),
        readdir: () => Promise.resolve([]),
        realpath: (p) => Promise.resolve(p),
        unlink: () => Promise.resolve()
      },
      probe: {
        observe: () => Promise.resolve({ exists: true, sizeBytes: 10, producerIdentity: 'w', generation: null }),
        digestSha256: () => Promise.resolve(null)
      },
      audit: { recordLifecycleMutation: (record) => audits.push(record) },
      scanRoots: [],
      accessPolicy: DENY_ALL_ACCESS_POLICY,
      resolveOwner: (ownerType, ownerId) => owners.get(`${ownerType}:${ownerId}`) ?? 'live',
      newId: () => `id-${(next += 1)}`
    });
  return { conn, audits, owners, build };
}

function artifact(artifactId: string): RegisterArtifactInput {
  return {
    artifactId,
    ownerRunId: 'run-1',
    sensitivity: 'content',
    retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
    storeKind: 'checkpoint',
    immutability: 'immutable',
    digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    byteSize: 40,
    mediaType: 'application/octet-stream',
    displayName: 'checkpoint',
    producerIdentity: 'writer',
    locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/checkpoints/run-1/patch' }
  };
}

const PAUSED_PIN = {
  artifactId: 'art-1',
  ownerType: 'run',
  ownerId: 'run-1',
  purpose: 'paused-recovery',
  protective: true
} as const;

function referenceRows(conn: NodeSqliteConnection): number {
  return conn.scalar<number>('SELECT COUNT(*) FROM artifact_references') ?? -1;
}

describe('FR-R6-F05 durable references (AC-02, FR-004..FR-007)', () => {
  it('adds and releases idempotently by natural key', () => {
    const h = harness();
    try {
      const service = h.build();
      expect(service.registerArtifact(artifact('art-1')).ok).toBe(true);
      const first = service.addReference(PAUSED_PIN);
      const second = service.addReference(PAUSED_PIN);
      expect(first.ok && second.ok).toBe(true);
      expect(first.ok && second.ok && second.value).toEqual(first.ok && first.value);
      expect(referenceRows(h.conn)).toBe(1);

      const release = { ...PAUSED_PIN, reason: 'owner-durable' } as const;
      const released = service.releaseReference(release);
      const again = service.releaseReference(release);
      expect(released.ok && released.value.active).toBe(false);
      expect(again.ok && again.value).toEqual(released.ok && released.value);
      expect(referenceRows(h.conn)).toBe(1);
    } finally {
      h.conn.close();
    }
  });

  it('upgrades an active non-protective reference when the same key is added as protective', () => {
    const h = harness();
    try {
      const service = h.build();
      expect(service.registerArtifact(artifact('art-1')).ok).toBe(true);
      const weak = service.addReference({ ...PAUSED_PIN, protective: false });
      const strong = service.addReference(PAUSED_PIN);
      expect(weak.ok && weak.value.protective).toBe(false);
      expect(strong.ok && strong.value.protective).toBe(true);
      expect(strong.ok && weak.ok && strong.value.referenceId).toBe(weak.ok && weak.value.referenceId);
      expect(referenceRows(h.conn)).toBe(1);
      const repeat = service.addReference({ ...PAUSED_PIN, protective: false });
      expect(repeat.ok && repeat.value.protective).toBe(true);
    } finally {
      h.conn.close();
    }
  });

  it('admits pins through the F02 quota and refuses the 65th for one owner', () => {
    const h = harness();
    try {
      const service = h.build();
      for (let index = 0; index <= ARTIFACT_PINS_PER_OWNER_MAX; index += 1) {
        expect(service.registerArtifact(artifact(`art-${index}`)).ok).toBe(true);
      }
      for (let index = 0; index < ARTIFACT_PINS_PER_OWNER_MAX; index += 1) {
        expect(service.addReference({ ...PAUSED_PIN, artifactId: `art-${index}` }).ok).toBe(true);
      }
      const refused = service.addReference({ ...PAUSED_PIN, artifactId: `art-${ARTIFACT_PINS_PER_OWNER_MAX}` });
      expect(refused.ok || refused.refusal.code).toBe('pin-quota-reached');
      expect(referenceRows(h.conn)).toBe(ARTIFACT_PINS_PER_OWNER_MAX);
    } finally {
      h.conn.close();
    }
  });

  it('keeps a paused owner protected after a restart', () => {
    const h = harness();
    try {
      const before = h.build();
      before.registerArtifact(artifact('art-1'));
      before.addReference(PAUSED_PIN);
      const restarted = h.build();
      expect(restarted.isProtected('art-1')).toEqual({ protected: true, diagnostic: null });
      expect(restarted.protectedRunIds()).toEqual(new Set(['run-1']));
    } finally {
      h.conn.close();
    }
  });

  it('fails closed with one bounded diagnostic on an unresolved owner or an unknown store version', () => {
    const h = harness();
    try {
      const service = h.build();
      service.registerArtifact(artifact('art-1'));
      service.addReference({ ...PAUSED_PIN, ownerType: 'export', ownerId: 'exp-1', purpose: 'report-lease', protective: false });
      expect(service.isProtected('art-1')).toEqual({ protected: false, diagnostic: null });

      h.owners.set('export:exp-1', 'unresolved');
      const unresolved = service.isProtected('art-1');
      expect(unresolved.protected).toBe(true);
      expect(unresolved.diagnostic?.code).toBe('ownership-unresolved');
      expect(unresolved.diagnostic?.artifactId).toBe('art-1');
      expect((unresolved.diagnostic?.detail ?? '').length).toBeLessThanOrEqual(LIFECYCLE_DIAGNOSTIC_DETAIL_MAX_CHARS);

      h.owners.clear();
      h.conn.run(
        `INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at_ms) VALUES (99, 'future', ?, ?)`,
        'f'.repeat(64),
        NOW
      );
      const future = service.isProtected('art-1');
      expect(future.protected).toBe(true);
      expect(future.diagnostic?.code).toBe('unknown-version');
    } finally {
      h.conn.close();
    }
  });

  it('requires a preview naming the surrendered capability before an early release', () => {
    const h = harness();
    try {
      const service = h.build();
      service.registerArtifact(artifact('art-1'));
      const added = service.addReference(PAUSED_PIN);
      if (!added.ok) throw new Error('setup');
      const referenceId = added.value.referenceId;

      const blind = service.releaseReferenceEarly({ referenceId, previewId: 'none', confirmation: 'confirmed', authority: FULL });
      expect(blind.ok || blind.refusal.code).toBe('preview-required');
      expect(h.audits).toEqual([]);

      const preview = service.previewEarlyRelease(referenceId);
      if (!preview.ok) throw new Error('preview');
      expect(preview.value.kind).toBe('early-release');
      expect(preview.value.summary.notes.join(' ')).toContain('resume of a paused run');

      const released = service.releaseReferenceEarly({
        referenceId,
        previewId: preview.value.previewId,
        confirmation: 'confirmed',
        authority: FULL
      });
      expect(released.ok && released.value.releaseReason).toBe('operator-early-release');
      expect(h.audits.map((record) => record.operationKind)).toEqual(['early-release']);
      expect(service.isProtected('art-1')).toEqual({ protected: false, diagnostic: null });
    } finally {
      h.conn.close();
    }
  });

  it('keeps references independent of the F04 runs table', () => {
    const h = harness();
    try {
      const targets = h.conn
        .all<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list('artifact_references')`)
        .map((row) => row.table);
      expect(targets).toEqual(['artifacts']);
    } finally {
      h.conn.close();
    }
  });
});
