import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  matchesAbsentAsSuccess,
  matchesUncheckedCast,
  readRoutes
} from './sidebar-answer-handling';
import { linesMatching } from './source-scan';

/**
 * FR-R3-163 (feature 202) — the sidebar command routes read the host's answer
 * before they acknowledge it.
 *
 * Two shapes are forbidden, and they are forbidden for different reasons.
 * Shape A defaults a possibly-absent answer to a literal asserting success:
 * `undefined` has a known cause — Workspace Trust refused and the handler never
 * ran — so acknowledging it as success reports a mutation that did not occur.
 * Shape B asserts the answer's shape at a boundary the host does not control:
 * the value crossed a VS Code command boundary as `unknown`, and an assertion
 * tells the compiler a fact nobody verified.
 *
 * WHAT THIS GATE DELIBERATELY DOES NOT EXAMINE (FR-018), carried verbatim from
 * `specs/202-cancel-ack-outcomes/data-model.md` §3:
 *
 * > This gate examines every `.ts` file directly under
 * > `src/ui/sidebar/commands/` — the 55 routes and the nine support modules
 * > beside them, `handler-helpers.ts` and `index.ts` included — and only the two
 * > shapes named above. The support modules are IN scope deliberately: a
 * > forbidden shape in the shared helper would put every one of its callers into
 * > the defect at once, and a file excluded by name is a second place for the
 * > shape to hide (rule 67, docs/hard-rules.md:860-862). The scan is non-recursive, so a
 * > future subdirectory does not silently enlarge the population.
 * >
 * > It does not examine `src/contracts/command-outcome.ts`, where the *correct*
 * > answer-reading lives — `normalizeCommandResult` at `:129` — which is outside
 * > the scanned directory; it does not examine assertions to named types such as
 * > `as CommandHandler` in `index.ts`, which are declared contracts a reader can
 * > follow; it does not examine nullish-coalescing defaults whose right-hand side
 * > does not assert success; and it does not examine whether a route that reads
 * > its answer correctly then chose the semantically right outcome — that is
 * > FR-R3-154's question, not this gate's.
 * >
 * > Its census half is scoped differently and on purpose: that one filters to
 * > `cmd-*.ts`, because its population is the 55 handler FILES, not every module
 * > in the directory.
 *
 * CORRECTED 2026-09-05 (T038). This paragraph previously claimed the gate
 * examined "only the sidebar command routes" and did "not examine
 * `handler-helpers.ts`". Both halves were wrong about the scope actually walked:
 * `readRoutes` returns every `.ts` file directly under the root. The gate was
 * green either way, because no support module carries either shape — which is
 * precisely the failure FR-018 exists to prevent, a true green underneath a
 * description of a scope nobody had re-read. Fixed by correcting the sentence
 * rather than narrowing the scan, because the narrower scan is the weaker gate.
 *
 * BOTH TERMS MATCH FILE CONTENT, COMMENTS INCLUDED. A route whose module header
 * spelled out one of the shapes in prose — to explain what it deliberately does
 * not do — would be reported by this gate even though its code is correct. That
 * is not hypothetical: it is finding F27, where `rg -l ackGenericResult` counted
 * eighteen callers because one route's header discusses the helper it does not
 * call, and it happened again while the two fixtures below were being written.
 * The remedy is to rewrite the prose so it describes the shape without quoting
 * it, exactly as those fixtures now do. It is NOT to add an exemption: an
 * exemption list is a second place for a route to hide (rule 67,
 * docs/hard-rules.md:860-862).
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const HANDLERS_DIR = resolve(REPO_ROOT, 'src', 'ui', 'sidebar', 'commands');
const HANDLERS_INDEX = resolve(HANDLERS_DIR, 'index.ts');
const FIXTURES_DIR = resolve(__dirname, 'fixtures');

/**
 * The floor below which a "no violations" result means nothing.
 *
 * Required rather than stylistic. `scanning-gates-prove-they-scanned.test.ts`
 * fails any gate that matches its `SCANS` and `ASSERTS_EMPTY` forms without also
 * matching `PROVES_NON_EMPTY`, and its exemption set is empty BY DESIGN — there
 * is no entry to add. 64 `.ts` files sit in the handlers directory today (55
 * routes plus nine support modules), so 50 leaves room for ordinary churn while
 * still catching the failure this exists for: a renamed or mistyped directory,
 * which `filesUnder` reports as an empty scan rather than as an error, turning
 * every assertion below vacuously green (FR-019, finding F38).
 */
const MIN_ROUTES = 50;

/**
 * The ONE shared enumeration (FR-031). Both cases and the census read this same
 * list, so there is no second population that could disagree with the first.
 */
const routes = readRoutes(HANDLERS_DIR);

const violating = (pick: (reading: (typeof routes)[number]) => boolean): readonly string[] =>
  routes.filter(pick).map((reading) => reading.file);

describe('FR-R3-163 — sidebar routes do not read an absent answer as success', () => {
  it('scanned a non-trivial route population', () => {
    expect(
      routes.length,
      `only ${routes.length} files were scanned under ${HANDLERS_DIR}. Below ${MIN_ROUTES} the ` +
        'emptiness assertions in this file prove nothing — check the directory still exists ' +
        'and still holds the routes.'
    ).toBeGreaterThan(MIN_ROUTES);
  });

  it('CASE A: no route defaults an absent host answer to success', () => {
    const violations = violating((reading) => reading.absentAsSuccess);
    expect(
      violations,
      `these routes default an absent host answer to a literal asserting success:\n  ${violations.join(
        '\n  '
      )}\nAn absent answer means Workspace Trust refused and the handler never ran, so this ` +
        'acknowledges a mutation that did not happen. Route the call through `execAndAck` in ' +
        '`handler-helpers.ts`, which reads the answer with `normalizeCommandResult`.'
    ).toEqual([]);
  });

  it('CASE B: no route asserts the host answer into shape with a cast', () => {
    const violations = violating((reading) => reading.uncheckedCast);
    expect(
      violations,
      `these routes assert the host's answer into shape rather than narrowing it:\n  ${violations.join(
        '\n  '
      )}\nThe value crossed the VS Code command boundary as \`unknown\`; the cast tells the ` +
        'compiler a fact nobody verified. Use `execAndAck` in `handler-helpers.ts`.'
    ).toEqual([]);
  });
});

describe('FR-R3-163 — the route census agrees from two independent sources', () => {
  /**
   * Two sources, and the assertion is a SET DIFFERENCE IN BOTH DIRECTIONS rather
   * than two totals. `55 === 55` is satisfied by two lists that disagree about
   * five members each, which is the failure this shape exists to make impossible
   * (FR-033, SC-017, contracts/handler-census.md C1-C2).
   *
   * THE UNIT IS THE FILE. Source 1 counts files named `cmd-*.ts`; source 2 counts
   * the distinct module specifiers `index.ts` imports. Both are file counts, so
   * they are comparable.
   *
   * REGISTERED ROUTES: 60 — recorded here under its own label, and asserted
   * NOWHERE. It is a different unit from the 55 above: 54 files export one
   * handler each and `cmd-catalog-lifecycle.ts` exports six, imported at
   * `src/ui/sidebar/commands/index.ts:108-114`. Labelling either figure with the
   * other's name is finding
   * F37, which this feature's own first draft got wrong. A count with two owners
   * disagrees with itself eventually, and removing that pattern is the other half
   * of this feature — so the figure is recorded for a reader and left out of
   * every assertion (FR-029, FR-033, SC-013, contracts/handler-census.md C3).
   */
  const onDisk = routes
    .filter((reading) => reading.file.startsWith('cmd-'))
    .map((reading) => reading.file.replace(/\.ts$/, ''));

  const imported = [
    ...new Set(
      linesMatching(HANDLERS_INDEX, String.raw`from '\./cmd-`)
        .map((match) => /from '\.\/(cmd-[a-z0-9-]+)'/.exec(match.text)?.[1])
        .filter((specifier): specifier is string => specifier !== undefined)
    )
  ];

  it('both sources are populated, so the differences below mean something', () => {
    // MEASURED, not anticipated. The T017 demonstration pointed the scan root at
    // an empty directory and the two set-difference assertions below BOTH went
    // green — because `index.ts` is resolved relative to that same root, so one
    // wrong root empties both "independent" sources at once and every difference
    // is trivially empty. The floor in the first block caught it; this one makes
    // the census stand on its own, rather than on a floor two describes away.
    //
    // These are floors, not cardinalities: the property under test is still set
    // equality, asserted below as an empty difference in each direction. Nothing
    // here says how many routes there should be (constraint C3).
    expect(onDisk.length, 'no cmd-*.ts files were scanned').toBeGreaterThan(MIN_ROUTES);
    expect(imported.length, `no cmd- imports found in ${HANDLERS_INDEX}`).toBeGreaterThan(
      MIN_ROUTES
    );
  });

  it('every route file on disk is imported by index.ts', () => {
    const onDiskNotImported = onDisk.filter((name) => !imported.includes(name)).sort();
    expect(
      onDiskNotImported,
      `these route files exist but nothing imports them:\n  ${onDiskNotImported.join('\n  ')}\n` +
        'An unimported route is dead code, or a route the sidebar can no longer reach.'
    ).toEqual([]);
  });

  it('every route index.ts imports exists on disk', () => {
    const importedNotOnDisk = imported.filter((name) => !onDisk.includes(name)).sort();
    expect(
      importedNotOnDisk,
      `index.ts imports these, and no such file was scanned:\n  ${importedNotOnDisk.join(
        '\n  '
      )}\nEither the scan missed them or the import is stale.`
    ).toEqual([]);
  });
});

describe('FR-R3-163 — the fixtures show each term still matches its own shape', () => {
  const fixtures = readRoutes(FIXTURES_DIR);
  const reading = (name: string): unknown => fixtures.find((entry) => entry.file === name);

  it('shape A matches the shape-A fixture and NOT the shape-B one', () => {
    expect(reading('absent-answer-as-success.fixture.ts')).toEqual({
      file: 'absent-answer-as-success.fixture.ts',
      absentAsSuccess: true,
      uncheckedCast: false
    });
  });

  it('shape B matches the shape-B fixture and NOT the shape-A one', () => {
    expect(reading('unchecked-answer-cast.fixture.ts')).toEqual({
      file: 'unchecked-answer-cast.fixture.ts',
      absentAsSuccess: false,
      uncheckedCast: true
    });
  });
});

describe('FR-R3-163 — NON-VACUITY: the terms match the shapes and nothing adjacent', () => {
  // Per `no-new-error-cast.test.ts:106-109`. The fixtures above prove each term
  // finds its shape in a real file; these inline controls prove the NARROWING,
  // which a file fixture cannot show. Both terms are ordinary TypeScript — a
  // nullish-coalescing default and a type assertion — so without these the gate
  // would be green by luck rather than by construction (rule 67).
  it('matches shape A', () => {
    expect(matchesAbsentAsSuccess('await ack(ctx, result ?? { ok: true });')).toBe(true);
  });

  it('matches shape B', () => {
    expect(matchesUncheckedCast('const r = v as { ok: boolean; reason?: string };')).toBe(true);
  });

  it.each([
    ["a PESSIMISTIC default is correct code", "result ?? { ok: false, reason: 'x' }"],
    ['a default of undefined asserts nothing', 'const r = result ?? undefined;'],
    ['a defaulted PAYLOAD field is not an answer', 'const p = payload ?? { taskId };'],
    ['an assertion to a NAMED type is followable', 'const h = handler as CommandHandler;'],
    ['a const assertion', "const ids = ['a', 'b'] as const;"],
    ['an assertion to a named result type', 'const r = v as CancelResult;']
  ])('does NOT match: %s', (_why, sample) => {
    expect(matchesAbsentAsSuccess(sample)).toBe(false);
    expect(matchesUncheckedCast(sample)).toBe(false);
  });
});
