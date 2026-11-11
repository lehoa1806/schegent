/**
 * FR-R6-F15 (F15-A; FR-005, FR-006, FR-014, FR-018) — which accepted contributions a handoff
 * carries. Selection reads one cutoff: bound inputs first, then required selectors in policy
 * order, then optional selectors by priority. A request names one exact producer occurrence
 * or the selection is refused. Required context that is missing or does not fit refuses the
 * handoff; optional context that does not fit is left out, with every optional request after
 * it, and each source left out is recorded with its reason. Nothing is cut to fit.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { ManifestSource, Omission, OmissionReason, RequestRef } from '../../contracts/phase-context/context-manifest';
import {
  PHASE_CONTEXT_LIMITS,
  type BoundInput,
  type HandoffPolicy,
  type ProducerRef,
  type Refusal,
  type SourceContribution
} from '../../contracts/phase-context/context-policy';
import { compareProducers, producerKey } from './identity';
import { refuse } from './primitives';

/** A candidate whose contribution was read: `null` when the contribution is not valid. */
export interface ValidCandidate {
  readonly acceptedFrom: ProducerRef;
  readonly acceptedSequence: number;
  readonly contribution: SourceContribution | null;
}

export interface SourceCost {
  readonly manifestBytes: number;
  readonly renderedBytes: number;
}

export interface SelectionInput {
  readonly policy: HandoffPolicy;
  readonly boundInputs: readonly BoundInput[];
  readonly candidates: readonly ValidCandidate[];
  readonly cutoffSequence: number;
  /** The bytes the sources may add to the serialized manifest. */
  readonly manifestBytesBudget: number;
  /** The bytes the sources may add to the rendered context. */
  readonly renderedBytesBudget: number;
  costOf(source: ManifestSource): SourceCost;
}

export interface SelectionResult {
  readonly ok: true;
  readonly sources: readonly ManifestSource[];
  readonly omissions: readonly Omission[];
  readonly omissionsUnlisted: number;
}

interface SourceRequest {
  readonly ref: RequestRef;
  readonly nodePath: string;
  readonly required: boolean;
}

/** What the selected sources hold so far, in the units the limits are stated in. */
interface Tally {
  readonly sources: number;
  readonly artifacts: number;
  readonly outcomes: number;
  readonly decisions: number;
  readonly constraints: number;
  readonly unresolvedIssues: number;
  readonly manifestBytes: number;
  readonly renderedBytes: number;
}

type Step =
  | { readonly kind: 'select'; readonly source: ManifestSource; readonly tally: Tally }
  | { readonly kind: 'omit'; readonly reason: OmissionReason; readonly closesOptional: boolean }
  | { readonly kind: 'refuse'; readonly refusal: Refusal };

const EMPTY_TALLY: Tally = Object.freeze({
  sources: 0,
  artifacts: 0,
  outcomes: 0,
  decisions: 0,
  constraints: 0,
  unresolvedIssues: 0,
  manifestBytes: 0,
  renderedBytes: 0
});

/** FR-006: bound inputs come before any selector; optional selectors go by declared priority. */
function requestsOf(policy: HandoffPolicy, boundInputs: readonly BoundInput[]): readonly SourceRequest[] {
  const bound = boundInputs.map(
    (input): SourceRequest => ({ ref: { kind: 'binding', id: input.bindingId }, nodePath: input.sourceNodePath, required: true })
  );
  const selectors = policy.selectors.map((selector, position) => ({ selector, position }));
  const byPolicy = selectors.filter((entry) => entry.selector.required);
  const byPriority = selectors
    .filter((entry) => !entry.selector.required)
    .sort((left, right) => left.selector.priority - right.selector.priority || left.position - right.position);
  const fromSelectors = [...byPolicy, ...byPriority].map(
    ({ selector }): SourceRequest => ({
      ref: { kind: 'selector', id: selector.selectorId },
      nodePath: selector.sourceNodePath,
      required: selector.required
    })
  );
  return [...bound, ...fromSelectors];
}

function sourceOf(request: SourceRequest, candidate: ValidCandidate, contribution: SourceContribution): ManifestSource {
  return {
    producer: candidate.acceptedFrom,
    acceptedSequence: candidate.acceptedSequence,
    coverage: contribution.coverage === 'partial' ? 'partial' : 'complete',
    required: request.required,
    selectedBy: request.ref,
    outcomes: contribution.outcomes,
    decisions: contribution.decisions,
    constraints: contribution.constraints,
    unresolvedIssues: contribution.unresolvedIssues,
    summary: contribution.summary,
    artifacts: contribution.artifacts
  };
}

function tallyWith(tally: Tally, source: ManifestSource, cost: SourceCost): Tally {
  return {
    sources: tally.sources + 1,
    artifacts: tally.artifacts + source.artifacts.length,
    outcomes: tally.outcomes + source.outcomes.length,
    decisions: tally.decisions + source.decisions.length,
    constraints: tally.constraints + source.constraints.length,
    unresolvedIssues: tally.unresolvedIssues + source.unresolvedIssues.length,
    manifestBytes: tally.manifestBytes + cost.manifestBytes,
    renderedBytes: tally.renderedBytes + cost.renderedBytes
  };
}

/** The first limit the tally passes, or `null` when everything fits. */
function capacityFault(tally: Tally, input: SelectionInput): string | null {
  if (tally.sources > PHASE_CONTEXT_LIMITS.sourceContributionsMax) return 'source-count';
  if (tally.artifacts > PHASE_CONTEXT_LIMITS.artifactReferencesMax) return 'artifact-count';
  const largestCollection = Math.max(tally.outcomes, tally.decisions, tally.constraints, tally.unresolvedIssues);
  if (largestCollection > PHASE_CONTEXT_LIMITS.collectionEntriesMax) return 'entry-count';
  if (tally.manifestBytes > input.manifestBytesBudget) return 'manifest-bytes';
  return tally.renderedBytes > input.renderedBytesBudget ? 'rendered-bytes' : null;
}

/**
 * FR-014: the one candidate at the cutoff the request names. Two occurrences refuse the
 * selection; the later one is never taken for the earlier.
 */
function matchOf(request: SourceRequest, atCutoff: readonly ValidCandidate[]): ValidCandidate | Refusal | null {
  const matches = atCutoff.filter((candidate) => candidate.acceptedFrom.nodePath === request.nodePath);
  if (matches.length > 1) return refuse('invalid-source', 'ambiguous-source');
  const match = matches.at(0);
  if (match !== undefined) return match;
  return request.required ? refuse('required-context-unavailable', 'no-contribution') : null;
}

function refusalStep(refusal: Refusal): Step {
  return { kind: 'refuse', refusal };
}

/** What one request does with the candidate it names. */
function stepFor(request: SourceRequest, candidate: ValidCandidate, tally: Tally, optionalClosed: boolean, input: SelectionInput): Step {
  const { contribution } = candidate;
  if (contribution === null) return refusalStep(refuse('invalid-source', 'invalid-contribution'));
  if (contribution.coverage === 'unavailable') {
    if (request.required) return refusalStep(refuse('required-context-unavailable', 'coverage-unavailable'));
    return { kind: 'omit', reason: 'coverage-unavailable', closesOptional: false };
  }
  // FR-018: once one optional source did not fit, no optional request after it is tried.
  if (optionalClosed && !request.required) return { kind: 'omit', reason: 'optional-capacity', closesOptional: true };
  const source = sourceOf(request, candidate, contribution);
  const next = tallyWith(tally, source, input.costOf(source));
  const fault = capacityFault(next, input);
  if (fault === null) return { kind: 'select', source, tally: next };
  if (request.required) return refusalStep(refuse('capacity-exceeded', fault));
  return { kind: 'omit', reason: 'optional-capacity', closesOptional: true };
}

/** FR-005: every candidate no request settled, with the reason it is not in the manifest. */
function unrequestedOmissions(input: SelectionInput, settled: ReadonlySet<string>): Omission[] {
  return input.candidates
    .filter((candidate) => !settled.has(producerKey(candidate.acceptedFrom)))
    .map(
      (candidate): Omission => ({
        producer: candidate.acceptedFrom,
        request: null,
        reason: candidate.acceptedSequence > input.cutoffSequence ? 'after-cutoff' : 'not-selected-by-policy'
      })
    )
    .sort((left, right) => compareProducers(left.producer, right.producer));
}

export function selectSources(input: SelectionInput): SelectionResult | Refusal {
  const atCutoff = input.candidates.filter((candidate) => candidate.acceptedSequence <= input.cutoffSequence);
  const sources: ManifestSource[] = [];
  const requested: Omission[] = [];
  const settled = new Set<string>();
  let tally = EMPTY_TALLY;
  let optionalClosed = false;

  for (const request of requestsOf(input.policy, input.boundInputs)) {
    const match = matchOf(request, atCutoff);
    if (match === null) continue;
    if ('ok' in match) return match;
    const key = producerKey(match.acceptedFrom);
    // A source an earlier request settled is not selected or recorded again.
    if (settled.has(key)) continue;
    const step = stepFor(request, match, tally, optionalClosed, input);
    if (step.kind === 'refuse') return step.refusal;
    settled.add(key);
    if (step.kind === 'select') {
      sources.push(step.source);
      tally = step.tally;
      continue;
    }
    requested.push({ producer: match.acceptedFrom, request: request.ref, reason: step.reason });
    optionalClosed = optionalClosed || step.closesOptional;
  }

  const omissions = [...requested, ...unrequestedOmissions(input, settled)];
  const listed = omissions.slice(0, PHASE_CONTEXT_LIMITS.sourceContributionsMax);
  return { ok: true, sources, omissions: listed, omissionsUnlisted: omissions.length - listed.length };
}
