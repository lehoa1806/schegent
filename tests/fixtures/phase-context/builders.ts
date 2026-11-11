// FR-R6-F15 T005 — builders for the phase-context tests. Every value is valid by default; a
// test overrides the one field it is about.
import type { ProfileCapacity } from '../../../src/contracts/phase-context/context-delivery';
import type {
  ArtifactRef,
  ContextSelector,
  ContributionCandidate,
  HandoffIdentity,
  HandoffPolicy,
  ProducerRef,
  SourceContribution
} from '../../../src/contracts/phase-context/context-policy';
import type { ManifestSource, Omission } from '../../../src/contracts/phase-context/context-manifest';
import type { FixClaims, NewFinding, ReviewReport } from '../../../src/contracts/phase-context/review-loop';
import type { ManifestInput } from '../../../src/services/phase-context/manifest';

/** Text of exactly `bytes` UTF-8 bytes, one byte per character. */
export function textOfBytes(bytes: number, fill = 'a'): string {
  return fill.repeat(bytes);
}

/** Text of exactly `bytes` UTF-8 bytes made of two-byte characters, padded with one `a`. */
export function wideTextOfBytes(bytes: number): string {
  const wide = String.fromCodePoint(0xe9);
  return wide.repeat(Math.floor(bytes / 2)) + 'a'.repeat(bytes % 2);
}

/** A marker a test seeds into context text and then searches for. Joined from parts. */
export function marker(label: string): string {
  return ['SEEDED', 'CONTEXT', label].join('~');
}

export function digestOf(character: string): string {
  return character.repeat(64);
}

export function producer(nodePath = 'plan', occurrenceId = 'occ-1', attemptId = 'att-1'): ProducerRef {
  return { nodePath, occurrenceId, attemptId };
}

export function selector(overrides: Partial<ContextSelector> = {}): ContextSelector {
  return { selectorId: 'sel-plan', sourceNodePath: 'plan', required: true, priority: 0, ...overrides };
}

export function policy(overrides: Partial<HandoffPolicy> = {}): HandoffPolicy {
  return { version: 1, approval: 'automatic', session: 'fresh', selectors: [selector()], ...overrides };
}

export function artifactRef(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    artifactId: 'artifact-1',
    immutableVersion: 'v1',
    digestHex: digestOf('a'),
    byteSize: 120,
    kind: 'text',
    ...overrides
  };
}

export function contribution(overrides: Partial<SourceContribution> = {}): SourceContribution {
  return {
    schemaVersion: 1,
    producer: producer(),
    coverage: 'complete',
    outcomes: ['The plan lists four steps.'],
    decisions: ['Use the existing queue.'],
    constraints: ['Do not change the public contract.'],
    unresolvedIssues: [],
    summary: null,
    artifacts: [],
    ...overrides
  };
}

/** A candidate whose contribution names the attempt it was accepted from. */
export function candidate(
  nodePath: string,
  acceptedSequence: number,
  overrides: Partial<SourceContribution> = {},
  occurrenceId = 'occ-1'
): ContributionCandidate {
  const acceptedFrom = producer(nodePath, occurrenceId, `att-${nodePath}`);
  return { acceptedFrom, acceptedSequence, contribution: contribution({ producer: acceptedFrom, ...overrides }) };
}

export function identity(overrides: Partial<HandoffIdentity> = {}): HandoffIdentity {
  return {
    workspaceId: 'workspace-1',
    rootExecutionId: 'root-1',
    sourceInvocationId: 'frame-1',
    targetNodePath: 'implement',
    targetOccurrenceId: 'occ-1',
    inputEnvelopeRevision: 1,
    sourceAttempts: [producer('plan', 'occ-1', 'att-plan')],
    ...overrides
  };
}

/** An identity whose source attempts are the accepting attempts of the given candidates. */
export function identityFor(candidates: readonly ContributionCandidate[], overrides: Partial<HandoffIdentity> = {}): HandoffIdentity {
  return identity({ sourceAttempts: candidates.map((entry) => entry.acceptedFrom), ...overrides });
}

/** A selected source of the node path, accepted at sequence 1 by the selector `sel-<nodePath>`. */
export function manifestSource(nodePath = 'plan', overrides: Partial<ManifestSource> = {}): ManifestSource {
  return {
    producer: producer(nodePath, 'occ-1', `att-${nodePath}`),
    acceptedSequence: 1,
    coverage: 'complete',
    required: true,
    selectedBy: { kind: 'selector', id: `sel-${nodePath}` },
    outcomes: ['The plan lists four steps.'],
    decisions: [],
    constraints: [],
    unresolvedIssues: [],
    summary: null,
    artifacts: [],
    ...overrides
  };
}

export function omission(nodePath: string, overrides: Partial<Omission> = {}): Omission {
  return { producer: producer(nodePath, 'occ-1', `att-${nodePath}`), request: null, reason: 'not-selected-by-policy', ...overrides };
}

/** The input of a revision 1 manifest whose identity names the producers of the given sources. */
export function manifestInput(sources: readonly ManifestSource[] = [manifestSource()], overrides: Partial<ManifestInput> = {}): ManifestInput {
  const attempts = sources.length === 0 ? [producer('plan', 'occ-1', 'att-plan')] : sources.map((source) => source.producer);
  return {
    revision: 1,
    previousRevision: null,
    origin: 'selected',
    identity: identity({ sourceAttempts: attempts }),
    policyDigest: digestOf('b'),
    approval: 'automatic',
    session: 'fresh',
    cutoffSequence: 10,
    targetInstructionsDigest: digestOf('c'),
    renderedBytesMax: 32 * 1024,
    sources,
    omissions: [],
    omissionsUnlisted: 0,
    ...overrides
  };
}

export function profile(overrides: Partial<ProfileCapacity> = {}): ProfileCapacity {
  return { profileId: 'profile-1', profileRevision: 1, qualifiedContextBytes: 64 * 1024, ...overrides };
}

export function finding(overrides: Partial<NewFinding> = {}): NewFinding {
  return {
    id: 'F-1',
    severity: 'high',
    title: 'The retry path loses the error code.',
    explanation: 'A second attempt reports success after the first one failed.',
    evidence: ['report#L10'],
    ...overrides
  };
}

export function reviewReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    reportVersion: 1,
    loopId: 'loop-1',
    pass: 1,
    reviewerAttemptId: 'att-review-1',
    candidateRef: 'candidate@1',
    scopeRevision: 'scope@1',
    criteriaRevision: 'criteria@1',
    previousReportRef: null,
    coverage: 'complete',
    reviewPassed: false,
    blockingCount: 1,
    findings: [finding()],
    dispositions: [],
    ...overrides
  };
}

export function reviewReportText(overrides: Partial<ReviewReport> = {}): string {
  return JSON.stringify(reviewReport(overrides));
}

export function fixClaims(overrides: Partial<FixClaims> = {}): FixClaims {
  return {
    claimsVersion: 1,
    loopId: 'loop-1',
    pass: 1,
    fixerAttemptId: 'att-fix-1',
    basedOnReportRef: 'report@1',
    claims: [{ findingId: 'F-1', claim: 'claimed-fixed' }],
    ...overrides
  };
}

export function fixClaimsText(overrides: Partial<FixClaims> = {}): string {
  return JSON.stringify(fixClaims(overrides));
}
