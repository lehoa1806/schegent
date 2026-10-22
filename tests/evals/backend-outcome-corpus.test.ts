import { describe, expect, it } from 'vitest';
import corpusJson from './fixtures/backend-outcomes.json';
import { parseAuditLogBlock } from '../../src/parser/audit-log-parser';
import { RATE_LIMIT_MATCHERS, detectCreditError } from '../../src/parser/credit-error-detector';
import { parseInvocation, type InvocationResult } from '../../src/parser/stdout-parser';
import {
  failClosedOnTruncatedOutput,
  mapOutcome,
  mapTerminationReason
} from '../../src/controller/phase-outcome-mapper';
import {
  resolveSessionDispatch,
  type SessionDispatchInputs
} from '../../src/services/session-dispatch-policy';
import type { PhaseOutcome } from '../../src/controller/phase';
import type { TerminationReason } from '../../src/state/workflow-run';
import { unwrapStreamJson, type ApiErrorMetadata } from '../../src/parser/stream-json-unwrapper';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../src/contracts/backend-kinds';
import {
  MAX_DIAGNOSTIC_LINE_LENGTH,
  classifyFatal,
  getEffectiveSignatures,
  isDiagnosticLine,
  type EffectiveSignature,
  type FatalClassification
} from '../../src/lib/fatal-signature-registry';
import type {
  EvidencePolicyOrigin,
  PhaseEvidencePolicy
} from '../../src/contracts/process-definitions';
import {
  ENUMERATION,
  UNCOVERED_REASONS,
  buildCoverageMap,
  entryId,
  type CoverageClaim
} from './verdict-enumeration';
import {
  ENVELOPE_READ_FIELDS,
  auditBlockReadFields,
  auditBlockViolations,
  envelopeViolations,
  type EnvelopeShape
} from './read-fields';

/**
 * FR-R3-067 — the test count a suite source declares, derived rather than kept.
 *
 * Two kinds of declaration, separated by their title syntax, because counting
 * `it(` alone undercounts badly: most of the tests come from the loop over
 * `corpus.cases`. Measured 2026-08-24, before this assertion existed: 6
 * declarations for 15 reported tests. That is exactly the trap FR-R3-065 hit when
 * it counted `test(` calls in a parameterised visual suite and got 4 for 18.
 *
 *   an `it('…')` or `it("…")` with a QUOTED title is one test;
 *   an `it(`…`)` with a TEMPLATE title is one per corpus case.
 *
 * Both quote styles, because the first draft matched single quotes only and missed
 * its own double-quoted title — reporting 6 standalone where there were 7. It
 * caught itself on the first run, which is the argument for deriving a number
 * rather than restating it.
 *
 * Taken as a parameter rather than reading the file, so the derivation itself is
 * testable against a synthetic source (SC-011).
 */
function deriveTestTally(
  source: string,
  caseCount: number
): {
  readonly standalone: number;
  readonly templated: number;
  readonly unsupported: number;
  readonly total: number;
} {
  const standalone = (source.match(/^\s*it\(["']/gm) ?? []).length;
  const templated = (source.match(/^\s*it\(`/gm) ?? []).length;
  // Declaration forms this derivation cannot account for. Counted rather than
  // ignored, because each of them moves the REPORTED tally without moving the
  // derived one: a `.each` multiplies by a list this function never sees, a
  // `.skip` or `.todo` subtracts from the passing count, and a bare `test(` is a
  // test in a shape the two regexes above do not match. Any of them would leave a
  // green gate standing over a stale README — the failure mode this whole
  // derivation exists to remove — so the assertion that reads this demands zero
  // and the derivation gets extended instead.
  const unsupported = (source.match(/^\s*(?:test\(|(?:it|test|describe)\.[A-Za-z]+\()/gm) ?? [])
    .length;
  return { standalone, templated, unsupported, total: standalone + templated * caseCount };
}

type AuditFixture = 'valid' | 'missing-notes' | 'none';

/**
 * FR-006 / FR-007 — where a case came from, on EVERY case.
 *
 * The filing's title said "eleven recorded cases". None of the eleven was
 * recorded; all were hand-authored. That gap is the whole defect class this
 * feature answers, and an optional field would let the next case reproduce it.
 * `reason` is required on `synthesized` and forbidden on `recorded`, so
 * "synthesized" cannot be used as a shrug.
 */
type CaseProvenance =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'synthesized'; readonly reason: string };

/**
 * FR-008b — the bytes a backend actually writes, before `unwrapStreamJson`.
 *
 * Minimal by construction: only the fields the unwrapper reads. A verbatim
 * capture carries `session_id`, usage figures and whole file contents inside
 * `tool_result` blocks, which breaches FR-019's leak bound and would force the
 * corpus-wide scrub gate FR-019 deliberately declines to build.
 */
interface CaseEnvelope {
  readonly shape: EnvelopeShape;
  readonly lines: readonly string[];
  readonly note: string;
}

/**
 * The `ParseInputs` fields `evaluate()` used to drop.
 *
 * Research D8: several branches are unreachable by ANY fixture until the
 * harness forwards these, so the harness widens before the corpus grows. Every
 * member is optional and omitted by default, which is why the eleven
 * pre-existing cases parse byte-for-byte as they did at version 1.
 */
interface CaseParseInputs {
  readonly evidencePolicy?: PhaseEvidencePolicy;
  readonly evidencePolicyDeclaredAt?: EvidencePolicyOrigin;
  readonly effectiveFatalSignatures?: readonly EffectiveSignature[];
  /**
   * Operator-registered fatal patterns, as the operator writes them.
   *
   * Expanded through the real `getEffectiveSignatures` rather than declared as
   * a literal `EffectiveSignature[]`: a hand-built effective list can disagree
   * with the real merge — drop the built-in floor, mis-set `source`, invent a
   * stream scope — and a case that covers `fatal-detector:source:operator-defined`
   * against a hand-built list would be covering the harness's idea of the
   * registry instead of the registry.
   */
  readonly operatorFatalSignatures?: readonly string[];
  readonly streamFatalMatch?: FatalClassification;
}

interface EvalCase {
  readonly id: string;
  readonly description: string;
  readonly provenance: CaseProvenance;
  /** FR-004 / FR-005 — which members of `SUPPORTED_BACKENDS` this case stands for. */
  readonly backends: readonly BackendRunnerKind[];
  readonly envelope: CaseEnvelope | null;
  /** FR-008b — a positive statement, never a silent omission. */
  readonly envelopeNullReason?: string;
  /** Enumeration entry ids (`<set>:<key>`) this case claims to exercise. */
  readonly covers?: readonly string[];
  readonly output: {
    readonly stdoutLines: readonly string[];
    readonly stderrLines: readonly string[];
    readonly exitCode: number | null;
    readonly auditBlock: AuditFixture;
    readonly truncated: boolean;
  };
  readonly parseInputs?: CaseParseInputs;
  readonly session?: SessionDispatchInputs;
  readonly expected: {
    readonly parserKind: InvocationResult['kind'];
    readonly phaseOutcome: PhaseOutcome;
    readonly terminationReason: TerminationReason;
    readonly auditEntryPresent: boolean;
    readonly auditWarningIncludes?: string;
    readonly resultWarningIncludes?: string;
    readonly mayAdvance: boolean;
    readonly session?: ReturnType<typeof resolveSessionDispatch>;
    /** Required iff `envelope !== null`. Asserted BEFORE classification. */
    readonly unwrappedText?: string;
    readonly apiError?: ApiErrorMetadata | null;
    /**
     * Optional direct assertions on the two detectors. A case that merely
     * *declares* it covers a detector branch has declared nothing checkable;
     * these make the declaration a measurement.
     */
    readonly creditDetection?: { readonly matched: boolean; readonly cause: string };
    readonly fatalClassification?: { readonly matched: boolean; readonly signature?: string };
  };
}

/**
 * Contract §1 — the file is `{schemaVersion, cases}` and nothing else.
 *
 * The FR-005 written reasons deliberately do NOT live here. They are prose
 * about SOURCE BRANCHES, not about cases: each one explains why some arm of a
 * union or some `if` in a detector cannot be reached by any fixture. Keeping
 * them beside the enumeration that produces the entries (`UNCOVERED_REASONS` in
 * `verdict-enumeration.ts`) means adding an unreachable member and writing its
 * reason are one edit in one file. Putting them in the fixture would have split
 * that across two, with the JSON half unable to reference the anchor it is
 * explaining.
 */
interface EvalCorpus {
  readonly schemaVersion: number;
  readonly cases: readonly EvalCase[];
}

const corpus = corpusJson as unknown as EvalCorpus;

// FR-018 — one shape, rejected outright rather than tolerated.
//
// A version-1 case carries no `provenance`, so a compatibility path would
// silently accept "nobody recorded where this came from" as a valid state —
// the precise condition FR-007 exists to make impossible. Thrown at module
// load rather than asserted inside a test, because a wrong-version fixture
// makes every assertion below meaningless rather than merely failing one.
if (corpus.schemaVersion !== 2) {
  throw new Error(
    `backend-outcomes.json declares schemaVersion ${String(corpus.schemaVersion)}; this suite ` +
      'reads version 2 only. Migrate the fixture (contracts/corpus-case-schema.md §1); do not add ' +
      'a version-1 fallback.'
  );
}

function auditBlock(kind: AuditFixture): string {
  if (kind === 'none') return '';
  const lines = [
    '=== SCHEGENT AUDIT LOG ===',
    'phase: speckit-specify',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: []',
    'ruleset_switches: []'
  ];
  if (kind === 'valid') lines.push('notes: deterministic evaluation fixture');
  lines.push('=== END AUDIT LOG ===');
  return lines.join('\n');
}

/**
 * T010 / T011 — the schema-shape assertion for ONE case, over both tiers.
 *
 * Returns violations rather than asserting, for the same reason the tier
 * helpers do: T012 has to check that this reports a read-field rename AND that
 * it stays silent on churn in fields no verdict reader reads. A throwing form
 * can only be tested in the failing direction, and the silent direction is the
 * one FR-010 is about — an assertion that fires on every upstream telemetry
 * change is one an operator learns to override.
 *
 * Every violation is prefixed with the case id, so a failure names the case as
 * well as the field (FR-009a).
 */
function schemaViolations(testCase: EvalCase): string[] {
  const found: string[] = [];

  const envelope = testCase.envelope;
  if (envelope !== null) {
    found.push(...envelopeViolations(envelope.shape, envelope.lines));
  }

  const kind = testCase.output.auditBlock;
  if (kind === 'valid') {
    found.push(...auditBlockViolations(auditBlock(kind)));
  } else if (kind === 'missing-notes') {
    // This fixture is short by exactly one required field on purpose — that
    // omission IS the case. Asserting the shortfall rather than skipping it
    // keeps the tier pinned here too: rename `notes` upstream and the derived
    // list follows, the expected violation stops naming `notes`, and this
    // reports the drift instead of quietly accepting a different absence.
    const missing = auditBlockViolations(auditBlock(kind));
    const only = missing.length === 1 ? missing.at(0) : undefined;
    const namesNotes = only !== undefined && only.includes('`notes`');
    if (!namesNotes) {
      found.push(
        'the missing-notes fixture must produce exactly one audit violation, naming `notes`; got ' +
          (missing.length === 0 ? '(none)' : missing.join(' | '))
      );
    }
  }
  // `kind === 'none'` synthesizes no block at all, so there is no audit tier to
  // hold to a shape. The case's own `auditEntryPresent: false` pins that.

  return found.map((violation) => `${testCase.id}: ${violation}`);
}

/**
 * The fatal signature list this case is classified against.
 *
 * `undefined` for every case that declares neither field, which is what
 * `classifyFatal` and `ParseInputs` already treat as "use the built-in floor" —
 * so the eleven version-1 cases keep classifying byte-for-byte as they did.
 * Shared with `observedCoverage` so the coverage attribution cannot be reading
 * a different registry from the one that produced the verdict.
 */
function effectiveSignaturesFor(
  testCase: EvalCase
): ReadonlyArray<EffectiveSignature> | undefined {
  const extra = testCase.parseInputs;
  if (extra?.effectiveFatalSignatures) return extra.effectiveFatalSignatures;
  if (extra?.operatorFatalSignatures) return getEffectiveSignatures(extra.operatorFatalSignatures);
  return undefined;
}

/**
 * Reproduce the production call order — `backend stdout -> unwrapStreamJson ->
 * parseInvocation -> mapOutcome` — for one case.
 *
 * The unwrap step is the one this harness used to skip. In production it
 * happens at `phase-runner.ts:756`, before the parser sees a byte; a corpus
 * entering downstream of it cannot observe a renamed envelope field at all,
 * which is what made "eleven cases guard the boundary" an overclaim.
 *
 * `expect` is called INSIDE this function on purpose. Contract §3 makes the
 * ordering normative: `unwrapStreamJson` does not throw on drift, it returns
 * `hasModelText ? unwrapped : rawText`, handing the classifier the raw
 * stream-json with the termination token still inside it as literal bytes. The
 * class can therefore still come out `clean`, so an assertion that ran after
 * classification — or only on the class — would pass the exact fault it exists
 * to detect. Asserting here makes "before classification" a property of the
 * code rather than a note in a document.
 */
function evaluate(testCase: EvalCase): {
  readonly result: InvocationResult;
  readonly phaseOutcome: PhaseOutcome;
  readonly terminationReason: TerminationReason;
  readonly auditEntryPresent: boolean;
  readonly auditWarnings: readonly string[];
  readonly credit: ReturnType<typeof detectCreditError>;
  readonly fatal: FatalClassification;
  /**
   * The exact bytes the two detectors were handed. Returned so the coverage
   * attribution below reads the same text the verdict was decided from, rather
   * than re-deriving it from the case and risking a quiet disagreement.
   */
  readonly detectorStdout: string;
  readonly detectorStderr: string;
} {
  const envelope = testCase.envelope;
  const unwrapped = envelope === null ? null : unwrapStreamJson(envelope.lines.join('\n'));

  if (unwrapped !== null) {
    expect(
      unwrapped.text,
      `${testCase.id}: unwrapStreamJson returned text the case did not expect. A renamed or ` +
        'restructured envelope field falls through to the raw stream-json rather than erroring, so ' +
        'this assertion — not the phase outcome — is what detects the drift.'
    ).toBe(testCase.expected.unwrappedText);
    expect(unwrapped.apiError, `${testCase.id}: apiError mismatch`).toEqual(
      testCase.expected.apiError ?? null
    );
  }

  const modelLines = unwrapped === null ? testCase.output.stdoutLines : [unwrapped.text];
  // FR-R3-199 — the block leads. Since feature 107 the parser reads the
  // termination token only after the audit block, which is where the prompt
  // tells the model to print it. Appended after the model's lines, the block
  // left every case's token outside the region the host reads.
  const stdout = [auditBlock(testCase.output.auditBlock), ...modelLines]
    .filter((line) => line.length > 0)
    .join('\n');
  const stderr = testCase.output.stderrLines.join('\n');
  const audit = parseAuditLogBlock(stdout);
  const credit = detectCreditError(stdout, stderr, testCase.output.exitCode);
  const extra = testCase.parseInputs;
  const effectiveFatalSignatures = effectiveSignaturesFor(testCase);
  const apiError = unwrapped?.apiError ?? undefined;
  const streamFatalMatch = extra?.streamFatalMatch;
  const parsed = parseInvocation({
    stdout,
    stderr,
    exitCode: testCase.output.exitCode,
    rateLimit: credit,
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    // FR-R3-199 — always forwarded, as phase-runner.ts forwards it. Omitted, the
    // parser scanned the whole stdout for the token, so a case could classify
    // clean on a token the host ignores.
    region: audit.region,
    // Everything below was dropped before this feature. Each is absent unless
    // the case declares it, and absent is what `ParseInputs` already treats as
    // "behave as the caller that was never updated" — which is why the eleven
    // version-1 cases classify identically.
    evidencePolicy: extra?.evidencePolicy,
    evidencePolicyDeclaredAt: extra?.evidencePolicyDeclaredAt,
    // Omitted rather than set to `undefined`. These three are the fields
    // `ParseInputs` declares WITHOUT `| undefined` in the type — `apiError?:
    // ApiErrorMetadata | null` (stdout-parser.ts:375), `effectiveFatalSignatures?:
    // ReadonlyArray<EffectiveSignature>` (:381) and `streamFatalMatch?:
    // FatalClassification` (:393) — where the two `evidencePolicy` fields above
    // are declared `?: T | undefined` and take it directly. Under
    // `exactOptionalPropertyTypes`, pinned by
    // tests/lint/compiler-strictness-ratchet.test.ts, an explicitly-undefined
    // key is a different thing from an absent one. The distinction is
    // type-level only here — each is read as a VALUE, never as a key: `effective
    // ?? getEffectiveSignatures([])` (fatal-signature-registry.ts:205) behaves
    // identically either way — so nothing about how these cases classify
    // changes with these lines. They are written so the harness can be read
    // under the flag the ratchet is adopting.
    ...(apiError === undefined ? {} : { apiError }),
    ...(effectiveFatalSignatures === undefined ? {} : { effectiveFatalSignatures }),
    ...(streamFatalMatch === undefined ? {} : { streamFatalMatch })
  });
  const result = failClosedOnTruncatedOutput(parsed, testCase.output.truncated);
  return {
    result,
    phaseOutcome: mapOutcome(result, testCase.output.exitCode),
    terminationReason: mapTerminationReason(result, testCase.output.exitCode),
    auditEntryPresent: audit.entry !== null,
    auditWarnings: audit.warnings,
    credit,
    // Recomputed rather than read back off the parse, because a `NoFatalMatch`
    // is indistinguishable from "the parser returned before consulting the
    // detector". The suppression cases in T024 assert exactly that distinction.
    fatal: classifyFatal(stdout, stderr, effectiveFatalSignatures),
    detectorStdout: stdout,
    detectorStderr: stderr
  };
}

/**
 * T018 — what a case DEMONSTRABLY exercised, observed rather than declared.
 *
 * The obvious design is a `covers: [...]` list on each case. It is the wrong
 * one, and for this feature's own reason: a hand-written coverage list is a
 * claim validated by nothing, which is precisely the overclaim the filing
 * describes. A case could name `credit-detector:branch:exit-429` while carrying
 * `exitCode: 1` and the map would report the branch covered forever.
 *
 * So every id below is attributed from a WITNESS — a value the production code
 * returned, or an input the case itself declares:
 *
 *   - class ids come straight off the returned kind, outcome and reason;
 *   - the credit matchers are tested with `RATE_LIMIT_MATCHERS` itself, the
 *     exported frozen array, so the attribution cannot disagree with the
 *     detector about which matcher a stderr matches;
 *   - the fatal signature, stream and source come off `FatalClassification`,
 *     which names all three on a match;
 *   - the unwrapper branch is read from the returned text against the input
 *     lines, which is the same comparison the branch itself makes.
 *
 * Two attributions have no return value to read, because the branch they name
 * returns `null`: the two soft-warn suppressions. Their witness is the case's
 * own stdout carrying the sigil and the status literal while `matched` is
 * false. The sigil constants are module-private in the detector, so those two
 * literals are duplicated here — the same maintenance class the entries
 * already declare (`derivation: 'hand-anchored'`), and the alternative is
 * leaving the difference between a courtesy warning and a multi-hour backoff
 * unmeasured.
 *
 * An entry no witness can distinguish gets no claim at all. It then surfaces
 * as uncovered and must be answered with a written reason (FR-005), which is
 * the honest outcome rather than a silent one.
 */
const RATE_LIMIT_EVENT_SIGIL = 'rate_limit_event';

function observedCoverage(
  testCase: EvalCase,
  observed: ReturnType<typeof evaluate>
): string[] {
  const covers: string[] = [
    `InvocationResult:${observed.result.kind}`,
    `PhaseOutcome:${observed.phaseOutcome}`,
    `TerminationReason:${observed.terminationReason}`
  ];

  // --- the credit detector, at branch grain -------------------------------
  const stderr = observed.detectorStderr;
  const exitCode = testCase.output.exitCode;
  const stderrMatcher = RATE_LIMIT_MATCHERS.find((matcher) => matcher.regex.test(stderr));
  const stdoutText = observed.detectorStdout;

  if (observed.credit.matched) {
    if (stderrMatcher && stderrMatcher.cause === observed.credit.cause) {
      // The matcher claim is made HERE and nowhere else. The exit-429 branch
      // synthesizes the cause `rate-limit` without consulting a matcher at all,
      // so claiming `matcher:rate-limit` from the cause would report a matcher
      // exercised by a case that never ran one.
      covers.push(`credit-detector:matcher:${observed.credit.cause}`);
      covers.push('credit-detector:branch:stderr-match');
    } else if (exitCode === 429) {
      covers.push('credit-detector:branch:exit-429');
    } else if (observed.credit.cause === 'out-of-credits') {
      // `out-of-credits` has no matcher behind it; only `matchLine` returns it,
      // so the cause alone identifies the branch.
      covers.push('credit-detector:branch:sigil-out-of-credits');
    } else if (observed.credit.cause === 'rate-limit') {
      covers.push('credit-detector:branch:sigil-rate-limit');
    }
  } else if (exitCode === 0) {
    covers.push('credit-detector:branch:exit-0-gate');
  } else if (stdoutText.includes(RATE_LIMIT_EVENT_SIGIL)) {
    // The sigil is present and nothing matched, so a suppression fired. Which
    // one is read from the status literal the suppression tests for.
    if (/"status":\s?"allowed_warning"/.test(stdoutText)) {
      covers.push('credit-detector:branch:soft-warn-allowed_warning');
    } else if (/"status":\s?"allow"/.test(stdoutText)) {
      covers.push('credit-detector:branch:soft-warn-allow');
    }
  } else {
    covers.push('credit-detector:branch:no-match');
  }

  // --- the fatal detector -------------------------------------------------
  if (observed.fatal.matched) {
    // Only built-in patterns are enumerated, because only they are derivable —
    // `SIGNATURE_STREAMS` is the source the enumeration reads. An
    // operator-registered pattern is configuration, and claiming it as an
    // enumerated signature would let a fixture invent entries and then report
    // them covered. The operator path is still measured, through
    // `fatal-detector:source:operator-defined` just below.
    if (observed.fatal.source === 'built-in') {
      covers.push(`fatal-detector:signature:${observed.fatal.signature}`);
    }
    covers.push(`fatal-detector:stream:${observed.fatal.stream}`);
    covers.push(`fatal-detector:source:${observed.fatal.source}`);
    covers.push(`fatal-detector:branch:${observed.fatal.stream}-match`);
  } else {
    covers.push('fatal-detector:branch:no-match');

    // The three suppressions, attributed from the real predicates.
    //
    // These branches return nothing — they `continue` past a line — so there is
    // no classification to read them off. The witness is instead the pair
    // (a line that CARRIES a signature, a no-match verdict): something declined
    // that line, and which predicate declined it is decided by running the
    // exported predicates over it rather than by restating their conditions.
    //
    // Scope is checked first because it is checked first in `classifyFatal`:
    // a stderr-only pattern sitting on stdout never reaches `isDiagnosticLine`.
    // Past that, `isDiagnosticLine` returning false on a line that is neither
    // empty nor whitespace-only leaves exactly two causes, separated by the
    // exported bound.
    const effective = effectiveSignaturesFor(testCase) ?? getEffectiveSignatures([]);
    const streams = [
      { stream: 'stdout' as const, text: observed.detectorStdout },
      { stream: 'stderr' as const, text: observed.detectorStderr }
    ];
    for (const { stream, text } of streams) {
      for (const line of text.split('\n')) {
        for (const entry of effective) {
          if (!line.includes(entry.pattern)) continue;
          if (!(entry.streams ?? ['stdout', 'stderr']).includes(stream)) {
            covers.push('fatal-detector:branch:stream-scope-suppression');
            continue;
          }
          if (isDiagnosticLine(line)) continue;
          covers.push(
            line.length > MAX_DIAGNOSTIC_LINE_LENGTH
              ? 'fatal-detector:branch:isDiagnosticLine:over-length'
              : 'fatal-detector:branch:isDiagnosticLine:structured-envelope'
          );
        }
      }
    }
  }

  // --- the unwrapper's exit branches (FR-001a) ----------------------------
  const envelope = testCase.envelope;
  if (envelope !== null) {
    const raw = envelope.lines.join('\n');
    const unwrapped = unwrapStreamJson(raw);
    // `shape` is a sound witness for `sawAnyLine` because `envelopeViolations`
    // asserts it: a `raw-passthrough` case whose lines parse as JSON objects
    // fails, and so does any other shape whose lines do not. Reading the shape
    // therefore reads a verified property rather than re-deciding the
    // unwrapper's own `sawAnyLine` test a second time in the harness.
    if (envelope.shape === 'raw-passthrough') {
      covers.push('unwrapper:raw-passthrough');
    } else if (unwrapped.text === raw) {
      covers.push('unwrapper:raw-fallback-on-drift');
    } else {
      covers.push('unwrapper:unwrapped-model-text');
    }
    if (unwrapped.apiError !== null) covers.push('unwrapper:api-error-detected');
  }

  return covers;
}

describe('backend-neutral outcome evaluation corpus', () => {
  it('is versioned, uniquely keyed, and covers every required scenario', () => {
    expect(corpus.schemaVersion).toBe(2);
    const ids = corpus.cases.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'clean-completion',
      'clarification-loop',
      'remaining-issues',
      'malformed-audit-block',
      'fatal-signature',
      'rate-limit',
      'truncated-output',
      'internal-execution-error',
      'session-continuation',
      'runner-switch',
      // FR-R3-084 §3.4 — the injection-shaped scenario. Fixture-based and in the
      // deterministic corpus by the item's own instruction, so it is exercised on
      // every `npm run ci` rather than only when a live backend is reachable.
      'prompt-injection-in-output',

      // T020 / T021 — the envelope tier. These are the cases that enter ABOVE
      // `unwrapStreamJson`; the eleven above all enter below it, which is what
      // made "eleven cases guard the phase-verdict boundary" an overclaim.
      'envelope-claude-assistant',
      'envelope-codex-item-completed',
      'envelope-agy-item-completed',
      'envelope-raw-passthrough',
      'envelope-drift-claude-tool-use-only',
      'envelope-drift-codex-non-agent-item',
      'envelope-drift-agy-non-agent-item',
      'envelope-api-error-exit-zero',
      'envelope-api-error-nonzero-exit',

      // T022 — the credit detector at branch grain. Four matchers that no case
      // reached, the exit-429 floor, both stdout sigils, and the two soft-warn
      // suppressions, which are the branches that decide whether an operator
      // waits out a courtesy warning as if it were a multi-hour backoff.
      'credit-matcher-out-of-usage',
      'credit-matcher-credits-exhausted',
      'credit-matcher-quota-exceeded',
      'credit-matcher-session-limit',
      'credit-exit-429-without-diagnostic',
      'credit-stdout-sigil-out-of-credits',
      'credit-stdout-sigil-rate-limit',
      'credit-soft-warn-allowed-warning',
      'credit-soft-warn-allow',

      // T024 — the fatal detector. Two matches and three suppressions; the
      // suppressions assert NOT fatal, which is the only direction in which a
      // branch that returns nothing can be witnessed.
      'fatal-autocompact-on-stdout',
      'fatal-operator-defined-signature',
      'fatal-suppressed-by-stream-scope',
      'fatal-suppressed-by-structured-envelope',
      'fatal-suppressed-by-line-length'
    ]);
  });

  // FR-006 / FR-007 / FR-008b — contract §4 rules V2..V5 and V8, checked at
  // parse time rather than trusted.
  //
  // These are structural, not behavioural: they say nothing about whether a
  // case classifies correctly, only that it is a case at all. They earn their
  // place because every one of them guards a way for a case to look complete
  // while asserting less than it appears to — an unlabelled fixture read as a
  // recording, an envelope silently absent, a case claiming three backends it
  // never stood for.
  it('holds every case to the version-2 shape: provenance, backends, envelope decision', () => {
    const problems: string[] = [];
    const seen = new Set<string>();

    // Read as LOADED, not as declared. `corpus` is a cast over parsed JSON
    // (`corpusJson as unknown as EvalCorpus`, above) and this test is what earns
    // that cast — so reading the cases back through `EvalCase` would let the
    // compiler answer the very questions being asked. Under the declared type
    // `envelope === undefined` is unreachable and `kind !== 'synthesized'` is
    // always false, when in fact each is the only thing standing between a
    // malformed case and a green suite. Widened over exactly the two fields the
    // V2/V3/V5 rules police, and no further: `backends` and `expected` keep
    // their declared types because the checks below do not interrogate their
    // presence.
    type AsLoaded = Omit<EvalCase, 'provenance' | 'envelope'> & {
      readonly provenance?: { readonly kind?: string; readonly reason?: unknown };
      readonly envelope?: CaseEnvelope | null;
    };
    const loaded: readonly AsLoaded[] = corpus.cases;

    for (const testCase of loaded) {
      const at = testCase.id;

      // V8 — uniqueness, re-checked here because the pinned list above is an
      // ORDER assertion; two cases sharing an id would satisfy it only if both
      // appeared, which the pinned list would then also have to repeat.
      if (seen.has(at)) problems.push(`${at}: duplicate id`);
      seen.add(at);

      // V2 — `reason` iff synthesized. The forbidden direction matters as much
      // as the required one: a `recorded` case carrying a reason is a case
      // someone re-labelled without re-recording.
      const provenance = testCase.provenance;
      if (!provenance || (provenance.kind !== 'recorded' && provenance.kind !== 'synthesized')) {
        problems.push(`${at}: provenance.kind must be 'recorded' or 'synthesized'`);
      } else if (provenance.kind === 'synthesized') {
        if (typeof provenance.reason !== 'string' || provenance.reason.trim().length === 0) {
          problems.push(`${at}: synthesized cases must state why no recording exists`);
        }
      } else if ('reason' in provenance) {
        problems.push(`${at}: a recorded case must not carry a synthesis reason`);
      }

      // V4 — non-empty, and every member a real backend. Read from
      // `SUPPORTED_BACKENDS` so adding a backend cannot leave this stale.
      if (!Array.isArray(testCase.backends) || testCase.backends.length === 0) {
        problems.push(`${at}: backends must be a non-empty list`);
      } else {
        for (const backend of testCase.backends) {
          if (!SUPPORTED_BACKENDS.includes(backend)) {
            problems.push(`${at}: '${backend}' is not in SUPPORTED_BACKENDS`);
          }
        }
      }

      // V3 / V5 — the envelope decision is explicit in both directions, and
      // the two `expected` fields exist exactly when there is an envelope to
      // assert them against.
      const hasEnvelope = testCase.envelope !== null && testCase.envelope !== undefined;
      if (testCase.envelope === undefined) {
        problems.push(`${at}: envelope must be present, as an object or an explicit null`);
      }
      if (!hasEnvelope) {
        const reason = testCase.envelopeNullReason;
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          problems.push(`${at}: envelope null requires envelopeNullReason, a positive statement`);
        }
        if ('unwrappedText' in testCase.expected) {
          problems.push(`${at}: unwrappedText is meaningless with no envelope to unwrap`);
        }
        if ('apiError' in testCase.expected) {
          problems.push(`${at}: apiError is meaningless with no envelope to unwrap`);
        }
      } else {
        const envelope = testCase.envelope as CaseEnvelope;
        if (testCase.envelopeNullReason !== undefined) {
          problems.push(`${at}: envelopeNullReason is set on a case that has an envelope`);
        }
        if (!Array.isArray(envelope.lines) || envelope.lines.length === 0) {
          problems.push(`${at}: envelope.lines must be a non-empty list`);
        }
        if (typeof envelope.note !== 'string' || envelope.note.trim().length === 0) {
          problems.push(`${at}: envelope.note must say what the envelope is minimal with respect to`);
        }
        if (typeof testCase.expected.unwrappedText !== 'string') {
          problems.push(`${at}: an envelope case must assert expected.unwrappedText (FR-008b)`);
        }
        if (!('apiError' in testCase.expected)) {
          problems.push(`${at}: an envelope case must assert expected.apiError, even as null`);
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  // T008 / T009 / T010 — the read-field tables themselves, over both tiers.
  //
  // This asserts the PINS, not the cases: that each tier derived a non-empty
  // list, that every entry is anchored by symbol, that required fields are
  // pinned on presence and optional ones on kind-when-present. The cases are
  // held to those pins inside the templated loop (T011).
  it('pins every field a verdict reader reads, by symbol, in both tiers', () => {
    const auditFields = auditBlockReadFields();
    expect(auditFields.length, 'the audit tier derived an empty field list').toBeGreaterThan(0);
    expect(ENVELOPE_READ_FIELDS.length).toBeGreaterThan(0);

    // FR-008a — the anchor's unit is the SYMBOL, never the file.
    // `parseAuditLogLineDetailed` shares a file with `parseAuditLogBlock`,
    // reads the host's own persisted audit JSONL and decides no verdict; a
    // file-grained anchor would sweep in nine of its fields, none of which any
    // backend drift could ever move.
    for (const field of [...auditFields, ...ENVELOPE_READ_FIELDS]) {
      expect(field.anchor.symbol.trim(), `${field.path}: anchor has no symbol`).not.toBe('');
      expect(field.anchor.line, `${field.path}: anchor has no line`).toBeGreaterThan(0);
      expect(
        field.anchor.file.startsWith('repo/src/'),
        `${field.path}: anchored outside the host at ${field.anchor.file}`
      ).toBe(true);
    }
    expect(auditFields.every((f) => f.anchor.symbol === 'parseAuditLogBlock')).toBe(true);

    // Required fields are pinned on PRESENCE: drop any one from the block the
    // harness synthesizes and the assertion names it. Checked for every derived
    // field rather than a sampled one, so a field the parser starts requiring
    // is covered on the run it appears, not the run someone remembers it.
    const block = auditBlock('valid');
    expect(auditBlockViolations(block)).toEqual([]);
    for (const field of auditFields) {
      const without = block
        .split('\n')
        .filter((line) => !line.startsWith(`${field.path}:`))
        .join('\n');
      expect(
        without,
        `${field.path}: the removal did not apply, so the probe below proves nothing`
      ).not.toBe(block);
      expect(auditBlockViolations(without).join('\n')).toContain(`\`${field.path}\``);
    }

    // The envelope tier has exactly one required field: the discriminator every
    // branch of `processLine` switches on. The rest are protocol-OPTIONAL, and
    // FR-010 is explicit about what that means — a backend that omits
    // `is_error` on a successful turn is behaving correctly, and a corpus that
    // failed on the omission would be pinning the absence of an error as an
    // error.
    expect(ENVELOPE_READ_FIELDS.filter((f) => f.presence === 'required').map((f) => f.path)).toEqual(
      ['type']
    );

    const conformant = '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}';
    expect(envelopeViolations('claude-assistant', [conformant])).toEqual([]);
    // Optional present with the wrong kind is named...
    expect(
      envelopeViolations('claude-assistant', [
        '{"type":"assistant","is_error":"yes","message":{"content":[{"type":"text","text":"d"}]}}'
      ]).join('\n')
    ).toContain('is_error');
    // ...and the required one, absent, is named rather than tolerated.
    expect(
      envelopeViolations('claude-assistant', [
        '{"message":{"content":[{"type":"text","text":"d"}]}}'
      ]).join('\n')
    ).toContain('`type`');
  });

  // T012 / FR-009a — the negative check, run on every suite run.
  //
  // The assertion has to be demonstrably SCOPED, not merely present. One that
  // fires on every upstream change is one an operator learns to override; one
  // that fires on nothing is one nobody notices is dead. Both directions are
  // checked here.
  //
  // Nothing on disk is mutated: the probes are built in memory and the corpus
  // subjects are deep copies, so a failure mid-test cannot leave the fixture
  // dirty for the next run or for the commit.
  it('fails on a renamed read field and stays silent on fields nothing reads', () => {
    // --- audit-block tier ---------------------------------------------------
    const block = auditBlock('valid');
    const firstField = auditBlockReadFields().at(0);
    if (firstField === undefined) {
      throw new Error('the audit tier derived no read fields, so there is nothing to rename');
    }
    const readField = firstField.path;
    const renamedRead = block.replace(new RegExp(`^${readField}:`, 'm'), `${readField}_renamed:`);
    expect(
      renamedRead,
      'the rename did not apply; a failed mutation and a weak assertion look identical from here'
    ).not.toBe(block);
    expect(auditBlockViolations(renamedRead).join('\n')).toContain(`\`${readField}\``);

    // Churn in fields no verdict reader reads: added, renamed, removed. None
    // may produce a violation.
    const withExtras = block.replace(
      '=== END AUDIT LOG ===',
      'session_id: fixture-session\nusage_input_tokens: 12\n=== END AUDIT LOG ==='
    );
    const renamedExtra = withExtras.replace('usage_input_tokens:', 'usage_in_tokens:');
    const removedExtra = withExtras
      .split('\n')
      .filter((line) => !line.startsWith('session_id:'))
      .join('\n');
    expect(withExtras).not.toBe(block);
    expect(renamedExtra).not.toBe(withExtras);
    expect(removedExtra).not.toBe(withExtras);
    for (const [label, variant] of [
      ['added', withExtras],
      ['renamed', renamedExtra],
      ['removed', removedExtra]
    ] as const) {
      expect(
        auditBlockViolations(variant),
        `audit block, ${label}: churn in a field nothing reads must not fail`
      ).toEqual([]);
    }

    // --- envelope tier ------------------------------------------------------
    // The probes are built here rather than read from the corpus so this check
    // cannot go vacuous on the day the last envelope case is deleted. Corpus
    // envelope cases are mutated as well, as deep copies, so it also grows with
    // the corpus.
    //
    // `raw-passthrough` is excluded on purpose: it carries no read field to
    // rename, because it is the shape whose defining property is that the lines
    // do NOT parse as JSON objects. That property is asserted per case in the
    // templated loop instead.
    // `carriesModelText` marks the subjects for which `text` is a REQUIRED read
    // field, so the nested rename below can be asserted as a failure. It is not
    // universal: a drift case carries a `tool_use` block or a non-agent item,
    // where `text` is legitimately absent and the unwrapper is legitimately
    // silent — which is the property those cases exist to record.
    const probes: ReadonlyArray<{
      shape: EnvelopeShape;
      line: string;
      carriesModelText: boolean;
    }> = [
      {
        shape: 'claude-assistant',
        line: '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
        carriesModelText: true
      },
      {
        shape: 'codex-item-completed',
        line: '{"type":"item_completed","item":{"type":"agent_message","text":"done"}}',
        carriesModelText: true
      },
      {
        shape: 'agy-item-completed',
        line: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
        carriesModelText: true
      }
    ];
    const fromCorpus = (JSON.parse(JSON.stringify(corpus.cases)) as EvalCase[])
      .filter((c) => c.envelope !== null)
      .flatMap((c) => {
        const envelope = c.envelope as CaseEnvelope;
        return envelope.lines.map((line) => ({
          shape: envelope.shape,
          line,
          // Decided by the unwrapper, not by the checker and not by a second
          // reading of the line's structure. If `unwrapStreamJson` extracted
          // anything from this line, the line carried model text; if it handed
          // back the raw bytes, it did not. Asking the checker instead would be
          // circular — it would ask whether the checker complains and then
          // assert that the checker complains.
          carriesModelText: unwrapStreamJson(line).text !== line
        }));
      });

    for (const { shape, line, carriesModelText } of [...probes, ...fromCorpus]) {
      if (shape === 'raw-passthrough') continue;
      expect(
        envelopeViolations(shape, [line]),
        `${shape}: this subject is not conformant to begin with`
      ).toEqual([]);

      // `type` is the rename applied to every subject, because it is the one
      // field `ENVELOPE_READ_FIELDS` marks `required` — the discriminator every
      // branch of `processLine` switches on. It is therefore present in every
      // conformant line, including the drift cases, whose defining property is
      // that they carry no OTHER read field for the unwrapper to consume.
      const renamedType = line.replace(/"type":/g, '"kind":');
      expect(renamedType, `${shape}: the type rename did not apply`).not.toBe(line);
      expect(
        envelopeViolations(shape, [renamedType]).join('\n'),
        `${shape}: a renamed discriminator must fail`
      ).toContain('`type`');

      // The nested read field, where the subject actually carries one:
      // `message.content[].text` for claude, `item.text` for codex and agy.
      if (carriesModelText) {
        const renamedText = line.replace(/"text":/g, '"value":');
        expect(renamedText, `${shape}: the text rename did not apply`).not.toBe(line);
        expect(
          envelopeViolations(shape, [renamedText]).join('\n'),
          `${shape}: a renamed nested read field must fail`
        ).toContain('text');
      }

      // The three unread operations. `session_id` and usage accounting are read
      // by the sidecar readers FR-008c excludes by name, and by nothing that
      // decides whether a phase advanced.
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const variants = [
        ['added', { ...parsed, session_id: 'fixture-session', usage: { input_tokens: 1 } }],
        ['renamed', { ...parsed, sessionId: 'fixture-session', usage: { input_tokens: 1 } }],
        ['removed', { ...parsed, usage: { input_tokens: 1 } }]
      ] as const;
      for (const [label, variant] of variants) {
        expect(
          envelopeViolations(shape, [JSON.stringify(variant)]),
          `${shape}/${label}: churn in a field nothing reads must not fail`
        ).toEqual([]);
      }
    }
  });

  // The pinned list above stops the corpus shrinking, but it cannot say whether
  // the corpus still *covers* what it claims to. These two assertions do: every
  // arm of the two mappers under evaluation must be reached by some case. Added
  // 2026-08-19 after `transient_error` — the parser kind behind Feature 011's
  // delayed-retry path — turned out to be reachable only as an *outcome* (via a
  // truncated `malformed` parse) and never as a parser *kind*, so both mappers'
  // `case 'transient_error'` arms were unexercised here while this suite
  // reported "covers every required scenario".
  it('reaches every parser kind the outcome mappers switch on', () => {
    const covered = new Set(corpus.cases.map((c) => c.expected.parserKind));
    expect([...covered].sort()).toEqual([
      'clean',
      'malformed',
      'open_questions',
      'rate_limited',
      'remaining_issues',
      'transient_error'
    ]);
  });

  it('reaches every termination reason the parser path can produce', () => {
    // Five members are deliberately absent — `deadline`, `iteration_cap`,
    // `timeout`, `cancel` and `pre_spawn_refusal` — produced by the run-level
    // deadline check, the controller loop, the watchdog, an operator signal and
    // a pre-spawn guard, none of which runs through `mapTerminationReason`.
    // This comment named three of the five until `TERMINATION_REACHABLE` in
    // verdict-enumeration.ts counted them against the union; each carries its
    // own written reason there, which is what this list can no longer drift
    // from silently.
    const covered = new Set(corpus.cases.map((c) => c.expected.terminationReason));
    expect([...covered].sort()).toEqual([
      'error',
      'open_questions',
      'rate_limit',
      'remaining_issues',
      'token'
    ]);
  });

  for (const testCase of corpus.cases) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      // T011 / FR-009 — the schema assertion runs PER CASE rather than once
      // globally. Two backends sharing an envelope shape are asserted once per
      // carrying case, so dropping a case drops its protocol coverage with it
      // instead of leaving a global check standing over a corpus that no longer
      // contains the shape it was written for.
      const violations = schemaViolations(testCase);
      expect(violations, violations.join('\n')).toEqual([]);

      const actual = evaluate(testCase);
      expect(actual.result.kind).toBe(testCase.expected.parserKind);
      expect(actual.phaseOutcome).toBe(testCase.expected.phaseOutcome);
      expect(actual.terminationReason).toBe(testCase.expected.terminationReason);
      expect(actual.auditEntryPresent).toBe(testCase.expected.auditEntryPresent);
      expect(actual.phaseOutcome === 'clean').toBe(testCase.expected.mayAdvance);

      if (testCase.expected.auditWarningIncludes) {
        expect(actual.auditWarnings.join('\n')).toContain(testCase.expected.auditWarningIncludes);
      }
      if (testCase.expected.resultWarningIncludes) {
        expect(actual.result.kind).toBe('malformed');
        if (actual.result.kind === 'malformed') {
          expect(actual.result.warnings).toContain(testCase.expected.resultWarningIncludes);
        }
      }
      if (testCase.session && testCase.expected.session) {
        expect(resolveSessionDispatch(testCase.session)).toEqual(testCase.expected.session);
      }

      // The two detectors, asserted directly where a case declares them.
      //
      // The class alone cannot separate them: `transient_error` is what a
      // non-zero exit yields whether the credit detector declined the line or
      // never saw one, and `clean` is what a healthy run yields whether a fatal
      // suppression fired or no signature was present. The suppression cases
      // exist to pin exactly that difference, so they assert the detector.
      if (testCase.expected.creditDetection) {
        expect(
          { matched: actual.credit.matched, cause: actual.credit.cause },
          `${testCase.id}: credit detection`
        ).toEqual(testCase.expected.creditDetection);
      }
      if (testCase.expected.fatalClassification) {
        const expectedFatal = testCase.expected.fatalClassification;
        expect(actual.fatal.matched, `${testCase.id}: fatal match`).toBe(expectedFatal.matched);
        if (actual.fatal.matched && expectedFatal.signature !== undefined) {
          expect(actual.fatal.signature).toBe(expectedFatal.signature);
        }
      }

      // FR-005 — `covers` is INTENT, checked against the observation.
      //
      // It is never a SOURCE of coverage: the map below is built from
      // `observedCoverage` alone, so deleting every `covers` list would change
      // no coverage number. What it catches is the authoring mistake the
      // observed-only design cannot — a case written for one branch that
      // actually lands on another, which reads as progress in the aggregate
      // while the branch it was written for stays dark.
      const observedIds = new Set(observedCoverage(testCase, actual));
      const unmet = (testCase.covers ?? []).filter((id) => !observedIds.has(id));
      expect(
        unmet,
        `${testCase.id} declares it covers ${unmet.join(', ')}, but the pipeline did not observe ` +
          `that. What it did observe:\n  ${[...observedIds].sort().join('\n  ')}`
      ).toEqual([]);
    });
  }

  /**
   * T019 / FR-005 — the assertion that gives the coverage claim a denominator.
   *
   * Every enumerated entry must be covered by a case or answered by a written
   * reason. An uncovered entry with no reason FAILS; it is not an accepted
   * residue. That rule is the whole feature in one line: the filing said eleven
   * cases guard the phase-verdict boundary, and what made that an overclaim was
   * not the eleven — it was that nothing measured the other side.
   *
   * The claims are computed here rather than accumulated by the loop above, so
   * this test does not depend on the runner's declaration order. Re-running the
   * pipeline for all cases costs a few milliseconds.
   */
  it('covers every enumerated verdict branch, or says in writing why not', () => {
    const claims: CoverageClaim[] = corpus.cases.map((testCase) => ({
      id: testCase.id,
      backends: testCase.backends,
      covers: observedCoverage(testCase, evaluate(testCase))
    }));

    const map = buildCoverageMap(claims, UNCOVERED_REASONS, SUPPORTED_BACKENDS);

    // A claim naming an entry that no longer exists is never harmless: it
    // inflates `entriesCovered` against a denominator that shrank, which reads
    // as coverage improving at the moment it fell.
    expect(map.unknownClaims, `stale coverage claims:\n${map.unknownClaims.join('\n')}`).toEqual(
      []
    );

    // And the mirror of it, over the reasons rather than the claims. A written
    // reason for a branch that no longer exists is worse than a stale claim: it
    // is an ARGUMENT, and it keeps reading as a considered decision long after
    // the code it argues about is gone. The blank-line reason below is exactly
    // the shape at risk — it holds only while every registrable pattern is
    // non-empty, and the entry it answers would disappear silently if
    // `isDiagnosticLine` were restructured.
    const enumerated = new Set(ENUMERATION.map((entry) => entryId(entry)));
    const orphanedReasons = Object.keys(UNCOVERED_REASONS).filter((id) => !enumerated.has(id));
    expect(
      orphanedReasons,
      `${orphanedReasons.length} entries in UNCOVERED_REASONS answer nothing in ENUMERATION. The ` +
        'branch was renamed or removed; delete the reason with it rather than leaving an argument ' +
        'about code that is not there.'
    ).toEqual([]);

    const unanswered = map.uncovered.filter((entry) => entry.reason.trim() === '');
    expect(
      unanswered.map((entry) => `${entryId(entry.entry)}  (${entry.entry.anchor.file}:${entry.entry.anchor.line})`),
      `${unanswered.length} of ${map.entriesTotal} enumerated entries are neither covered by a case ` +
        'nor answered by a written reason. Add a case, or add the entry to UNCOVERED_REASONS in ' +
        'tests/evals/verdict-enumeration.ts with a statement about the SOURCE — why no input can ' +
        'reach that branch. "Not yet written" is the gap restated, not a reason.'
    ).toEqual([]);

    // FR-004 — stated per backend and never aggregated. Two backends reaching a
    // class by the same parsing path is a fact one case may record for both
    // (FR-005, research D9); two backends reaching it by different paths is not.
    for (const backend of SUPPORTED_BACKENDS) {
      const openForBackend = map.uncoveredByBackend.get(backend);
      expect(
        openForBackend,
        `${backend} has no per-backend list at all. buildCoverageMap was handed a backend list ` +
          'that disagrees with SUPPORTED_BACKENDS, and an absent list would otherwise pass this ' +
          'check by having nothing in it.'
      ).toBeDefined();
      const missing = (openForBackend ?? []).filter(
        (id) => (UNCOVERED_REASONS[id] ?? '').trim() === ''
      );
      expect(
        missing,
        `${backend}: ${missing.length} entries are unclaimed for this backend specifically. ` +
          'A case covers a backend only if its `backends` list names it.'
      ).toEqual([]);
    }
  });
});

/**
 * FR-R3-061 (M-08 / R-15) — what this corpus is, asserted rather than assumed.
 *
 * A review cited this suite as evidence that backend behaviour was qualified. It
 * is not, and cannot be: every input is a fixture, and nothing here runs a CLI,
 * opens a socket, or authenticates. The scope note lives in `tests/evals/README.md`;
 * these assertions keep it true, because a note nothing checks is a note that
 * drifts.
 */
describe('the corpus measures parser coverage, not behavioural qualification', () => {
  it('has a scope note that says so', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
    expect(readme).toContain('not behavioral qualification');
    // FR-R3-138 — this pinned the string `backend-canary.yml`, so the README could
    // not stop naming a file `FR-R3-099` had deleted without turning this suite
    // red. An assertion that holds a document to a deleted file does not keep the
    // document true; it enforces the falsehood, which is the worse of the two
    // failure modes because nobody re-reads a green test. What the README must
    // still say is how the canary is actually invoked.
    expect(readme).toContain('npm run canary');
    // FR-R3-084 (2026-08-26) — this pinned `skipped-no-live-path` on the premise
    // that "the canary qualifies nothing yet either: a version probe plus an
    // honest skip until a live invocation exists". A live invocation exists now,
    // so that string is gone and pinning it would hold the README to an obsolete
    // claim. What replaces it is what the README must still not omit: the honest
    // skip state the live phase can report, and the fact that nothing schedules
    // the canary — without which a reader would take it for a running one.
    expect(readme).toContain('skipped-not-authenticated');
    expect(readme).toContain('No workflow declares it');
  });

  it("reports the test tally its README states", async () => {
    // FR-R3-067 — the README said 13 while the suite reported 15, because
    // FR-R3-061 added two meta-assertions in the same change that wrote the
    // sentence. A corrected number with nothing behind it is a number that goes
    // stale again, so the tally is DERIVED here rather than restated. See
    // `deriveTestTally` for how, and why the obvious way does not work.
    //
    // Both components are exact: the standalone count from this source, the
    // multiplier from the fixture this file imports. Add a test and both sides of
    // the comparison move together, which is the whole point.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, 'backend-outcome-corpus.test.ts'), 'utf8');
    const { standalone, templated, unsupported, total } = deriveTestTally(
      source,
      corpus.cases.length
    );

    // Pinned so a SECOND loop cannot silently change the arithmetic. If someone
    // adds one, this fails loudly and the derivation gets revisited — which is
    // the behaviour to want from a count that must not go stale.
    expect(
      templated,
      'exactly one templated `it(` is expected, generated once per corpus case; a second loop means ' +
        'this derivation no longer describes the suite and must be rewritten rather than adjusted'
    ).toBe(1);

    // Pinned for the same reason, one step out: a declaration shape the derivation
    // cannot count would leave this gate green while the README went stale, which
    // is the whole failure it exists to prevent. Review found the loop pin above
    // guarded only the shape that already existed.
    expect(
      unsupported,
      'this suite gained a declaration this derivation cannot count — a `.each`, `.skip`, `.only`, ' +
        '`.todo`, or a bare `test(`. Each of those moves the reported tally without moving the derived ' +
        'total, so extend `deriveTestTally` to account for the new shape; do not delete this assertion.'
    ).toBe(0);

    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
    const stated = /\*\*(\d+) passing tests\*\*/.exec(readme);
    expect(
      stated,
      'README.md no longer states a passing-test tally in the form `**N passing tests**`. Either restore ' +
        'it or delete this assertion deliberately — do not loosen the pattern until it matches something.'
    ).not.toBeNull();
    expect(
      Number(stated?.[1]),
      `README.md says ${stated?.[1]} passing tests; this suite declares ${total} ` +
        `(${standalone} standalone + ${templated} x ${corpus.cases.length} corpus cases). ` +
        'Correct the README, not this derivation.'
    ).toBe(total);
  });

  it('derives a tally that moves with the file, so it needs no maintenance', () => {
    // FR-R3-067 SC-011 — the claim is that adding a test moves BOTH sides of the
    // comparison above, so the number never needs re-blessing by hand. That is
    // asserted by construction here rather than merely stated: the same
    // derivation is applied to a synthetic source that gains a declaration.
    //
    // The declarations are ASSEMBLED rather than written literally, because a line
    // beginning `it(` in this file would be counted by the derivation reading it —
    // a fixture that changed the number it exists to explain.
    const standaloneDecl = (title: string) => `  ${'it'}('${title}', () => {});`;
    const templatedDecl = `  ${'it'}(\`\${c.id}\`, () => {});`;

    const before = [standaloneDecl('one'), standaloneDecl('two'), templatedDecl].join('\n');
    const after = [before, standaloneDecl('three')].join('\n');

    expect(deriveTestTally(before, 10)).toEqual({
      standalone: 2,
      templated: 1,
      unsupported: 0,
      total: 12
    });
    // Adding a declaration moves the derived total with no other edit.
    expect(deriveTestTally(after, 10)).toEqual({
      standalone: 3,
      templated: 1,
      unsupported: 0,
      total: 13
    });
    // And the multiplier is the live case count, never a constant.
    expect(deriveTestTally(before, 4).total).toBe(6);
    // A double-quoted title counts too — the slip the first draft made.
    expect(deriveTestTally(`  ${'it'}("quoted", () => {});`, 10).standalone).toBe(1);

    // And a shape the derivation CANNOT account for is reported rather than
    // silently dropped, so the assertion above can refuse it. Assembled the same
    // way, for the same reason.
    const uncountable = [
      `  ${'it'}.each([1, 2])('%s', () => {});`,
      `  ${'it'}.skip('parked', () => {});`,
      `  ${'test'}('a different declarator', () => {});`
    ].join('\n');
    const withUncountable = deriveTestTally([before, uncountable].join('\n'), 10);
    expect(withUncountable.unsupported).toBe(3);
    // Note the trap this guards: none of the three moved the derived total.
    expect(withUncountable.total).toBe(12);
  });

  it('states the corpus case count its fixture actually holds', async () => {
    // The other number the README states, and the one that carries the
    // substantive claim FR-R3-061 wrote this file to protect.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');
    const stated = /\*\*(\d+) cases\*\*/.exec(readme);
    expect(stated, 'README.md no longer states a case count as `**N cases**`').not.toBeNull();
    expect(Number(stated?.[1])).toBe(corpus.cases.length);
  });

  it('keeps naming what the enlarged corpus still does not establish', async () => {
    // FR-014 / FR-019 / FR-002a — the residues. They live in the README because
    // that is the document a reader consults before citing the suite, and they
    // are pinned here because an unnamed limit reads as an absent one: the exact
    // failure this corpus exists to answer was a review citing eleven cases as
    // behavioural qualification.
    //
    // Pinned on SHORT, DURABLE phrases, never on whole sentences. The comment at
    // the top of this describe block records what pinning a brittle string costs:
    // `backend-canary.yml` held the README to a file that had been deleted. A
    // phrase that survives rewording but not deletion is the one to pin.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8');

    const residues = [
      // Classification is all this corpus asserts; meaning is untouched.
      'Semantic drift is undetectable',
      // No scrub gate. Synthesized minimal cases are a practice, not an enforcement.
      'Leak freedom is reviewed, not gated',
      // The enumerations that no list in `src/` backs are hand-anchored.
      'The enumeration is maintenance',
      // A field the unwrapper ignores is absent by construction (FR-010's cost).
      'Minimal envelopes hide ignored fields',
      // Five termination reasons no parser input can produce.
      'are out of reach',
      // Production feeds the credit detector raw bytes; this harness feeds unwrapped text.
      'different bytes here than in production',
      // `isDiagnosticLine`'s blank guard, covered by a written reason and nothing else.
      'One fatal branch has no witness'
    ];
    for (const residue of residues) {
      expect(
        readme.includes(residue),
        `README.md no longer names the residue "${residue}". If the limit is genuinely gone, delete ` +
          'this entry with the change that removed it; if it is only the wording that moved, re-point ' +
          'the pin. Do not delete it to make this green.'
      ).toBe(true);
    }
  });

  it('reaches no CLI, socket or credential', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, 'backend-outcome-corpus.test.ts'), 'utf8');
    // Only the IMPORT lines. Scanning the whole file for these tokens fails on
    // this assertion's own list -- the first version of it did exactly that, which
    // is the same self-reference trap as a lint gate matching its own comment.
    const imports = source
      .split(/\r?\n/)
      .filter((line) => line.startsWith('import ') || line.includes("from '"));
    const live = ['child_' + 'process', 'node:net', 'node:http', 'undici'];
    for (const forbidden of live) {
      expect(
        imports.some((line) => line.includes(forbidden)),
        `the corpus must not import ${forbidden}: a deterministic suite that grew a live call ` +
          'would keep passing while becoming the flaky PR gate the review warned against'
      ).toBe(false);
    }
  });
});
