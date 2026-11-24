// FR-R7-17 (R7-17-08, AC-14) — unit tests for `handoff-materializer.ts`:
// exact 64/65 files, 16 MiB / 16 MiB + 1 B per-file (ref.byteSize & real stat size),
// 64 MiB / 64 MiB + 1 B aggregate with artifactVersionKey dedup before cap, <= 1 MiB streaming
// chunks, 30,000 ms vs 30,001 ms deadline, ENOSPC/unwritable typed storage-unavailable with 0
// uncaught throws and 0 exposed partial/0-byte destination files, multi-file batch rollback,
// Pass-1/Pass-2 digest & mutation detection, symlink refusal, restart reuse ensuring F05 pin,
// original pin survival, and shared NFR-003 PreparationAdmission.
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LIFECYCLE_OPAQUE_ID_PATTERN } from '../../../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef
} from '../../../../src/contracts/phase-context/context-policy';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactLifecycleService
} from '../../../../src/services/artifact-lifecycle';
import {
  artifactVersionKey,
  materializeHandoffArtifacts,
  type MaterializationSource
} from '../../../../src/services/phase-context/handoff-materializer';
import { materializedCopyArtifactId } from '../../../../src/services/phase-context/phase-context-helpers';
import { createPreparationAdmission } from '../../../../src/services/phase-context/preparation-admission';
import { SqliteApplicationStore } from '../../../../src/services/sqlite-store';

const MIB = 1024 * 1024;
const tempDirs: string[] = [];
const openStores: SqliteApplicationStore[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeLifecycle(): ArtifactLifecycleService {
  const sqlite = SqliteApplicationStore.openInMemory();
  openStores.push(sqlite);
  return createArtifactLifecycleService({
    conn: sqlite.writerConnection,
    nowMs: () => 1_700_000_000_000,
    probe: {
      observe: async () => ({
        exists: true,
        sizeBytes: 0,
        producerIdentity: null,
        generation: null
      }),
      digestSha256: async () => null
    },
    resolveOwner: () => 'live',
    audit: { recordLifecycleMutation: () => undefined },
    fs: {
      lstat: async () => null,
      readdir: async () => [],
      realpath: async (p) => p,
      unlink: async () => undefined
    },
    scanRoots: [],
    accessPolicy: DENY_ALL_ACCESS_POLICY
  });
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function createSourceFile(
  sourceRoot: string,
  artifactId: string,
  bytes: Buffer,
  immutableVersion = 'v1',
  kind: 'text' | 'binary' = 'binary'
): Promise<MaterializationSource> {
  const relSegments = ['src-artifacts', `${artifactId}.bin`] as const;
  const fullPath = path.join(sourceRoot, ...relSegments);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, bytes);
  const ref: ArtifactRef = {
    artifactId,
    immutableVersion,
    digestHex: sha256Hex(bytes),
    byteSize: bytes.byteLength,
    kind
  };
  return { ref, sourceRoot, sourceSegments: relSegments };
}

async function listMaterializedDir(targetRoot: string, attemptId: string): Promise<string[]> {
  const dir = path.join(targetRoot, '.schegent', 'handoff-materialized', attemptId);
  return fsp.readdir(dir).catch(() => []);
}

afterEach(async () => {
  while (openStores.length > 0) {
    openStores.pop()!.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      await fsp.chmod(dir, 0o700);
      const restore = async (target: string): Promise<void> => {
        const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = path.join(target, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            await fsp.chmod(full, 0o700).catch(() => undefined);
            await restore(full);
          } else {
            await fsp.chmod(full, 0o600).catch(() => undefined);
          }
        }
      };
      await restore(dir);
    } catch {
      // Best-effort permission restoration for temp directory cleanup.
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('FR-R7-17 (AC-14) — handoff-materializer', () => {
  it('accepts exact 64 unique files (including duplicates above 64 raw refs) and refuses 65 unique files', async () => {
    const sourceRoot = await makeTempDir('hm-64-src-');
    const targetRoot = await makeTempDir('hm-64-dst-');

    const sources64: MaterializationSource[] = [];
    for (let i = 0; i < 64; i += 1) {
      sources64.push(
        await createSourceFile(sourceRoot, `art-${String(i).padStart(2, '0')}`, Buffer.from(`payload-${i}`))
      );
    }

    // 64 unique + 6 duplicate refs (70 raw refs) MUST succeed because dedup runs before cap!
    const withDuplicates = [...sources64, ...sources64.slice(0, 6)];
    const ok64 = await materializeHandoffArtifacts({
      runId: 'run-64',
      handoffId: 'h-64',
      targetAttemptId: 'att-64',
      targetRoot,
      sources: withDuplicates
    });
    expect(ok64.ok).toBe(true);
    if (ok64.ok) {
      expect(ok64.byArtifactKey.size).toBe(64);
      expect(ok64.entries).toHaveLength(70);
      const files = await listMaterializedDir(targetRoot, 'att-64');
      expect(files).toHaveLength(64);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    }

    // 65 unique files MUST be refused with capacity-exceeded / materialized-file-count.
    const extra65 = await createSourceFile(sourceRoot, 'art-64', Buffer.from('payload-64'));
    const fail65 = await materializeHandoffArtifacts({
      runId: 'run-65',
      handoffId: 'h-65',
      targetAttemptId: 'att-65',
      targetRoot,
      sources: [...sources64, extra65]
    });
    expect(fail65).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'materialized-file-count'
    });
    expect(await listMaterializedDir(targetRoot, 'att-65')).toEqual([]);
  });

  it('enforces exact 16 MiB per-file limit on both ref.byteSize and real sourceStat.size', async () => {
    const sourceRoot = await makeTempDir('hm-16m-src-');
    const targetRoot = await makeTempDir('hm-16m-dst-');
    expect(PHASE_CONTEXT_LIMITS.materializedFileBytesMax).toBe(16 * MIB);

    // Exact 16 MiB accepted.
    const exact16Buf = Buffer.alloc(16 * MIB, 0x41);
    const srcExact16 = await createSourceFile(sourceRoot, 'art-16m', exact16Buf);
    const resExact = await materializeHandoffArtifacts({
      runId: 'run-16m',
      handoffId: 'h-16m',
      targetAttemptId: 'att-16m',
      targetRoot,
      sources: [srcExact16]
    });
    expect(resExact.ok).toBe(true);
    if (resExact.ok) {
      expect(resExact.totalBytes).toBe(16 * MIB);
    }

    // 16 MiB + 1 B refused via ref.byteSize.
    const overRef: MaterializationSource = {
      ...srcExact16,
      ref: { ...srcExact16.ref, artifactId: 'art-16m-over-ref', byteSize: 16 * MIB + 1 }
    };
    const resOverRef = await materializeHandoffArtifacts({
      runId: 'run-16m',
      handoffId: 'h-16m',
      targetAttemptId: 'att-16m-over-ref',
      targetRoot,
      sources: [overRef]
    });
    expect(resOverRef).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'materialized-file-bytes'
    });

    // 16 MiB + 1 B on disk while ref.byteSize claims 1024 -> refused via real sourceStat.size!
    const overDiskBuf = Buffer.alloc(16 * MIB + 1, 0x42);
    const overDiskPath = path.join(sourceRoot, 'src-artifacts', 'art-over-disk.bin');
    await fsp.writeFile(overDiskPath, overDiskBuf);
    const resOverDisk = await materializeHandoffArtifacts({
      runId: 'run-16m',
      handoffId: 'h-16m',
      targetAttemptId: 'att-16m-over-disk',
      targetRoot,
      sources: [
        {
          ref: {
            artifactId: 'art-over-disk',
            immutableVersion: 'v1',
            digestHex: sha256Hex(overDiskBuf),
            byteSize: 1024,
            kind: 'binary'
          },
          sourceRoot,
          sourceSegments: ['src-artifacts', 'art-over-disk.bin']
        }
      ]
    });
    expect(resOverDisk).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'materialized-file-bytes'
    });
    expect(await listMaterializedDir(targetRoot, 'att-16m-over-disk')).toEqual([]);
  });

  it('enforces exact 64 MiB total cap (deduplicating duplicate artifactVersionKeys first) and refuses 64 MiB + 1 B', async () => {
    const sourceRoot = await makeTempDir('hm-64m-src-');
    const targetRoot = await makeTempDir('hm-64m-dst-');
    expect(PHASE_CONTEXT_LIMITS.materializedTotalBytesMax).toBe(64 * MIB);

    const fourBy16: MaterializationSource[] = [];
    for (let i = 0; i < 4; i += 1) {
      fourBy16.push(
        await createSourceFile(sourceRoot, `big-${i}`, Buffer.alloc(16 * MIB, 0x30 + i))
      );
    }

    // 4 unique 16 MiB files + 1 duplicate reference (80 MiB raw, 64 MiB deduplicated) -> ACCEPTED!
    const ok64M = await materializeHandoffArtifacts({
      runId: 'run-64m',
      handoffId: 'h-64m',
      targetAttemptId: 'att-64m',
      targetRoot,
      sources: [...fourBy16, fourBy16[0]!]
    });
    expect(ok64M.ok).toBe(true);
    if (ok64M.ok) {
      expect(ok64M.totalBytes).toBe(64 * MIB);
      expect(ok64M.byArtifactKey.size).toBe(4);
      expect(ok64M.entries).toHaveLength(5);
    }

    // 64 MiB + 1 B -> REFUSED!
    const oneByte = await createSourceFile(sourceRoot, 'one-byte', Buffer.from('x'));
    const fail64M = await materializeHandoffArtifacts({
      runId: 'run-64m-over',
      handoffId: 'h-64m-over',
      targetAttemptId: 'att-64m-over',
      targetRoot,
      sources: [...fourBy16, oneByte]
    });
    expect(fail64M).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'materialized-total-bytes'
    });
    expect(await listMaterializedDir(targetRoot, 'att-64m-over')).toEqual([]);
  });

  it('streams in <= 1 MiB chunks and enforces exact 30,000 ms vs 30,001 ms deadline', async () => {
    const sourceRoot = await makeTempDir('hm-stream-src-');
    const targetRoot = await makeTempDir('hm-stream-dst-');

    const payload3_5M = Buffer.alloc(3 * MIB + 512 * 1024, 0x55);
    const src = await createSourceFile(sourceRoot, 'stream-art', payload3_5M);
    const observedChunks: number[] = [];

    let now = 10_000;
    const resExactDeadline = await materializeHandoffArtifacts({
      runId: 'run-stream',
      handoffId: 'h-stream',
      targetAttemptId: 'att-stream',
      targetRoot,
      sources: [src],
      nowMs: () => now,
      onChunkCopied: ({ chunkBytes, copiedBytes, totalFileBytes }) => {
        observedChunks.push(chunkBytes);
        if (copiedBytes === totalFileBytes) {
          // Exactly at 30,000 ms elapsed -> STILL accepted!
          now = 10_000 + PHASE_CONTEXT_LIMITS.materializationDeadlineMs;
        }
      }
    });
    expect(resExactDeadline.ok).toBe(true);
    expect(observedChunks.length).toBeGreaterThanOrEqual(4);
    expect(observedChunks.every((c) => c > 0 && c <= PHASE_CONTEXT_LIMITS.materializationStreamBytesMax)).toBe(true);

    // At 30,001 ms elapsed mid-copy -> refused with materialization-deadline and 0 exposed files!
    let nowExpired = 20_000;
    const resExpired = await materializeHandoffArtifacts({
      runId: 'run-stream-exp',
      handoffId: 'h-stream-exp',
      targetAttemptId: 'att-stream-exp',
      targetRoot,
      sources: [src],
      nowMs: () => nowExpired,
      onChunkCopied: () => {
        nowExpired = 20_000 + PHASE_CONTEXT_LIMITS.materializationDeadlineMs + 1;
      }
    });
    expect(resExpired).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'materialization-deadline'
    });
    expect(await listMaterializedDir(targetRoot, 'att-stream-exp')).toEqual([]);
  });

  it('converts ENOSPC/write-stall/unwritable errors to typed storage-unavailable with 0 uncaught throws and rolls back multi-file batches', async () => {
    const sourceRoot = await makeTempDir('hm-err-src-');
    const targetRoot = await makeTempDir('hm-err-dst-');
    const lifecycle = makeLifecycle();

    const srcs: MaterializationSource[] = [];
    for (let i = 0; i < 4; i += 1) {
      const s = await createSourceFile(sourceRoot, `batch-${i}`, Buffer.from(`batch-file-${i}-data`));
      srcs.push(s);
      // Register and pin original source artifacts with ownerType: 'handoff' to verify survival!
      const reg = lifecycle.registerArtifact({
        artifactId: s.ref.artifactId,
        ownerRunId: 'run-batch',
        ownerAttemptId: 'att-producer',
        sensitivity: 'content',
        retentionClass: 'generated-reports-handoff-exports',
        storeKind: 'handoff-context',
        immutability: 'immutable',
        digest: { algorithm: 'sha256', value: s.ref.digestHex },
        byteSize: s.ref.byteSize,
        mediaType: 'application/octet-stream',
        displayName: `${s.ref.artifactId}.bin`,
        producerIdentity: 'att-producer',
        locator: { storageTier: 'workspace_file', uriOrRelpath: s.sourceSegments.join('/') }
      });
      expect(reg.ok).toBe(true);
      const pin = lifecycle.addReference({
        artifactId: s.ref.artifactId,
        ownerType: 'handoff',
        ownerId: 'h-batch',
        purpose: 'phase-context',
        protective: true
      });
      expect(pin.ok).toBe(true);
    }

    // Fail with ENOSPC on the 3rd file (after files 1 & 2 were already copied and pinned!).
    let writeCalls = 0;
    const enospcRes = await materializeHandoffArtifacts({
      runId: 'run-batch',
      handoffId: 'h-batch',
      targetAttemptId: 'att-enospc',
      targetRoot,
      sources: srcs,
      lifecycle,
      writeChunk: async (handle, buf, offset, length, pos) => {
        writeCalls += 1;
        if (writeCalls === 3) {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return handle.write(buf, offset, length, pos);
      }
    });
    expect(enospcRes).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'destination-write-enospc'
    });
    // ZERO exposed destination files AND ZERO leftover temp files!
    expect(await listMaterializedDir(targetRoot, 'att-enospc')).toEqual([]);
    // Newly added copy pins for files 1 & 2 were released on rollback!
    expect(lifecycle.isProtected('mat-batch-0-att-enospc').protected).toBe(false);
    expect(lifecycle.isProtected('mat-batch-1-att-enospc').protected).toBe(false);
    // Original source handoff pins ALL survived the failure and rollback!
    for (const s of srcs) {
      expect(lifecycle.isProtected(s.ref.artifactId).protected).toBe(true);
    }

    // destination-write-stalled (bytesWritten === 0) leaves 0 exposed files.
    const stallRes = await materializeHandoffArtifacts({
      runId: 'run-batch',
      handoffId: 'h-batch',
      targetAttemptId: 'att-stall',
      targetRoot,
      sources: [srcs[0]!],
      writeChunk: async () => ({ bytesWritten: 0 })
    });
    expect(stallRes).toEqual({
      ok: false,
      failure: 'storage-unavailable',
      detail: 'destination-write-stalled'
    });
    expect(await listMaterializedDir(targetRoot, 'att-stall')).toEqual([]);

    // Unwritable destination directory on POSIX non-root returns typed storage-unavailable.
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      const roDir = path.join(targetRoot, '.schegent', 'handoff-materialized', 'att-ro');
      await fsp.mkdir(roDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(roDir, 0o500);
      const roRes = await materializeHandoffArtifacts({
        runId: 'run-batch',
        handoffId: 'h-batch',
        targetAttemptId: 'att-ro',
        targetRoot,
        sources: [srcs[0]!]
      });
      expect(roRes.ok).toBe(false);
      if (!roRes.ok) {
        expect(roRes.failure).toBe('storage-unavailable');
      }
      await fsp.chmod(roDir, 0o700);
      expect(await listMaterializedDir(targetRoot, 'att-ro')).toEqual([]);
    }
  });

  it('detects Pass-1 digest mismatch, Pass-2 mid-copy source mutation, and symlink source/destination with 0 exposed files', async () => {
    const sourceRoot = await makeTempDir('hm-mut-src-');
    const targetRoot = await makeTempDir('hm-mut-dst-');
    const outsideRoot = await makeTempDir('hm-mut-out-');

    // Pass-1 digest mismatch.
    const src1 = await createSourceFile(sourceRoot, 'art-mismatch', Buffer.from('original-bytes'));
    const badDigestRes = await materializeHandoffArtifacts({
      runId: 'run-mut',
      handoffId: 'h-mut',
      targetAttemptId: 'att-bad-digest',
      targetRoot,
      sources: [{ ...src1, ref: { ...src1.ref, digestHex: '0'.repeat(64) } }]
    });
    expect(badDigestRes).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'source-digest-mismatch'
    });
    expect(await listMaterializedDir(targetRoot, 'att-bad-digest')).toEqual([]);

    // Pass-2 mid-copy source mutation (2 MiB file mutated after first chunk is copied).
    const twoMib = Buffer.alloc(2 * MIB, 0x61);
    const srcMut = await createSourceFile(sourceRoot, 'art-mutate', twoMib);
    const srcMutPath = path.join(sourceRoot, ...srcMut.sourceSegments);
    let mutated = false;
    const mutRes = await materializeHandoffArtifacts({
      runId: 'run-mut',
      handoffId: 'h-mut',
      targetAttemptId: 'att-mutated',
      targetRoot,
      sources: [srcMut],
      onChunkCopied: async () => {
        if (!mutated) {
          mutated = true;
          const fh = await fsp.open(srcMutPath, 'r+');
          try {
            await fh.write(Buffer.from('CORRUPT!'), 0, 8, MIB + 16);
          } finally {
            await fh.close();
          }
        }
      }
    });
    expect(mutRes).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'source-mutated-during-copy'
    });
    expect(await listMaterializedDir(targetRoot, 'att-mutated')).toEqual([]);

    // Symlink source refused.
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const secretBytes = Buffer.from('outside-secret');
    await fsp.writeFile(outsideFile, secretBytes);
    const symSrcPath = path.join(sourceRoot, 'src-artifacts', 'sym.bin');
    await fsp.symlink(outsideFile, symSrcPath);
    const symRes = await materializeHandoffArtifacts({
      runId: 'run-mut',
      handoffId: 'h-mut',
      targetAttemptId: 'att-sym-src',
      targetRoot,
      sources: [
        {
          ref: {
            artifactId: 'sym-art',
            immutableVersion: 'v1',
            digestHex: sha256Hex(secretBytes),
            byteSize: secretBytes.byteLength,
            kind: 'text'
          },
          sourceRoot,
          sourceSegments: ['src-artifacts', 'sym.bin']
        }
      ]
    });
    expect(symRes).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'source-open-refused'
    });
  });

  it('ensures F05 registration and protective pin exist on restart reuse and refuses if pin fails', async () => {
    const sourceRoot = await makeTempDir('hm-reuse-src-');
    const targetRoot = await makeTempDir('hm-reuse-dst-');
    const src = await createSourceFile(sourceRoot, 'art-reuse', Buffer.from('reusable-payload'));

    // First run writes the copy (simulating pre-restart materialization without F05 pin in new store).
    const first = await materializeHandoffArtifacts({
      runId: 'run-reuse',
      handoffId: 'h-reuse',
      targetAttemptId: 'att-reuse',
      targetRoot,
      sources: [src]
    });
    expect(first.ok).toBe(true);

    // Delete the source file to prove the second run genuinely reuses the verified destination copy!
    await fsp.unlink(path.join(sourceRoot, ...src.sourceSegments));

    const lifecycle = makeLifecycle();
    const reused = await materializeHandoffArtifacts({
      runId: 'run-reuse',
      handoffId: 'h-reuse',
      targetAttemptId: 'att-reuse',
      targetRoot,
      sources: [src],
      lifecycle
    });
    expect(reused.ok).toBe(true);
    if (reused.ok) {
      expect(reused.byArtifactKey.has(artifactVersionKey(src.ref.artifactId, src.ref.immutableVersion))).toBe(true);
    }
    // F05 artifact record AND protective pin MUST exist after restart reuse!
    const copyArtifactId = 'mat-art-reuse-att-reuse';
    expect(lifecycle.getArtifact(copyArtifactId).ok).toBe(true);
    expect(lifecycle.isProtected(copyArtifactId).protected).toBe(true);

    // If pin fails on restart reuse (e.g. pin-quota-reached), fail closed!
    const quotaLifecycle = {
      registerArtifact: () => ({ ok: true, value: {} }),
      getArtifact: () => ({ ok: false, refusal: { code: 'not-found', message: 'missing' } }),
      addReference: () => ({ ok: false, refusal: { code: 'pin-quota-reached', message: 'full' } })
    } as unknown as ArtifactLifecycleService;
    const reusePinFail = await materializeHandoffArtifacts({
      runId: 'run-reuse',
      handoffId: 'h-reuse',
      targetAttemptId: 'att-reuse',
      targetRoot,
      sources: [src],
      lifecycle: quotaLifecycle
    });
    expect(reusePinFail).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'pin-quota-reached'
    });
  });

  it('integrates with shared NFR-003 PreparationAdmission slots and releases slots on completion or failure', async () => {
    const sourceRoot = await makeTempDir('hm-adm-src-');
    const targetRoot = await makeTempDir('hm-adm-dst-');
    const src = await createSourceFile(sourceRoot, 'art-adm', Buffer.from('admission-payload'));

    const now = 5_000;
    const admission = createPreparationAdmission({ now: () => now });

    // Saturate all 2 active + 8 queued slots -> 11th request via materializer is immediately refused!
    for (let i = 0; i < 10; i += 1) {
      expect(admission.request(`other-${i}`, 64 * 1024).ok).toBe(true);
    }
    const saturated = await materializeHandoffArtifacts({
      runId: 'run-adm',
      handoffId: 'h-adm',
      targetAttemptId: 'att-adm-11',
      targetRoot,
      sources: [src],
      admission,
      nowMs: () => now
    });
    expect(saturated).toEqual({
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'preparation-queue-full'
    });

    // Release slots and verify materializer acquires and cleanly releases its own slot.
    for (let i = 0; i < 10; i += 1) admission.release(`other-${i}`);
    const admittedOk = await materializeHandoffArtifacts({
      runId: 'run-adm',
      handoffId: 'h-adm',
      targetAttemptId: 'att-adm-ok',
      targetRoot,
      sources: [src],
      admission,
      admissionOwner: 'coord-owner-1',
      nowMs: () => now
    });
    expect(admittedOk.ok).toBe(true);
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0, workingSetBytes: 0 });
  });

  it('CR-314-9: rejects restart reuse when destination has trailing bytes appended and rejects non-regular files', async () => {
    const sourceRoot = await makeTempDir('hm-cr314-9-src-');
    const targetRoot = await makeTempDir('hm-cr314-9-dst-');
    const payload = Buffer.from('exact-materialized-bytes', 'utf8');
    const src = await createSourceFile(sourceRoot, 'art-trail', payload);

    // 1. First materialization creates destination copy.
    const first = await materializeHandoffArtifacts({
      runId: 'run-trail',
      handoffId: 'h-trail',
      targetAttemptId: 'att-trail',
      targetRoot,
      sources: [src]
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const destPath = first.entries[0]!.absolutePath;

    // 2. Append trailing bytes to the destination copy and delete source -> reuse MUST NOT match!
    await fsp.appendFile(destPath, Buffer.from('TRAILING', 'utf8'));
    await fsp.unlink(path.join(sourceRoot, ...src.sourceSegments));
    const afterAppend = await materializeHandoffArtifacts({
      runId: 'run-trail',
      handoffId: 'h-trail',
      targetAttemptId: 'att-trail',
      targetRoot,
      sources: [src]
    });
    expect(afterAppend).toEqual({
      ok: false,
      failure: 'required-context-unavailable',
      detail: 'source-open-refused'
    });

    // 3. Non-regular source directory (where a regular file was expected) fails closed.
    const dirRel = ['sub', 'not-a-file'] as const;
    await fsp.mkdir(path.join(sourceRoot, ...dirRel), { recursive: true });
    const dirRes = await materializeHandoffArtifacts({
      runId: 'run-trail',
      handoffId: 'h-trail',
      targetAttemptId: 'att-trail-dir',
      targetRoot,
      sources: [
        {
          ref: {
            artifactId: 'art-dir',
            immutableVersion: 'v1',
            digestHex: createHash('sha256').update('').digest('hex'),
            byteSize: 0,
            kind: 'binary'
          },
          sourceRoot,
          sourceSegments: dirRel
        }
      ]
    });
    expect(dirRes.ok).toBe(false);
    if (!dirRes.ok) {
      expect(['required-context-unavailable', 'storage-unavailable']).toContain(dirRes.failure);
    }
  });

  it('CR-B2 #3: produces collision-free 120-char copyArtifactIds for long prefix-sharing attempts materializing the same long artifactId', async () => {
    const sourceRoot = await makeTempDir('hm-crb2-3-src-');
    const targetRoot = await makeTempDir('hm-crb2-3-dst-');
    const longArtId = `art-long-identifier-${'component-'.repeat(5)}v1`;
    const sharedAttemptPrefix = `att-nested-workflow-${'prefix-seg-'.repeat(4)}`;
    const attemptA = `${sharedAttemptPrefix}first`;
    const attemptB = `${sharedAttemptPrefix}second`;
    const payload = Buffer.from('collision-free-materialization-payload', 'utf8');
    const src = await createSourceFile(sourceRoot, longArtId, payload);

    // Short IDs retain legacy format; long IDs fold into 120-char collision-free hash suffix.
    expect(materializedCopyArtifactId('art-1', 'att-1', src.ref.digestHex)).toBe('mat-art-1-att-1');
    const idA = materializedCopyArtifactId(longArtId, attemptA, src.ref.digestHex);
    const idB = materializedCopyArtifactId(longArtId, attemptB, src.ref.digestHex);
    expect(idA).not.toBe(idB);
    expect(idA.length).toBe(120);
    expect(idB.length).toBe(120);
    expect(LIFECYCLE_OPAQUE_ID_PATTERN.test(idA)).toBe(true);
    expect(LIFECYCLE_OPAQUE_ID_PATTERN.test(idB)).toBe(true);

    const lifecycle = makeLifecycle();
    const resA = await materializeHandoffArtifacts({
      runId: 'run-crb2-3',
      handoffId: 'h-crb2-3',
      targetAttemptId: attemptA,
      targetRoot,
      sources: [src],
      lifecycle
    });
    const resB = await materializeHandoffArtifacts({
      runId: 'run-crb2-3',
      handoffId: 'h-crb2-3',
      targetAttemptId: attemptB,
      targetRoot,
      sources: [src],
      lifecycle
    });
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    expect(lifecycle.isProtected(idA).protected).toBe(true);
    expect(lifecycle.isProtected(idB).protected).toBe(true);
  });
});
