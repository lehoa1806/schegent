// FR-R7-17 (R7-17-08, AC-12) — unit tests for `attempt-result-publisher.ts`:
// atomic staging validation, short-read offset safety, exact 256 KiB boundary, ENOENT-only absence,
// leftover *.tmp / *.part fail-closed refusal, atomic immutable capture, checked F05 pins, and
// attempt/iteration-scoped sanitized `legacySidecarOptIn`.
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PHASE_CONTEXT_CONTRIBUTION_VERSION,
  PHASE_CONTEXT_LIMITS,
  type ProducerRef
} from '../../../../src/contracts/phase-context/context-policy';
import {
  FIX_CLAIMS_VERSION,
  REVIEW_REPORT_VERSION
} from '../../../../src/contracts/phase-context/review-loop';
import { composePhaseMessagePath } from '../../../../src/controller/phase-sidecar-reader';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY,
  type ArtifactLifecycleService
} from '../../../../src/services/artifact-lifecycle';
import {
  allocateAttemptStagingPaths,
  captureAttemptPublications,
  readBoundedUtf8FromHandle
} from '../../../../src/services/phase-context/attempt-result-publisher';
import { SqliteApplicationStore } from '../../../../src/services/sqlite-store';

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

afterEach(async () => {
  while (openStores.length > 0) {
    openStores.pop()!.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    // Restore permissions in case a test chmod'd a file/dir to 0o000/0o500.
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
      // Best-effort cleanup permission restore.
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const PRODUCER: ProducerRef = Object.freeze({
  nodePath: 'root/implement',
  occurrenceId: 'occ-1',
  attemptId: 'att-impl-1'
});

function validContributionJson(producer: ProducerRef = PRODUCER, extraOutcome = 'Step done.'): string {
  return JSON.stringify({
    schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
    producer,
    coverage: 'complete',
    outcomes: [extraOutcome],
    decisions: [],
    constraints: [],
    unresolvedIssues: [],
    summary: null,
    artifacts: []
  });
}

function validReviewReportJson(attemptId: string = PRODUCER.attemptId): string {
  return JSON.stringify({
    reportVersion: REVIEW_REPORT_VERSION,
    loopId: 'loop-review-1',
    pass: 1,
    reviewerAttemptId: attemptId,
    candidateRef: 'cand-sha-1',
    scopeRevision: 'scope-1',
    criteriaRevision: 'criteria-1',
    previousReportRef: null,
    coverage: 'complete',
    reviewPassed: true,
    blockingCount: 0,
    findings: [],
    dispositions: []
  });
}

function validFixClaimsJson(attemptId: string = PRODUCER.attemptId): string {
  return JSON.stringify({
    claimsVersion: FIX_CLAIMS_VERSION,
    loopId: 'loop-review-1',
    pass: 1,
    fixerAttemptId: attemptId,
    basedOnReportRef: 'report@1',
    claims: [{ findingId: 'F-1', claim: 'claimed-fixed' }]
  });
}

function padJsonToExactBytes(jsonText: string, targetBytes: number): string {
  const currentBytes = Buffer.byteLength(jsonText, 'utf8');
  if (currentBytes > targetBytes) {
    throw new Error(`base JSON (${currentBytes}) already exceeds ${targetBytes}`);
  }
  return jsonText + ' '.repeat(targetBytes - currentBytes);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.stage`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, filePath);
}

describe('FR-R7-17 (AC-12) — attempt-result-publisher', () => {
  it('accumulates short reads at the current offset without corrupting byte 0 and catches concurrent growth past maxBytes', async () => {
    const payload = Buffer.from(validContributionJson(PRODUCER, 'Short-read verification payload.'), 'utf8');
    const chunkSize = 7;

    const shortReadHandle: Pick<FileHandle, 'stat' | 'read'> = {
      stat: (async () => ({
        size: payload.byteLength,
        isFile: () => true
      })) as unknown as FileHandle['stat'],
      read: (async (buffer: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null, position?: number | null) => {
        const dest = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const destOffset = offset ?? 0;
        const pos = position ?? 0;
        const maxLen = length ?? dest.byteLength - destOffset;
        if (pos >= payload.byteLength) {
          return { bytesRead: 0, buffer };
        }
        const toCopy = Math.min(chunkSize, maxLen, payload.byteLength - pos);
        payload.copy(dest, destOffset, pos, pos + toCopy);
        return { bytesRead: toCopy, buffer };
      }) as unknown as FileHandle['read']
    };

    const readOk = await readBoundedUtf8FromHandle(shortReadHandle, PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax);
    expect(readOk.kind).toBe('ok');
    if (readOk.kind === 'ok') {
      expect(readOk.text).toBe(payload.toString('utf8'));
      expect(readOk.byteSize).toBe(payload.byteLength);
      expect(readOk.digestHex).toBe(createHash('sha256').update(payload).digest('hex'));
    }

    // Concurrent growth past maxBytes (stat reports exact limit, file actually yields limit + 1 byte).
    const maxBytes = 64;
    const grownPayload = Buffer.alloc(maxBytes + 1, 0x61);
    const grownHandle: Pick<FileHandle, 'stat' | 'read'> = {
      stat: (async () => ({
        size: maxBytes,
        isFile: () => true
      })) as unknown as FileHandle['stat'],
      read: (async (buffer: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null, position?: number | null) => {
        const dest = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const destOffset = offset ?? 0;
        const pos = position ?? 0;
        const maxLen = length ?? dest.byteLength - destOffset;
        if (pos >= grownPayload.byteLength) return { bytesRead: 0, buffer };
        const toCopy = Math.min(16, maxLen, grownPayload.byteLength - pos);
        grownPayload.copy(dest, destOffset, pos, pos + toCopy);
        return { bytesRead: toCopy, buffer };
      }) as unknown as FileHandle['read']
    };

    const grownResult = await readBoundedUtf8FromHandle(grownHandle, maxBytes);
    expect(grownResult).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'artifact-oversized'
    });

    // Concurrent truncation (stat reports 100 bytes, EOF after 20 bytes).
    const truncHandle: Pick<FileHandle, 'stat' | 'read'> = {
      stat: (async () => ({
        size: 100,
        isFile: () => true
      })) as unknown as FileHandle['stat'],
      read: (async (buffer: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null, position?: number | null) => {
        const dest = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const destOffset = offset ?? 0;
        const pos = position ?? 0;
        if (pos >= 20) return { bytesRead: 0, buffer };
        const toCopy = Math.min(length ?? 20, 20 - pos);
        dest.fill(0x78, destOffset, destOffset + toCopy);
        return { bytesRead: toCopy, buffer };
      }) as unknown as FileHandle['read']
    };

    const truncResult = await readBoundedUtf8FromHandle(truncHandle, maxBytes * 4);
    expect(truncResult).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'artifact-truncated'
    });
  });

  it('atomically captures valid contribution, review-report, and fix-claims and pins them in F05 with zero leftover temp files', async () => {
    const execRoot = await makeTempDir('arp-exec-');
    const primaryRoot = await makeTempDir('arp-primary-');
    const lifecycle = makeLifecycle();
    const staging = allocateAttemptStagingPaths(execRoot, 'run-1', PRODUCER.attemptId);

    await writeAtomic(staging.contributionAbsPath, validContributionJson());
    await writeAtomic(staging.reviewReportAbsPath, validReviewReportJson());
    await writeAtomic(staging.fixClaimsAbsPath, validFixClaimsJson());

    const result = await captureAttemptPublications({
      runId: 'run-1',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      lifecycle
    });

    expect(result.contribution.kind).toBe('accepted');
    expect(result.reviewReport.kind).toBe('accepted');
    expect(result.fixClaims.kind).toBe('accepted');

    if (result.contribution.kind === 'accepted') {
      const capDir = path.dirname(result.contribution.capture.immutableAbsPath);
      const capFiles = await fsp.readdir(capDir);
      expect(capFiles.some((f) => f.endsWith('.tmp'))).toBe(false);
      expect(lifecycle.isProtected(result.contribution.capture.artifactRef.artifactId).protected).toBe(true);
    }
    if (result.reviewReport.kind === 'accepted') {
      expect(lifecycle.isProtected(result.reviewReport.capture.artifactRef.artifactId).protected).toBe(true);
    }
    if (result.fixClaims.kind === 'accepted') {
      expect(lifecycle.isProtected(result.fixClaims.capture.artifactRef.artifactId).protected).toBe(true);
    }

    // Idempotent re-capture with identical immutable bytes succeeds (handles F05 identity-conflict).
    const repeat = await captureAttemptPublications({
      runId: 'run-1',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      lifecycle
    });
    expect(repeat.contribution.kind).toBe('accepted');
    expect(repeat.reviewReport.kind).toBe('accepted');
    expect(repeat.fixClaims.kind).toBe('accepted');
  });

  it('accepts exact 262,144 B and refuses 262,145 B across contribution.json, review-report.json, and fix-claims.json', async () => {
    const maxBytes = PHASE_CONTEXT_LIMITS.reviewArtifactBytesMax;
    expect(maxBytes).toBe(262_144);

    const execExact = await makeTempDir('arp-exact-');
    const primaryExact = await makeTempDir('arp-exact-pri-');
    const stagingExact = allocateAttemptStagingPaths(execExact, 'run-bound', PRODUCER.attemptId);

    await writeAtomic(stagingExact.contributionAbsPath, padJsonToExactBytes(validContributionJson(), maxBytes));
    await writeAtomic(stagingExact.reviewReportAbsPath, padJsonToExactBytes(validReviewReportJson(), maxBytes));
    await writeAtomic(stagingExact.fixClaimsAbsPath, padJsonToExactBytes(validFixClaimsJson(), maxBytes));

    const exactRes = await captureAttemptPublications({
      runId: 'run-bound',
      executionRoot: execExact,
      primaryWorkspaceRoot: primaryExact,
      producer: PRODUCER
    });
    expect(exactRes.contribution.kind).toBe('accepted');
    expect(exactRes.reviewReport.kind).toBe('accepted');
    expect(exactRes.fixClaims.kind).toBe('accepted');

    const execOver = await makeTempDir('arp-over-');
    const primaryOver = await makeTempDir('arp-over-pri-');
    const stagingOver = allocateAttemptStagingPaths(execOver, 'run-bound', PRODUCER.attemptId);

    await writeAtomic(stagingOver.contributionAbsPath, padJsonToExactBytes(validContributionJson(), maxBytes + 1));
    await writeAtomic(stagingOver.reviewReportAbsPath, padJsonToExactBytes(validReviewReportJson(), maxBytes + 1));
    await writeAtomic(stagingOver.fixClaimsAbsPath, padJsonToExactBytes(validFixClaimsJson(), maxBytes + 1));

    const overRes = await captureAttemptPublications({
      runId: 'run-bound',
      executionRoot: execOver,
      primaryWorkspaceRoot: primaryOver,
      producer: PRODUCER
    });
    expect(overRes.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'artifact-oversized'
    });
    expect(overRes.reviewReport).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'artifact-oversized'
    });
    expect(overRes.fixClaims).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'artifact-oversized'
    });
  });

  it('refuses stale/foreign attemptId, nodePath, occurrenceId, 0-byte, and malformed JSON', async () => {
    const execRoot = await makeTempDir('arp-foreign-');
    const primaryRoot = await makeTempDir('arp-foreign-pri-');
    const staging = allocateAttemptStagingPaths(execRoot, 'run-foreign', PRODUCER.attemptId);

    // Foreign attemptId in contribution, review-report, and fix-claims.
    await writeAtomic(
      staging.contributionAbsPath,
      validContributionJson({ ...PRODUCER, attemptId: 'att-stale-0' })
    );
    await writeAtomic(staging.reviewReportAbsPath, validReviewReportJson('att-stale-0'));
    await writeAtomic(staging.fixClaimsAbsPath, validFixClaimsJson('att-stale-0'));

    const res1 = await captureAttemptPublications({
      runId: 'run-foreign',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(res1.contribution).toMatchObject({ kind: 'refused', ok: false, failure: 'invalid-source', detail: 'producer-mismatch' });
    expect(res1.reviewReport).toMatchObject({ kind: 'refused', ok: false, failure: 'invalid-source', detail: 'reviewer-attempt-mismatch' });
    expect(res1.fixClaims).toMatchObject({ kind: 'refused', ok: false, failure: 'invalid-source', detail: 'fixer-attempt-mismatch' });

    // Foreign nodePath and occurrenceId in contribution.
    await writeAtomic(
      staging.contributionAbsPath,
      validContributionJson({ ...PRODUCER, nodePath: 'root/other-node' })
    );
    await fsp.unlink(staging.reviewReportAbsPath);
    await fsp.unlink(staging.fixClaimsAbsPath);
    const resNode = await captureAttemptPublications({
      runId: 'run-foreign',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(resNode.contribution).toMatchObject({ kind: 'refused', ok: false, failure: 'invalid-source', detail: 'producer-mismatch' });

    await writeAtomic(
      staging.contributionAbsPath,
      validContributionJson({ ...PRODUCER, occurrenceId: 'occ-other' })
    );
    const resOcc = await captureAttemptPublications({
      runId: 'run-foreign',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(resOcc.contribution).toMatchObject({ kind: 'refused', ok: false, failure: 'invalid-source', detail: 'producer-mismatch' });

    // 0-byte file and partial/truncated JSON refused.
    await writeAtomic(staging.contributionAbsPath, '');
    const resEmpty = await captureAttemptPublications({
      runId: 'run-foreign',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(resEmpty.contribution).toMatchObject({ kind: 'refused', ok: false, failure: 'invalid-source' });

    await writeAtomic(staging.contributionAbsPath, '{"schemaVersion":1,"producer":');
    const resMalformed = await captureAttemptPublications({
      runId: 'run-foreign',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(resMalformed.contribution).toMatchObject({ kind: 'refused', ok: false, failure: 'invalid-source' });
  });

  it('classifies only ENOENT as absent and refuses symlinks, directories, and EACCES', async () => {
    const execRoot = await makeTempDir('arp-fs-');
    const primaryRoot = await makeTempDir('arp-fs-pri-');
    const outsideDir = await makeTempDir('arp-outside-');
    const staging = allocateAttemptStagingPaths(execRoot, 'run-fs', PRODUCER.attemptId);

    // ENOENT -> absent.
    const absentRes = await captureAttemptPublications({
      runId: 'run-fs',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(absentRes.contribution).toEqual({ kind: 'absent' });
    expect(absentRes.reviewReport).toEqual({ kind: 'absent' });
    expect(absentRes.fixClaims).toEqual({ kind: 'absent' });

    // Symlink leaf refused (never absent!).
    const outsideFile = path.join(outsideDir, 'leak.json');
    await fsp.writeFile(outsideFile, validContributionJson(), 'utf8');
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
    await fsp.symlink(outsideFile, staging.contributionAbsPath);

    const symLeafRes = await captureAttemptPublications({
      runId: 'run-fs',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(symLeafRes.contribution.kind).toBe('refused');
    if (symLeafRes.contribution.kind === 'refused') {
      expect(symLeafRes.contribution.failure).toBe('invalid-source');
    }
    await fsp.unlink(staging.contributionAbsPath);

    // Directory at leaf refused (never absent!).
    await fsp.mkdir(staging.contributionAbsPath);
    const dirLeafRes = await captureAttemptPublications({
      runId: 'run-fs',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(dirLeafRes.contribution.kind).toBe('refused');
    await fsp.rm(staging.contributionAbsPath, { recursive: true, force: true });

    // EACCES refused (never absent!) on POSIX non-root.
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      await writeAtomic(staging.contributionAbsPath, validContributionJson());
      await fsp.chmod(staging.contributionAbsPath, 0o000);
      const eaccesRes = await captureAttemptPublications({
        runId: 'run-fs',
        executionRoot: execRoot,
        primaryWorkspaceRoot: primaryRoot,
        producer: PRODUCER
      });
      expect(eaccesRes.contribution.kind).toBe('refused');
      if (eaccesRes.contribution.kind === 'refused') {
        expect(eaccesRes.contribution.failure).toBe('storage-unavailable');
      }
      await fsp.chmod(staging.contributionAbsPath, 0o600);
      await fsp.unlink(staging.contributionAbsPath);
    }

    // Symlink parent component refused.
    const symExecRoot = await makeTempDir('arp-symparent-');
    await fsp.mkdir(path.join(symExecRoot, '.schegent'), { recursive: true });
    await fsp.symlink(outsideDir, path.join(symExecRoot, '.schegent', 'results'));
    const symParentRes = await captureAttemptPublications({
      runId: 'run-fs',
      executionRoot: symExecRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(symParentRes.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'staging-symlink-component'
    });
  });

  it('fails closed on leftover *.tmp or *.part files both alone and beside a valid final file (Clarification Q4)', async () => {
    const execRoot = await makeTempDir('arp-temp-');
    const primaryRoot = await makeTempDir('arp-temp-pri-');
    const staging = allocateAttemptStagingPaths(execRoot, 'run-tmp', PRODUCER.attemptId);
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });

    // Case 1: leftover .tmp alone (no contribution.json) -> MUST refuse (never absent / never fallback!).
    const tmpAlone = path.join(staging.stagingDirAbsPath, 'contribution.json.tmp');
    await fsp.writeFile(tmpAlone, '{"partial":true', 'utf8');
    const aloneRes = await captureAttemptPublications({
      runId: 'run-tmp',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(aloneRes.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'incomplete-staging-temp-file'
    });
    expect(aloneRes.reviewReport).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'incomplete-staging-temp-file'
    });
    expect(aloneRes.fixClaims).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'incomplete-staging-temp-file'
    });
    await fsp.unlink(tmpAlone);

    // Case 2: leftover .part sitting beside a valid contribution.json -> STILL fails closed!
    await writeAtomic(staging.contributionAbsPath, validContributionJson());
    const partBeside = path.join(staging.stagingDirAbsPath, 'review-report.json.part');
    await fsp.writeFile(partBeside, 'partial', 'utf8');
    const besideRes = await captureAttemptPublications({
      runId: 'run-tmp',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(besideRes.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'incomplete-staging-temp-file'
    });
    // Zero immutable capture created when staging dir had leftover temp file.
    const immutableDir = path.join(primaryRoot, '.schegent', 'immutable-results');
    const exists = await fsp.stat(immutableDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('surfaces typed refusals when F05 registerArtifact or addReference fails (e.g. pin-quota-reached)', async () => {
    const execRoot = await makeTempDir('arp-f05-');
    const primaryRoot = await makeTempDir('arp-f05-pri-');
    const staging = allocateAttemptStagingPaths(execRoot, 'run-f05', PRODUCER.attemptId);
    await writeAtomic(staging.contributionAbsPath, validContributionJson());

    const quotaLifecycle = {
      registerArtifact: () => ({ ok: true, value: {} }),
      getArtifact: () => ({ ok: false, refusal: { code: 'not-found', message: 'missing' } }),
      addReference: () => ({
        ok: false,
        refusal: { code: 'pin-quota-reached', message: 'quota exceeded' }
      })
    } as unknown as ArtifactLifecycleService;

    const quotaRes = await captureAttemptPublications({
      runId: 'run-f05',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      lifecycle: quotaLifecycle
    });
    expect(quotaRes.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'pin-quota-reached'
    });

    const failingRegLifecycle = {
      registerArtifact: () => ({
        ok: false,
        refusal: { code: 'unavailable', message: 'db locked' }
      }),
      getArtifact: () => ({ ok: false, refusal: { code: 'not-found', message: 'missing' } }),
      addReference: () => ({ ok: true, value: {} })
    } as unknown as ArtifactLifecycleService;

    const regFailRes = await captureAttemptPublications({
      runId: 'run-f05',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      lifecycle: failingRegLifecycle
    });
    expect(regFailRes.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'storage-unavailable',
      detail: 'artifact-registration-failed'
    });
  });

  it('handles legacySidecarOptIn off vs on with attempt/iteration scoping, secret redaction, UTF-8 safe clipping, and non-swallowed refusals', async () => {
    const execRoot = await makeTempDir('arp-legacy-');
    const primaryRoot = await makeTempDir('arp-legacy-pri-');
    const outsideDir = await makeTempDir('arp-legacy-out-');
    const staging = allocateAttemptStagingPaths(execRoot, 'run-legacy', PRODUCER.attemptId);

    // Unattributed flat workspace-root `.schegent/phase-message.env` MUST NOT be trusted.
    await writeAtomic(path.join(execRoot, '.schegent', 'phase-message.env'), 'SUMMARY=stale-global\n');

    const flatIgnored = await captureAttemptPublications({
      runId: 'run-legacy',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      legacySidecarOptIn: true
    });
    expect(flatIgnored.contribution).toEqual({ kind: 'absent' });

    // Canonical iteration-scoped path via `composePhaseMessagePath` + `legacySidecarScope`.
    const scope = { pipelineId: 'pipe-1', phaseId: 'phase-implement', iteration: 2 };
    const canonicalSidecarPath = composePhaseMessagePath({
      cwd: execRoot,
      runId: 'run-legacy',
      ...scope
    });
    const fakeSecret = ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].join('-');
    const longEmoji = '🚀'.repeat(700); // 2,800 UTF-8 bytes (> 2 KiB entry limit)
    await writeAtomic(
      canonicalSidecarPath,
      `STATUS=passed\nAPI_KEY=${fakeSecret}\nEMOJI_NOTE=${longEmoji}\n`
    );

    // With legacySidecarOptIn omitted/false, sidecar is NOT imported.
    const optOut = await captureAttemptPublications({
      runId: 'run-legacy',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      legacySidecarOptIn: false,
      legacySidecarScope: scope
    });
    expect(optOut.contribution).toEqual({ kind: 'absent' });

    // With legacySidecarOptIn: true, sidecar is imported, redacted, and UTF-8 clipped cleanly!
    const optIn = await captureAttemptPublications({
      runId: 'run-legacy',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      legacySidecarOptIn: true,
      legacySidecarScope: scope
    });
    expect(optIn.contribution.kind).toBe('accepted');
    if (optIn.contribution.kind === 'accepted') {
      expect(optIn.contribution.contribution.coverage).toBe('partial');
      const joined = optIn.contribution.contribution.outcomes.join('\n');
      expect(joined).toContain('STATUS=passed');
      expect(joined).toContain('API_KEY=[REDACTED]');
      expect(joined).not.toContain(fakeSecret);
      expect(joined).not.toContain('\uFFFD');
      const emojiEntry = optIn.contribution.contribution.outcomes.find((o) => o.startsWith('EMOJI_NOTE='));
      expect(emojiEntry).toBeDefined();
      expect(Buffer.byteLength(emojiEntry!, 'utf8')).toBeLessThanOrEqual(PHASE_CONTEXT_LIMITS.textEntryBytesMax);
    }

    // Oversized legacy sidecar (> 4096 B) MUST be refused, never swallowed!
    await writeAtomic(canonicalSidecarPath, `BIG=${'a'.repeat(5000)}\n`);
    const oversized = await captureAttemptPublications({
      runId: 'run-legacy',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      legacySidecarOptIn: true,
      legacySidecarScope: scope
    });
    expect(oversized.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'artifact-oversized'
    });

    // Symlinked legacy sidecar MUST be refused, never swallowed!
    await fsp.unlink(canonicalSidecarPath);
    const outsideSidecar = path.join(outsideDir, 'evil.env');
    await fsp.writeFile(outsideSidecar, 'STATUS=evil\n', 'utf8');
    await fsp.symlink(outsideSidecar, canonicalSidecarPath);
    const symSidecar = await captureAttemptPublications({
      runId: 'run-legacy',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      legacySidecarOptIn: true,
      legacySidecarScope: scope
    });
    expect(symSidecar.contribution.kind).toBe('refused');
    if (symSidecar.contribution.kind === 'refused') {
      expect(symSidecar.contribution.failure).toBe('invalid-source');
    }

    // Also verify attempt-scoped staging dir sidecar works when `legacySidecarScope` is omitted,
    // and F05 refusal during `persistImmutableCapture` is NOT swallowed!
    await writeAtomic(staging.legacySidecarAbsPath, 'RESULT=ok\n');
    const pinFailLifecycle = {
      registerArtifact: () => ({ ok: true, value: {} }),
      getArtifact: () => ({ ok: false, refusal: { code: 'not-found', message: 'missing' } }),
      addReference: () => ({ ok: false, refusal: { code: 'pin-quota-reached', message: 'quota' } })
    } as unknown as ArtifactLifecycleService;
    const captureRefused = await captureAttemptPublications({
      runId: 'run-legacy',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      legacySidecarOptIn: true,
      lifecycle: pinFailLifecycle
    });
    expect(captureRefused.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'capacity-exceeded',
      detail: 'pin-quota-reached'
    });
  });

  it('CR-314-7: fails closed on invalid UTF-8 bytes (0xff) in staged JSON instead of lossy U+FFFD decoding', async () => {
    const execRoot = await makeTempDir('arp-utf8-exec-');
    const primaryRoot = await makeTempDir('arp-utf8-pri-');
    const staging = allocateAttemptStagingPaths(execRoot, 'run-utf8', PRODUCER.attemptId);
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });

    // Valid JSON wrapper containing raw invalid UTF-8 byte 0xff inside a string literal.
    const invalidUtf8Payload = Buffer.concat([
      Buffer.from('{"summary":"bad-', 'utf8'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}', 'utf8')
    ]);
    await fsp.writeFile(staging.contributionAbsPath, invalidUtf8Payload);

    const res = await captureAttemptPublications({
      runId: 'run-utf8',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER
    });
    expect(res.contribution).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'artifact-invalid-utf8'
    });
  });

  it('SR-314-2: refuses staged review-report.json when allowReviewReport is false', async () => {
    const execRoot = await makeTempDir('arp-role-exec-');
    const primaryRoot = await makeTempDir('arp-role-pri-');
    const staging = allocateAttemptStagingPaths(execRoot, 'run-role', PRODUCER.attemptId);
    await writeAtomic(staging.reviewReportAbsPath, validReviewReportJson(PRODUCER.attemptId));

    const res = await captureAttemptPublications({
      runId: 'run-role',
      executionRoot: execRoot,
      primaryWorkspaceRoot: primaryRoot,
      producer: PRODUCER,
      allowReviewReport: false
    });
    expect(res.reviewReport).toEqual({
      kind: 'refused',
      ok: false,
      failure: 'invalid-source',
      detail: 'reviewer-role-unauthorized'
    });
  });
});
