// FR-R6-F08 T012 — reference resolution (research R6).
//
// WHAT THIS PINS:
//   - every row of the R6 table: F05 `not-found`, each availability state, a null probe
//     digest, a changed digest, an unknown-version refusal, a refused store kind, and the
//     present-and-matching case;
//   - a store kind outside the accepted set (`transcript`, `provider-session`) is
//     `unsupported` and the probe is never asked;
//   - a revision is `usable` only when every required reference is `available`; an optional
//     failure is listed under `omitted` and does not block;
//   - each result is written to `last_resolution` with the resolve time.

import { describe, expect, it } from 'vitest';
import type {
  ArtifactAvailabilityState,
  ArtifactRecord,
  ArtifactStoreKind,
  LifecycleResult
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import type { ArtifactLocator } from '../../../src/services/artifact-lifecycle/artifact-records';
import { ArtifactRecordStore } from '../../../src/services/artifact-lifecycle/artifact-records';
import { createHandoffStore, type SqliteHandoffStore } from '../../../src/services/recovery-handoff/handoff-store';
import {
  classifyResolution,
  resolveRevision,
  type ResolverDeps
} from '../../../src/services/recovery-handoff/handoff-resolver';
import type { ArtifactLifecycleService } from '../../../src/services/artifact-lifecycle';
import { checkpointArtifact, lifecycleFixture, NOW } from '../artifact-lifecycle/lifecycle-fixture';

const HANDOFF_ID = 'a'.repeat(64);
const RECORDED = 'a'.repeat(64);
const OTHER = 'f'.repeat(64);

interface Harness {
  readonly store: SqliteHandoffStore;
  readonly lifecycle: ArtifactLifecycleService;
  readonly records: ArtifactRecordStore;
  /** Probe answers keyed by artifact id; an absent key answers the recorded digest. */
  readonly digests: Map<string, string | null>;
  readonly probed: string[];
}

function harness(): Harness {
  const fixture = lifecycleFixture();
  return {
    store: createHandoffStore(fixture.conn),
    lifecycle: fixture.build(),
    records: new ArtifactRecordStore(fixture.conn, () => NOW),
    digests: new Map(),
    probed: []
  };
}

function register(h: Harness, artifactId: string, storeKind: ArtifactStoreKind = 'checkpoint'): void {
  const result = h.lifecycle.registerArtifact(checkpointArtifact(artifactId, { storeKind }));
  if (!result.ok) throw new Error(`register failed: ${result.refusal.code}`);
}

function setAvailability(h: Harness, artifactId: string, availability: ArtifactAvailabilityState): void {
  const found = h.records.get(artifactId);
  if (!found.ok) throw new Error(found.refusal.code);
  if (!h.records.compareAndSetAvailability(artifactId, found.value.lifecycleRevision, availability)) {
    throw new Error('availability did not move');
  }
}

function artifactIdOf(locator: ArtifactLocator): string {
  const file = locator.uriOrRelpath.split('/').at(-1) ?? '';
  return file.replace(/\.patch$/, '');
}

function deps(h: Harness): ResolverDeps {
  return {
    store: h.store,
    lifecycle: h.lifecycle,
    locatorOf: (artifactId) => h.records.locatorOf(artifactId),
    probe: {
      digestSha256: (locator) => {
        const artifactId = artifactIdOf(locator);
        h.probed.push(artifactId);
        const answer = h.digests.has(artifactId) ? h.digests.get(artifactId) : RECORDED;
        return Promise.resolve(answer ?? null);
      }
    },
    nowMs: () => NOW + 7
  };
}

interface Ref {
  readonly artifactId: string;
  readonly required?: boolean;
}

function seedRevision(h: Harness, refs: readonly Ref[]): void {
  h.store.insertHandoff({
    handoffId: HANDOFF_ID,
    workspaceId: 'ws-1',
    rootExecutionId: 'root-1',
    invocationId: 'inv-1',
    sourceAttemptId: 'att-1',
    legacyProvenance: null,
    nowMs: NOW
  });
  h.store.insertRevision({
    handoffId: HANDOFF_ID,
    revisionNo: 1,
    cutoffKey: 'c'.repeat(64),
    executionRevision: 'exec-1',
    usageRevision: 0,
    factCutoffMs: NOW,
    manifestVersion: 1,
    manifestJson: '{"version":1}',
    manifestDigest: 'd'.repeat(64),
    certainty: 'uncertain',
    coverage: 'partial'
  });
  for (const ref of refs) {
    h.store.insertReference({
      handoffId: HANDOFF_ID,
      revisionNo: 1,
      artifactId: ref.artifactId,
      role: 'validated',
      required: ref.required ?? true,
      expectedDigest: null
    });
  }
}

function presentRecord(h: Harness, artifactId: string): LifecycleResult<ArtifactRecord> {
  register(h, artifactId);
  return h.lifecycle.getArtifact(artifactId);
}

describe('FR-R6-F08 T012 — classifyResolution (R6 table)', () => {
  it('maps an F05 not-found refusal to missing and an unknown-version refusal to unsupported', () => {
    const notFound: LifecycleResult<ArtifactRecord> = {
      ok: false,
      refusal: { code: 'not-found', message: 'no such artifact' }
    };
    const newer: LifecycleResult<ArtifactRecord> = {
      ok: false,
      refusal: { code: 'unknown-version', message: 'newer build' }
    };
    expect(classifyResolution(notFound, null, null)).toBe('missing');
    expect(classifyResolution(newer, null, null)).toBe('unsupported');
  });

  it.each([
    ['missing', 'missing'],
    ['expired', 'expired'],
    ['deleted', 'deleted'],
    ['corrupt', 'unreadable'],
    ['unverified', 'unreadable'],
    ['pending', 'unreadable']
  ] as const)('maps availability %s to %s', (availability, expected) => {
    const h = harness();
    register(h, 'art-1');
    setAvailability(h, 'art-1', availability);
    expect(classifyResolution(h.lifecycle.getArtifact('art-1'), RECORDED, null)).toBe(expected);
  });

  it('maps a present record to available, unreadable or changed by the probe digest', () => {
    const h = harness();
    const record = presentRecord(h, 'art-1');
    expect(classifyResolution(record, RECORDED, null)).toBe('available');
    expect(classifyResolution(record, null, null)).toBe('unreadable');
    expect(classifyResolution(record, OTHER, null)).toBe('changed');
  });

  it('checks the probe against the reference expected digest when one is given', () => {
    const h = harness();
    const record = presentRecord(h, 'art-1');
    expect(classifyResolution(record, OTHER, OTHER)).toBe('available');
    expect(classifyResolution(record, RECORDED, OTHER)).toBe('changed');
  });

  it('maps a present record with no recorded digest to available without a probe digest', () => {
    const h = harness();
    const result = h.lifecycle.registerArtifact(
      checkpointArtifact('art-1', { immutability: 'growing', digest: undefined, generation: 0, extentBytes: 0 })
    );
    if (!result.ok) throw new Error(result.refusal.code);
    expect(classifyResolution(h.lifecycle.getArtifact('art-1'), null, null)).toBe('available');
  });

  it.each(['transcript', 'provider-session'] as const)('maps the %s store kind to unsupported', (storeKind) => {
    const h = harness();
    register(h, 'art-1', storeKind);
    expect(classifyResolution(h.lifecycle.getArtifact('art-1'), RECORDED, null)).toBe('unsupported');
  });
});

describe('FR-R6-F08 T012 — resolveRevision', () => {
  it('is usable when every reference is available, and writes last_resolution with the time', async () => {
    const h = harness();
    register(h, 'art-1');
    register(h, 'art-2');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-2', required: false }]);
    const result = await resolveRevision(deps(h), HANDOFF_ID, 1);
    expect(result.status).toBe('usable');
    expect(result.omitted).toEqual([]);
    expect(result.references.map((ref) => `${ref.artifactId}:${ref.resolution}`)).toEqual([
      'art-1:available',
      'art-2:available'
    ]);
    for (const row of h.store.listReferences(HANDOFF_ID, 1)) {
      expect(row.lastResolution).toBe('available');
      expect(row.resolvedAtMs).toBe(NOW + 7);
    }
  });

  it('is blocked when a required reference is missing', async () => {
    const h = harness();
    register(h, 'art-2');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-2' }]);
    const result = await resolveRevision(deps(h), HANDOFF_ID, 1);
    expect(result.status).toBe('blocked');
    expect(result.references.find((ref) => ref.artifactId === 'art-1')?.resolution).toBe('missing');
    expect(h.store.listReferences(HANDOFF_ID, 1).find((row) => row.artifactId === 'art-1')?.lastResolution).toBe(
      'missing'
    );
  });

  it('is usable with a missing optional reference listed under omitted', async () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-9', required: false }]);
    const result = await resolveRevision(deps(h), HANDOFF_ID, 1);
    expect(result.status).toBe('usable');
    expect(result.omitted).toEqual([{ artifactId: 'art-9', role: 'validated', resolution: 'missing' }]);
  });

  it('is blocked by a changed or unreadable required reference', async () => {
    const h = harness();
    register(h, 'art-1');
    register(h, 'art-2');
    h.digests.set('art-1', OTHER);
    h.digests.set('art-2', null);
    seedRevision(h, [{ artifactId: 'art-1' }, { artifactId: 'art-2' }]);
    const result = await resolveRevision(deps(h), HANDOFF_ID, 1);
    expect(result.status).toBe('blocked');
    expect(result.references.map((ref) => `${ref.artifactId}:${ref.resolution}`)).toEqual([
      'art-1:changed',
      'art-2:unreadable'
    ]);
  });

  it.each(['transcript', 'provider-session'] as const)(
    'refuses a %s reference as unsupported without probing its bytes',
    async (storeKind) => {
      const h = harness();
      register(h, 'art-1', storeKind);
      seedRevision(h, [{ artifactId: 'art-1' }]);
      const result = await resolveRevision(deps(h), HANDOFF_ID, 1);
      expect(result.status).toBe('blocked');
      expect(result.references.at(0)?.resolution).toBe('unsupported');
      expect(h.probed).toEqual([]);
    }
  );

  it('does not probe a reference whose record is not present', async () => {
    const h = harness();
    register(h, 'art-1');
    setAvailability(h, 'art-1', 'expired');
    seedRevision(h, [{ artifactId: 'art-1' }]);
    const result = await resolveRevision(deps(h), HANDOFF_ID, 1);
    expect(result.references.at(0)?.resolution).toBe('expired');
    expect(h.probed).toEqual([]);
  });

  it('reads a present record with no locator as unreadable', async () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }]);
    const result = await resolveRevision({ ...deps(h), locatorOf: () => null }, HANDOFF_ID, 1);
    expect(result.references.at(0)?.resolution).toBe('unreadable');
  });

  it('reads a probe that throws as unreadable', async () => {
    const h = harness();
    register(h, 'art-1');
    seedRevision(h, [{ artifactId: 'art-1' }]);
    const throwing: ResolverDeps = {
      ...deps(h),
      probe: { digestSha256: () => Promise.reject(new Error('io')) }
    };
    const result = await resolveRevision(throwing, HANDOFF_ID, 1);
    expect(result.references.at(0)?.resolution).toBe('unreadable');
  });
});
