/**
 * FR-R3-177 / FR-001, FR-001a, FR-002a — the outcome classes and verdict
 * branches the host distinguishes, ENUMERATED FROM SOURCE rather than
 * transcribed from memory.
 *
 * The filing this module answers said eleven recorded cases guard the
 * phase-verdict boundary. They do not: the corpus covered six parser kinds and
 * five termination reasons, and nothing measured what it did NOT cover. A
 * coverage claim with no denominator is the overclaim this feature exists to
 * abolish, so the denominator is computed here, on every run.
 *
 * Three derivation mechanisms hold exactness, and which one an entry uses is
 * recorded on the entry itself, because they differ in what they can promise
 * (research D1):
 *
 *   `type-exhaustive` — a `Record<Union, Anchor>`. Adding a member to the
 *       TypeScript union breaks `tsc` at this file. Strongest, and available
 *       only for string unions.
 *   `runtime-array`   — the exported frozen array is read at run time, so the
 *       table cannot disagree with it. Available only where the source keeps
 *       its list as data.
 *   `hand-anchored`   — a bare `if`/`return` branch has neither a type nor an
 *       array behind it. These are MAINTENANCE: a branch added to the source
 *       tomorrow is absent here and nothing goes red. That limit is stated in
 *       the corpus's residue block rather than papered over.
 *
 * Anchors are `file` + `symbol` + `line`, and the SYMBOL is the unit (FR-008a).
 * A file-grained anchor would let `parseAuditLogLineDetailed` — which reads the
 * host's own persisted JSONL and decides no verdict — be mistaken for a verdict
 * reader because it shares a file with one.
 *
 * Every line number below was measured against the tree at implementation time,
 * not copied from the plan: three anchors in the task text were stale by one to
 * three lines and are corrected here. The convention, where a branch spans an
 * `if` and its `return`, is to anchor the RETURN — the line that produces the
 * verdict.
 */

import type { InvocationResult } from '../../src/parser/stdout-parser';
import type { PhaseOutcome } from '../../src/controller/phase';
import type { TerminationReason } from '../../src/state/workflow-run';
import { RATE_LIMIT_MATCHERS } from '../../src/parser/credit-error-detector';
import {
  FATAL_SIGNATURES,
  type FatalSource,
  type FatalStream
} from '../../src/lib/fatal-signature-registry';

export interface Anchor {
  readonly file: string;
  readonly symbol: string;
  readonly line: number;
}

export type EnumerationSet =
  | 'InvocationResult'
  | 'PhaseOutcome'
  | 'TerminationReason'
  | 'credit-detector'
  | 'fatal-detector'
  | 'unwrapper';

export type DerivationMechanism = 'type-exhaustive' | 'runtime-array' | 'hand-anchored';

export interface EnumerationEntry {
  /**
   * FR-001a. An `envelope-branch` names no verdict of its own; it decides which
   * verdict is REACHABLE. Folding the two kinds into one population would let a
   * table be exhaustive over classes while blind to the drift that silently
   * changes which class a correct run receives.
   */
  readonly entryKind: 'class' | 'envelope-branch';
  readonly set: EnumerationSet;
  readonly key: string;
  readonly anchor: Anchor;
  readonly derivation: DerivationMechanism;
  /**
   * False where no arm of `mapOutcome` / `mapTerminationReason` can produce the
   * member. Such an entry is not a coverage failure — no fixture can reach it —
   * but it still needs a written reason (FR-005), which is why it is enumerated
   * rather than filtered out.
   */
  readonly reachableFromParser: boolean;
}

/** The stable coverage key. Cases declare these; the map joins on them. */
export function entryId(entry: EnumerationEntry): string {
  return `${entry.set}:${entry.key}`;
}

const PARSER = 'repo/src/parser/stdout-parser.ts';
const PHASE = 'repo/src/controller/phase.ts';
const RUN = 'repo/src/state/workflow-run.ts';
const CREDIT = 'repo/src/parser/credit-error-detector.ts';
const FATAL = 'repo/src/lib/fatal-signature-registry.ts';
const UNWRAP = 'repo/src/parser/stream-json-unwrapper.ts';

// ---------------------------------------------------------------------------
// T014 — the three TypeScript unions, type-exhaustively.
// ---------------------------------------------------------------------------

/**
 * `Record<K, …>` and not an array of literals: an array would accept a stale
 * list silently, whereas a missing key here is a compile error naming the
 * member that was added. This is the only mechanism in the file that cannot go
 * stale without someone noticing.
 */
const INVOCATION_KINDS: Record<InvocationResult['kind'], number> = {
  clean: 27,
  open_questions: 29,
  remaining_issues: 35,
  rate_limited: 41,
  transient_error: 63,
  incomplete_turn: 72,
  malformed: 78
};

/**
 * `timeout`, `skipped` and `paused-at-breakpoint` have no arm in `mapOutcome`:
 * the watchdog, the sequencer's skip path and the dispatch-boundary breakpoint
 * produce them, none of which parses backend output at all.
 */
const PHASE_OUTCOME_REACHABLE: Record<PhaseOutcome, boolean> = {
  clean: true,
  issues_remain: true,
  failed: true,
  rate_limited: true,
  transient_error: true,
  incomplete_turn: true,
  timeout: false,
  skipped: false,
  'paused-at-breakpoint': false
};

/**
 * Six of the eleven are parser-reachable. The corpus suite's own comment named
 * only three of the five unreachable ones — `iteration_cap`, `timeout`,
 * `cancel` — and silently omitted `deadline` and `pre_spawn_refusal`. Measuring
 * the union rather than restating the comment is what surfaced that.
 */
const TERMINATION_REACHABLE: Record<TerminationReason, boolean> = {
  token: true,
  open_questions: true,
  remaining_issues: true,
  rate_limit: true,
  error: true,
  incomplete_turn: true,
  deadline: false,
  iteration_cap: false,
  timeout: false,
  cancel: false,
  pre_spawn_refusal: false
};

function unionEntries(): EnumerationEntry[] {
  const entries: EnumerationEntry[] = [];
  for (const [key, line] of Object.entries(INVOCATION_KINDS)) {
    entries.push({
      entryKind: 'class',
      set: 'InvocationResult',
      key,
      anchor: { file: PARSER, symbol: 'InvocationResult', line },
      derivation: 'type-exhaustive',
      reachableFromParser: true
    });
  }
  for (const [key, reachable] of Object.entries(PHASE_OUTCOME_REACHABLE)) {
    entries.push({
      entryKind: 'class',
      set: 'PhaseOutcome',
      key,
      anchor: { file: PHASE, symbol: 'PhaseOutcome', line: 60 },
      derivation: 'type-exhaustive',
      reachableFromParser: reachable
    });
  }
  for (const [key, reachable] of Object.entries(TERMINATION_REACHABLE)) {
    entries.push({
      entryKind: 'class',
      set: 'TerminationReason',
      key,
      anchor: { file: RUN, symbol: 'TerminationReason', line: 181 },
      derivation: 'type-exhaustive',
      reachableFromParser: reachable
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// T015 — the credit detector, at BRANCH grain.
// ---------------------------------------------------------------------------

/**
 * Keyed by branch and never by cause string. `rate-limit` is produced by three
 * different branches — a stderr regex match, the `exitCode === 429` shortcut,
 * and the stdout `rate_limit_event` sigil path — and a cause-keyed table would
 * report two unexercised branches as covered the moment any one of them ran.
 */
const CREDIT_BRANCHES: ReadonlyArray<{ key: string; line: number }> = [
  { key: 'branch:exit-0-gate', line: 123 },
  { key: 'branch:stderr-match', line: 131 },
  { key: 'branch:exit-429', line: 135 },
  { key: 'branch:sigil-out-of-credits', line: 104 },
  { key: 'branch:sigil-rate-limit', line: 105 },
  { key: 'branch:soft-warn-allowed_warning', line: 95 },
  { key: 'branch:soft-warn-allowed', line: 98 },
  { key: 'branch:soft-warn-allow', line: 101 },
  { key: 'branch:no-match', line: 151 }
];

function creditEntries(): EnumerationEntry[] {
  // Runtime-enumerated: the exported frozen array is the source of truth, so a
  // matcher added there appears here without an edit.
  const matchers = RATE_LIMIT_MATCHERS.map<EnumerationEntry>(({ cause }) => ({
    entryKind: 'class',
    set: 'credit-detector',
    key: `matcher:${cause}`,
    anchor: { file: CREDIT, symbol: 'RATE_LIMIT_MATCHERS', line: 3 },
    derivation: 'runtime-array',
    reachableFromParser: true
  }));
  const branches = CREDIT_BRANCHES.map<EnumerationEntry>(({ key, line }) => ({
    entryKind: 'class',
    set: 'credit-detector',
    key,
    anchor: {
      file: CREDIT,
      symbol: key.startsWith('branch:sigil') || key.startsWith('branch:soft-warn')
        ? 'matchLine'
        : 'detectCreditError',
      line
    },
    derivation: 'hand-anchored',
    reachableFromParser: true
  }));
  return [...matchers, ...branches];
}

// ---------------------------------------------------------------------------
// T016 — the fatal detector. The SECOND detector FR-001 names.
// ---------------------------------------------------------------------------

/**
 * Omitted from this feature's first pass, and recovered only because a
 * requirements checklist asked whether "the credit and fatal detectors" had
 * been read as one thing. It had been. The recovery is recorded here rather
 * than quietly fixed, because the near-miss is the argument for the enumeration.
 *
 * `classifyFatal` is a DELEGATE of the stdout parser, not a fifth verdict
 * reader: `parseInvocation` calls it at `stdout-parser.ts:424`. It reads bytes
 * and decides a verdict all the same, which is why its branches are enumerated.
 */
const FATAL_BRANCHES: ReadonlyArray<{ key: string; symbol: string; line: number }> = [
  { key: 'branch:stdout-match', symbol: 'classifyFatal', line: 213 },
  { key: 'branch:stderr-match', symbol: 'classifyFatal', line: 216 },
  { key: 'branch:no-match', symbol: 'classifyFatal', line: 219 },
  { key: 'branch:stream-scope-suppression', symbol: 'classifyFatal', line: 211 },
  // The three suppression tests of `isDiagnosticLine`. An earlier draft named
  // only the length gate, and anchored it at `:120` — the CONSTANT
  // `MAX_DIAGNOSTIC_LINE_LENGTH`, not a branch. Both halves of that mistake are
  // corrected here: the anchors are the returning lines, and all three tests
  // are present.
  //
  // Which one fires matters. Real stream-json output is one JSON envelope per
  // line, so the ENVELOPE test is the one that catches a signature quoted
  // inside a transported `tool_result` — the 2026-08-16 incident where this
  // repository's own ARCHITECTURE.md, read by a phase and echoed on stdout,
  // matched `error: unknown option` and failed a healthy run at 3.6 hours. The
  // length test is the backstop for the non-JSON case.
  { key: 'branch:isDiagnosticLine:over-length', symbol: 'isDiagnosticLine', line: 142 },
  { key: 'branch:isDiagnosticLine:structured-envelope', symbol: 'isDiagnosticLine', line: 146 },
  { key: 'branch:isDiagnosticLine:blank', symbol: 'isDiagnosticLine', line: 148 }
];

const FATAL_SOURCES: Record<FatalSource, number> = {
  'built-in': 87,
  'operator-defined': 87
};

const FATAL_STREAMS: Record<FatalStream, number> = {
  stdout: 32,
  stderr: 32
};

function fatalEntries(): EnumerationEntry[] {
  const signatures = FATAL_SIGNATURES.map<EnumerationEntry>((pattern) => ({
    entryKind: 'class',
    set: 'fatal-detector',
    key: `signature:${pattern}`,
    anchor: { file: FATAL, symbol: 'FATAL_SIGNATURES', line: 83 },
    derivation: 'runtime-array',
    reachableFromParser: true
  }));
  const sources = Object.entries(FATAL_SOURCES).map<EnumerationEntry>(([key, line]) => ({
    entryKind: 'class',
    set: 'fatal-detector',
    key: `source:${key}`,
    anchor: { file: FATAL, symbol: 'FatalSource', line },
    derivation: 'type-exhaustive',
    reachableFromParser: true
  }));
  const streams = Object.entries(FATAL_STREAMS).map<EnumerationEntry>(([key, line]) => ({
    entryKind: 'class',
    set: 'fatal-detector',
    key: `stream:${key}`,
    anchor: { file: FATAL, symbol: 'FatalStream', line },
    derivation: 'type-exhaustive',
    reachableFromParser: true
  }));
  const branches = FATAL_BRANCHES.map<EnumerationEntry>(({ key, symbol, line }) => ({
    entryKind: 'class',
    set: 'fatal-detector',
    key,
    anchor: { file: FATAL, symbol, line },
    derivation: 'hand-anchored',
    reachableFromParser: true
  }));
  return [...signatures, ...sources, ...streams, ...branches];
}

// ---------------------------------------------------------------------------
// T017 — the unwrapper's four exit branches (FR-001a).
// ---------------------------------------------------------------------------

/**
 * These decide nothing on their own, and that is exactly why they were missing.
 * A renamed envelope field does not throw: `unwrapStreamJson` returns
 * `hasModelText ? unwrapped : rawText`, so the classifier is handed the RAW
 * stream-json. The termination token survives inside that JSON as literal
 * bytes, `containsTerminationToken` still accepts, and a drifted run can still reach
 * `clean` — by luck rather than by reading. A corpus asserting only the class
 * passes the exact fault it was added to detect, which is why the envelope
 * cases assert `unwrappedText` BEFORE classification.
 */
const UNWRAPPER_BRANCHES: ReadonlyArray<{ key: string; line: number }> = [
  { key: 'raw-passthrough', line: 112 },
  { key: 'unwrapped-model-text', line: 116 },
  { key: 'raw-fallback-on-drift', line: 116 },
  { key: 'api-error-detected', line: 35 }
];

function unwrapperEntries(): EnumerationEntry[] {
  return UNWRAPPER_BRANCHES.map(({ key, line }) => ({
    entryKind: 'envelope-branch',
    set: 'unwrapper',
    key,
    anchor: { file: UNWRAP, symbol: 'unwrapStreamJson', line },
    derivation: 'hand-anchored',
    reachableFromParser: true
  }));
}

export const ENUMERATION: ReadonlyArray<EnumerationEntry> = Object.freeze([
  ...unionEntries(),
  ...creditEntries(),
  ...fatalEntries(),
  ...unwrapperEntries()
]);

// ---------------------------------------------------------------------------
// T018 — the coverage map.
// ---------------------------------------------------------------------------

export interface UncoveredEntry {
  readonly entry: EnumerationEntry;
  readonly reason: string;
}

export interface CoverageMap {
  readonly entriesTotal: number;
  readonly entriesCovered: number;
  readonly uncovered: ReadonlyArray<UncoveredEntry>;
  /**
   * FR-004 — stated per backend, never aggregated across them.
   *
   * A Map rather than a record keyed by backend name: a lookup that can miss
   * should say so in its type. The record form reads as total, and its miss has
   * no honest handler — dropping the id and inventing an empty list are both
   * wrong, and both are silent.
   */
  readonly uncoveredByBackend: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Declared coverage keys matching no enumeration entry. Always a failure. */
  readonly unknownClaims: ReadonlyArray<string>;
}

export interface CoverageClaim {
  readonly id: string;
  readonly backends: ReadonlyArray<string>;
  readonly covers: ReadonlyArray<string>;
}

/**
 * Joins declared coverage onto the enumeration.
 *
 * `unknownClaims` is the half that makes the declaration honest. A case naming
 * a branch that no longer exists is not a harmless stale string: it inflates
 * `entriesCovered` against a denominator that shrank, which reads as better
 * coverage than before. The suite fails on a non-empty list.
 */
export function buildCoverageMap(
  claims: ReadonlyArray<CoverageClaim>,
  reasons: Readonly<Record<string, string>>,
  allBackends: ReadonlyArray<string>
): CoverageMap {
  const known = new Set(ENUMERATION.map(entryId));
  const coveredBy = new Map<string, Set<string>>();
  const unknownClaims: string[] = [];

  for (const claim of claims) {
    for (const key of claim.covers) {
      if (!known.has(key)) {
        unknownClaims.push(`${claim.id} -> ${key}`);
        continue;
      }
      const backends = coveredBy.get(key) ?? new Set<string>();
      for (const backend of claim.backends) backends.add(backend);
      coveredBy.set(key, backends);
    }
  }

  const uncovered: UncoveredEntry[] = [];
  for (const entry of ENUMERATION) {
    const id = entryId(entry);
    const backends = coveredBy.get(id);
    if (!backends || backends.size === 0) {
      uncovered.push({ entry, reason: reasons[id] ?? '' });
    }
  }

  // One pass per backend, rather than one shared record pushed into from inside
  // the loop above. Each backend's list is built whole and set once, so there is
  // no half-built entry to read back and no "list missing for this backend" arm
  // to write — a branch that would be unreachable by construction and therefore
  // unwitnessable, which is the shape this corpus spends a written reason on
  // elsewhere. ENUMERATION is 54 entries and the backend list is 3.
  const uncoveredByBackend = new Map<string, ReadonlyArray<string>>();
  for (const backend of allBackends) {
    uncoveredByBackend.set(
      backend,
      ENUMERATION.map(entryId).filter((id) => !coveredBy.get(id)?.has(backend))
    );
  }

  return {
    entriesTotal: ENUMERATION.length,
    entriesCovered: ENUMERATION.length - uncovered.length,
    uncovered,
    uncoveredByBackend,
    unknownClaims
  };
}

// ---------------------------------------------------------------------------
// T025 — the written reasons (FR-005).
// ---------------------------------------------------------------------------

/**
 * Why an enumerated entry has no case, stated per entry.
 *
 * FR-005 makes an uncovered entry a suite FAILURE unless a reason is written
 * here, which is the difference between a residue and a gap nobody noticed.
 * The reasons live beside the enumeration that produces the ids rather than in
 * the fixture, because each is prose about a SOURCE BRANCH, not about a case:
 * adding an unreachable member and writing its reason is then one edit in one
 * file, and the reason can name the anchor it is explaining. The fixture's
 * top-level shape is pinned to `{schemaVersion, cases}` by contract §1 and has
 * nowhere to put them in any event.
 *
 * A reason is a statement about the SOURCE, never about the schedule. "Not yet
 * written" is not a reason; it is the gap restated.
 */
export const UNCOVERED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  // --- PhaseOutcome members no arm of `mapOutcome` produces -----------------
  'PhaseOutcome:timeout':
    'Produced by the watchdog, which fires on elapsed wall-clock and never reads backend output. ' +
    'No stdout, stderr or exit code can reach it, so no fixture can either.',
  'PhaseOutcome:skipped':
    "Produced by the sequencer's skip path when a phase is not selected for the run. The phase " +
    'never spawns, so there is no invocation to parse.',
  'PhaseOutcome:paused-at-breakpoint':
    'Produced at the dispatch boundary before a backend is launched, from operator configuration ' +
    'rather than from output. Reaching it through the parser would mean the breakpoint had failed.',

  // --- TerminationReason members no arm of `mapTerminationReason` produces ---
  // The suite's own prose named three of these five and silently omitted
  // `deadline` and `pre_spawn_refusal`. Enumerating the union rather than
  // restating the comment is what surfaced the omission.
  'TerminationReason:deadline':
    'Set by the run-level deadline check against the clock, outside any invocation. The parser is ' +
    'not consulted, so no fixture reaches it.',
  'TerminationReason:iteration_cap':
    'Set by the controller loop when the iteration budget is spent. It is a property of the run, ' +
    'not of any one invocation, and a single parsed invocation cannot exhibit it.',
  'TerminationReason:timeout':
    'Set by the watchdog on elapsed time, for the same reason `PhaseOutcome:timeout` is unreachable.',
  'TerminationReason:cancel':
    'Set from an operator cancellation signal. There is no output that means "the operator cancelled".',
  'TerminationReason:pre_spawn_refusal':
    'Set before a backend process exists, when a guard declines to spawn one. By construction there ' +
    'is no stdout, stderr or exit code, so the parser never runs.',

  // --- the one fatal-detector branch no input can witness -------------------
  'fatal-detector:branch:isDiagnosticLine:blank':
    'The whitespace-only return at fatal-signature-registry.ts:148, reached when the scan finds no ' +
    'non-whitespace character. A line reaches isDiagnosticLine only after classifyFatal has already ' +
    'found a signature pattern inside it, and every registered pattern is a non-empty string of ' +
    'non-whitespace characters — so a line that contains one cannot be whitespace-only. The branch ' +
    'is a guard against a state its own caller makes unreachable, not a behaviour a fixture is ' +
    'declining to exercise. Note the shape of this reason: it is an argument about the SOURCE that ' +
    'stops holding the moment a whitespace-only pattern can be registered, at which point this ' +
    'entry needs a case rather than a longer reason.'
});
