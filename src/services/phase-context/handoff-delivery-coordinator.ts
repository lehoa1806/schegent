/**
 * FR-R6-F15 (F15-B; F15-FR-08, F15-FR-18..FR-20, F15-FR-25..FR-26) — declared output-file
 * inspection and ACP prompt-block delivery planning + cross-root streaming materialization,
 * extracted so `phase-handoff-coordinator.ts` stays well below its 1,000-line ceiling.
 *
 * Zero `vscode` or `node:fs` imports (docs/hard-rules.md rules 13, 69).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { NegotiatedCapabilities } from '../../contracts/acp-runtime';
import type {
  ArtifactAccess,
  ProfileCapacity,
  SessionRequest
} from '../../contracts/phase-context/context-delivery';
import type { HandoffRecord } from '../../contracts/phase-context/context-manifest';
import {
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type ProducerRef,
  type Refusal
} from '../../contracts/phase-context/context-policy';
import type { FrozenPhaseHandoffDelivery, ResolvedPortValue } from '../../contracts/run-request';
import { openWithinRoot } from '../../lib/safe-open';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import { storedManifest, type AcceptanceService } from './acceptance';
import { allocateAttemptStagingPaths } from './attempt-result-publisher';
import { checkDispatch, planDelivery } from './delivery-plan';
import { materializeHandoffArtifacts } from './handoff-materializer';
import { refuse } from './primitives';
import { renderContext } from './renderer';
import type { DurableHandoffStore } from './sqlite-handoff-store';

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
  readonly previousSessionAttempt?: {
    readonly producer: ProducerRef;
    readonly backendId: string;
  } | null;
}

export type PlanAttemptDeliveryResult =
  | { readonly ok: true; readonly delivery: FrozenPhaseHandoffDelivery }
  | Refusal;

export function normalizeHandoffIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : fallback;
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

export async function inspectDeclaredOutputFiles(
  executionRoot: string,
  declaredOutputs: Readonly<Record<string, ResolvedPortValue>>
): Promise<{
  readonly refs: readonly ArtifactRef[];
  readonly locations: ReadonlyMap<string, StoredArtifactLocation>;
}> {
  const refs: ArtifactRef[] = [];
  const locations = new Map<string, StoredArtifactLocation>();
  for (const [portId, portVal] of Object.entries(declaredOutputs)) {
    if (portVal.type !== 'file' && portVal.type !== 'local-file') continue;
    const segments = splitSafeRelativePath(portVal.value);
    if (segments === null) continue;
    const opened = await openWithinRoot(executionRoot, segments, { flags: 'r' });
    if (opened.outcome === 'refused') continue;
    try {
      const stat = await opened.handle.stat();
      if (stat.size > PHASE_CONTEXT_LIMITS.materializedFileBytesMax) continue;
      const buf = await opened.handle.readFile();
      const digestHex = createHash('sha256').update(buf).digest('hex');
      const artifactId = normalizeHandoffIdentifier(
        `out-${portId}-${digestHex.slice(0, 8)}`,
        'out-file'
      );
      const immutableVersion = `v1-${digestHex.slice(0, 12)}`;
      const isSmallText = buf.byteLength <= PHASE_CONTEXT_LIMITS.embedBytesMax && !buf.includes(0);
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
        sourceRoot: executionRoot,
        sourceSegments: segments,
        inlineText: isSmallText ? buf.toString('utf8') : null
      });
    } catch {
      // Unreadable optional output file skipped cleanly.
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
    if (refs.length >= PHASE_CONTEXT_LIMITS.artifactReferencesMax) break;
  }
  return { refs, locations };
}

export async function executePlanAttemptDelivery(params: {
  readonly input: PlanAttemptDeliveryInput;
  readonly store: DurableHandoffStore;
  readonly acceptance: AcceptanceService;
  readonly resolveExecutionRoot: (runId: string) => string;
  readonly resolveProfile: (backendId: string) => TargetProfileResolution;
  readonly lookupRunArtifactLocations: (runId: string) => ReadonlyMap<string, StoredArtifactLocation>;
  readonly lifecycle: ArtifactLifecycleService | null;
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
    staging.reviewReportAbsPath,
    staging.fixClaimsAbsPath
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

  const inspected = params.acceptance.inspect(input.handoffId);
  if (!inspected.ok) return inspected;
  if (inspected.record === null) return refuse('stale-revision', 'unknown-handoff');
  const latestRevision = inspected.record.revisions.at(-1);
  if (latestRevision === undefined) return refuse('stale-revision', 'unknown-revision');
  if (latestRevision.state !== 'ready') return refuse('stale-revision', 'revision-not-ready');
  const manifest = storedManifest(latestRevision);
  if (manifest === null) return refuse('storage-unavailable', 'stored-manifest');

  const rendered = renderContext(manifest);
  const { profile, capabilities } = params.resolveProfile(input.backendId);
  const targetRoot = path.resolve(params.resolveExecutionRoot(input.runId));
  const knownLocations = params.lookupRunArtifactLocations(input.runId);
  const materializedMap = new Map<string, string>();

  const normalizedTargetNodePath = manifest.identity.targetNodePath;
  const normalizedTargetOcc = manifest.identity.targetOccurrenceId;
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
      linkUri: isInsideTargetRoot ? pathToFileURL(absSource).href : null,
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
      handoffId: input.handoffId,
      targetAttemptId: normalizedAttemptId,
      targetRoot,
      sources: toCopy,
      lifecycle: params.lifecycle,
      nowMs: params.clock
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

  const handoffId = input.handoffId;
  const intent = params.store.runInImmediateTransaction(() => {
    params.store.saveRepresentation(planned.plan.representation);
    const recorded = params.acceptance.recordDispatchIntent(
      handoffId,
      latestRevision.revision,
      normalizedAttemptId,
      planned.plan.representation.representationDigest
    );
    if (!recorded.ok) return recorded;
    const freshRecord = params.store.load(handoffId);
    if (freshRecord !== null) {
      params.onDispatchIntentRecorded(freshRecord, latestRevision.revision, normalizedAttemptId);
    }
    return recorded;
  });
  if (!intent.ok) return intent;

  const upstreamPaths: string[] = [];
  for (const block of planned.plan.blocks) {
    if (block.type === 'resource-link' && block.uri.startsWith('file://')) {
      try {
        upstreamPaths.push(new URL(block.uri).pathname);
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
