/**
 * FR-R6-F06 (FR-006, FR-007, research R5) — the one authority rule for overlapping observations.
 *
 * Rank: provider-reported 3, derived 2, estimated 1. Among known candidates the highest rank
 * wins, and within a rank the lowest ingest sequence wins. Another known candidate at the
 * selected rank is corroborating when its value is equal and conflicting when it differs; the
 * result is `conflicting` only in that second case. Lower ranks and unknown candidates are
 * superseded. Unknown never displaces known. The input order never changes the result.
 *
 * A latest-value group (ACP context occupancy and its session-cumulative amounts, FR-023) reports
 * a fresh reading each update, so within the selected rank the newest event wins, then the later
 * ingest; the older readings are superseded, not conflicting.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { Completeness, Disposition, Provenance } from '../../contracts/usage-accounting/accounting-types';

export const ACCOUNTING_PROVENANCE_RANK: Readonly<Record<Provenance, number>> = Object.freeze({
  'provider-reported': 3,
  derived: 2,
  estimated: 1
});

export interface CandidateMeasure {
  readonly observationId: string;
  readonly ingestSeq: number;
  readonly provenance: Provenance;
  /** The measure row's completeness: never `conflicting`, which only a selection produces. */
  readonly completeness: Completeness;
  /** `null` means unknown. */
  readonly quantity: bigint | null;
  /** Set for a latest-value reading (ACP occupancy): the event instant that orders the readings. */
  readonly latestWinsEventUtc?: string | undefined;
}

export type CandidateDisposition = Extract<Disposition, 'accepted' | 'corroborating' | 'conflicting' | 'superseded'>;

export interface ContributionSelection {
  readonly selected: CandidateMeasure | null;
  readonly dispositions: ReadonlyMap<string, CandidateDisposition>;
  readonly completeness: Completeness;
}

function byAuthority(left: CandidateMeasure, right: CandidateMeasure): number {
  const rankDelta = ACCOUNTING_PROVENANCE_RANK[right.provenance] - ACCOUNTING_PROVENANCE_RANK[left.provenance];
  if (rankDelta !== 0) return rankDelta;
  if (left.ingestSeq !== right.ingestSeq) return left.ingestSeq - right.ingestSeq;
  return left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0;
}

function isKnown(candidate: CandidateMeasure): boolean {
  return candidate.quantity !== null && candidate.completeness !== 'unknown';
}

/** Newest event first, then the later ingest, then the observation id: total and order-free. */
function byLatest(left: CandidateMeasure, right: CandidateMeasure): number {
  const leftUtc = left.latestWinsEventUtc ?? '';
  const rightUtc = right.latestWinsEventUtc ?? '';
  if (leftUtc !== rightUtc) return leftUtc < rightUtc ? 1 : -1;
  if (left.ingestSeq !== right.ingestSeq) return right.ingestSeq - left.ingestSeq;
  return left.observationId < right.observationId ? 1 : left.observationId > right.observationId ? -1 : 0;
}

/** The known candidates at the top rank, when every one of them is a latest-value reading. */
function latestValuePeers(known: readonly CandidateMeasure[]): CandidateMeasure[] | null {
  const topRank = ACCOUNTING_PROVENANCE_RANK[(known.at(0) as CandidateMeasure).provenance];
  const peers = known.filter((item) => ACCOUNTING_PROVENANCE_RANK[item.provenance] === topRank);
  return peers.every((item) => item.latestWinsEventUtc !== undefined) ? peers : null;
}

function selectLatestValue(
  ordered: readonly CandidateMeasure[],
  peers: readonly CandidateMeasure[]
): ContributionSelection {
  const selected = [...peers].sort(byLatest).at(0) as CandidateMeasure;
  const dispositions = new Map<string, CandidateDisposition>();
  for (const item of ordered) dispositions.set(item.observationId, item === selected ? 'accepted' : 'superseded');
  return { selected, dispositions, completeness: selected.completeness };
}

/** Selects one candidate for an (attempt, invocation, measure, unit) group and classifies the others. */
export function selectContribution(candidates: readonly CandidateMeasure[]): ContributionSelection {
  const ordered = [...candidates].sort(byAuthority);
  const known = ordered.filter(isKnown);
  const dispositions = new Map<string, CandidateDisposition>();

  if (known.length === 0) {
    const allLatest = ordered.length > 0 && ordered.every((item) => item.latestWinsEventUtc !== undefined);
    const first = (allLatest ? [...ordered].sort(byLatest) : ordered).at(0) ?? null;
    for (const item of ordered) dispositions.set(item.observationId, item === first ? 'accepted' : 'superseded');
    return { selected: first, dispositions, completeness: 'unknown' };
  }

  const peers = latestValuePeers(known);
  if (peers !== null) return selectLatestValue(ordered, peers);

  const selected = known.at(0) as CandidateMeasure;
  const selectedRank = ACCOUNTING_PROVENANCE_RANK[selected.provenance];
  let conflicting = false;
  for (const item of ordered) {
    if (item === selected) {
      dispositions.set(item.observationId, 'accepted');
      continue;
    }
    const sameRank = isKnown(item) && ACCOUNTING_PROVENANCE_RANK[item.provenance] === selectedRank;
    if (!sameRank) {
      dispositions.set(item.observationId, 'superseded');
      continue;
    }
    const agrees = item.quantity === selected.quantity;
    if (!agrees) conflicting = true;
    dispositions.set(item.observationId, agrees ? 'corroborating' : 'conflicting');
  }
  const completeness: Completeness = conflicting ? 'conflicting' : selected.completeness;
  return { selected, dispositions, completeness };
}

const OBSERVATION_DISPOSITION_PRECEDENCE: readonly CandidateDisposition[] = [
  'accepted',
  'conflicting',
  'corroborating',
  'superseded'
];

/** One observation's disposition across its measures: accepted > conflicting > corroborating > superseded. */
export function aggregateObservationDisposition(perMeasure: readonly CandidateDisposition[]): CandidateDisposition | undefined {
  for (const disposition of OBSERVATION_DISPOSITION_PRECEDENCE) {
    if (perMeasure.includes(disposition)) return disposition;
  }
  return undefined;
}
