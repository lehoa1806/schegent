// Pure label, availability-phrase, and state formatting helpers shared by ExecutionVisibilityPanel
// and ChangeReviewPanel (keeps both Svelte components comfortably under the 500-line LOC budget).

import { availabilityPhrase, type ReviewDescriptor } from '../../../src/contracts/change-review';
import type { HandoffExplanation } from '../../../src/contracts/phase-context/context-manifest';
import type { ExecutionAttemptVisibility } from './messages';

export function laneStateLabel(state: string | null): string {
  if (state === null || state === '' || state === 'unknown') {
    return availabilityPhrase('unknown');
  }
  switch (state) {
    case 'preparing':
      return 'Preparing';
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'abandoned':
      return 'Abandoned';
    case 'cleaned':
      return 'Cleaned up';
    default:
      return state.replaceAll('-', ' ');
  }
}

export function reviewStateLabel(d: ReviewDescriptor): string {
  if (d.state === 'current') return 'Current: matches frozen target commit';
  if (d.state === 'stale') return `Stale: target or candidate moved (${d.reason ?? 'stale'})`;
  return `${availabilityPhrase('uncertain')} (${d.reason ?? 'uncertain'})`;
}

export function qualityLabel(quality: ExecutionAttemptVisibility['hierarchy']['dataQuality']): string {
  if (quality === 'authoritative') return 'Authoritative';
  if (quality === 'partial') return availabilityPhrase('partial');
  return availabilityPhrase('unknown');
}

export function streamLabel(state: ExecutionAttemptVisibility['liveLog']['streamState']): string {
  if (state === 'captured') return 'Captured';
  if (state === 'not-captured') return 'Not captured (disabled)';
  if (state === 'partial') return availabilityPhrase('partial');
  return availabilityPhrase('unknown');
}

export function recoveryLabel(posture: ExecutionAttemptVisibility['recovery']['posture']): string {
  if (posture === 'verified') return 'Verified recovery handoff';
  if (posture === 'degraded') return 'Degraded (unsupported or refused)';
  if (posture === 'uncertain') return availabilityPhrase('uncertain');
  return 'Not recorded';
}

export function acpStateLabel(state: ExecutionAttemptVisibility['acp']['runtimeState']): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'awaiting-permission':
      return 'Awaiting permission (awaiting-permission)';
    case 'canceled':
      return 'Canceled';
    case 'uncertain':
      return availabilityPhrase('uncertain');
    case 'not-recorded':
      return 'Not recorded';
  }
}

export function availabilityLabelForArtifact(availability: string): string {
  switch (availability) {
    case 'expired':
      return availabilityPhrase('expired');
    case 'missing':
      return availabilityPhrase('missing');
    case 'deleted':
    case 'corrupt':
    case 'unavailable':
      return availabilityPhrase('unavailable');
    case 'unverified':
    case 'uncertain':
      return availabilityPhrase('uncertain');
    case 'partial':
      return availabilityPhrase('partial');
    case 'pending':
      return 'Pending capture';
    default:
      return availabilityPhrase('unknown');
  }
}

// F12-FR-03: never render numeric `0 present / N recorded` for expired, missing, partial,
// uncertain, or unavailable artifacts; always use explicit non-numeric availability phrases.
export function evidenceSummary(evidence: ExecutionAttemptVisibility['evidence']): string {
  if (evidence.length === 0) {
    return availabilityPhrase('missing');
  }
  const presentCount = evidence.filter((item) => item.availability === 'present').length;
  if (presentCount === evidence.length) {
    return `All present (${evidence.length} recorded)`;
  }
  if (presentCount > 0) {
    return `${availabilityPhrase('partial')} (${presentCount} of ${evidence.length} present)`;
  }
  const phrases: string[] = [];
  for (const item of evidence) {
    const phrase = availabilityLabelForArtifact(item.availability);
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases.join('; ');
}

export function latestRevisionState(h: HandoffExplanation): string {
  return h.revisions.find((r) => r.revision === h.revision)?.state ?? 'unknown';
}

// SR-A2 #4 (F12-FR-13): replace control characters, bidi overrides/isolates/marks, format
// characters, lone surrogates, and line/paragraph separators with U+FFFD so hostile repository
// filenames cannot spoof extensions or reorder surrounding UI text (matches review-uri.ts).
const UNSAFE_REVIEW_DISPLAY_PATH_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

export function sanitizeReviewDisplayPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  return raw.replace(UNSAFE_REVIEW_DISPLAY_PATH_RE, '\uFFFD');
}

