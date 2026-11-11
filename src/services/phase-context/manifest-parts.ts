/**
 * FR-R6-F15 (F15-A; FR-006, FR-007, FR-017, NFR-001) — one selected source and one omission of
 * a manifest, read from an untrusted value. Each is rebuilt field by field under the bounds a
 * contribution passes; a key the contract does not name refuses it.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  MANIFEST_COVERAGES,
  OMISSION_REASONS,
  REQUEST_KINDS,
  type ManifestSource,
  type Omission,
  type RequestRef
} from '../../contracts/phase-context/context-manifest';
import { IDENTIFIER_PATTERN } from '../../contracts/phase-context/context-policy';
import { parseProducerRef } from './identity';
import { hasExactKeys, isOneOf, isWholeNumber, matchesPattern, plainRecord } from './primitives';
import { isSummary, parseArtifacts, parseEntries } from './source-contribution';

const SOURCE_KEYS = [
  'producer',
  'acceptedSequence',
  'coverage',
  'required',
  'selectedBy',
  'outcomes',
  'decisions',
  'constraints',
  'unresolvedIssues',
  'summary',
  'artifacts'
] as const;
const REQUEST_KEYS = ['kind', 'id'] as const;
const OMISSION_KEYS = ['producer', 'request', 'reason'] as const;

/** The bound input or selector that asked for a source, or `null` when the value is not one. */
export function parseRequestRef(value: unknown): RequestRef | null {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, REQUEST_KEYS)) return null;
  const { kind, id } = record;
  if (!isOneOf(REQUEST_KINDS, kind) || !matchesPattern(IDENTIFIER_PATTERN, id)) return null;
  return { kind, id };
}

/**
 * One selected source, or the detail code of what is wrong with it. A source accepted after
 * the cutoff of its manifest is refused: the cutoff is what selection saw (FR-005).
 */
export function parseManifestSource(value: unknown, cutoffSequence: number): ManifestSource | string {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, SOURCE_KEYS)) return 'source-shape';
  const producer = parseProducerRef(record.producer);
  if (producer === null) return 'source-producer';
  const { acceptedSequence, coverage, required, summary } = record;
  if (!isWholeNumber(acceptedSequence, 0)) return 'source-sequence';
  if (acceptedSequence > cutoffSequence) return 'source-after-cutoff';
  if (!isOneOf(MANIFEST_COVERAGES, coverage)) return 'source-coverage';
  if (typeof required !== 'boolean') return 'source-required';
  const selectedBy = parseRequestRef(record.selectedBy);
  if (selectedBy === null) return 'source-request';

  const outcomes = parseEntries(record.outcomes);
  if (typeof outcomes === 'string') return outcomes;
  const decisions = parseEntries(record.decisions);
  if (typeof decisions === 'string') return decisions;
  const constraints = parseEntries(record.constraints);
  if (typeof constraints === 'string') return constraints;
  const unresolvedIssues = parseEntries(record.unresolvedIssues);
  if (typeof unresolvedIssues === 'string') return unresolvedIssues;
  if (!isSummary(summary)) return 'summary';
  const artifacts = parseArtifacts(record.artifacts);
  if (typeof artifacts === 'string') return artifacts;

  return { producer, acceptedSequence, coverage, required, selectedBy, outcomes, decisions, constraints, unresolvedIssues, summary, artifacts };
}

/** One omission, or `null` when the value is not one. */
export function parseOmission(value: unknown): Omission | null {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, OMISSION_KEYS)) return null;
  const producer = parseProducerRef(record.producer);
  if (producer === null) return null;
  const request = record.request === null ? null : parseRequestRef(record.request);
  if (record.request !== null && request === null) return null;
  const { reason } = record;
  if (!isOneOf(OMISSION_REASONS, reason)) return null;
  return { producer, request, reason };
}
