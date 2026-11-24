/**
 * FR-R6-F15 (F15-B; F15-FR-08, F15-FR-13, F15-FR-18..FR-20, F15-FR-25..FR-26, F15-FR-32, F15-FR-35) —
 * declared output-file snapshotting, ForEach immutable result-index capture, ACP prompt-block
 * delivery planning, persisted DeliveryRepresentation verification, and cross-root streaming
 * materialization.
 *
 * Extracted so `phase-handoff-coordinator.ts` and `acp-backed-runner.ts` stay well below their
 * 1,000-line ceilings.
 *
 * Zero `vscode` or raw `node:fs` path-creating imports (docs/hard-rules.md rules 13, 69).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { NegotiatedCapabilities } from '../../contracts/acp-runtime';
import type {
  ArtifactAccess,
  ProfileCapacity,
  SessionRequest
} from '../../contracts/phase-context/context-delivery';
import type { HandoffManifest, HandoffRecord } from '../../contracts/phase-context/context-manifest';
import {
  IDENTIFIER_PATTERN,
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type ProducerRef,
  type Refusal
} from '../../contracts/phase-context/context-policy';
import type { FrozenPhaseHandoffDelivery, ResolvedPortValue } from '../../contracts/run-request';
import { resolveContainedTarget } from '../../lib/path-containment';
import { openWithinRoot } from '../../lib/safe-open';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { nodeExportFs, publishPartial, removePartials } from '../reporting/export-publisher';
import { readStoredManifest, type AcceptanceService } from './acceptance';
import { allocateAttemptStagingPaths } from './attempt-result-publisher';
import { checkDispatch, planDelivery } from './delivery-plan';
import { materializeHandoffArtifacts } from './handoff-materializer';
import {
  readBoundedBytesFromHandle,
  sanitizePhaseContextToken
} from './phase-context-helpers';
import type { PreparationAdmission } from './preparation-admission';
import { matchesPattern, refuse } from './primitives';
import { renderContext } from './renderer';
import {
  ensureArtifactRegisteredInLifecycle,
  pinHandoffArtifactsInLifecycle,
  type NodeReviewRole
} from './review-loop-coordinator';
import type { DurableHandoffStore } from './sqlite-handoff-store';

let snapshotTempCounter = 0;

export interface StoredArtifactLocation {
  readonly ref: ArtifactRef;
  readonly sourceRoot: string;
  readonly sourceSegments: readonly string[];
  readonly inlineText: string | null;
}

export interface TargetProfileResolution {
  readonly profile: ProfileCapacity;
  readonly capabilities: NegotiatedCapabilities;
}

export interface PlanAttemptDeliveryInput {
  readonly runId: string;
  readonly handoffId: string | null;
  readonly targetAttemptId: string;
  readonly targetNodePath: string;
  readonly targetOccurrenceId: string;
  readonly targetInstructions: string;
  readonly backendId: string;
  /** Host-bound review-loop role governing whether `review-report.json` / `fix-claims.json` are authorized. */
  readonly reviewRole?: NodeReviewRole;
  readonly previousSessionAttempt?: {
    readonly producer: ProducerRef;
    readonly backendId: string;
  } | null;
}

export type PlanAttemptDeliveryResult =
  | { readonly ok: true; readonly delivery: FrozenPhaseHandoffDelivery }
  | Refusal;

export function normalizeNodePathForHandoff(raw: string): string {
  const stripped = raw.trim().replace(/^\/+/, '').replace(/[^A-Za-z0-9._:/#-]/g, '-');
  const ensured = stripped.replace(/^[^A-Za-z0-9]+/, '').slice(0, 256);
  return ensured.length > 0 ? ensured : 'root';
}

export function canonicalNodePathInFrame(
  frame: { readonly parentInvocationId: string | null; readonly nodePath: string },
  nodeId: string
): string {
  const parentPrefix =
    frame.parentInvocationId === null
      ? ''
      : frame.nodePath.slice(0, frame.nodePath.lastIndexOf('/'));
  return normalizeNodePathForHandoff(
    parentPrefix.length > 0 ? `${parentPrefix}/${nodeId}` : nodeId
  );
}

export function normalizeHandoffIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Deterministic `IDENTIFIER_PATTERN`-valid admission owner key (<= 128 ASCII chars). */
export function buildBoundedAdmissionOwner(prefix: string, parts: readonly string[]): string {
  const cleanPrefix = normalizeHandoffIdentifier(prefix, 'prep').slice(0, 24);
  const digest = createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 32);
  const candidate = `${cleanPrefix}-${digest}`;
  return matchesPattern(IDENTIFIER_PATTERN, candidate) ? candidate : `prep-${digest}`;
}

export function artifactLocationKey(artifactId: string, immutableVersion: string): string {
  return `${artifactId}@${immutableVersion}`;
}

export function splitSafeRelativePath(relPath: string): readonly string[] | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.length === 0) return null;
  const parts = normalized.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return parts;
}

export function clipUtf8Safe(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

async function cleanupSnapshotTemp(
  primaryWorkspaceRoot: string,
  dirAbsPath: string,
  tempName: string
): Promise<void> {
  const verdict = await resolveContainedTarget(dirAbsPath, [primaryWorkspaceRoot]);
  if (verdict.outcome === 'contained') {
    await removePartials(nodeExportFs, verdict.resolved, [tempName]).catch(() => undefined);
  }
}

/**
 * Atomically publishes immutable artifact bytes beneath `primaryWorkspaceRoot` via sibling temp
 * file + contained rename (`openWithinRoot`, Rule 69).
 */
export async function snapshotImmutableArtifactBytes(params: {
  readonly primaryWorkspaceRoot: string;
  readonly dirSegments: readonly string[];
  readonly fileName: string;
  readonly bytes: Buffer;
}): Promise<{ readonly ok: true; readonly segments: readonly string[]; readonly relPath: string } | Refusal> {
  snapshotTempCounter += 1;
  const tempName = `.${params.fileName}.${process.pid}.${snapshotTempCounter}.tmp`;
  const tempSegments = [...params.dirSegments, tempName] as const;
  const finalSegments = [...params.dirSegments, params.fileName] as const;
  const dirAbsPath = path.join(params.primaryWorkspaceRoot, ...params.dirSegments);

  const opened = await openWithinRoot(params.primaryWorkspaceRoot, tempSegments, {
    flags: 'wx',
    createDirs: true,
    dirMode: 0o700,
    fileMode: 0o600
  });
  if (opened.outcome === 'refused') {
    return refuse('storage-unavailable', 'immutable-snapshot-open-refused');
  }

  let writeOk = false;
  try {
    await opened.handle.writeFile(params.bytes);
    writeOk = true;
  } catch {
    return refuse('storage-unavailable', 'immutable-snapshot-write-failed');
  } finally {
    await opened.handle.close().catch(() => undefined);
    if (!writeOk) {
      await cleanupSnapshotTemp(params.primaryWorkspaceRoot, dirAbsPath, tempName);
    }
  }

  const dirVerdict = await resolveContainedTarget(dirAbsPath, [params.primaryWorkspaceRoot]);
  if (dirVerdict.outcome !== 'contained') {
    return refuse('storage-unavailable', 'immutable-snapshot-containment-failed');
  }

  const published = await publishPartial(nodeExportFs, dirVerdict.resolved, tempName, params.fileName, true);
  if (published !== 'published') {
    await removePartials(nodeExportFs, dirVerdict.resolved, [tempName]).catch(() => undefined);
    return refuse('storage-unavailable', 'immutable-snapshot-publish-failed');
  }

  return { ok: true, segments: finalSegments, relPath: finalSegments.join('/') };
}

export async function inspectDeclaredOutputFiles(params: {
  readonly executionRoot: string;
  readonly primaryWorkspaceRoot: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly declaredOutputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly lifecycle?: ArtifactLifecycleService | null;
}): Promise<
  | {
      readonly ok: true;
      readonly refs: readonly ArtifactRef[];
      readonly locations: ReadonlyMap<string, StoredArtifactLocation>;
    }
  | Refusal
> {
  const refs: ArtifactRef[] = [];
  const locations = new Map<string, StoredArtifactLocation>();
  const sameRootAsPrimary =
    path.resolve(params.executionRoot) === path.resolve(params.primaryWorkspaceRoot);
  const attemptAlias = sanitizePhaseContextToken(params.attemptId, 'attempt');
  const normalizedRunId = normalizeHandoffIdentifier(params.runId, 'run-1');

  for (const [portId, portVal] of Object.entries(params.declaredOutputs)) {
    if (portVal.type !== 'file' && portVal.type !== 'local-file') continue;
    const segments = splitSafeRelativePath(portVal.value);
    if (segments === null) continue;
    const opened = await openWithinRoot(params.executionRoot, segments, { flags: 'r' });
    if (opened.outcome === 'refused') continue;

    let buf: Buffer;
    try {
      const readRes = await readBoundedBytesFromHandle(
        opened.handle,
        PHASE_CONTEXT_LIMITS.materializedFileBytesMax
      );
      if (!readRes.ok) continue;
      buf = readRes.bytes;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }

    const digestHex = createHash('sha256').update(buf).digest('hex');
    const artifactId = normalizeHandoffIdentifier(
      `out-${portId}-${digestHex.slice(0, 8)}`,
      'out-file'
    );
    const immutableVersion = `v1-${digestHex.slice(0, 12)}`;
    const isSmallText = buf.byteLength <= PHASE_CONTEXT_LIMITS.embedBytesMax && !buf.includes(0);

    // Preserve pre-registered immutable artifacts owned by this run under `primaryWorkspaceRoot`
    // directly; snapshot mutable declared output files atomically under `.schegent/immutable-results/<attemptAlias>/`.
    const preRegistered = params.lifecycle?.getArtifact(artifactId);
    const reusePrimaryPath =
      sameRootAsPrimary &&
      preRegistered?.ok === true &&
      preRegistered.value.ownerRunId !== null &&
      (preRegistered.value.ownerRunId === params.runId ||
        preRegistered.value.ownerRunId === normalizedRunId) &&
      preRegistered.value.immutability === 'immutable' &&
      preRegistered.value.digest?.value === digestHex &&
      preRegistered.value.byteSize === buf.byteLength;

    let storedRoot = params.primaryWorkspaceRoot;
    let storedSegments: readonly string[] = segments;
    let storedRelPath = segments.join('/');
    if (!reusePrimaryPath) {
      const fileName = `out-${sanitizePhaseContextToken(portId, 'file')}-${digestHex.slice(0, 12)}.blob`;
      const snapped = await snapshotImmutableArtifactBytes({
        primaryWorkspaceRoot: params.primaryWorkspaceRoot,
        dirSegments: ['.schegent', 'immutable-results', attemptAlias],
        fileName,
        bytes: buf
      });
      if (!snapped.ok) {
        return snapped;
      }
      storedRoot = params.primaryWorkspaceRoot;
      storedSegments = snapped.segments;
      storedRelPath = snapped.relPath;
    }

    if (params.lifecycle) {
      const reg = ensureArtifactRegisteredInLifecycle({
        lifecycle: params.lifecycle,
        artifactId,
        runId: params.runId,
        attemptId: params.attemptId,
        digestHex,
        byteSize: buf.byteLength,
        mediaType: isSmallText ? 'text/plain' : 'application/octet-stream',
        displayName: path.basename(storedRelPath),
        relPath: storedRelPath,
        pinOwner: {
          ownerType: 'attempt',
          ownerId: normalizeHandoffIdentifier(params.attemptId, 'attempt-1')
        }
      });
      if (!reg.ok) return reg;
    }

    const ref: ArtifactRef = Object.freeze({
      artifactId,
      immutableVersion,
      digestHex,
      byteSize: buf.byteLength,
      kind: isSmallText ? 'text' : 'binary'
    });
    refs.push(ref);
    locations.set(artifactLocationKey(artifactId, immutableVersion), {
      ref,
      sourceRoot: storedRoot,
      sourceSegments: storedSegments,
      inlineText: isSmallText ? buf.toString('utf8') : null
    });
    if (refs.length >= PHASE_CONTEXT_LIMITS.artifactReferencesMax) break;
  }
  return { ok: true, refs, locations };
}

/**
 * FR-032 — resolves (or persists immutably when only inline `resultIndex` is present) the ordered
 * ForEach result index artifact as a full selectable `ArtifactRef` without 2 KiB truncation.
 */
export async function inspectForEachResultIndexArtifact(params: {
  readonly executionRoot: string;
  readonly primaryWorkspaceRoot: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly declaredOutputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly lifecycle?: ArtifactLifecycleService | null;
}): Promise<
  | {
      readonly ok: true;
      readonly ref: ArtifactRef | null;
      readonly location: StoredArtifactLocation | null;
      readonly summaryLine: string;
    }
  | Refusal
> {
  const indexPort: ResolvedPortValue | undefined = Object.hasOwn(params.declaredOutputs, 'resultIndex')
    ? params.declaredOutputs['resultIndex']
    : undefined;
  const artifactPort: ResolvedPortValue | undefined = Object.hasOwn(
    params.declaredOutputs,
    'resultIndexArtifact'
  )
    ? params.declaredOutputs['resultIndexArtifact']
    : undefined;
  const rawJson = indexPort?.value;
  let relSegments: readonly string[] | null =
    artifactPort !== undefined && (artifactPort.type === 'file' || artifactPort.type === 'local-file')
      ? splitSafeRelativePath(artifactPort.value)
      : null;

  if (relSegments === null && rawJson !== undefined && rawJson.length > 0) {
    const digest = createHash('sha256').update(rawJson, 'utf8').digest('hex');
    relSegments = ['.schegent', 'foreach-results', `fe-idx-${digest.slice(0, 32)}.json`];
  }
  if (relSegments === null) {
    return { ok: true, ref: null, location: null, summaryLine: 'foreach-ordered-result-index:empty' };
  }

  let indexBytes: Buffer | null = null;
  let resolvedRoot = params.primaryWorkspaceRoot;
  let resolvedSegments = relSegments;

  // Prefer reading the already-persisted immutable ForEach result index file from disk.
  const candidateRoots =
    path.resolve(params.executionRoot) === path.resolve(params.primaryWorkspaceRoot)
      ? [params.primaryWorkspaceRoot]
      : [params.primaryWorkspaceRoot, params.executionRoot];

  for (const root of candidateRoots) {
    const opened = await openWithinRoot(root, relSegments, { flags: 'r' });
    if (opened.outcome === 'refused') continue;
    try {
      const readRes = await readBoundedBytesFromHandle(
        opened.handle,
        PHASE_CONTEXT_LIMITS.materializedFileBytesMax
      );
      if (readRes.ok) {
        indexBytes = readRes.bytes;
        resolvedRoot = root;
        break;
      }
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  // If the file lived only in a separate executionRoot or was not yet written to disk,
  // snapshot it immutably beneath primaryWorkspaceRoot/.schegent/foreach-results/.
  if (indexBytes === null && rawJson !== undefined) {
    indexBytes = Buffer.from(rawJson, 'utf8');
  }
  if (indexBytes === null) {
    return { ok: true, ref: null, location: null, summaryLine: 'foreach-ordered-result-index:unavailable' };
  }

  const digestHex = createHash('sha256').update(indexBytes).digest('hex');
  const fileName = `fe-idx-${digestHex.slice(0, 32)}.json`;
  if (
    resolvedRoot !== params.primaryWorkspaceRoot ||
    resolvedSegments.join('/') !== `.schegent/foreach-results/${fileName}`
  ) {
    const snapped = await snapshotImmutableArtifactBytes({
      primaryWorkspaceRoot: params.primaryWorkspaceRoot,
      dirSegments: ['.schegent', 'foreach-results'],
      fileName,
      bytes: indexBytes
    });
    if (!snapped.ok) return snapped;
    resolvedRoot = params.primaryWorkspaceRoot;
    resolvedSegments = snapped.segments;
  }

  const artifactId = normalizeHandoffIdentifier(`foreach-idx-${digestHex.slice(0, 12)}`, 'foreach-idx');
  const immutableVersion = `v1-${digestHex.slice(0, 16)}`;
  const relPath = resolvedSegments.join('/');

  if (params.lifecycle) {
    const reg = ensureArtifactRegisteredInLifecycle({
      lifecycle: params.lifecycle,
      artifactId,
      runId: params.runId,
      attemptId: params.attemptId,
      digestHex,
      byteSize: indexBytes.byteLength,
      mediaType: 'application/json',
      displayName: fileName,
      relPath,
      pinOwner: {
        ownerType: 'attempt',
        ownerId: normalizeHandoffIdentifier(params.attemptId, 'attempt-1')
      }
    });
    if (!reg.ok) return reg;
  }

  const ref: ArtifactRef = Object.freeze({
    artifactId,
    immutableVersion,
    digestHex,
    byteSize: indexBytes.byteLength,
    kind: 'text'
  });
  const text = indexBytes.toString('utf8');
  const location: StoredArtifactLocation = Object.freeze({
    ref,
    sourceRoot: resolvedRoot,
    sourceSegments: resolvedSegments,
    inlineText: indexBytes.byteLength <= PHASE_CONTEXT_LIMITS.embedBytesMax ? text : null
  });

  let summaryLine = `foreach-result-index:ref=${artifactId};bytes=${indexBytes.byteLength}`;
  try {
    const parsed = JSON.parse(text) as {
      readonly itemCount?: unknown;
      readonly errorCount?: unknown;
      readonly hasErrors?: unknown;
    };
    if (typeof parsed.itemCount === 'number' && typeof parsed.errorCount === 'number') {
      summaryLine = `foreach-result-index:ref=${artifactId};items=${parsed.itemCount};errors=${parsed.errorCount};hasErrors=${String(parsed.hasErrors === true)};bytes=${indexBytes.byteLength}`;
    }
  } catch {
    // Keep bounded metadata-only fallback summary if JSON could not be parsed.
  }

  return {
    ok: true,
    ref,
    location,
    summaryLine: clipUtf8Safe(summaryLine, PHASE_CONTEXT_LIMITS.textEntryBytesMax)
  };
}

async function readAndVerifyFile(
  root: string,
  segments: readonly string[],
  ref: ArtifactRef
): Promise<
  | { readonly ok: true; readonly inlineText: string | null }
  | { readonly ok: false; readonly reason: 'open-refused' | 'size-mismatch' | 'digest-mismatch' }
> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome === 'refused') return { ok: false, reason: 'open-refused' };
  try {
    const stat = await opened.handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'open-refused' };
    if (stat.size !== ref.byteSize) return { ok: false, reason: 'size-mismatch' };
    const hash = createHash('sha256');
    const collectChunks: Buffer[] | null =
      ref.kind === 'text' && ref.byteSize <= PHASE_CONTEXT_LIMITS.embedBytesMax ? [] : null;
    const chunkSize = Math.min(PHASE_CONTEXT_LIMITS.materializationStreamBytesMax, Math.max(4096, stat.size));
    const buf = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    while (offset < stat.size) {
      const toRead = Math.min(buf.length, stat.size - offset);
      const { bytesRead } = await opened.handle.read(buf, 0, toRead, offset);
      if (bytesRead <= 0) return { ok: false, reason: 'size-mismatch' };
      const slice = buf.subarray(0, bytesRead);
      hash.update(slice);
      if (collectChunks !== null) {
        collectChunks.push(Buffer.from(slice));
      }
      offset += bytesRead;
    }
    const extra = await opened.handle.read(buf, 0, 1, stat.size);
    if (extra.bytesRead > 0) return { ok: false, reason: 'size-mismatch' };
    if (hash.digest('hex') !== ref.digestHex) return { ok: false, reason: 'digest-mismatch' };
    return {
      ok: true,
      inlineText: collectChunks !== null ? Buffer.concat(collectChunks).toString('utf8') : null
    };
  } catch {
    return { ok: false, reason: 'open-refused' };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function resolveArtifactLocationsForDelivery(params: {
  readonly runId: string;
  readonly handoffId: string;
  readonly manifest: HandoffManifest;
  readonly primaryWorkspaceRoot: string;
  readonly targetRoot: string;
  readonly inMemoryLocations: ReadonlyMap<string, StoredArtifactLocation>;
  readonly store: DurableHandoffStore;
  readonly lifecycle: ArtifactLifecycleService | null;
}): Promise<
  | {
      readonly ok: true;
      readonly locations: ReadonlyMap<string, StoredArtifactLocation>;
      readonly blockedLinkKeys: ReadonlySet<string>;
    }
  | Refusal
> {
  const persisted = params.store.loadArtifactLocations(params.handoffId);
  const resolved = new Map<string, StoredArtifactLocation>();
  const blockedLinkKeys = new Set<string>();
  const requiredByKey = new Map<string, boolean>();
  const distinctRefs = new Map<string, ArtifactRef>();

  for (const src of params.manifest.sources) {
    for (const ref of src.artifacts) {
      const key = artifactLocationKey(ref.artifactId, ref.immutableVersion);
      distinctRefs.set(key, ref);
      requiredByKey.set(key, (requiredByKey.get(key) ?? false) || src.required);
    }
  }

  for (const [key, ref] of distinctRefs.entries()) {
    const isRequired = requiredByKey.get(key) === true;
    let loc: StoredArtifactLocation | undefined = params.inMemoryLocations.get(key);

    // Fallback 1: persisted `artifactLocations` inside `phase_handoff_records.record_json`.
    if (loc === undefined) {
      const persistedRel: string | undefined = Object.hasOwn(persisted, ref.artifactId)
        ? persisted[ref.artifactId]
        : Object.hasOwn(persisted, key)
          ? persisted[key]
          : undefined;
      const segments = persistedRel !== undefined ? splitSafeRelativePath(persistedRel) : null;
      if (segments !== null) {
        const rootsToTry =
          path.resolve(params.primaryWorkspaceRoot) === path.resolve(params.targetRoot)
            ? [params.primaryWorkspaceRoot]
            : [params.primaryWorkspaceRoot, params.targetRoot];
        for (const root of rootsToTry) {
          const verified = await readAndVerifyFile(root, segments, ref);
          if (verified.ok) {
            loc = {
              ref,
              sourceRoot: root,
              sourceSegments: segments,
              inlineText: verified.inlineText
            };
            break;
          }
          if (verified.reason === 'digest-mismatch' || verified.reason === 'size-mismatch') {
            if (isRequired) {
              return refuse(
                'required-context-unavailable',
                verified.reason === 'digest-mismatch' ? 'source-digest-mismatch' : 'source-size-mismatch'
              );
            }
          }
        }
      }
    }

    // Fallback 2: F05 `lifecycle.getArtifact` metadata lookup under `primaryWorkspaceRoot`.
    // Enforces strict ownerRunId, immutability, digest, and byteSize parity to block cross-run disclosure.
    if (loc === undefined && params.lifecycle !== null) {
      const artRec = params.lifecycle.getArtifact(ref.artifactId);
      const normalizedRunId = normalizeHandoffIdentifier(params.runId, 'run-1');
      if (artRec.ok) {
        const ownerMatches =
          artRec.value.ownerRunId !== null &&
          (artRec.value.ownerRunId === params.runId ||
            artRec.value.ownerRunId === normalizedRunId);
        const matchesMeta =
          ownerMatches &&
          artRec.value.immutability === 'immutable' &&
          artRec.value.digest?.value === ref.digestHex &&
          artRec.value.byteSize === ref.byteSize;
        if (!matchesMeta) {
          return refuse('invalid-source', 'artifact-owner-or-digest-mismatch');
        }
        if (artRec.value.availability === 'present') {
          const rawLeaf = artRec.value.displayName.trim();
          const displayLeaf = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(rawLeaf) && !rawLeaf.includes('..') ? rawLeaf : '';
          if (displayLeaf.length > 0) {
            const candidateSegmentLists: (readonly string[])[] = [
              ['.schegent', 'immutable-results', sanitizePhaseContextToken(params.handoffId.slice(0, 24), 'handoff'), displayLeaf],
              ['.schegent', 'reports', displayLeaf],
              ['.schegent', 'foreach-results', displayLeaf]
            ];
            if (artRec.value.ownerAttemptId !== null) {
              candidateSegmentLists.unshift([
                '.schegent',
                'immutable-results',
                sanitizePhaseContextToken(artRec.value.ownerAttemptId, 'attempt'),
                displayLeaf
              ]);
            }
            for (const candidateSegments of candidateSegmentLists) {
              const verified = await readAndVerifyFile(params.primaryWorkspaceRoot, candidateSegments, ref);
              if (verified.ok) {
                loc = {
                  ref,
                  sourceRoot: params.primaryWorkspaceRoot,
                  sourceSegments: candidateSegments,
                  inlineText: verified.inlineText
                };
                break;
              }
            }
          }
        }
      }
    }

    if (loc === undefined) continue;

    // Re-verify digest & size of same-root files before permitting a `resource-link` so a
    // mutated file under `targetRoot` can never silently be linked without digest verification.
    const absSource = path.resolve(loc.sourceRoot, ...loc.sourceSegments);
    const relToTarget = path.relative(params.targetRoot, absSource);
    const isInsideTargetRoot =
      relToTarget.length > 0 && !relToTarget.startsWith('..') && !path.isAbsolute(relToTarget);
    if (isInsideTargetRoot) {
      const verified = await readAndVerifyFile(loc.sourceRoot, loc.sourceSegments, ref);
      if (!verified.ok) {
        if (verified.reason === 'digest-mismatch' || verified.reason === 'size-mismatch') {
          if (isRequired) {
            return refuse(
              'required-context-unavailable',
              verified.reason === 'digest-mismatch' ? 'source-digest-mismatch' : 'source-size-mismatch'
            );
          }
          continue;
        }
        if (loc.inlineText === null) {
          if (isRequired) return refuse('required-context-unavailable', 'source-open-refused');
          continue;
        }
        blockedLinkKeys.add(key);
      }
    }

    resolved.set(key, loc);
  }

  return { ok: true, locations: resolved, blockedLinkKeys };
}

export async function executePlanAttemptDelivery(params: {
  readonly input: PlanAttemptDeliveryInput;
  readonly store: DurableHandoffStore;
  readonly acceptance: AcceptanceService;
  readonly primaryWorkspaceRoot: string;
  readonly resolveExecutionRoot: (runId: string) => string;
  readonly resolveProfile: (backendId: string) => TargetProfileResolution;
  readonly lookupRunArtifactLocations: (runId: string) => ReadonlyMap<string, StoredArtifactLocation>;
  readonly lifecycle: ArtifactLifecycleService | null;
  readonly admission?: PreparationAdmission;
  readonly clock: () => number;
  readonly onDispatchIntentRecorded: (
    record: HandoffRecord,
    revision: number,
    targetAttemptId: string
  ) => void;
}): Promise<PlanAttemptDeliveryResult> {
  const { input } = params;
  const normalizedAttemptId = normalizeHandoffIdentifier(input.targetAttemptId, 'attempt-1');
  const staging = allocateAttemptStagingPaths(
    params.resolveExecutionRoot(input.runId),
    input.runId,
    input.targetAttemptId
  );
  const authorizedOutputPaths = Object.freeze([
    staging.contributionAbsPath,
    ...(input.reviewRole === 'reviewer' ? [staging.reviewReportAbsPath] : []),
    ...(input.reviewRole === 'fixer' ? [staging.fixClaimsAbsPath] : [])
  ]);

  if (input.handoffId === null) {
    return {
      ok: true,
      delivery: Object.freeze({
        handoffId: null,
        revision: null,
        attemptId: normalizedAttemptId,
        representationDigest: null,
        authorizedOutputPaths
      })
    };
  }

  const handoffId = input.handoffId;
  const inspected = params.acceptance.inspect(handoffId);
  if (!inspected.ok) return inspected;
  if (inspected.record === null) return refuse('stale-revision', 'unknown-handoff');
  const latestRevision = inspected.record.revisions.at(-1);
  if (latestRevision === undefined) return refuse('stale-revision', 'unknown-revision');
  if (latestRevision.state !== 'ready') return refuse('stale-revision', 'revision-not-ready');
  const manifestRead = readStoredManifest(latestRevision);
  if (manifestRead.kind === 'unsupported-version') return refuse('unsupported-version', 'manifest-version');
  if (manifestRead.kind !== 'valid') return refuse('storage-unavailable', 'stored-manifest');
  const manifest = manifestRead.manifest;

  const rendered = renderContext(manifest);
  const { profile, capabilities } = params.resolveProfile(input.backendId);

  // FR-035: check any persisted DeliveryRepresentation for this handoff revision BEFORE planning
  // or committing dispatch intent; on refusal, return immediately WITHOUT overwriting it.
  const existingExactRep = params.store.loadRepresentation(
    handoffId,
    latestRevision.revision,
    normalizedAttemptId
  );
  if (existingExactRep !== null) {
    const existingCheck = checkDispatch(existingExactRep, {
      capabilities,
      profile,
      contentDigest: latestRevision.manifestDigest
    });
    if (!existingCheck.ok) return existingCheck;
  } else {
    for (const d of inspected.record.dispatches) {
      if (d.revision !== latestRevision.revision) continue;
      const priorRep = params.store.loadRepresentation(handoffId, d.revision, d.targetAttemptId);
      if (priorRep !== null) {
        const priorCheck = checkDispatch(priorRep, {
          capabilities,
          profile,
          contentDigest: latestRevision.manifestDigest
        });
        if (!priorCheck.ok) return priorCheck;
      }
    }
  }

  // R7-17-07 (Clarification Q3): refuse duplicate dispatch before materializing or persisting a
  // representation whenever any dispatch on this revision is still in `'intent'` or `'uncertain'`.
  if (
    inspected.record.dispatches.some(
      (d) => d.revision === latestRevision.revision && (d.state === 'uncertain' || d.state === 'intent')
    )
  ) {
    return refuse('uncertain-delivery', 'dispatch-uncertain');
  }

  const targetRoot = path.resolve(params.resolveExecutionRoot(input.runId));
  const normalizedTargetNodePath = manifest.identity.targetNodePath;
  const normalizedTargetOcc = manifest.identity.targetOccurrenceId;
  const requestedNodePath =
    input.targetNodePath.trim().length > 0
      ? normalizeNodePathForHandoff(input.targetNodePath)
      : '';
  const requestedOcc =
    input.targetOccurrenceId.trim().length > 0
      ? normalizeHandoffIdentifier(input.targetOccurrenceId, '')
      : '';
  if (requestedNodePath.length > 0 && requestedNodePath !== normalizedTargetNodePath) {
    return refuse('stale-revision', 'target-node-mismatch');
  }
  if (requestedOcc.length > 0 && requestedOcc !== normalizedTargetOcc) {
    return refuse('stale-revision', 'target-occurrence-mismatch');
  }

  const located = await resolveArtifactLocationsForDelivery({
    runId: input.runId,
    handoffId,
    manifest,
    primaryWorkspaceRoot: params.primaryWorkspaceRoot,
    targetRoot,
    inMemoryLocations: params.lookupRunArtifactLocations(input.runId),
    store: params.store,
    lifecycle: params.lifecycle
  });
  if (!located.ok) return located;
  const knownLocations = located.locations;
  const blockedLinkKeys = located.blockedLinkKeys;
  const materializedMap = new Map<string, string>();
  const canReuseSession =
    manifest.session === 'reuse-when-qualified' &&
    capabilities.loadSession &&
    input.previousSessionAttempt != null &&
    input.previousSessionAttempt.backendId === input.backendId &&
    input.previousSessionAttempt.producer.nodePath === normalizedTargetNodePath &&
    input.previousSessionAttempt.producer.occurrenceId === normalizedTargetOcc;

  const sessionRequest: SessionRequest = canReuseSession
    ? {
        kind: 'reuse',
        sessionLineage: input.previousSessionAttempt!.producer,
        targetLineage: {
          nodePath: normalizedTargetNodePath,
          occurrenceId: normalizedTargetOcc,
          attemptId: normalizedAttemptId
        }
      }
    : { kind: 'fresh' };

  const accessOf = (ref: ArtifactRef): ArtifactAccess => {
    const key = artifactLocationKey(ref.artifactId, ref.immutableVersion);
    const loc = knownLocations.get(key);
    const matUri = materializedMap.get(key) ?? null;
    if (loc === undefined) {
      return {
        embeddedText: null,
        linkUri: null,
        materializePermitted: matUri !== null,
        materializedUri: matUri
      };
    }
    const absSource = path.resolve(loc.sourceRoot, ...loc.sourceSegments);
    const relToTarget = path.relative(targetRoot, absSource);
    const isInsideTargetRoot =
      relToTarget.length > 0 && !relToTarget.startsWith('..') && !path.isAbsolute(relToTarget);
    return {
      embeddedText: loc.inlineText,
      linkUri: isInsideTargetRoot && !blockedLinkKeys.has(key) ? pathToFileURL(absSource).href : null,
      materializePermitted: !isInsideTargetRoot,
      materializedUri: matUri
    };
  };

  let planned = planDelivery({
    revision: latestRevision,
    manifest,
    rendered,
    targetInstructions: input.targetInstructions,
    targetAttemptId: normalizedAttemptId,
    capabilities,
    profile,
    session: sessionRequest,
    accessOf
  });
  if (!planned.ok) return planned;

  if (planned.plan.awaitingCopy.length > 0) {
    const neededIds = new Set(planned.plan.awaitingCopy);
    const toCopy = [];
    for (const src of manifest.sources) {
      for (const art of src.artifacts) {
        if (!neededIds.has(art.artifactId)) continue;
        const loc = knownLocations.get(artifactLocationKey(art.artifactId, art.immutableVersion));
        if (loc === undefined) {
          return refuse('required-context-unavailable', 'materialization-source-missing');
        }
        toCopy.push({ ref: art, sourceRoot: loc.sourceRoot, sourceSegments: loc.sourceSegments });
      }
    }

    const copied = await materializeHandoffArtifacts({
      runId: input.runId,
      handoffId,
      targetAttemptId: normalizedAttemptId,
      targetRoot,
      sources: toCopy,
      lifecycle: params.lifecycle,
      nowMs: params.clock,
      ...(params.admission !== undefined
        ? {
            admission: params.admission,
            admissionOwner: buildBoundedAdmissionOwner('mat', [input.runId, normalizedAttemptId])
          }
        : {})
    });
    if (!copied.ok) return copied;
    for (const [key, mat] of copied.byArtifactKey.entries()) {
      materializedMap.set(key, mat.fileUri);
    }

    planned = planDelivery({
      revision: latestRevision,
      manifest,
      rendered,
      targetInstructions: input.targetInstructions,
      targetAttemptId: normalizedAttemptId,
      capabilities,
      profile,
      session: sessionRequest,
      accessOf
    });
    if (!planned.ok) return planned;
  }

  const verified = checkDispatch(planned.plan.representation, {
    capabilities,
    profile,
    contentDigest: latestRevision.manifestDigest
  });
  if (!verified.ok) return verified;

  let intent: ReturnType<AcceptanceService['recordDispatchIntent']>;
  try {
    intent = params.store.runInImmediateTransaction(() => {
      const recorded = params.acceptance.recordDispatchIntent(
        handoffId,
        latestRevision.revision,
        normalizedAttemptId,
        planned.plan.representation.representationDigest,
        { blockUnsettledIntent: true }
      );
      if (!recorded.ok) return recorded;
      params.store.saveRepresentation(planned.plan.representation);
      const freshRecord = params.store.load(handoffId);
      if (freshRecord !== null) {
        params.onDispatchIntentRecorded(freshRecord, latestRevision.revision, normalizedAttemptId);
      }
      return recorded;
    });
  } catch {
    // Fail closed on SQLite or corrupt-row failures during dispatch intent commit.
    return refuse('storage-unavailable', 'store-failure');
  }
  if (!intent.ok) return intent;

  const upstreamPaths: string[] = [];
  for (const block of planned.plan.blocks) {
    if (block.type === 'resource-link' && block.uri.startsWith('file://')) {
      try {
        upstreamPaths.push(fileURLToPath(block.uri));
      } catch {
        // Ignore non-file URLs.
      }
    }
  }

  return {
    ok: true,
    delivery: Object.freeze({
      handoffId,
      revision: latestRevision.revision,
      attemptId: normalizedAttemptId,
      representationDigest: planned.plan.representation.representationDigest,
      acpPromptBlocks: Object.freeze([...planned.plan.blocks]),
      authorizedUpstreamInputPaths: Object.freeze(upstreamPaths),
      authorizedOutputPaths,
      sessionReusePermitted: planned.plan.representation.session === 'reuse'
    })
  };
}

export { verifyNegotiatedHandoffCapabilities } from './phase-context-helpers';

/**
 * FR-008 / FR-016 — builds durable workspace-relative artifact locators for `phase_handoff_records`
 * and acquires checked F05 `ownerType: 'handoff'` protective pins (registering unregistered
 * artifacts first and rolling back partial pins on any quota/storage refusal).
 */
export async function ensureHandoffArtifactsPinned(params: {
  readonly primaryWorkspaceRoot: string;
  readonly runId: string;
  readonly handoffId: string;
  readonly manifest: HandoffManifest;
  readonly runLocations: ReadonlyMap<string, StoredArtifactLocation>;
  readonly lifecycle: ArtifactLifecycleService | null;
}): Promise<
  | {
      readonly ok: true;
      readonly persistedLocations: Readonly<Record<string, string>>;
      readonly newlyPinnedArtifactIds: readonly string[];
    }
  | Refusal
> {
  const persistedLocations: Record<string, string> = {};
  const distinctArtifacts = new Map<string, { readonly ref: ArtifactRef; readonly attemptId: string }>();
  for (const src of params.manifest.sources) {
    for (const art of src.artifacts) {
      if (!distinctArtifacts.has(art.artifactId)) {
        distinctArtifacts.set(art.artifactId, { ref: art, attemptId: src.producer.attemptId });
      }
    }
  }

  const primaryResolved = path.resolve(params.primaryWorkspaceRoot);
  const handoffAlias = sanitizePhaseContextToken(params.handoffId.slice(0, 24), 'handoff');

  for (const { ref } of distinctArtifacts.values()) {
    const loc = params.runLocations.get(artifactLocationKey(ref.artifactId, ref.immutableVersion));
    if (loc === undefined) continue;
    if (path.resolve(loc.sourceRoot) === primaryResolved) {
      persistedLocations[ref.artifactId] = loc.sourceSegments.join('/');
      continue;
    }
    // External root (e.g. separate lane): snapshot immutably under primaryWorkspaceRoot so
    // restart recovery resolves the locator durably without requiring in-memory re-registration.
    const opened = await openWithinRoot(loc.sourceRoot, loc.sourceSegments, { flags: 'r' });
    if (opened.outcome === 'refused') continue;
    let bytes: Buffer | null = null;
    try {
      const readRes = await readBoundedBytesFromHandle(
        opened.handle,
        Math.min(ref.byteSize, PHASE_CONTEXT_LIMITS.materializedFileBytesMax)
      );
      if (
        readRes.ok &&
        readRes.bytes.byteLength === ref.byteSize &&
        createHash('sha256').update(readRes.bytes).digest('hex') === ref.digestHex
      ) {
        bytes = readRes.bytes;
      }
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
    if (bytes !== null) {
      const fileName = `ext-${sanitizePhaseContextToken(ref.artifactId, 'art')}-${ref.digestHex.slice(0, 12)}.blob`;
      const snapped = await snapshotImmutableArtifactBytes({
        primaryWorkspaceRoot: params.primaryWorkspaceRoot,
        dirSegments: ['.schegent', 'immutable-results', handoffAlias],
        fileName,
        bytes
      });
      if (snapped.ok) {
        persistedLocations[ref.artifactId] = snapped.relPath;
      }
    }
  }

  if (params.lifecycle === null) {
    return { ok: true, persistedLocations, newlyPinnedArtifactIds: [] };
  }
  const pinned = pinHandoffArtifactsInLifecycle({
    lifecycle: params.lifecycle,
    runId: params.runId,
    handoffId: params.handoffId,
    manifest: params.manifest,
    persistedLocations
  });
  if (!pinned.ok) return pinned;
  return {
    ok: true,
    persistedLocations,
    newlyPinnedArtifactIds: pinned.newlyPinnedArtifactIds
  };
}
