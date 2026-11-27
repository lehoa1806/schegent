// FR-R3-167 — the absent-field census must be a gate, not a snapshot.
//
// A dated document once counted every assertion in this suite that says a field
// is *not* there, cross-referenced each against the payload contracts, and
// published a verdict. The verdict was true on the day it was written and began
// decaying immediately, because nothing re-ran it. This gate is that method,
// executable: it re-derives the population and the corpus on every run, so the
// answer is never older than the tree.
//
// ---------------------------------------------------------------- the method
//
// Step 1 — find the population. Five assertion shapes say "absent". By hand,
// run from `repo/`:
//
//     A   grep -rn "not\.toHaveProperty(" tests/ webview-ui/src/
//     B1  grep -rnE '\.[a-zA-Z_][a-zA-Z0-9_]*\)\.toBeUndefined\(\)' tests/ webview-ui/src/
//     B2  grep -rnE '\.[a-zA-Z_][a-zA-Z0-9_]*\)\.toBe\(undefined\)' tests/ webview-ui/src/
//     B3  grep -rnE '\.[a-zA-Z_][a-zA-Z0-9_]*\)\.toBeNull\(\)' tests/ webview-ui/src/
//     B4  grep -rnE '\.[a-zA-Z_][a-zA-Z0-9_]*\)\.toBe\(null\)' tests/ webview-ui/src/
//
// Both roots, because the discovered corpus includes `sidebar-ipc*.md`, which
// governs exactly the host/webview boundary the second suite tests. Reading
// `tests/` alone would make a claim about a contract while blind to half the
// code that contract binds.
//
// Those five commands are documentation for a human and nothing else. This gate
// spawns no binary: it walks the tree with Node `fs`, through
// `runCensus` -> `scanTestCorpus` -> `filesUnder` in `tests/lint/source-scan.ts`.
// A grep line count and this gate's assertion count are not the same number, and
// the coverage block below reconciles them rather than picking one. Two of the
// differences are deliberate widenings, both reported in that block: this gate
// reads an assertion prettier wrapped across a newline, which no line-oriented
// search can see, and it reads the two-argument `expect(value, message)` form.
//
// Step 2 — find the corpus. A payload-defining contract is any markdown file
// whose basename matches `audit-events*.md`, `sidebar-ipc*.md`,
// `state-schema*.md` or `audit-payload-delta*.md`, under `repo/docs/` always and
// under the planning envelope's `specs/` when an envelope is above `repo/`.
//
// Step 3 — classify, in three reads, each of which narrows:
//
//   1. Name cross-reference. An assertion becomes a *candidate* when its literal
//      field name is one the contracts quote in backticks. The match is on the
//      field's NAME, never on its value — `docs/hard-rules.md` rule 67, and the
//      reason a value search would prove nothing about a single resolution site.
//   2. Conditionality. A candidate becomes a *finding* only if some contract
//      declares the name with no conditionality marker. A nullable union
//      member, an optional-property marker, or a conditional-presence
//      annotation in English has already said the field may be absent; a test
//      asserting it absent agrees with the contract rather than contradicting it.
//   3. Receiver. Whether the object under assertion is the record type the
//      contract governs is a human read. Its outcome is recorded as a dated
//      comment next to the assertion, and that note is what this gate requires.
//
// ------------------------------------------------- what this gate cannot say
//
// Stated as limitations of its own answer, not left for a reader to find out:
//
//   - Receivers. `runId` on a queue item is not `runId` on an audit event, and
//     no amount of scanning settles which one a line is reading. That judgement
//     is human; the adjacent dated note is where it is written down, and a note
//     is accepted on its face.
//   - Dynamic keys. An assertion whose field name is computed rather than
//     literal is unresolvable by this method. Those rows are reported with that
//     reason, never presumed clean and never dropped.
//   - Non-identifier literals. `'9bad'`, `'has-dash'`: written out in full, so
//     nothing about them is dynamic, but no contract declares a field under a
//     name that is not a JavaScript identifier. Reported as their own kind,
//     because calling them dynamic misdescribes what a reader would find there.
//   - An `expect(value, message)` whose message contains a parenthesis. The
//     message is read up to the first paren of either sort, so that one assertion
//     is invisible to this gate rather than merely unclassifiable. Bounding it
//     that way is what stops the pattern reaching across a call boundary and
//     pairing a property access with some distant matcher.
//   - Contract breadth. The corpus is the four basename patterns above. A
//     payload contract published under some other name is outside this gate's
//     reach, and widening the set here would answer a different question each
//     release.
//   - Conditionality in prose. The English phrase list is a heuristic. It is
//     pinned by unit tests and kept narrow on purpose: widening it is how this
//     gate would go quiet.
//
// The gate enforces one rule and no other: a contract-governed absence needs an
// adjacent dated decision note. It does not judge whether asserting an absence
// was a good idea.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  type Classification,
  type ConditionalityShape,
  type ContractDocument,
  type CorpusScope,
  EXCLUDED_FROM_POPULATION,
  type Finding,
  PATTERN_FAMILIES,
  classify,
  clip,
  formatCoverage,
  formatFindings,
  locateDeclaration,
  readContract,
  resolveScope,
  runCensus,
  scanSource,
} from './absent-field-census';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (relative: string): string => readFileSync(resolve(REPO_ROOT, relative), 'utf8');

const SCOPE = resolveScope();
const CENSUS = runCensus(SCOPE);

// FR-017: emitted on every run, passing or failing, in one deterministic block.
// A pass that says nothing about its reach is the snapshot failure with a green tick.
console.log(formatCoverage(CENSUS.report));

/** The gate's whole rule, in one function. `note === null` is the failure. */
function unNotedFindings(classification: Classification): readonly Finding[] {
  return classification.findings.filter((finding) => finding.note === null);
}

// ------------------------------------------------------------------ the plant
//
// A finding manufactured on purpose, so the gate's own rule can be watched
// rejecting one. Entirely in memory: no file is written and the real tree is
// never mutated, because a control that edits the corpus it is controlling can
// fail in a way that leaves the corpus edited.
//
// `plantedField` is invented. Every fixture name in this feature is, and for a
// reason worth stating once: the scanner does not blank string literals, so a
// real contract field name quoted in a fixture here would enter the population
// as a genuine assertion and manufacture a finding somewhere else.

/**
 * Fixture locations are written as segments joined at run time, never as one
 * path literal. They name places inside a temporary directory or a synthetic
 * `FileScan`, not paths in this repository, and `lint-anchor-grounding.test.ts`
 * is right to read a `tests/...` literal inside a lint as a claim that the path
 * exists. The other temp-root gates in this directory keep their fixtures to
 * bare basenames for the same reason; these need a repo-shaped layout because
 * the scope resolver derives `<root>/tests` and `<root>/docs` from the root.
 */
const at = (...segments: readonly string[]): string => segments.join('/');

const PLANT_FILE = at('tests', 'unit', 'planted.test.ts');
const PLANT_CONTRACT_PATH = 'docs/reference/audit-events.md';

const PLANT_CONTRACT = [
  '| Field | Type | Notes |',
  '|-------|------|-------|',
  '| `plantedField` | string | Always present on every event. |',
].join('\n');

const PLANTED_ASSERTION = "    expect(payload).not.toHaveProperty('plantedField');";

const DATED_NOTE = '// 2026-09-06 coincidental: a planted fixture, not the record the contract governs';

function plantAgainst(contract: ContractDocument, assertionLine: string): Classification {
  const source = [
    "describe('planted', () => {",
    "  it('asserts a planted absence', () => {",
    assertionLine,
    '  });',
    '});',
  ].join('\n');

  return classify(
    [scanSource(PLANT_FILE, source)],
    [contract],
    (file) => (file === PLANT_FILE ? source.split('\n') : [])
  );
}

const plant = (assertionLine: string): Classification =>
  plantAgainst(readContract(PLANT_CONTRACT_PATH, 'repo-docs', PLANT_CONTRACT), assertionLine);

// ------------------------------------------------------------- synthetic roots
//
// The derivation and standalone-clone proofs need real directories, because what
// they prove is that the corpora are walked rather than listed. They are built
// under the OS temp directory and removed afterwards; the real tree is never
// touched by either.

const scratchDirs: string[] = [];

function syntheticRoot(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `absent-field-${name}-`));
  scratchDirs.push(dir);
  return dir;
}

function writeAt(root: string, relativePath: string, body: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
}

/** A synthetic repository has no planning envelope above it, which is the standalone-clone shape. */
const scopeFor = (root: string): CorpusScope => resolveScope(root, dirname(root));

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('FR-R3-167 — a contract-governed absence needs an adjacent dated decision note', () => {
  it('finds none without one on this tree', () => {
    // `formatFindings` rather than the raw rows: an empty array is the assertion,
    // and a failure prints the file, the line, the declaration that decided it
    // and the two ways out, so acting on it needs nothing re-derived.
    expect(formatFindings(unNotedFindings(CENSUS.classification))).toEqual([]);
  });

  it('reports findings sorted by file then line', () => {
    const keys = CENSUS.classification.findings.map((finding) => ({
      file: finding.assertion.file,
      line: finding.assertion.line,
    }));
    const sorted = [...keys].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

    expect(sorted).toEqual(keys);
  });

  it('carries everything needed to act in the failure message', () => {
    const message = formatFindings(unNotedFindings(plant(PLANTED_ASSERTION)))[0] ?? '';

    expect(message).toContain(`${PLANT_FILE}:3  field \`plantedField\``);
    expect(message).toContain("  asserted absent: expect(payload).not.toHaveProperty('plantedField');");
    expect(message).toContain(`  declared by:     ${PLANT_CONTRACT_PATH}:3 — | \`plantedField\` |`);
    expect(message).toContain('  no adjacent dated decision note');
    expect(message).toContain('If the receiver here is a different record type, say so in a note on the line:');
    expect(message).toContain('If the divergence is deliberate, say that instead, with the date it was decided.');
  });
});

describe('negative control — the rule rejects an un-noted finding', () => {
  it('reports a planted contract-governed absence with no adjacent dated note', () => {
    const planted = plant(PLANTED_ASSERTION);

    expect(planted.findings).toHaveLength(1);
    expect(planted.findings[0]?.assertion.fieldName).toBe('plantedField');
    expect(unNotedFindings(planted)).toHaveLength(1);
  });

  it('accepts the same plant once it carries a dated note', () => {
    const planted = plant(`${PLANTED_ASSERTION} ${DATED_NOTE}`);

    expect(planted.findings).toHaveLength(1);
    expect(unNotedFindings(planted)).toEqual([]);
  });

  it('rejects an adjacent comment that carries no date', () => {
    const planted = plant(`${PLANTED_ASSERTION} // coincidental: a planted fixture`);

    expect(planted.findings).toHaveLength(1);
    expect(unNotedFindings(planted)).toHaveLength(1);
  });
});

describe('the gate is not in its own population', () => {
  it('excludes both of its own modules by path', () => {
    const scanned = new Set(CENSUS.scans.map((scan) => scan.file));
    const leaked = EXCLUDED_FROM_POPULATION.filter((file) => scanned.has(file));

    expect(leaked).toEqual([]);
  });

  it('excludes them for a reason — scanned, this file would contribute assertions', () => {
    // The plants above and the five verbatim patterns in the header are exactly
    // what FR-016 exists to keep out of the count. If the exclusion ever became
    // a no-op this assertion says what it would cost.
    const self = EXCLUDED_FROM_POPULATION[1] ?? '';
    expect(self).toBe('tests/lint/absent-field-census.test.ts');
    expect(scanSource(self, read(self)).assertions.length).toBeGreaterThan(0);
  });
});

describe('conditionality — a contract that permits the absence is not contradicted', () => {
  /** The published reference is reachable in a standalone clone too, so this control always runs. */
  it('reads the optional marker on a real field of the published reference', () => {
    const contract = readContract(PLANT_CONTRACT_PATH, 'repo-docs', read(PLANT_CONTRACT_PATH));
    const declaration = locateDeclaration(contract, 'schemaVersion');

    expect(declaration.kind).toBe('found');
    expect(declaration.kind === 'found' ? declaration.conditionality : []).toContain('optional-marker');

    const planted = plantAgainst(contract, "    expect(payload).not.toHaveProperty('schemaVersion');");
    expect(planted.findings).toEqual([]);
    expect(planted.ordinary).toHaveLength(1);
  });

  /**
   * One control per shape, with the example found in the discovered corpus rather
   * than remembered: a shape nothing declares any more is a shape this gate has
   * stopped being able to read.
   */
  const SHAPES: readonly ConditionalityShape[] = ['nullable-union', 'optional-marker', 'conditional-annotation'];

  const exampleOf = (shape: ConditionalityShape): { contract: ContractDocument; field: string } | null => {
    for (const contract of CENSUS.contracts) {
      for (const name of [...contract.quotedNames].sort()) {
        const declaration = locateDeclaration(contract, name);
        if (declaration.kind === 'found' && declaration.conditionality.includes(shape)) {
          return { contract, field: name };
        }
      }
    }
    return null;
  };

  // The nullable-union example on this tree lives in an envelope contract, so with
  // no planning envelope above `repo/` there is nothing to read it from.
  it.skipIf(SCOPE.envelopeSpecsRoot === null)(
    'exempts a planted assertion under every conditionality shape the corpus declares',
    () => {
      const missing = SHAPES.filter((shape) => exampleOf(shape) === null);
      expect(missing).toEqual([]);

      const contradicted: string[] = [];
      for (const shape of SHAPES) {
        const example = exampleOf(shape);
        if (example === null) continue;
        const planted = plantAgainst(
          example.contract,
          `    expect(payload).not.toHaveProperty('${example.field}');`
        );
        // Clipped like every other corpus echo. A quoted name is bounded by the
        // identifier pattern that harvested it, so this is consistency rather
        // than a repair — but "bounded elsewhere" is the argument that stops
        // being true when the elsewhere changes.
        if (planted.findings.length > 0) {
          contradicted.push(`${shape}: ${example.contract.path} \`${clip(example.field)}\``);
        }
      }

      expect(contradicted).toEqual([]);
    }
  );
});

describe('coverage — the gate cannot report green over nothing', () => {
  // Floors, deliberately far below the real figures and never equal to one. A
  // transcribed count would have to be re-transcribed on every ordinary change,
  // which is how a check becomes a chore and then a rubber stamp. These catch a
  // scan root that broke, and nothing else.
  const MIN_TEST_FILES = 100;
  const MIN_ASSERTIONS = 100;
  const MIN_CONTRACT_DOCUMENTS = 1;

  it('scanned a corpus rather than an empty tree', () => {
    expect(CENSUS.report.testFilesScanned).toBeGreaterThan(MIN_TEST_FILES);
    expect(CENSUS.report.totalAssertions).toBeGreaterThan(MIN_ASSERTIONS);
    expect(CENSUS.report.contractDocuments).toBeGreaterThanOrEqual(MIN_CONTRACT_DOCUMENTS);
    expect(CENSUS.contracts.map((contract) => contract.path)).toContain('docs/reference/audit-events.md');
  });

  it('finished the scan on every file it counted', () => {
    // The blanker gives each file a bounded allowance of sub-scan work, because a
    // file of `` `${ `` or of `='` costs it quadratic time otherwise and there is
    // nothing above `runCensus()` to stop it: the gate would report nothing at all
    // rather than report the file. A file that exhausts the allowance is counted
    // in `testFilesScanned` and contributes nothing else, so without this the
    // population could go quietly short by a whole file's assertions.
    //
    // Zero today. When it is not zero, the file is named and the allowance is the
    // thing to look at — not the count, and not this assertion.
    expect(CENSUS.report.unscannableFiles.map((row) => `${row.file} — ${row.reason}`)).toEqual([]);
  });

  it('read the webview suite too, when the repository carries one', () => {
    // A second population root, and the floor above cannot tell whether it was
    // read: `repo/tests` alone clears it several times over. `sidebar-ipc*.md`
    // is in the corpus, so a census blind to `webview-ui/src` would be making a
    // claim about a contract while unable to see half the code it binds.
    if (SCOPE.webviewTestsRoot === null) return;

    const fromWebview = CENSUS.scans.filter((scan) => scan.file.startsWith('webview-ui/'));
    expect(fromWebview.length).toBeGreaterThan(0);
  });

  it.skipIf(SCOPE.envelopeSpecsRoot === null)('reads the envelope corpus, not the published reference alone', () => {
    // The floors above are the standalone-clone floors: with the envelope gone
    // this tree still reports one contract and hundreds of assertions, and every
    // one of them passes. So they say nothing about whether the envelope was
    // read. When it is present, say what its presence is worth.
    const envelopeSited = CENSUS.contracts.filter((contract) => contract.root === 'envelope-specs');
    expect(envelopeSited.length).toBeGreaterThan(0);
    expect(CENSUS.report.contractDocuments).toBeGreaterThan(envelopeSited.length);
    // A corpus that grew past the published reference must actually reach further
    // into the population, or the extra documents are decoration.
    expect(CENSUS.report.candidates).toBeGreaterThan(0);
  });

  it('still matches every pattern family', () => {
    // The telemetry-gate regression in the round-3 record: two assertions went
    // vacuous and the suite stayed green, because nothing asked whether the
    // pattern still matched anything.
    //
    // Liveness is proven against a fixture rather than against the tree. Two of
    // the five families have a single-digit population here, so a real-tree
    // non-zero assertion is one ordinary deletion away from red — and the repair
    // for that red would be to plant an assertion nobody wanted, or to delete
    // the check. The fixture cannot be deleted out from under the pattern.
    const fixture = [
      "expect(payload).not.toHaveProperty('alphaField');",
      'expect(record.betaField).toBeUndefined();',
      'expect(record.gammaField).toBe(undefined);',
      'expect(record.deltaField).toBeNull();',
      'expect(record.epsilonField).toBe(null);',
    ].join('\n');
    const scan = scanSource(at('tests', 'unit', 'fixture.test.ts'), fixture);
    const unmatched = PATTERN_FAMILIES.filter(
      (family) => !scan.assertions.some((assertion) => assertion.family === family)
    );
    expect(unmatched).toEqual([]);

    // On the real tree, the self-calibrating half: a family that matched code
    // lines but produced no assertion has lost its capture, not its population.
    const codeWithoutAssertions = PATTERN_FAMILIES.filter(
      (family) => CENSUS.report.codeLinesByFamily[family] > 0 && CENSUS.report.assertionsByFamily[family] === 0
    );
    expect(codeWithoutAssertions).toEqual([]);

    // And the population as a whole is non-trivial, without pinning any one family.
    const live = PATTERN_FAMILIES.filter((family) => CENSUS.report.assertionsByFamily[family] > 0);
    expect(live.length).toBeGreaterThanOrEqual(3);
  });

  it('reads assertions no line-oriented search can see', () => {
    // The widening that justifies itself: prettier wraps an assertion the moment
    // it crosses the print width, and a census whose answer changes when a file
    // is reformatted is exactly the decay this feature exists to end. Proven
    // against a fixture, then reported for the real tree in the coverage block.
    const wrapped = ['expect(', '  record.wrappedField', ').toBeNull();'].join('\n');
    const scan = scanSource(at('tests', 'unit', 'fixture.test.ts'), wrapped);

    expect(scan.assertions.map((assertion) => assertion.fieldName)).toEqual(['wrappedField']);
    expect(scan.assertions[0]?.spansLines).toBe(true);
    expect(scan.spanningByFamily.B3).toBe(1);
    // Invisible to every one of the five published `grep` commands.
    expect(scan.linesByFamily.B3).toBe(0);
    expect(scan.invisibleByFamily.B3).toBe(1);
  });

  it('does not call a wrapped family A assertion invisible, because it is not', () => {
    // A wrap and an invisibility are two different things, and reporting the
    // first as the second overstated the gate's reach by three of thirteen.
    // Family A's pattern stops at the opening paren and its capture may close
    // empty, so the first line matches on its own and `grep` prints it. Only the
    // B families begin at the property access, which a wrap moves onto a line
    // that matches nothing. Nothing pinned the A case, which is how the wrong
    // generalisation survived into the printed register and the published page.
    const wrapped = ['expect(payload).not.toHaveProperty(', "  'alphaField'", ');'].join('\n');
    const scan = scanSource(at('tests', 'unit', 'fixture.test.ts'), wrapped);

    expect(scan.assertions.map((assertion) => assertion.fieldName)).toEqual(['alphaField']);
    expect(scan.assertions[0]?.spansLines).toBe(true);
    expect(scan.spanningByFamily.A).toBe(1);
    expect(scan.linesByFamily.A).toBe(1);
    expect(scan.invisibleByFamily.A).toBe(0);
  });

  it('reconciles every discovered assertion into exactly one disposition', () => {
    const report = CENSUS.report;

    expect(report.ordinary + report.findings + report.unclassifiable.length).toBe(report.totalAssertions);
    expect(report.candidates).toBeGreaterThanOrEqual(report.findings);
    expect(report.findings).toBeGreaterThanOrEqual(report.findingsWithNote);
  });

  it('names a reason for every unclassifiable row', () => {
    // An unclassifiable row does not fail the gate. Making it fail would push a
    // maintainer to delete the row rather than say why it is unresolvable, and
    // losing the row is the loss this feature exists to prevent.
    const silent = CENSUS.report.unclassifiable.filter((row) => row.reason.trim() === '');
    expect(silent).toEqual([]);
  });

  it('accounts for the difference between discovered lines and assertions', () => {
    const report = CENSUS.report;

    const unaccounted = PATTERN_FAMILIES.filter(
      (family) =>
        report.linesByFamily[family] !== report.codeLinesByFamily[family] + report.commentLinesByFamily[family]
    );
    expect(unaccounted).toEqual([]);

    const belowItsLines = PATTERN_FAMILIES.filter(
      (family) => report.assertionsByFamily[family] < report.codeLinesByFamily[family]
    );
    expect(belowItsLines).toEqual([]);

    // The accounting is exercised rather than merely true: some discovered lines
    // on this tree really are comment-sited, so the two counts really do differ.
    const inComments = PATTERN_FAMILIES.reduce((sum, family) => sum + report.commentLinesByFamily[family], 0);
    expect(inComments).toBeGreaterThan(0);
  });
});

describe('derivation — both corpora are walked, not listed', () => {
  const FIXTURE_CONTRACTS: readonly { readonly path: string; readonly body: string }[] = [
    {
      path: 'docs/reference/audit-events.md',
      body: ['| Field | Type | Notes |', '|---|---|---|', '| `alphaField` | string | Always present. |'].join('\n'),
    },
    {
      path: 'docs/reference/state-schema.md',
      body: ['| Field | Type | Notes |', '|---|---|---|', '| `betaField` | number | Always present. |'].join('\n'),
    },
  ];

  const FIXTURE_TEST = [
    "describe('fixture', () => {",
    "  it('asserts', () => {",
    "    expect(record).not.toHaveProperty('alphaField'); // 2026-09-06 coincidental: a synthetic fixture",
    '  });',
    '});',
  ].join('\n');

  it('changes the reported contract count when one discovered contract is removed', () => {
    const root = syntheticRoot('contracts');
    for (const contract of FIXTURE_CONTRACTS) writeAt(root, contract.path, contract.body);
    writeAt(root, at('tests', 'unit', 'fixture.test.ts'), FIXTURE_TEST);

    const before = runCensus(scopeFor(root));
    expect(before.report.contractDocuments).toBe(FIXTURE_CONTRACTS.length);

    rmSync(join(root, FIXTURE_CONTRACTS[1]?.path ?? ''));
    const after = runCensus(scopeFor(root));

    expect(after.report.contractDocuments).toBe(FIXTURE_CONTRACTS.length - 1);
    expect(after.contracts.map((contract) => contract.path)).toEqual([FIXTURE_CONTRACTS[0]?.path]);
  });

  it('changes the reported assertion count when a test file appears in a new directory', () => {
    const root = syntheticRoot('population');
    for (const contract of FIXTURE_CONTRACTS) writeAt(root, contract.path, contract.body);
    writeAt(root, at('tests', 'unit', 'fixture.test.ts'), FIXTURE_TEST);

    const before = runCensus(scopeFor(root));

    writeAt(
      root,
      at('tests', 'newly-added', 'second.test.ts'),
      "it('asserts', () => { expect(record).not.toHaveProperty('gammaField'); });"
    );
    const after = runCensus(scopeFor(root));

    expect(after.report.testFilesScanned).toBe(before.report.testFilesScanned + 1);
    expect(after.report.totalAssertions).toBe(before.report.totalAssertions + 1);
  });
});

describe('a standalone clone', () => {
  it('says which root it read and why the other is missing, and still passes', () => {
    const root = syntheticRoot('standalone');
    writeAt(
      root,
      'docs/reference/audit-events.md',
      ['| Field | Type | Notes |', '|---|---|---|', '| `alphaField` | string, optional | Sometimes present. |'].join(
        '\n'
      )
    );
    writeAt(
      root,
      at('tests', 'unit', 'fixture.test.ts'),
      "it('asserts', () => { expect(record).not.toHaveProperty('alphaField'); });"
    );

    const scope = scopeFor(root);
    expect(scope.envelopeSpecsRoot).toBeNull();
    expect(scope.envelopeAbsentReason).not.toBeNull();

    const standalone = runCensus(scope);
    const block = formatCoverage(standalone.report);

    expect(block).toContain('contracts read  : repo/docs only — no planning envelope:');
    expect(block).toContain('no ARCHITECTURE.md, CLAUDE.md and docs/ at the parent');
    expect(standalone.report.contractDocuments).toBeGreaterThan(0);
    expect(unNotedFindings(standalone.classification)).toEqual([]);
  });
});
