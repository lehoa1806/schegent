/**
 * FR-R6-F15 (F15-A; FR-004, FR-008, FR-017, NFR-001) — what one finished attempt offers the
 * next phase, read from an untrusted value. The contribution is rebuilt field by field, bound
 * by count and by UTF-8 size, and must name the attempt it was accepted from. One fault
 * refuses the whole contribution: nothing is cut to fit and nothing is repaired.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  ARTIFACT_KINDS,
  COVERAGES,
  DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  PHASE_CONTEXT_CONTRIBUTION_VERSION,
  PHASE_CONTEXT_LIMITS,
  type ArtifactRef,
  type ProducerRef,
  type Refusal,
  type SourceContribution
} from '../../contracts/phase-context/context-policy';
import { parseProducerRef, sameProducer } from './identity';
import { hasExactKeys, isOneOf, isWholeNumber, listOf, matchesPattern, plainRecord, refuse } from './primitives';
import { textFault } from './text-bounds';

export type ContributionParse = { readonly ok: true; readonly contribution: SourceContribution } | Refusal;

const CONTRIBUTION_KEYS = [
  'schemaVersion',
  'producer',
  'coverage',
  'outcomes',
  'decisions',
  'constraints',
  'unresolvedIssues',
  'summary',
  'artifacts'
] as const;
const ARTIFACT_KEYS = ['artifactId', 'immutableVersion', 'digestHex', 'byteSize', 'kind'] as const;

/** FR-008: a reference names an immutable version, its digest and its size, or it is refused. */
export function parseArtifactRef(value: unknown): ArtifactRef | null {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, ARTIFACT_KEYS)) return null;
  const { artifactId, immutableVersion, digestHex, byteSize, kind } = record;
  if (!matchesPattern(IDENTIFIER_PATTERN, artifactId)) return null;
  if (!matchesPattern(IDENTIFIER_PATTERN, immutableVersion)) return null;
  if (!matchesPattern(DIGEST_PATTERN, digestHex)) return null;
  if (!isWholeNumber(byteSize, 0)) return null;
  if (!isOneOf(ARTIFACT_KINDS, kind)) return null;
  return { artifactId, immutableVersion, digestHex, byteSize, kind };
}

/** One collection of text entries, or the detail code of what is wrong with it. */
export function parseEntries(value: unknown): readonly string[] | 'entry-count' | 'entry-text' {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.collectionEntriesMax);
  if (items === null) return 'entry-count';
  const entries: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || textFault(item, PHASE_CONTEXT_LIMITS.textEntryBytesMax) !== null) return 'entry-text';
    entries.push(item);
  }
  return entries;
}

/** True when the value is a summary: `null`, or text of 1 byte to 8 KiB. */
export function isSummary(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === 'string' && textFault(value, PHASE_CONTEXT_LIMITS.summaryBytesMax) === null;
}

/** The artifact references, or the detail code of what is wrong with them. */
export function parseArtifacts(value: unknown): readonly ArtifactRef[] | 'artifact-count' | 'artifact' | 'artifact-duplicate' {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.artifactReferencesMax);
  if (items === null) return 'artifact-count';
  const artifacts: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const artifact = parseArtifactRef(item);
    if (artifact === null) return 'artifact';
    if (seen.has(artifact.artifactId)) return 'artifact-duplicate';
    seen.add(artifact.artifactId);
    artifacts.push(artifact);
  }
  return artifacts;
}

export function parseSourceContribution(value: unknown, acceptedFrom: ProducerRef): ContributionParse {
  const record = plainRecord(value);
  if (record === null) return refuse('invalid-source', 'contribution-shape');
  const { schemaVersion } = record;
  if (isWholeNumber(schemaVersion, PHASE_CONTEXT_CONTRIBUTION_VERSION + 1)) {
    return refuse('unsupported-version', 'contribution-version');
  }
  if (schemaVersion !== PHASE_CONTEXT_CONTRIBUTION_VERSION) return refuse('invalid-source', 'contribution-version');
  if (!hasExactKeys(record, CONTRIBUTION_KEYS)) return refuse('invalid-source', 'contribution-shape');

  const producer = parseProducerRef(record.producer);
  if (producer === null) return refuse('invalid-source', 'producer');
  // FR-014: a contribution speaks only for the attempt the host accepted it from.
  if (!sameProducer(producer, acceptedFrom)) return refuse('invalid-source', 'producer-mismatch');
  const { coverage, summary } = record;
  if (!isOneOf(COVERAGES, coverage)) return refuse('invalid-source', 'coverage');

  const outcomes = parseEntries(record.outcomes);
  if (typeof outcomes === 'string') return refuse('invalid-source', outcomes);
  const decisions = parseEntries(record.decisions);
  if (typeof decisions === 'string') return refuse('invalid-source', decisions);
  const constraints = parseEntries(record.constraints);
  if (typeof constraints === 'string') return refuse('invalid-source', constraints);
  const unresolvedIssues = parseEntries(record.unresolvedIssues);
  if (typeof unresolvedIssues === 'string') return refuse('invalid-source', unresolvedIssues);
  if (!isSummary(summary)) return refuse('invalid-source', 'summary');
  const artifacts = parseArtifacts(record.artifacts);
  if (typeof artifacts === 'string') return refuse('invalid-source', artifacts);

  return {
    ok: true,
    contribution: {
      schemaVersion: PHASE_CONTEXT_CONTRIBUTION_VERSION,
      producer,
      coverage,
      outcomes,
      decisions,
      constraints,
      unresolvedIssues,
      summary,
      artifacts
    }
  };
}
