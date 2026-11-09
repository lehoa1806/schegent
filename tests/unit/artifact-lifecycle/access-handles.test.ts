// FR-R6-F05 (US5, T041) — qualified artifact access (AC-10, FR-023, SC-008).
//
// An agent reaches bytes only through a handle issued after the policy admitted its session, the
// artifact proved immutable, present and unchanged, and its attempt held an active protective
// reference. Every other request is refused with a typed reason and delivers nothing.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATERIALIZED_COPY_DEFAULT_TTL_MS,
  type QualifyAccessRequest
} from '../../../src/contracts/artifact-lifecycle/access-types';
import type { ArtifactAccessHandle } from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import type { RegisterArtifactInput } from '../../../src/services/artifact-lifecycle';
import { ArtifactRecordStore, ReferenceStore } from '../../../src/services/artifact-lifecycle';
import { validateQualifyAccessRequest } from '../../../src/contracts/validators/artifact-access';
import {
  createArtifactAccessHandles,
  type ArtifactAccessHandles,
  type ArtifactAccessPolicy
} from '../../../src/services/artifact-lifecycle/access-handles';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { checkpointArtifact, lifecycleFixture, NOW } from './lifecycle-fixture';

const CONTENT = Buffer.from('phase report body\n', 'utf8');
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex');
const ARTIFACT = 'report-1';
const ATTEMPT = 'attempt-1';
const SESSION = 'session-1';

const REQUEST: QualifyAccessRequest = {
  artifactId: ARTIFACT,
  expectedDigest: { algorithm: 'sha256', value: CONTENT_SHA },
  attemptId: ATTEMPT,
  sessionId: SESSION,
  mode: 'embed'
};

/** Admits exactly one attempt and session, as the F13 policy scopes access. */
const SCOPED_POLICY: ArtifactAccessPolicy = {
  admits: (request) => request.attemptId === ATTEMPT && request.sessionId === SESSION
};
const ADMIT_ALL: ArtifactAccessPolicy = { admits: () => true };

interface Harness {
  readonly conn: NodeSqliteConnection;
  readonly records: ArtifactRecordStore;
  readonly references: ReferenceStore;
  readonly access: ArtifactAccessHandles;
  readonly workspace: string;
  readonly probeCalls: string[];
  diskDigest: string | null;
  diskBytes: Uint8Array | null;
  now: number;
}

let harness: Harness;

function reportArtifact(overrides: Partial<RegisterArtifactInput> = {}): RegisterArtifactInput {
  return checkpointArtifact(ARTIFACT, {
    storeKind: 'report',
    retentionClass: 'generated-reports-handoff-exports',
    digest: { algorithm: 'sha256', value: CONTENT_SHA },
    byteSize: CONTENT.length,
    locator: { storageTier: 'workspace_file', uriOrRelpath: '.schegent/reports/report-1.md' },
    ...overrides
  });
}

function seedReport(input: RegisterArtifactInput = reportArtifact()): string {
  const registered = harness.records.register(input);
  if (!registered.ok) throw new Error(`seed failed: ${registered.refusal.code}`);
  const reference = harness.references.add({
    artifactId: input.artifactId,
    ownerType: 'attempt',
    ownerId: ATTEMPT,
    purpose: 'phase-context',
    protective: true
  });
  if (!reference.ok) throw new Error(`reference failed: ${reference.refusal.code}`);
  return reference.value.referenceId;
}

function refusalCode(result: { ok: boolean; refusal?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.refusal?.code;
}

async function qualified(): Promise<ArtifactAccessHandle> {
  const result = await harness.access.qualifyAccess(REQUEST, SCOPED_POLICY);
  if (!result.ok) throw new Error(`qualify failed: ${result.refusal.code}`);
  return result.value;
}

function availabilityOf(artifactId: string): string | undefined {
  const record = harness.records.get(artifactId);
  return record.ok ? record.value.availability : undefined;
}

function referenceRowCount(): number {
  return harness.conn.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_references')?.n ?? -1;
}

beforeEach(async () => {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'access-handles-'));
  let next = 0;
  const partial = {
    conn,
    workspace,
    probeCalls: [] as string[],
    diskDigest: CONTENT_SHA as string | null,
    diskBytes: CONTENT as Uint8Array | null,
    now: NOW
  };
  const nowMs = (): number => harness.now;
  const records = new ArtifactRecordStore(conn, nowMs);
  const references = new ReferenceStore(conn, nowMs);
  const access = createArtifactAccessHandles({
    conn,
    nowMs,
    newId: () => `id-${(next += 1)}`,
    records,
    references,
    workspaceRoot: workspace,
    probe: {
      observe: () => Promise.resolve({ exists: true, sizeBytes: CONTENT.length, producerIdentity: 'writer', generation: null }),
      digestSha256: (locator) => {
        harness.probeCalls.push(locator.uriOrRelpath);
        return Promise.resolve(harness.diskDigest);
      }
    },
    reader: { read: () => Promise.resolve(harness.diskBytes) }
  });
  harness = { ...partial, records, references, access };
});

afterEach(async () => {
  await rm(harness.workspace, { recursive: true, force: true });
});

describe('qualifyAccess', () => {
  it('serves a qualified handle to the attempt that holds an active protective reference', async () => {
    const referenceId = seedReport();
    const result = await harness.access.qualifyAccess(REQUEST, SCOPED_POLICY);
    expect(result).toEqual({
      ok: true,
      value: {
        handleId: 'id-1',
        artifactId: ARTIFACT,
        digest: { algorithm: 'sha256', value: CONTENT_SHA },
        sessionScope: { attemptId: ATTEMPT, sessionId: SESSION },
        mode: 'embed',
        pinReferenceId: referenceId
      }
    });
  });

  it('refuses another session access-denied', async () => {
    seedReport();
    const result = await harness.access.qualifyAccess({ ...REQUEST, sessionId: 'session-2' }, SCOPED_POLICY);
    expect(refusalCode(result)).toBe('access-denied');
    expect(harness.probeCalls).toEqual([]);
  });

  it('refuses an admitted attempt that holds no protective reference access-denied', async () => {
    seedReport();
    const result = await harness.access.qualifyAccess({ ...REQUEST, attemptId: 'attempt-2' }, ADMIT_ALL);
    expect(refusalCode(result)).toBe('access-denied');
  });

  it('refuses a released reference access-denied', async () => {
    seedReport();
    harness.references.release({
      artifactId: ARTIFACT,
      ownerType: 'attempt',
      ownerId: ATTEMPT,
      purpose: 'phase-context',
      reason: 'owner-durable'
    });
    expect(refusalCode(await harness.access.qualifyAccess(REQUEST, SCOPED_POLICY))).toBe('access-denied');
  });

  it.each([
    ['a path key', { ...REQUEST, path: '/etc/passwd' }],
    ['a uri key', { ...REQUEST, uri: 'file:///ws/.schegent/reports/report-1.md' }],
    ['a file URI as the id', { ...REQUEST, artifactId: 'file:///ws/.schegent/reports/report-1.md' }],
    ['a relative path as the id', { ...REQUEST, artifactId: '../reports/report-1.md' }],
    ['a Windows path as the id', { ...REQUEST, artifactId: 'C:\\ws\\report.md' }]
  ])('refuses %s invalid-input before resolution', async (_label, request) => {
    seedReport();
    const policy = { admits: vi.fn(() => true) };
    expect(refusalCode(validateQualifyAccessRequest(request))).toBe('invalid-input');
    const result = await harness.access.qualifyAccess(request as unknown as QualifyAccessRequest, policy);
    expect(refusalCode(result)).toBe('invalid-input');
    expect(policy.admits).not.toHaveBeenCalled();
    expect(harness.probeCalls).toEqual([]);
  });

  it('refuses changed bytes content-conflict and marks the artifact corrupt', async () => {
    seedReport();
    harness.diskDigest = 'b'.repeat(64);
    const result = await harness.access.qualifyAccess(REQUEST, SCOPED_POLICY);
    expect(refusalCode(result)).toBe('content-conflict');
    expect(availabilityOf(ARTIFACT)).toBe('corrupt');
    expect(refusalCode(await harness.access.qualifyAccess(REQUEST, SCOPED_POLICY))).toBe('unavailable');
  });

  it('refuses a stale expected digest content-conflict without marking the artifact corrupt', async () => {
    seedReport();
    const stale = { ...REQUEST, expectedDigest: { algorithm: 'sha256' as const, value: 'c'.repeat(64) } };
    expect(refusalCode(await harness.access.qualifyAccess(stale, SCOPED_POLICY))).toBe('content-conflict');
    expect(availabilityOf(ARTIFACT)).toBe('present');
  });

  it('refuses a growing artifact unavailable', async () => {
    const { digest: _none, ...growing } = reportArtifact({ immutability: 'growing', generation: 1, extentBytes: 10 });
    seedReport(growing);
    expect(refusalCode(await harness.access.qualifyAccess(REQUEST, SCOPED_POLICY))).toBe('unavailable');
    expect(harness.probeCalls).toEqual([]);
  });

  it('refuses an unknown artifact access-denied, never naming whether it exists', async () => {
    const result = await harness.access.qualifyAccess(REQUEST, ADMIT_ALL);
    expect(refusalCode(result)).toBe('access-denied');
  });
});

describe('materializeCopy', () => {
  it('writes the bytes under the destination root and records the source id and its own expiring pin', async () => {
    seedReport();
    const handle = await qualified();
    const copied = await harness.access.materializeCopy(handle, harness.workspace);
    if (!copied.ok) throw new Error(`copy failed: ${copied.refusal.code}`);
    expect(copied.value).toMatchObject({
      artifactId: ARTIFACT,
      digest: { algorithm: 'sha256', value: CONTENT_SHA },
      expiresAtMs: NOW + MATERIALIZED_COPY_DEFAULT_TTL_MS
    });
    const written = path.join(harness.workspace, copied.value.fileName);
    expect(await readFile(written)).toEqual(CONTENT);
    expect((await stat(written)).mode & 0o777).toBe(0o600);
    expect(harness.access.resolveMaterializedCopy(copied.value.copyId)).toEqual({ ok: true, value: copied.value });
  });

  it('refuses an expired materialized copy unavailable', async () => {
    seedReport();
    const copied = await harness.access.materializeCopy(await qualified(), harness.workspace, { ttlMs: 1000 });
    if (!copied.ok) throw new Error(`copy failed: ${copied.refusal.code}`);
    harness.now = copied.value.expiresAtMs;
    expect(refusalCode(harness.access.resolveMaterializedCopy(copied.value.copyId))).toBe('unavailable');
  });

  it('refuses a destination outside the workspace containment-violation', async () => {
    seedReport();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'access-outside-'));
    try {
      const result = await harness.access.materializeCopy(await qualified(), outside);
      expect(refusalCode(result)).toBe('containment-violation');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a handle whose reference belongs to another attempt access-denied', async () => {
    seedReport();
    const handle = await qualified();
    const forged = { ...handle, sessionScope: { attemptId: 'attempt-2', sessionId: SESSION } };
    expect(refusalCode(await harness.access.materializeCopy(forged, harness.workspace))).toBe('access-denied');
  });

  it('refuses a handle it never issued, or one altered after issue, access-denied', async () => {
    seedReport();
    const handle = await qualified();
    const unknown = { ...handle, handleId: 'id-never-issued' };
    const remoded = { ...handle, mode: 'read' as const };
    const rescoped = { ...handle, sessionScope: { attemptId: ATTEMPT, sessionId: 'session-2' } };
    for (const forged of [unknown, remoded, rescoped]) {
      expect(refusalCode(await harness.access.materializeCopy(forged, harness.workspace))).toBe('access-denied');
    }
    const copied = await harness.access.materializeCopy(handle, harness.workspace);
    expect(copied.ok).toBe(true);
  });

  it('refuses bytes that no longer match content-conflict and marks the artifact corrupt', async () => {
    seedReport();
    const handle = await qualified();
    harness.diskBytes = Buffer.from('tampered', 'utf8');
    expect(refusalCode(await harness.access.materializeCopy(handle, harness.workspace))).toBe('content-conflict');
    expect(availabilityOf(ARTIFACT)).toBe('corrupt');
  });

  it('refuses a lifetime past the bound invalid-input', async () => {
    seedReport();
    const result = await harness.access.materializeCopy(await qualified(), harness.workspace, { ttlMs: Number.MAX_SAFE_INTEGER });
    expect(refusalCode(result)).toBe('invalid-input');
  });
});

describe('session history', () => {
  it('creates no reference row and no permanent pin when a session reads and copies repeatedly', async () => {
    seedReport();
    const before = referenceRowCount();
    for (let read = 0; read < 3; read += 1) await qualified();
    const copied = await harness.access.materializeCopy(await qualified(), harness.workspace);
    expect(copied.ok).toBe(true);
    expect(referenceRowCount()).toBe(before);
    const permanent = harness.conn.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_pins WHERE expires_at_ms IS NULL');
    expect(permanent?.n).toBe(0);
  });
});

describe('service wiring', () => {
  it('qualifies through the policy the service was built with, never one the caller supplies', async () => {
    const fixture = lifecycleFixture();
    const service = fixture.build();
    const registered = service.registerArtifact(checkpointArtifact(ARTIFACT));
    expect(registered.ok).toBe(true);
    const result = await service.qualifyAccess(REQUEST);
    expect(result.ok ? undefined : result.refusal.code).toBe('access-denied');
  });

  it('resolves an unknown copy id as unavailable through the service', () => {
    const service = lifecycleFixture().build();
    const result = service.resolveMaterializedCopy('copy-unknown');
    expect(result.ok).toBe(false);
  });
});
