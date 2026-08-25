import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-067 — a count a document asserts about this tree must be a count
 * something checks.
 *
 * THE INCIDENT, TWICE
 *
 * A round-3 item said "the remaining 14 modules are not migrated … enumerated in
 * the gate's ledger"; the ledger held 16. The evaluation corpus README said the
 * suite "reports 13 passing tests"; it reported 15, because two meta-assertions
 * were added by the same change that wrote the sentence.
 *
 * Neither number was load-bearing for a mechanism, and that is the point.
 * FR-R3-046 corrected four numeric slips of exactly this kind earlier in the
 * round (13->10, 54->53, 112->111) and here were two more. **A corrected count
 * with nothing behind it is a count that will be wrong again**, and it will be
 * wrong in the document whose whole purpose is to be where the number is right.
 * FR-R3-063 filed generated-fact parity for counts as a deliverable and did not
 * build it; this is that.
 *
 * CITATION FIRST, ASSERTION SECOND
 *
 * The strongest fix is for a document to NAME its producer rather than transcribe
 * its cardinality — a sentence that says "every module on the ledger" cannot
 * drift. That is what happened to the ledger count: the number was removed, so
 * there is nothing here to check. This registry is for the cases where stating a
 * number genuinely serves a reader, which is why it is small. A large registry
 * would mean many documents restating facts they could have cited.
 *
 * WHAT THIS GATE GUARANTEES
 *
 *   - every registered count agrees with the producer that settles it;
 *   - a registry entry whose document or claim no longer exists fails, so an
 *     entry cannot outlive its subject;
 *   - each entry reads ONLY its own named document.
 *
 * WHAT IT DOES NOT GUARANTEE
 *
 *   - **It discovers nothing.** There is no scan for integers in prose. A count
 *     nobody registered is unchecked, and that is deliberate: a heuristic over
 *     prose produces false positives, and a gate with false positives is switched
 *     off. `docs/operations/asserted-counts-sweep.md` records what was examined
 *     so the registry's size is accountable rather than arbitrary.
 *   - **It settles only what a static read can settle.** A count only a running
 *     suite knows — the corpus's own test tally — belongs to that suite, asserted
 *     against its own declarations. Registering it here would mean faking a
 *     producer this gate cannot evaluate.
 *   - **It checks only what this checkout can read.** `repo/` cloned on its own
 *     is a supported layout and CI checks out exactly that, so an entry whose
 *     document lives in the planning envelope is skipped there rather than
 *     failed. Producers inside this repository are always read, so the
 *     producer-side direction stays live in both layouts.
 *   - **Dated measurements are out of scope, not detected.** A recorded
 *     observation with a commit and a date is evidence; "correcting" it into
 *     agreement with today's tree is falsification. Such counts are untouched
 *     because nobody registered them, not because a rule recognised them — and
 *     the assertion below pins that a specific known one stays out.
 */
/*
 * OBSERVED NON-VACUOUS, 2026-08-24, darwin/arm64. Command in every case:
 * `npx vitest run tests/lint/asserted-counts.test.ts`. Each seed reverted.
 *
 * Re-measured after review, because the first version of this block recorded a
 * two-entry registry that review had already reshaped — a stale count inside the
 * gate against stale counts. Rerun these commands rather than trusting the
 * numbers if the registry changes again.
 *
 * PRODUCER SIDE, both entries, documents untouched: added a seeded case to
 *   `backend-outcomes.json` -> red TWICE, once per entry:
 *     "repo/tests/evals/README.md states 10 in \"deterministic set of **10 cases**\",
 *      but the `cases` array ... yields 11."
 *     ".../61_FR-R3-061_behavioral_canaries.md states 10 in \"deterministic corpus of
 *      **10 cases**\", but the `cases` array ... yields 11."
 *   Each message names the document, the claim, and BOTH numbers, and says to
 *   correct the document rather than the producer.
 *
 * DOCUMENT SIDE — reworded the envelope claim to "**eleven cases**":
 *   red, naming the document and the claim it can no longer find. That is the
 *   stale-claim assertion firing rather than the comparison, which is correct:
 *   rewording a registered claim must be noticed, not silently re-scored, and it
 *   is the ONLY direction that fires when a document's own number is edited —
 *   `stated` is a constant here, so the comparison cannot see that edit.
 *
 * Restored tree: 13 passed.
 *
 * STANDALONE-CHECKOUT LEG: moved the envelope's `CLAUDE.md` and `docs/` aside to
 * simulate `repo/` cloned on its own. Before the `ENVELOPE_PRESENT` guard existed,
 * tests ERRORED with "does not exist in either repository", which would have failed
 * `verify:all` on every PR in this repository's own CI. After: 11 passed, 1 skipped
 * — and the envelope entry's PRODUCER comparison still ran, because that direction
 * iterates the whole registry rather than `CHECKABLE`. The direction that matters
 * is not skipped.
 *
 * The producer-side direction is the one that matters most. A gate that only caught
 * a perturbed document number would pass forever while the tree moved underneath
 * the claim — which is precisely how both slips this item fixes came to exist.
 */
const REPO = resolve(__dirname, '..', '..');
const ENVELOPE = resolve(REPO, '..');
const SWEEP = 'docs/operations/asserted-counts-sweep.md';

/**
 * True when `..` holds the planning envelope rather than an unrelated parent.
 *
 * `repo/` cloned on its own is a supported layout — CI checks out exactly that —
 * and there the parent directory is not the workspace at all. A registry entry
 * whose document lives in the envelope cannot be evaluated in that layout, and
 * throwing then would report the *environment* as a stale-claim failure a
 * contributor did not cause and cannot act on. So envelope-only entries are
 * skipped when the envelope is absent, and checked hard when it is there —
 * absent is not the same as unreadable. Same predicate as
 * `doc-duplicate-authority.test.ts` and `agents-claude-parity.test.ts`, for the
 * same reason.
 */
const ENVELOPE_PRESENT =
  existsSync(join(ENVELOPE, 'ARCHITECTURE.md')) &&
  existsSync(join(ENVELOPE, 'CLAUDE.md')) &&
  existsSync(join(ENVELOPE, 'docs'));

/**
 * True for a path this repository cannot resolve on its own.
 *
 * Registry paths are written from the workspace root, so a `repo/` prefix marks
 * a document inside this repository and its absence marks one in the envelope.
 */
function inEnvelopeOnly(relPath: string): boolean {
  return !relPath.startsWith('repo/');
}

/**
 * Resolve a path that may live in either repository of the workspace.
 *
 * The third candidate strips the `repo/` prefix, which is what makes a producer
 * inside this repository readable in a standalone checkout: without it, a path
 * written from the workspace root only ever resolves through the envelope.
 */
function readDocument(relPath: string): string {
  const candidates = [
    resolve(ENVELOPE, relPath),
    resolve(REPO, relPath),
    resolve(REPO, relPath.replace(/^repo\//, ''))
  ];
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error(
    `asserted-counts: ${relPath} does not exist in either repository. A registry entry cannot ` +
      'outlive its document: remove the entry, or fix the path.'
  );
}

/**
 * Lines a claim may be found on: prose and code, never an HTML comment.
 *
 * The comment exclusion is not decoration. Source-marker comments carry paths and
 * occasionally numbers, and a claim matched inside one would be checked in a
 * place no reader reads.
 */
function claimBearingLines(body: string): string[] {
  const kept: string[] = [];
  // A multi-line `<!-- ... -->` block hides its INTERIOR lines too. Matching a
  // claim inside one would report a withdrawn claim as live, which is the exact
  // failure this filter exists to prevent — a single-line test only proved the
  // easy half.
  let insideComment = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (insideComment) {
      if (line.includes('-->')) {
        insideComment = false;
      }
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) {
        insideComment = true;
      }
      continue;
    }
    if (line.length > 0) {
      kept.push(line);
    }
  }
  return kept;
}

interface CountEntry {
  /** Repository-relative path of the document making the claim. */
  readonly document: string;
  /** The claim, verbatim, as a substring of one claim-bearing line. */
  readonly claim: string;
  /** The number the claim states. */
  readonly stated: number;
  /** What settles it, named for a reader. */
  readonly producer: string;
  /** Derives the producer's count. Must be evaluable by a static read. */
  readonly derive: () => number;
  /** Why this is registered rather than cited. Every entry carries one. */
  readonly why: string;
}

/**
 * FR-R3-073 (feature 152) — the lease staleness window, in seconds.
 *
 * The recovery runbook tells an operator how long to wait before concluding a
 * lease's holder is gone; the review found it saying 30 while the code said 15,
 * doubling a wait made while a run is stuck. Derived from the constant's own
 * declaration line so the number cannot be transcribed twice.
 */
function leaseStalenessSeconds(): number {
  const body = readDocument('repo/src/state/lock.ts');
  const match = /export const STALENESS_THRESHOLD_MS = ([\d_]+);/.exec(body);
  if (!match) {
    throw new Error('asserted-counts: STALENESS_THRESHOLD_MS no longer declared in lock.ts');
  }
  return Number(match[1].replace(/_/g, '')) / 1000;
}

/**
 * FR-R3-073 (feature 152) — the VS Code engine floor's minor version.
 *
 * The developer-setup tutorial declared 1.85.0 while the manifest required
 * ^1.107.0 — a reader on 1.90 would install, then fail. The MINOR number is the
 * moving part (the major is pinned to 1.x by the caret), so that is what is
 * derived and what the claim states.
 */
function vscodeEngineFloorMinor(): number {
  const body = readDocument('repo/package.json');
  const parsed = JSON.parse(body) as { engines?: { vscode?: string } };
  const match = /^\^1\.(\d+)\.\d+$/.exec(parsed.engines?.vscode ?? '');
  if (!match) {
    throw new Error('asserted-counts: engines.vscode no longer a ^1.x.y range in package.json');
  }
  return Number(match[1]);
}

/** The corpus fixture. */
function corpusCases(): number {
  const body = readDocument('repo/tests/evals/fixtures/backend-outcomes.json');
  const parsed = JSON.parse(body) as { cases?: unknown[] };
  if (!Array.isArray(parsed.cases)) {
    throw new Error('asserted-counts: backend-outcomes.json no longer has a `cases` array');
  }
  return parsed.cases.length;
}

/*
 * WHY THE SAFE-FILESYSTEM "ELEVEN MODULES" CLAIM IS *NOT* REGISTERED.
 *
 * It was, briefly, and review was right to challenge it. That sentence is a
 * HISTORICAL FINDING — what the gate found when FR-R3-053 measured — and the
 * ledger it derives from "only shrinks" by that gate's own explicit rule. So the
 * first unrelated migration would have driven the derived value below eleven and
 * this gate would have demanded that a past finding be reduced to match today's
 * tree.
 *
 * That is falsification, and FR-R3-067's own rule forbids it: a recorded
 * observation is evidence, not a claim about now. The sentence is therefore DATED
 * in place ("measured 2026-08-24 against the ledger as it then stood, at sixteen
 * entries") and left out of the registry, exactly like the perimeter plan's
 * "643 files / 8,376 tests".
 *
 * Recorded here rather than silently omitted, because a reader comparing this
 * registry with the sweep will notice the row and wonder.
 */
const REGISTRY: readonly CountEntry[] = [
  /*
   * The corpus case count, in the two documents that state it descriptively.
   *
   * WHEN ONE OF THESE GOES RED, the fix is always the same: a case was added to or
   * removed from `backend-outcomes.json`, and the sentence has to follow it. Do not
   * re-bless the number by editing `stated` — that is the habit this item exists to
   * break — and do not edit the fixture to agree with the prose. Correct the
   * document, or withdraw the claim and remove its entry.
   *
   * Both entries share a producer deliberately. They are separate claims in
   * separate documents, and the pair is also what makes the per-entry scoping
   * assertion below non-vacuous: the two claim strings both contain `**10 cases**`,
   * so a gate that searched the tree for the number rather than reading the
   * document that makes each claim would score the wrong line.
   */
  {
    document: 'repo/tests/evals/README.md',
    claim: 'deterministic set of **10 cases**',
    stated: 10,
    producer: 'the `cases` array in repo/tests/evals/fixtures/backend-outcomes.json',
    derive: corpusCases,
    why:
      'REGISTERED because this is the number FR-R3-061 wrote the file to protect: the corpus measures ' +
      'parser coverage over ten recorded cases and must not be cited as behavioural qualification. A ' +
      'reader deciding what the suite proves needs the case count, so it is stated — and therefore has ' +
      'to be checked. The suite also asserts it against the same fixture; this gate is the static half, ' +
      'reachable without running the evals config.'
  },
  {
    document: 'docs/features/round_3/61_FR-R3-061_behavioral_canaries.md',
    claim: 'deterministic corpus of **10 cases**',
    stated: 10,
    producer: 'the `cases` array in repo/tests/evals/fixtures/backend-outcomes.json',
    derive: corpusCases,
    why:
      'REGISTERED because this document restates the count rather than citing it, and review found it ' +
      'was the only remaining transcription with nothing behind it: the item deliberately stopped ' +
      'transcribing the TEST TALLY for exactly this reason and then kept transcribing the CASE COUNT. ' +
      'Registering is the cheaper fix than rewording, because the sentence introduces the corpus and a ' +
      'reader of §1 wants its size. Envelope-only, so the claim side is skipped in a standalone ' +
      'checkout while the producer comparison still runs.'
  },
  {
    document: 'repo/docs/operations/recovery-checkpoints.md',
    claim: 'heartbeat goes stale (15 seconds',
    stated: 15,
    producer: 'STALENESS_THRESHOLD_MS in repo/src/state/lock.ts',
    derive: leaseStalenessSeconds,
    why:
      'REGISTERED because the runbook tells an operator how long to wait before concluding a stuck ' +
      "run's holder is gone, and the review found it saying 30 against a code value of 15 — the one " +
      'timing number in the corpus whose drift doubles a wait made under pressure (FR-R3-073). The ' +
      'sentence names its producer, and this entry is what fails when the constant moves.'
  },
  {
    document: 'repo/docs/tutorials/developer-setup.md',
    claim: 'VS Code 1.107.0 or newer',
    stated: 107,
    producer: 'engines.vscode in repo/package.json',
    derive: vscodeEngineFloorMinor,
    why:
      'REGISTERED because the tutorial declared a 1.85.0 floor while the manifest required ^1.107.0: ' +
      'a reader on an in-between version installs, then fails at activation with no pointer back to ' +
      'this line (FR-R3-073). The minor version is the moving part under the ^1 caret, so it is what ' +
      'is derived and what drifts when the engine floor is raised or lowered again.'
  }
];

/**
 * The entries whose document this checkout can actually read.
 *
 * In the full workspace that is every entry. In a standalone `repo/` clone it is
 * the ones inside this repository — the envelope-only claims are unreachable, and
 * an unreachable claim is not a failing one.
 */
const CHECKABLE: readonly CountEntry[] = ENVELOPE_PRESENT
  ? REGISTRY
  : REGISTRY.filter((entry) => !inEnvelopeOnly(entry.document));

/**
 * A dated measurement, registered NOWHERE, asserted here to stay that way.
 *
 * `00_verification_perimeter_plan.md` records "host 643 files / 8,376 tests" at a
 * named commit. That is evidence, not a claim about today, and rewriting it to
 * agree with the current tree would destroy it. The exclusion is by scope — the
 * registry is an allowlist — and this pins that nobody quietly added it.
 */
const DATED_MEASUREMENT = {
  document: 'docs/features/round_3/00_verification_perimeter_plan.md',
  // The whole measured phrase, not the bare digits. `'643'` alone would be
  // satisfied by any number containing them — `1,643 files` would pass while the
  // recorded observation had in fact been rewritten, which is exactly what this
  // assertion exists to catch.
  fragment: '643 files / 8,376 tests'
} as const;

describe('counts a document asserts are counts something checks (FR-R3-067)', () => {
  it('has at least one registered count, so this gate is not vacuous', () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
  });

  it.each(REGISTRY)('$document: $claim', (entry) => {
    const derived = entry.derive();
    expect(
      entry.stated,
      `${entry.document} states ${entry.stated} in "${entry.claim}", but ${entry.producer} yields ` +
        `${derived}. Correct the DOCUMENT, never the producer — a count is fixed by fixing the claim, ` +
        'not by editing the tree it describes.'
    ).toBe(derived);
  });

  it.each(CHECKABLE)('$document still contains its claim verbatim', (entry) => {
    // A stale entry cannot survive. If the sentence was reworded or removed, this
    // entry is checking a claim nobody makes any more.
    const lines = claimBearingLines(readDocument(entry.document));
    expect(
      lines.some((line) => line.includes(entry.claim)),
      `${entry.document} no longer contains "${entry.claim}". If the claim was withdrawn, remove this ` +
        'registry entry; if it was reworded, update the fragment so the entry points at something real.'
    ).toBe(true);
  });

  it.each(REGISTRY)('$document: the stated number appears in the claim itself', (entry) => {
    // Guards against an entry whose `stated` has drifted from the text it quotes,
    // which would make the comparison above check a number the document does not
    // actually say.
    const digits = entry.claim.replace(/\D+/g, ' ').trim().split(/\s+/).filter(Boolean);
    expect(
      digits.includes(String(entry.stated)) ||
        entry.claim.toLowerCase().includes(numberWord(entry.stated)),
      `entry for ${entry.document} says stated=${entry.stated}, but the claim text "${entry.claim}" ` +
        'contains neither that digit nor its word form'
    ).toBe(true);
  });

  it('requires a reason and an evaluable producer for every entry', () => {
    for (const entry of REGISTRY) {
      expect(entry.why.length, `${entry.document} needs a reason`).toBeGreaterThan(40);
      // Evaluable by a static read: calling it must not throw. A count that needs
      // a running suite belongs to that suite, not here.
      expect(() => entry.derive(), `${entry.producer} is not statically evaluable`).not.toThrow();
    }
  });

  it('is satisfied only by the document an entry names, not by a copy elsewhere', () => {
    // The claim strings in this registry appear VERBATIM in this feature's own
    // spec and plan, and near-verbatim in the source item that filed it. A gate
    // that searched the tree for a claim would match those quotations instead of
    // the real assertion. So the NEGATIVE direction is what makes scoping a
    // checked property rather than a happy accident: a claim must not be found in
    // a registered document that does not make it.
    for (const entry of CHECKABLE) {
      const others = CHECKABLE.filter((other) => other.document !== entry.document);
      for (const other of others) {
        expect(
          claimBearingLines(readDocument(other.document)).some((line) => line.includes(entry.claim)),
          `"${entry.claim}" was found in ${other.document}, which does not make that claim. Two ` +
            'entries sharing a claim string means the per-entry scoping no longer distinguishes them.'
        ).toBe(false);
      }
    }
  });

  /*
   * There was a third assertion here, and review removed it. It checked that
   * `67_FR-R3-067_….md` quotes the phrase "**eleven** modules the item does not
   * name", as a demonstration of why the scoping above is needed. That claim was
   * unregistered during this same item, so the assertion demonstrated nothing about
   * this registry while still going red whenever unrelated prose in a planning
   * document was reworded. The demonstration now comes from the registry itself:
   * two entries whose claims share `**10 cases**` in documents that make different
   * claims, which the negative direction above checks for real.
   */

  it('skips HTML-comment lines when looking for a claim', () => {
    // Not decoration. Source-marker comments carry paths and occasionally
    // numbers, and a claim matched inside one would be "checked" in a place no
    // reader reads. Asserted rather than left as a property of the filter.
    const lines = claimBearingLines(
      ['<!-- Source: package.json -->', 'a real prose line', '', '   <!-- 11 modules -->   '].join(
        '\n'
      )
    );
    expect(lines).toEqual(['a real prose line']);

    // And the interior of a MULTI-LINE comment, which the single-line form above
    // does not cover: a withdrawn claim left inside a commented-out draft would
    // otherwise still satisfy the verbatim check.
    expect(
      claimBearingLines(
        ['<!--', 'deterministic set of **10 cases**', '-->', 'the only prose line'].join('\n')
      )
    ).toEqual(['the only prose line']);
  });

  it('does not register a dated measurement', () => {
    // Recorded observations are evidence. The registry never touches one, and the
    // exclusion is by scope rather than by detection — so this asserts absence
    // from the registry, not the success of a rule.
    const registeredDocuments = new Set(REGISTRY.map((e) => e.document));
    expect(registeredDocuments.has(DATED_MEASUREMENT.document)).toBe(false);
  });

  it.skipIf(!ENVELOPE_PRESENT)('leaves the dated measurement it excludes unrewritten', () => {
    const body = readDocument(DATED_MEASUREMENT.document);
    expect(
      body.includes(DATED_MEASUREMENT.fragment),
      `${DATED_MEASUREMENT.document} no longer records its dated measurement. A recorded observation ` +
        'with a commit and a date is evidence; "correcting" it into agreement with today\'s tree is ' +
        'falsification, not maintenance.'
    ).toBe(true);
  });

  it('records what was examined, so the registry size is accountable', () => {
    // A registry a reader cannot account for looks arbitrary, and an arbitrary
    // allowlist is one nobody audits.
    expect(() => statSync(resolve(REPO, SWEEP))).not.toThrow();
    const sweep = readFileSync(resolve(REPO, SWEEP), 'utf8');
    for (const entry of REGISTRY) {
      expect(
        sweep.includes(entry.document),
        `${SWEEP} does not account for the registered claim in ${entry.document}`
      ).toBe(true);
    }
  });
});

/** Word forms this registry needs. Deliberately tiny — extend when an entry needs it. */
function numberWord(n: number): string {
  const words: Record<number, string> = {
    10: 'ten',
    11: 'eleven',
    12: 'twelve',
    13: 'thirteen',
    14: 'fourteen',
    15: 'fifteen',
    16: 'sixteen'
  };
  return words[n] ?? String(n);
}
