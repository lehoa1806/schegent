import { describe, expect, it } from 'vitest';
import {
  ArtifactRecordStore,
  type ArtifactByteObservation,
  type ArtifactByteProbe,
  type ArtifactLocator,
  type RegisterArtifactInput
} from '../../../src/services/artifact-lifecycle/artifact-records';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const DIGEST = 'b'.repeat(64);
const OTHER_DIGEST = 'c'.repeat(64);

function openStore(): { conn: NodeSqliteConnection; records: ArtifactRecordStore } {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  return { conn, records: new ArtifactRecordStore(conn, () => NOW) };
}

function immutableInput(artifactId: string): RegisterArtifactInput {
  return {
    artifactId,
    ownerRunId: 'run-1',
    ownerAttemptId: 'attempt-1',
    sensitivity: 'content',
    retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
    storeKind: 'transcript',
    immutability: 'immutable',
    digest: { algorithm: 'sha256', value: DIGEST },
    byteSize: 10,
    mediaType: 'text/plain',
    displayName: 'transcript',
    producerIdentity: 'writer-a',
    locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/someone/secret/transcript.txt' }
  };
}

function growingInput(artifactId: string): RegisterArtifactInput {
  return {
    ...immutableInput(artifactId),
    storeKind: 'live-log-segment',
    immutability: 'growing',
    digest: undefined,
    generation: 3,
    extentBytes: 100,
    byteSize: 100,
    locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/logs/segment.log' }
  };
}

class FakeProbe implements ArtifactByteProbe {
  public observation: ArtifactByteObservation = { exists: true, sizeBytes: 10, producerIdentity: 'writer-a', generation: null };
  public digest: string | null = DIGEST;
  public seenLocators: string[] = [];
  public onObserve: (() => void) | undefined;

  public observe(locator: ArtifactLocator): Promise<ArtifactByteObservation> {
    this.seenLocators.push(locator.uriOrRelpath);
    this.onObserve?.();
    return Promise.resolve(this.observation);
  }

  public digestSha256(): Promise<string | null> {
    return Promise.resolve(this.digest);
  }
}

function insertReference(conn: NodeSqliteConnection, artifactId: string): void {
  conn.run(
    `INSERT INTO artifact_references (reference_id, artifact_id, owner_type, owner_id, purpose, protective,
       created_revision, created_at_ms) VALUES (?, ?, 'run', 'run-1', 'active-recovery', 1, 1, ?)`,
    `ref-${artifactId}`,
    artifactId,
    NOW
  );
}

function referenceCount(conn: NodeSqliteConnection, artifactId: string): number {
  return conn.get<{ n: number }>(`SELECT count(*) AS n FROM artifact_references WHERE artifact_id = ?`, artifactId)?.n ?? -1;
}

describe('FR-R6-F05 artifact records (AC-01, FR-001..003, FR-022)', () => {
  it('registers an immutable artifact with its digest and an opaque identity', () => {
    const { conn, records } = openStore();
    try {
      const result = records.register(immutableInput('art-imm'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        artifactId: 'art-imm',
        managed: true,
        lifecycleRevision: 1,
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: DIGEST },
        generation: null,
        availability: 'present',
        ownerRunId: 'run-1'
      });
      expect(conn.get<{ n: number }>(`SELECT count(*) AS n FROM artifact_availability`)?.n).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('registers a growing artifact with generation and extent and no digest', () => {
    const { conn, records } = openStore();
    try {
      const result = records.register(growingInput('art-grow'));
      expect(result.ok && result.value).toMatchObject({
        immutability: 'growing',
        digest: null,
        generation: 3,
        extentBytes: 100
      });
    } finally {
      conn.close();
    }
  });

  it('refuses an immutable artifact without a digest and a growing artifact with one', () => {
    const { conn, records } = openStore();
    try {
      const noDigest = records.register({ ...immutableInput('art-a'), digest: undefined });
      expect(noDigest.ok || noDigest.refusal.code).toBe('invalid-input');
      const growingWithDigest = records.register({
        ...growingInput('art-b'),
        digest: { algorithm: 'sha256', value: DIGEST }
      });
      expect(growingWithDigest.ok || growingWithDigest.refusal.code).toBe('invalid-input');
      expect(conn.get<{ n: number }>(`SELECT count(*) AS n FROM artifacts`)?.n).toBe(0);
    } finally {
      conn.close();
    }
  });

  it.each([
    ['an absolute path', '/Users/someone/secret/transcript.txt'],
    ['a parent traversal', '../outside/transcript.txt'],
    ['an inner parent traversal', '.schegent/../../outside/transcript.txt'],
    ['a backslash traversal', '.schegent\\..\\..\\outside.txt'],
    ['a NUL byte', '.schegent/transcript\0.txt']
  ])('refuses a workspace-file locator with %s as invalid-input', (_label, uriOrRelpath) => {
    const { conn, records } = openStore();
    try {
      const result = records.register({ ...immutableInput('art-1'), locator: { storageTier: 'workspace_file', uriOrRelpath } });
      expect(result.ok || result.refusal.code).toBe('invalid-input');
      expect(conn.get<{ n: number }>(`SELECT count(*) AS n FROM artifacts`)?.n).toBe(0);
    } finally {
      conn.close();
    }
  });

  it('refuses a second registration of the same id', () => {
    const { conn, records } = openStore();
    try {
      records.register(immutableInput('art-1'));
      const again = records.register(immutableInput('art-1'));
      expect(again.ok || again.refusal.code).toBe('identity-conflict');
    } finally {
      conn.close();
    }
  });

  it('sanitizes the display name to at most 256 bytes and never returns the host locator', () => {
    const { conn, records } = openStore();
    try {
      const longName = `report for /Users/someone/project ${'é'.repeat(400)}`;
      const result = records.register({ ...immutableInput('art-1'), displayName: longName });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Buffer.byteLength(result.value.displayName, 'utf8')).toBeLessThanOrEqual(256);
      expect(result.value.displayName).not.toContain('/Users/');
      const serialized = JSON.stringify(records.get('art-1'));
      expect(serialized).not.toContain('secret/transcript.txt');
      expect(serialized).not.toContain('uriOrRelpath');
    } finally {
      conn.close();
    }
  });

  it('reconciles a removed file to missing and keeps the record and its references', async () => {
    const { conn, records } = openStore();
    try {
      records.register(immutableInput('art-1'));
      insertReference(conn, 'art-1');
      const probe = new FakeProbe();
      probe.observation = { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
      const result = await records.reconcile('art-1', probe);
      expect(result.ok && result.value.availability).toBe('missing');
      expect(result.ok && result.value.lifecycleRevision).toBe(2);
      expect(referenceCount(conn, 'art-1')).toBe(1);
      expect(probe.seenLocators).toEqual(['.schegent/someone/secret/transcript.txt']);
    } finally {
      conn.close();
    }
  });

  it('reconciles a replaced immutable file (digest mismatch) to corrupt', async () => {
    const { conn, records } = openStore();
    try {
      records.register(immutableInput('art-1'));
      insertReference(conn, 'art-1');
      const probe = new FakeProbe();
      probe.digest = OTHER_DIGEST;
      const result = await records.reconcile('art-1', probe);
      expect(result.ok && result.value.availability).toBe('corrupt');
      expect(result.ok && result.value.digest?.value).toBe(DIGEST);
      expect(referenceCount(conn, 'art-1')).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('reconciles a truncated growing file, and one from another producer or generation, to corrupt', async () => {
    const { conn, records } = openStore();
    try {
      records.register(growingInput('art-t'));
      records.register(growingInput('art-p'));
      records.register(growingInput('art-g'));
      const truncated = new FakeProbe();
      truncated.observation = { exists: true, sizeBytes: 40, producerIdentity: 'writer-a', generation: 3 };
      const truncatedResult = await records.reconcile('art-t', truncated);
      expect(truncatedResult.ok && truncatedResult.value.availability).toBe('corrupt');
      const otherProducer = new FakeProbe();
      otherProducer.observation = { exists: true, sizeBytes: 100, producerIdentity: 'writer-b', generation: 3 };
      const producerResult = await records.reconcile('art-p', otherProducer);
      expect(producerResult.ok && producerResult.value.availability).toBe('corrupt');
      const otherGeneration = new FakeProbe();
      otherGeneration.observation = { exists: true, sizeBytes: 100, producerIdentity: 'writer-a', generation: 4 };
      const generationResult = await records.reconcile('art-g', otherGeneration);
      expect(generationResult.ok && generationResult.value.availability).toBe('corrupt');
    } finally {
      conn.close();
    }
  });

  it('keeps a matching file present without bumping the revision', async () => {
    const { conn, records } = openStore();
    try {
      records.register(immutableInput('art-1'));
      const result = await records.reconcile('art-1', new FakeProbe());
      expect(result.ok && result.value).toMatchObject({ availability: 'present', lifecycleRevision: 1 });
    } finally {
      conn.close();
    }
  });

  it('refuses a reconciliation whose revision changed during the probe (CAS)', async () => {
    const { conn, records } = openStore();
    try {
      records.register(immutableInput('art-1'));
      const probe = new FakeProbe();
      probe.observation = { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
      probe.onObserve = () => {
        conn.run(`UPDATE artifact_lifecycle SET lifecycle_revision = lifecycle_revision + 1 WHERE artifact_id = 'art-1'`);
      };
      const result = await records.reconcile('art-1', probe);
      expect(result.ok || result.refusal.code).toBe('content-conflict');
      expect(records.get('art-1').ok && records.get('art-1')).toMatchObject({ value: { availability: 'present' } });
    } finally {
      conn.close();
    }
  });

  it('never resolves a missing artifact as usable bytes', async () => {
    const { conn, records } = openStore();
    try {
      records.register(immutableInput('art-1'));
      const probe = new FakeProbe();
      probe.observation = { exists: false, sizeBytes: 0, producerIdentity: null, generation: null };
      await records.reconcile('art-1', probe);
      const usable = records.requireUsable('art-1');
      expect(usable.ok).toBe(false);
      expect(usable.ok || usable.refusal).toMatchObject({ code: 'unavailable', artifactId: 'art-1' });
      const unknown = records.requireUsable('no-such-artifact');
      expect(unknown.ok || unknown.refusal.code).toBe('not-found');
    } finally {
      conn.close();
    }
  });

  it('reads an F04-only artifact through the fixed mapping as unmanaged', () => {
    const { conn, records } = openStore();
    try {
      conn.run(
        `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_at_ms)
         VALUES ('legacy-1', ?, 5, 'text/plain', 'transcript', ?)`,
        DIGEST,
        NOW
      );
      conn.run(
        `INSERT INTO artifact_availability (artifact_id, state, last_verified_at_ms, detail_json)
         VALUES ('legacy-1', 'quarantined', ?, '{}')`,
        NOW
      );
      const result = records.get('legacy-1');
      expect(result.ok && result.value).toMatchObject({
        managed: false,
        availability: 'present',
        storeKind: 'quarantine',
        byteSize: 5
      });
    } finally {
      conn.close();
    }
  });
});
