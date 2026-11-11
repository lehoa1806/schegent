/**
 * FR-R6-F15 (F15-A; FR-001, FR-002, FR-005, FR-018, FR-020, NFR-001, NFR-002) — one handoff
 * prepared from untrusted inputs: the policy, the identity, the accepted contributions and the
 * capacity the target profile is qualified for. The result is a manifest with its serialized
 * text, its digest and the rendered context, or one refusal. No policy means no handoff. Equal
 * inputs give equal bytes: candidates are read in producer order, not in the order given.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  OMISSION_REASONS,
  type ManifestSource,
  type Omission,
  type PreparedHandoff,
  type RequestRef
} from '../../contracts/phase-context/context-manifest';
import {
  PHASE_CONTEXT_LIMITS,
  type BoundInput,
  type ContributionCandidate,
  type HandoffPolicy,
  type PhaseContextFailure,
  type Refusal
} from '../../contracts/phase-context/context-policy';
import type { ProfileCapacity } from '../../contracts/phase-context/context-delivery';
import { compareProducers, parseHandoffIdentity, parseProducerRef, producerKey } from './identity';
import { buildManifest, manifestDigestOf, manifestEntryBytes, manifestOmissionBytes, serializeManifest, sourcesFault, type ManifestInput } from './manifest';
import { parseBoundInputs, parseHandoffPolicy } from './policy';
import { hasExactKeys, isWholeNumber, plainRecord, refuse, sha256Hex } from './primitives';
import { RENDERED_PREAMBLE_BYTES, renderContext, renderedSourceBytes } from './renderer';
import { selectSources, type SourceCost, type ValidCandidate } from './selection';
import { parseSourceContribution } from './source-contribution';
import { utf8Bytes } from './text-bounds';

export interface PrepareInput {
  readonly policy: unknown;
  readonly identity: unknown;
  readonly cutoffSequence: number;
  readonly candidates: readonly ContributionCandidate[];
  readonly boundInputs: unknown;
  /** The target's frozen instructions. Only their digest enters the manifest. */
  readonly targetInstructions: string;
  readonly profile: ProfileCapacity;
  /** 1 when absent. */
  readonly revision?: number;
  /** `null` for revision 1, else the revision before; derived when absent. */
  readonly previousRevision?: number | null;
}

export type PrepareResult =
  | { readonly kind: 'no-handoff' }
  | ({ readonly kind: 'prepared' } & PreparedHandoff)
  | { readonly kind: 'refused'; readonly failure: PhaseContextFailure; readonly detail: string };

/** Everything of a manifest that selection does not decide. */
type ManifestFrame = Omit<ManifestInput, 'sources' | 'omissions' | 'omissionsUnlisted'>;

interface Prepared {
  readonly frame: ManifestFrame;
  readonly policy: HandoffPolicy;
  readonly boundInputs: readonly BoundInput[];
}

const CANDIDATE_KEYS = ['acceptedFrom', 'acceptedSequence', 'contribution'] as const;
/** The count of unlisted omissions is at most the candidate limit: this many digits. */
const UNLISTED_COUNT_RESERVE_BYTES = String(PHASE_CONTEXT_LIMITS.candidatesMax).length;

function refused(refusal: Refusal): PrepareResult {
  return { kind: 'refused', failure: refusal.failure, detail: refusal.detail };
}

function isRefusal(value: object): value is Refusal {
  return 'ok' in value && value.ok === false;
}

function revisionOf(input: PrepareInput): { revision: number; previousRevision: number | null } | null {
  const revision = input.revision ?? 1;
  if (!isWholeNumber(revision, 1)) return null;
  const previousRevision = revision === 1 ? null : revision - 1;
  if (input.previousRevision !== undefined && input.previousRevision !== previousRevision) return null;
  return { revision, previousRevision };
}

/**
 * The rendered bound: the smaller of the limit and what the profile is qualified for. A
 * profile with no qualification is refused, never given a default (FR-018).
 */
function renderedBoundOf(profile: unknown): number | Refusal {
  const record = plainRecord(profile);
  if (record === null) return refuse('invalid-source', 'profile');
  const qualified = record.qualifiedContextBytes;
  if (qualified === null) return refuse('capacity-exceeded', 'profile-unqualified');
  if (!isWholeNumber(qualified, 1)) return refuse('invalid-source', 'profile-bound');
  const bound = Math.min(PHASE_CONTEXT_LIMITS.renderedContextBytesMax, qualified);
  // The host preamble is always rendered; a bound it alone passes can hold no handoff.
  return bound < RENDERED_PREAMBLE_BYTES ? refuse('capacity-exceeded', 'rendered-bound') : bound;
}

function frameOf(input: PrepareInput, policy: HandoffPolicy, policyDigest: string): Prepared | Refusal {
  const identity = parseHandoffIdentity(input.identity);
  if (!identity.ok) return identity;
  if (!isWholeNumber(input.cutoffSequence, 0)) return refuse('invalid-source', 'cutoff');
  const boundInputs = parseBoundInputs(input.boundInputs);
  if (boundInputs === null) return refuse('invalid-source', 'bound-inputs');
  if (typeof input.targetInstructions !== 'string') return refuse('invalid-source', 'target-instructions');
  const revision = revisionOf(input);
  if (revision === null) return refuse('invalid-source', 'revision');
  const renderedBytesMax = renderedBoundOf(input.profile);
  if (typeof renderedBytesMax !== 'number') return renderedBytesMax;
  return {
    policy,
    boundInputs,
    frame: {
      revision: revision.revision,
      previousRevision: revision.previousRevision,
      origin: 'selected',
      identity: identity.identity,
      policyDigest,
      approval: policy.approval,
      session: policy.session,
      cutoffSequence: input.cutoffSequence,
      targetInstructionsDigest: sha256Hex(input.targetInstructions),
      renderedBytesMax
    }
  };
}

/** The accepting attempt and sequence of each candidate, in producer order. */
function candidateHeads(value: unknown): readonly ContributionCandidate[] | Refusal {
  if (!Array.isArray(value)) return refuse('invalid-source', 'candidates');
  const items: readonly unknown[] = value;
  if (items.length > PHASE_CONTEXT_LIMITS.candidatesMax) return refuse('capacity-exceeded', 'candidate-count');
  const heads: ContributionCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const record = plainRecord(item);
    if (record === null || !hasExactKeys(record, CANDIDATE_KEYS)) return refuse('invalid-source', 'candidate');
    const acceptedFrom = parseProducerRef(record.acceptedFrom);
    const { acceptedSequence } = record;
    if (acceptedFrom === null || !isWholeNumber(acceptedSequence, 0)) return refuse('invalid-source', 'candidate');
    const key = producerKey(acceptedFrom);
    // One attempt is accepted once; a second candidate from it has no defined order.
    if (seen.has(key)) return refuse('invalid-source', 'candidate-duplicate');
    seen.add(key);
    heads.push({ acceptedFrom, acceptedSequence, contribution: record.contribution });
  }
  return heads.sort((left, right) => compareProducers(left.acceptedFrom, right.acceptedFrom));
}

/**
 * Each contribution read against the attempt it was accepted from. An invalid one refuses the
 * preparation only where selection would have to read it: at or before the cutoff, under a
 * node path a request names. Elsewhere it is kept as unread, and selection lists it as omitted.
 */
function readContributions(heads: readonly ContributionCandidate[], prepared: Prepared): readonly ValidCandidate[] | Refusal {
  const requested = new Set([
    ...prepared.boundInputs.map((entry) => entry.sourceNodePath),
    ...prepared.policy.selectors.map((entry) => entry.sourceNodePath)
  ]);
  const candidates: ValidCandidate[] = [];
  for (const { acceptedFrom, acceptedSequence, contribution } of heads) {
    const parsed = parseSourceContribution(contribution, acceptedFrom);
    const named = acceptedSequence <= prepared.frame.cutoffSequence && requested.has(acceptedFrom.nodePath);
    if (!parsed.ok && named) return parsed;
    candidates.push({ acceptedFrom, acceptedSequence, contribution: parsed.ok ? parsed.contribution : null });
  }
  return candidates;
}

function longest(texts: readonly string[]): string {
  return texts.reduce((widest, text) => (text.length > widest.length ? text : widest), '');
}

/**
 * The bytes the largest list of omissions these candidates could give adds to the manifest.
 * Selection needs the budget of the sources before it knows what it omits, so the budget
 * leaves room for the worst case: a candidate a bound input or a required selector names is
 * selected or refuses the handoff, and every other one may be listed.
 */
function omissionReserveBytes(candidates: readonly ValidCandidate[], prepared: Prepared): number {
  const { policy, boundInputs, frame } = prepared;
  const requiredPaths = new Set([
    ...boundInputs.map((entry) => entry.sourceNodePath),
    ...policy.selectors.filter((entry) => entry.required).map((entry) => entry.sourceNodePath)
  ]);
  const optionalIds = policy.selectors.filter((entry) => !entry.required).map((entry) => entry.selectorId);
  const request: RequestRef | null = optionalIds.length === 0 ? null : { kind: 'selector', id: longest(optionalIds) };
  const reason = OMISSION_REASONS.reduce((widest, entry) => (entry.length > widest.length ? entry : widest));
  const sizes = candidates
    .filter((entry) => entry.acceptedSequence > frame.cutoffSequence || !requiredPaths.has(entry.acceptedFrom.nodePath))
    .map((entry) => manifestOmissionBytes({ producer: entry.acceptedFrom, request, reason } satisfies Omission))
    .sort((left, right) => right - left)
    .slice(0, PHASE_CONTEXT_LIMITS.sourceContributionsMax);
  return sizes.reduce((sum, size) => sum + size, UNLISTED_COUNT_RESERVE_BYTES);
}

function costOf(source: ManifestSource): SourceCost {
  return { manifestBytes: manifestEntryBytes(source), renderedBytes: renderedSourceBytes(source) };
}

function assemble(candidates: readonly ValidCandidate[], prepared: Prepared): PrepareResult {
  const { frame, policy, boundInputs } = prepared;
  const emptyManifestBytes = utf8Bytes(serializeManifest(buildManifest({ ...frame, sources: [], omissions: [], omissionsUnlisted: 0 })));
  const selection = selectSources({
    policy,
    boundInputs,
    candidates,
    cutoffSequence: frame.cutoffSequence,
    manifestBytesBudget: PHASE_CONTEXT_LIMITS.manifestBytesMax - emptyManifestBytes - omissionReserveBytes(candidates, prepared),
    renderedBytesBudget: frame.renderedBytesMax - RENDERED_PREAMBLE_BYTES,
    costOf
  });
  if (!selection.ok) return refused(selection);
  // FR-002: the identity names the exact attempts a handoff may carry.
  const fault = sourcesFault(selection.sources, frame.identity);
  if (fault !== null) return refused(refuse('invalid-source', fault));

  const manifest = buildManifest({ ...frame, sources: selection.sources, omissions: selection.omissions, omissionsUnlisted: selection.omissionsUnlisted });
  const serialized = serializeManifest(manifest);
  if (utf8Bytes(serialized) > PHASE_CONTEXT_LIMITS.manifestBytesMax) return refused(refuse('capacity-exceeded', 'manifest-bytes'));
  const rendered = renderContext(manifest);
  if (rendered.bytes > frame.renderedBytesMax) return refused(refuse('capacity-exceeded', 'rendered-bytes'));
  return { kind: 'prepared', manifest, serialized, manifestDigest: manifestDigestOf(serialized), rendered };
}

export function prepareHandoff(input: PrepareInput): PrepareResult {
  const policy = parseHandoffPolicy(input.policy);
  if (policy.kind === 'absent') return { kind: 'no-handoff' };
  if (policy.kind === 'unsupported-version') return refused(refuse('unsupported-version', 'policy-version'));
  if (policy.kind === 'invalid') return refused(refuse('invalid-policy', policy.detail));

  const prepared = frameOf(input, policy.policy, policy.digestHex);
  if (isRefusal(prepared)) return refused(prepared);
  const heads = candidateHeads(input.candidates);
  if (isRefusal(heads)) return refused(heads);
  const candidates = readContributions(heads, prepared);
  if (isRefusal(candidates)) return refused(candidates);
  return assemble(candidates, prepared);
}
