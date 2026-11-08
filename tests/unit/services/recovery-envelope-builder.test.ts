import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_CAPTURE_CANDIDATE_PATHS,
  MAX_CAPTURE_DURATION_MS,
  MAX_CAPTURE_FILE_BYTES,
  MAX_CAPTURE_TOTAL_BYTES,
  MAX_RECOVERY_ENVELOPE_BYTES,
  MAX_RECOVERY_PATH_BYTES,
  MAX_RECOVERY_REF_BYTES,
  MAX_RECOVERY_REFS_PER_ARRAY,
  MAX_RECOVERY_WORKSPACE_ENTRIES,
  RECOVERY_ENVELOPE_VERSION,
  serializeRecoveryEnvelope,
  validateRecoveryEnvelope,
  type RecoveryEnvelope,
  type RecoveryWorkspaceEntry
} from '../../../src/contracts/recovery-envelope';
import {
  buildRecoveryEnvelope,
  captureWorkspaceObservation,
  deriveOpaqueRepositoryId,
  evaluateEffectCertainty,
  type WorkspaceObservationSnapshot
} from '../../../src/services/workflow-execution/recovery-envelope-builder';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function lookupRecord<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

describe('RecoveryEnvelope contract & builder (SPEC-05 / D5)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('pins D5 schema version and bounds constants', () => {
    expect(RECOVERY_ENVELOPE_VERSION).toBe(1);
    expect(MAX_RECOVERY_ENVELOPE_BYTES).toBe(16_384);
    expect(MAX_RECOVERY_WORKSPACE_ENTRIES).toBe(100);
    expect(MAX_RECOVERY_REF_BYTES).toBe(128);
    expect(MAX_RECOVERY_REFS_PER_ARRAY).toBe(32);
    expect(MAX_RECOVERY_PATH_BYTES).toBe(512);
    expect(MAX_CAPTURE_CANDIDATE_PATHS).toBe(1_000);
    expect(MAX_CAPTURE_FILE_BYTES).toBe(1_048_576);
    expect(MAX_CAPTURE_TOTAL_BYTES).toBe(8_388_608);
    expect(MAX_CAPTURE_DURATION_MS).toBe(2_000);
  });

  it('validates closed RecoveryEnvelope shape and rejects unknown fields or unsupported versions', () => {
    const valid: RecoveryEnvelope = {
      version: 1,
      invocationId: 'inv-001',
      previousAttemptId: 'att-001',
      previousOutcome: {
        status: 'incomplete',
        reason: 'credits'
      },
      upstreamArtifactRefs: ['art-up-1'],
      partialArtifactRefs: ['art-part-1'],
      workspace: {
        repositoryId: 'repo-0123456789abcdef',
        head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        coverage: 'complete',
        omittedCount: 0,
        entries: [
          {
            path: 'src/index.ts',
            existedBefore: true,
            dirtyBefore: false,
            beforeSha256: sha256Hex('before'),
            afterSha256: sha256Hex('after'),
            attribution: 'attempt'
          }
        ]
      },
      effects: {
        certainty: 'safe',
        evidenceRefs: ['checkpoint-001']
      },
      truncated: false
    };

    const okResult = validateRecoveryEnvelope(valid);
    expect(okResult.ok).toBe(true);

    const badVersion = validateRecoveryEnvelope({ ...valid, version: 2 });
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) {
      expect(badVersion.diagnostics.some((d) => d.code === 'unsupported-recovery-envelope-version')).toBe(true);
    }

    const unknownTop = validateRecoveryEnvelope({ ...valid, extraField: true });
    expect(unknownTop.ok).toBe(false);
    if (!unknownTop.ok) {
      expect(unknownTop.diagnostics.some((d) => d.code === 'unknown-recovery-envelope-field')).toBe(true);
    }

    const firstEntry = valid.workspace.entries.at(0);
    const unknownNested = validateRecoveryEnvelope({
      ...valid,
      workspace: {
        ...valid.workspace,
        entries: [
          {
            ...firstEntry,
            unexpected: 'x'
          }
        ]
      }
    });
    expect(unknownNested.ok).toBe(false);
    if (!unknownNested.ok) {
      expect(unknownNested.diagnostics.some((d) => d.field === 'workspace.entries[0].unexpected')).toBe(true);
    }

    const absoluteRepoId = validateRecoveryEnvelope({
      ...valid,
      workspace: {
        ...valid.workspace,
        repositoryId: '/Users/operator/secret-workspace'
      }
    });
    expect(absoluteRepoId.ok).toBe(false);

    const traversalPath = validateRecoveryEnvelope({
      ...valid,
      workspace: {
        ...valid.workspace,
        entries: [
          {
            path: '../outside.txt',
            existedBefore: false,
            dirtyBefore: false,
            attribution: 'attempt'
          }
        ]
      }
    });
    expect(traversalPath.ok).toBe(false);
  });

  it('attributes already-dirty files modified again by the attempt as attempt using SHA-256 hashes', () => {
    const hDirtyBefore = sha256Hex('operator uncommitted edit v1');
    const hDirtyModifiedAgain = sha256Hex('operator edit + candidate A partial edit v2');
    const hUntouchedDirty = sha256Hex('operator untouched dirty file');
    const hClean = sha256Hex('clean tracked file');
    const hCreated = sha256Hex('newly created by candidate A');

    const beforeObservation: WorkspaceObservationSnapshot = {
      repositoryId: 'repo-1111222233334444',
      head: 'abcdef1234567890abcdef1234567890abcdef12',
      isGitRepository: true,
      coverage: 'complete',
      omittedCount: 0,
      timedOut: false,
      capturedAtMs: 1_000,
      files: {
        'src/dirty-remodified.ts': {
          path: 'src/dirty-remodified.ts',
          existed: true,
          dirtyInGit: true,
          sha256: hDirtyBefore
        },
        'src/dirty-untouched.ts': {
          path: 'src/dirty-untouched.ts',
          existed: true,
          dirtyInGit: true,
          sha256: hUntouchedDirty
        },
        'src/clean-untouched.ts': {
          path: 'src/clean-untouched.ts',
          existed: true,
          dirtyInGit: false,
          sha256: hClean
        },
        'src/deleted-by-attempt.ts': {
          path: 'src/deleted-by-attempt.ts',
          existed: true,
          dirtyInGit: false,
          sha256: hClean
        }
      }
    };

    const afterObservation: WorkspaceObservationSnapshot = {
      repositoryId: 'repo-1111222233334444',
      head: 'abcdef1234567890abcdef1234567890abcdef12',
      isGitRepository: true,
      coverage: 'complete',
      omittedCount: 0,
      timedOut: false,
      capturedAtMs: 1_500,
      files: {
        'src/dirty-remodified.ts': {
          path: 'src/dirty-remodified.ts',
          existed: true,
          dirtyInGit: true,
          sha256: hDirtyModifiedAgain
        },
        'src/dirty-untouched.ts': {
          path: 'src/dirty-untouched.ts',
          existed: true,
          dirtyInGit: true,
          sha256: hUntouchedDirty
        },
        'src/clean-untouched.ts': {
          path: 'src/clean-untouched.ts',
          existed: true,
          dirtyInGit: false,
          sha256: hClean
        },
        'src/deleted-by-attempt.ts': {
          path: 'src/deleted-by-attempt.ts',
          existed: false,
          dirtyInGit: true
        },
        'src/new-by-attempt.ts': {
          path: 'src/new-by-attempt.ts',
          existed: true,
          dirtyInGit: true,
          sha256: hCreated
        }
      }
    };

    const result = buildRecoveryEnvelope({
      invocationId: 'inv-dirty-test',
      previousAttemptId: 'att-1',
      previousOutcome: {
        status: 'incomplete',
        reason: 'credits'
      },
      beforeObservation,
      afterObservation,
      sideEffects: 'workspace',
      hasAttributableTeardown: true,
      effectEvidenceRefs: ['teardown-att-1']
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entriesByPath = new Map(result.handover.workspace.entries.map((e) => [e.path, e]));
    expect(entriesByPath.has('src/clean-untouched.ts')).toBe(false);

    const remodified = entriesByPath.get('src/dirty-remodified.ts');
    expect(remodified).toEqual({
      path: 'src/dirty-remodified.ts',
      existedBefore: true,
      dirtyBefore: true,
      beforeSha256: hDirtyBefore,
      afterSha256: hDirtyModifiedAgain,
      attribution: 'attempt'
    });

    const untouchedDirty = entriesByPath.get('src/dirty-untouched.ts');
    expect(untouchedDirty).toEqual({
      path: 'src/dirty-untouched.ts',
      existedBefore: true,
      dirtyBefore: true,
      beforeSha256: hUntouchedDirty,
      afterSha256: hUntouchedDirty,
      attribution: 'preexisting'
    });

    const deleted = entriesByPath.get('src/deleted-by-attempt.ts');
    expect(deleted).toEqual({
      path: 'src/deleted-by-attempt.ts',
      existedBefore: true,
      dirtyBefore: false,
      beforeSha256: hClean,
      attribution: 'attempt'
    });

    const created = entriesByPath.get('src/new-by-attempt.ts');
    expect(created).toEqual({
      path: 'src/new-by-attempt.ts',
      existedBefore: false,
      dirtyBefore: false,
      afterSha256: hCreated,
      attribution: 'attempt'
    });

    expect(result.handover.effects.certainty).toBe('safe');
    expect(result.handover.workspace.coverage).toBe('complete');
  });

  it('enforces 100/101 entry cap and 16,384/16,385 UTF-8 byte boundary with deterministic truncation', () => {
    const entries101: RecoveryWorkspaceEntry[] = [];
    for (let index = 0; index < 101; index += 1) {
      const padded = String(index).padStart(3, '0');
      entries101.push({
        path: `src/module-${padded}/component-${padded}-${'x'.repeat(80)}.ts`,
        existedBefore: true,
        dirtyBefore: false,
        beforeSha256: sha256Hex(`before-${padded}`),
        afterSha256: sha256Hex(`after-${padded}`),
        attribution: 'attempt'
      });
    }

    const candidate: RecoveryEnvelope = {
      version: 1,
      invocationId: 'inv-bounds',
      previousAttemptId: 'att-bounds',
      previousOutcome: {
        status: 'failed',
        reason: 'process-failure'
      },
      upstreamArtifactRefs: Array.from({ length: 32 }, (_, i) => `up-ref-${i}-${'a'.repeat(40)}`),
      partialArtifactRefs: Array.from({ length: 32 }, (_, i) => `part-ref-${i}-${'b'.repeat(40)}`),
      workspace: {
        repositoryId: 'repo-abcdef0123456789',
        head: '0123456789abcdef0123456789abcdef01234567',
        coverage: 'complete',
        omittedCount: 0,
        entries: entries101
      },
      effects: {
        certainty: 'safe',
        evidenceRefs: ['ev-1']
      },
      truncated: false
    };

    // Unbounded JSON exceeds 16,384 bytes and 100 entries
    expect(Buffer.byteLength(JSON.stringify(candidate), 'utf8')).toBeGreaterThan(MAX_RECOVERY_ENVELOPE_BYTES);

    const bounded = serializeRecoveryEnvelope(candidate);
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;

    expect(bounded.byteLength).toBeLessThanOrEqual(MAX_RECOVERY_ENVELOPE_BYTES);
    expect(bounded.handover.workspace.entries.length).toBeLessThanOrEqual(MAX_RECOVERY_WORKSPACE_ENTRIES);
    expect(bounded.handover.truncated).toBe(true);
    expect(bounded.handover.workspace.coverage).toBe('partial');
    expect(bounded.handover.workspace.omittedCount).toBe(
      101 - bounded.handover.workspace.entries.length
    );

    // Verify validateRecoveryEnvelope rejects a raw payload of 16,385+ bytes
    const rawOversized = validateRecoveryEnvelope(candidate);
    expect(rawOversized.ok).toBe(false);
    if (!rawOversized.ok) {
      expect(rawOversized.diagnostics.some((d) => d.code === 'recovery-context-too-large')).toBe(true);
    }

    // Verify refusal with recovery-context-too-large if fixed metadata alone exceeds 16,384 bytes
    const impossibleFixedMetadata = serializeRecoveryEnvelope({
      ...candidate,
      invocationId: 'x'.repeat(20_000),
      workspace: {
        ...candidate.workspace,
        entries: []
      },
      upstreamArtifactRefs: [],
      partialArtifactRefs: [],
      effects: {
        certainty: 'safe',
        evidenceRefs: []
      }
    });
    expect(impossibleFixedMetadata.ok).toBe(false);
    if (!impossibleFixedMetadata.ok) {
      expect(impossibleFixedMetadata.code).toBe('recovery-context-too-large');
    }
  });

  it('enforces 1,000 paths, 1 MiB per file, 8 MiB aggregate, and 2,000 ms capture timeout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f27-unit-'));
    tempDirs.push(root);

    await fs.writeFile(path.join(root, 'small.txt'), 'hello world\n', 'utf8');
    await fs.writeFile(path.join(root, 'oversized.bin'), Buffer.alloc(1024, 0x41));

    // 1) Per-file byte cap (set to 512 bytes in test)
    const perFileCapObs = await captureWorkspaceObservation({
      workspaceRoot: root,
      maxFileBytes: 512
    });
    expect(perFileCapObs.coverage).toBe('partial');
    expect(perFileCapObs.omittedCount).toBe(1);
    expect(lookupRecord(perFileCapObs.files, 'small.txt')?.sha256).toBe(sha256Hex('hello world\n'));
    expect(lookupRecord(perFileCapObs.files, 'oversized.bin')?.oversized).toBe(true);
    expect(lookupRecord(perFileCapObs.files, 'oversized.bin')?.sha256).toBeUndefined();

    // 2) Aggregate byte cap (set to 100 bytes so second file exceeds aggregate)
    await fs.writeFile(path.join(root, 'a-file.txt'), 'x'.repeat(80), 'utf8');
    await fs.writeFile(path.join(root, 'b-file.txt'), 'y'.repeat(80), 'utf8');
    const totalCapObs = await captureWorkspaceObservation({
      workspaceRoot: root,
      candidatePaths: ['a-file.txt', 'b-file.txt'],
      maxTotalBytes: 100
    });
    expect(totalCapObs.coverage).toBe('partial');
    expect(lookupRecord(totalCapObs.files, 'a-file.txt')?.sha256).toBeDefined();
    expect(lookupRecord(totalCapObs.files, 'b-file.txt')?.oversized).toBe(true);

    // 3) Candidate path count cap (100/101 or custom maxCandidatePaths)
    const manyPaths = Array.from({ length: 101 }, (_, i) => `path-${String(i).padStart(3, '0')}.txt`);
    const pathCapObs = await captureWorkspaceObservation({
      workspaceRoot: root,
      candidatePaths: manyPaths,
      maxCandidatePaths: 100
    });
    expect(pathCapObs.coverage).toBe('partial');
    expect(pathCapObs.omittedCount).toBeGreaterThanOrEqual(1);
    expect(Object.keys(pathCapObs.files).length).toBe(100);

    // 4) 2,000 ms capture timeout via injected virtual clock
    let fakeNow = 10_000;
    const timeoutObs = await captureWorkspaceObservation({
      workspaceRoot: root,
      candidatePaths: ['a-file.txt', 'b-file.txt', 'small.txt'],
      nowMs: () => fakeNow,
      fileReadHook: (relPath) => {
        if (relPath === 'b-file.txt') {
          fakeNow += 2_005;
        }
      }
    });
    expect(timeoutObs.timedOut).toBe(true);
    expect(timeoutObs.coverage).toBe('partial');
    expect(timeoutObs.omittedCount).toBe(2);
    expect(lookupRecord(timeoutObs.files, 'a-file.txt')?.sha256).toBeDefined();
    expect(lookupRecord(timeoutObs.files, 'b-file.txt')).toBeUndefined();
  });

  it('redacts secrets via logger sanitizer and classifies safe, uncertain, and unknown effects', () => {
    const secretRef = 'ref-with-secret-sk-ant-api03-1234567890abcdefghijklmnop';
    const result = buildRecoveryEnvelope({
      invocationId: 'inv-redact',
      upstreamArtifactRefs: [secretRef],
      beforeObservation: {
        repositoryId: deriveOpaqueRepositoryId('/Users/operator/private-repo'),
        isGitRepository: false,
        coverage: 'complete',
        omittedCount: 0,
        timedOut: false,
        capturedAtMs: 100,
        files: {}
      },
      afterObservation: {
        repositoryId: deriveOpaqueRepositoryId('/Users/operator/private-repo'),
        isGitRepository: false,
        coverage: 'complete',
        omittedCount: 0,
        timedOut: false,
        capturedAtMs: 200,
        files: {}
      },
      sideEffects: 'git',
      hasAttributableTeardown: true,
      effectEvidenceRefs: ['checkpoint-1']
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.serialized).not.toContain('sk-ant-api03-1234567890abcdefghijklmnop');
    expect(result.serialized).not.toContain('/Users/operator/private-repo');
    // git side effects without verified reconciliation yield uncertain
    expect(result.handover.effects.certainty).toBe('uncertain');

    // Unrestricted side effects yield uncertain unless verifiedReconciliation is true
    expect(
      evaluateEffectCertainty({
        sideEffects: 'unrestricted',
        hasAttributableTeardown: true,
        evidenceRefs: ['ev-1'],
        workspaceCoverage: 'complete',
        entries: []
      })
    ).toBe('uncertain');

    // Concurrent entry forces unknown certainty even with workspace sideEffects
    expect(
      evaluateEffectCertainty({
        sideEffects: 'workspace',
        hasAttributableTeardown: true,
        evidenceRefs: ['ev-1'],
        workspaceCoverage: 'partial',
        entries: [
          {
            path: 'src/concurrent.ts',
            existedBefore: true,
            dirtyBefore: false,
            attribution: 'concurrent'
          }
        ]
      })
    ).toBe('unknown');
  });
});
