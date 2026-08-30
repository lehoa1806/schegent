// Feature 094 — Authority-citation guard for
// `schegent.queue.globalConcurrencyCap`.
//
// The cap's range is wider than one because
// `docs/architecture/local-queue-parallelism-ratification.md` narrows one clause
// of the remote/multi-user expansion gate for the local single-operator shape.
// FR-011 requires every site that *defines* the range or the default to cite
// that record, so a reader who arrives through the code can reach the authority
// without already knowing it exists.
//
// That requirement was review-enforced when it was written, and review is what
// let the thing this feature fixes happen in the first place: two idle
// projections drifted to a stale default while a parity guard restated the
// expected value as a literal and stayed green. A documented invariant with no
// mechanical guard is the defect this feature exists to correct, so the
// invariant this feature introduces gets a guard rather than an exhortation.
//
// Three failure modes are covered, each of which review has already missed once
// somewhere in this codebase:
//
//   1. A **new** definition site appears and nobody adds a citation. The
//      discovery sweep below fails on an unclassified file, so a fifth site
//      cannot be added silently — the author must classify it, and classifying
//      it as a definition site brings the citation assertion with it.
//   2. A citation is **deleted** or edited away. Each definition site is
//      asserted to name the record.
//   3. The record is **renamed or moved**. The cited path is resolved on disk,
//      so a rename fails here rather than leaving six links pointing nowhere.
//
// This guard checks the citation *link*. The values themselves are held by
// `tests/parity/settings-defaults-parity.test.ts`, which now asserts that the
// idle projections *import* the two constants rather than restating them, and by
// `tests/lint/architecture-doc-schema-parity.test.ts`, which pins the documented
// default and range to the code. The enforcing sites derive their ceiling from
// `MAX_QUEUES` and so cannot drift from it by restatement.
//
// FR-R3-145 (T1570) — this file previously named the advertising sites' agreement
// as the other half, checked by `tests/unit/config/settings-schema-parity.test.ts`
// against the manifest. There are no advertising sites left: the manifest
// contribution, its schema row and its `general-settings.ts` field advertised a
// configuration key that no scheduling path read, and were removed with it. The
// half of the problem that gate covered is gone rather than moved, which is a
// smaller surface, not a weaker one.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { MAX_GLOBAL_CONCURRENCY_CAP } from '../../src/state/workspace-state';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The authority every definition site must cite, relative to `repo/`. */
const RECORD_PATH = 'docs/architecture/local-queue-parallelism-ratification.md';

/** The token by which a citation is recognised. */
const RECORD_CITATION = 'local-queue-parallelism-ratification.md';

/**
 * The four sites that state the cap's permitted values or its default.
 *
 * One **defines** the numbers other sites derive from. Three **enforce** them —
 * they refuse a value outside the range. The split matters to a reader deciding
 * which site answers a question, and it is recorded here because two in-code
 * comments carried counts (four, and five) that disagreed with each other and
 * with the truth until feature 094 enumerated them by inspection.
 *
 * FR-R3-145 (T1570) — six became four, and the `advertises` role became empty.
 * `package.json`, `src/config/settings-schema.ts` and
 * `src/config/general-settings.ts` advertised `schegent.queue.globalConcurrencyCap`
 * to the operator; nothing read it. The cap the drain gates on is the workspace
 * memento of the same name, written through `CMD_SAVE_QUEUE_SETTINGS`. Three
 * sites telling an operator a number that no scheduling path consults is not a
 * weaker version of advertising, it is a different thing, so the rows were
 * removed with the key rather than re-pointed.
 *
 * `src/contracts/queue-bounds.ts` is the arrival, and it is a third role rather
 * than either existing one. It refuses nothing and tells no operator anything —
 * it is where `MAX_QUEUES` and `DEFAULT_GLOBAL_CONCURRENCY_CAP` are written down,
 * and every other site derives from it. A reader who lands there is being told
 * what the numbers are, which is exactly the reader FR-011's citation exists for.
 */
const CAP_DEFINITION_SITES: ReadonlyArray<{
  file: string;
  role: 'defines' | 'advertises' | 'enforces';
}> = [
  { file: 'src/contracts/queue-bounds.ts', role: 'defines' },
  { file: 'src/state/workspace-state.ts', role: 'enforces' },
  { file: 'src/queue/queue-manager.ts', role: 'enforces' },
  { file: 'src/contracts/validators/queue-management.ts', role: 'enforces' },
];

/**
 * Files that name the cap without defining its bound: they carry the value
 * across a boundary, project it, or read it. They are exempt from the citation
 * requirement because a reader who lands on one is not being told what the
 * range is, so there is no authority for them to be missing.
 *
 * The distinguishing test is the one in the spec's Key Entities section: would
 * this site still be consulted if every other were deleted? An enforcing site
 * would still refuse an out-of-range value; an advertising site would still
 * state the range; one of these would still compile and answer for nothing.
 */
const NON_DEFINITION_MENTIONS: ReadonlySet<string> = new Set([
  // Contract surfaces — carry the field, state no bound.
  'src/contracts/sidebar-ipc.ts',
  'src/contracts/sidebar-ipc/queue.ts',
  'src/ui/sidebar/commands/router-types.ts',
  // Command handlers — pass an already-validated value through.
  'src/commands/cancel.ts',
  'src/ui/sidebar/commands/cmd-cancel.ts',
  'src/ui/sidebar/commands/cmd-save-queue-settings.ts',
  // FR-R3-145 (T1572) — the snapshot path, added when the cap became a projected
  // field. `snapshot-projections.ts` declares `QueueSettingsProjection`,
  // `snapshot-composer.ts` fills it from the store, and `snapshot.ts` holds the
  // idle value. None states a bound.
  //
  // `snapshot.ts` is the one worth reading twice, because it is the file this
  // guard's own header is about: "two idle projections drifted to a stale default
  // while a parity guard restated the expected value as a literal and stayed
  // green". `IDLE_QUEUE_SETTINGS` cannot drift, because it does not restate — it
  // value-imports `DEFAULT_GLOBAL_CONCURRENCY_CAP` and `DEFAULT_QUEUE_ID` from the
  // contract layer. That is why it belongs here and not above: an importing site
  // has no second opinion to be wrong about.
  'src/contracts/snapshot-projections.ts',
  'src/ui/sidebar/snapshot-composer.ts',
  'src/ui/sidebar/snapshot.ts',
  // FR-R3-145 (T1570) — three entries were removed from this set rather than
  // kept: `src/contracts/generated/boundary-contracts.ts` and
  // `src/contracts/generated/schemas/settings.schema.json` (generated from
  // `settings-schema.ts`, whose entry is gone, so they no longer contain the
  // bound) and `src/contracts/configuration-trust-dispositions.ts` (its row
  // classified a configuration key that no longer exists). An exemption for a
  // file that no longer mentions the cap exempts nothing and hides the return: if
  // one of them states the cap again, it should arrive here as an unclassified
  // file and be argued for, which is what this set is for.
]);

/** Every source file naming the setting key or the exported constants. */
function discoverMentioningFiles(): string[] {
  const found: string[] = [];
  const pattern = /globalConcurrencyCap|GLOBAL_CONCURRENCY_CAP/;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(ts|json)$/.test(entry.name)) continue;
      if (pattern.test(fs.readFileSync(abs, 'utf8'))) {
        found.push(path.relative(REPO_ROOT, abs));
      }
    }
  };

  walk(path.join(REPO_ROOT, 'src'));
  return found.sort();
}

describe('concurrency cap authority citation', () => {
  it('the cited record exists on disk', () => {
    // A rename that leaves six dangling links fails here, not in review.
    expect(fs.existsSync(path.join(REPO_ROOT, RECORD_PATH))).toBe(true);
  });

  it.each(CAP_DEFINITION_SITES)(
    '$file ($role) cites the ratification record',
    ({ file }) => {
      const contents = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(
        contents.includes(RECORD_CITATION),
        `${file} states the cap's range or default but does not name the record that ` +
          `authorises a range wider than one. Add a reference to ${RECORD_PATH}; a reader ` +
          `who arrives here through the code has no other way to reach the authority.`
      ).toBe(true);
    }
  );

  it('names one defining, three enforcing and no advertising sites', () => {
    const byRole = (role: string): number =>
      CAP_DEFINITION_SITES.filter((s) => s.role === role).length;
    expect(byRole('defines')).toBe(1);
    expect(byRole('enforces')).toBe(3);
    // FR-R3-145 (T1570) — pinned at zero deliberately, not left unstated. An
    // advertising site is one that tells an operator what the range is, and the
    // three that did were removed because the value they advertised was not the
    // value the scheduler used. Re-adding one is a real decision — it means the
    // cap has become configurable again — and it should fail here first.
    expect(byRole('advertises')).toBe(0);
  });

  it('no source file states the cap without being classified', () => {
    const mentioning = discoverMentioningFiles();
    // FR-R3-145 (T1570) — vacuity control, and this gate went without one for a
    // round. Its non-vacuity used to be carried accidentally, by
    // `expect(advertises).toHaveLength(3)` in the test above: a count of a
    // hand-written array, which proves nothing about whether the WALK found
    // anything. That number went to zero when the advertising sites were removed,
    // and with it the only thing `scanning-gates-prove-they-scanned` recognised
    // here — which is how the miss surfaced. This is the real control: the sweep
    // walks `src/`, and a moved root or a pattern that stops matching yields an
    // empty set and a green gate, indistinguishable from a clean tree. Thirteen
    // files under `src/` name the cap today.
    expect(
      mentioning.length,
      'the sweep found (almost) no file naming the concurrency cap. The walk root or the ' +
        'pattern has stopped matching how this tree spells the setting, so the check below ' +
        'is comparing nothing to nothing and would pass on any tree.'
    ).toBeGreaterThan(8);

    const classified = new Set<string>([
      ...CAP_DEFINITION_SITES.map((s) => s.file),
      ...NON_DEFINITION_MENTIONS,
    ]);
    const unclassified = mentioning.filter((f) => !classified.has(f));

    expect(
      unclassified,
      `These files name the concurrency cap but are in neither set:\n` +
        unclassified.map((f) => `  ${f}`).join('\n') +
        `\n\nClassify each one. If it states the range or the default, add it to ` +
        `CAP_DEFINITION_SITES with its role and give it a citation of ${RECORD_PATH}. ` +
        `If it only carries or reads the value, add it to NON_DEFINITION_MENTIONS with ` +
        `a note saying which. Do not widen the sweep to silence this.`
    ).toEqual([]);
  });
});

/**
 * The record's re-evaluation trigger lists eleven premises whose change reopens
 * the decision. Most are facts about the deployment shape — one operator, one
 * host process, no network surface — which no test can observe. Three are
 * numbers pinned in code, and those are checked here.
 *
 * Enumerating a premise is detection by a reader who happens to look. These
 * three are detection by the suite, on the commit that changes them. A record
 * whose trigger nobody watches is the permanent clearance FR-015 exists to
 * prevent, and it fails silently: the premise moves, the record still reads as
 * current, and the approval it carries now covers a shape nobody evaluated.
 */
describe('re-evaluation trigger premises still hold', () => {
  const recordText = (): string => fs.readFileSync(path.join(REPO_ROOT, RECORD_PATH), 'utf8');

  const premises: ReadonlyArray<{
    premise: string;
    source: string;
    read: () => string | undefined;
    expected: string;
  }> = [
    {
      premise: 'MAX_QUEUES',
      // FR-R3-110 (FR-104) moved the declaration from `src/queue/queue-registry.ts`
      // to here, because `contracts/validators/queue-management.ts` value-imported
      // it from the queue layer — a backwards edge the dependency-direction gate
      // refuses. The **value did not change**: it was 20 before the move and is 20
      // after, so this trigger fired on the premise's *location*, not on its
      // content, and the record's criterion 3 reasons from the same number it
      // always did. Re-pointing the reader is therefore the whole fix; no
      // disposition needed re-evaluating.
      source: 'src/contracts/queue-bounds.ts',
      read: () =>
        /export const MAX_QUEUES\s*=\s*(\d+)/.exec(
          fs.readFileSync(path.join(REPO_ROOT, 'src/contracts/queue-bounds.ts'), 'utf8')
        )?.[1],
      expected: '20',
    },
    {
      premise: "the cap's maximum",
      // FR-R3-145 (T1570) re-pointed this from `package.json`, the same way
      // FR-R3-110 re-pointed premise 5 when `MAX_QUEUES` moved: the trigger fired
      // on the premise's *location*, not its content. The manifest contributed
      // `maximum: 20` for a configuration key nothing read; removing the key
      // removed the only place a literal 20 was written for the cap. The value is
      // unchanged — `MAX_GLOBAL_CONCURRENCY_CAP` is `MAX_QUEUES`, which was 20
      // before the removal and is 20 after — so the record's criterion 3 reasons
      // from the same number it always did, and no disposition needed
      // re-evaluating.
      //
      // Imported rather than regexed, because after the removal the maximum is
      // computed and no source file states it as a digit. A regex would have to
      // match `MAX_QUEUES` and then chase it, which is the indirection this
      // premise exists to collapse.
      source: 'src/state/workspace-state.ts',
      read: () => String(MAX_GLOBAL_CONCURRENCY_CAP),
      expected: '20',
    },
    {
      premise: 'state schema version',
      source: 'src/contracts/state-schema.ts',
      read: () =>
        /export const STATE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(
          fs.readFileSync(path.join(REPO_ROOT, 'src/contracts/state-schema.ts'), 'utf8')
        )?.[1],
      // Moved 11 → 12 by FR-R3-010's per-queue history reshape and 12 → 13 by
      // FR-R3-011's queue-pause collapse, each after the re-evaluation this
      // trigger demands. Criterion 3 is the disposition that reasons from this
      // number, and it survived all three: its downgrade refusal compares against
      // the runtime `STATE_SCHEMA_VERSION` rather than a literal, v12 is another
      // forward-only per-queue reshape, v13 is narrower still — a forward-only
      // rewrite *within* each queue record, not a reshape of the record map — and
      // v14 (FR-R3-117) is narrower again: two fields added to each phase of a
      // plan snapshot, reshaping nothing and changing no cardinality this decision
      // rests on. The shape of the argument is unchanged. The record's premise
      // table carries the 2026-08-27 re-evaluation.
      expected: '14',
    },
  ];

  it.each(premises)('$premise is still $expected', ({ premise, source, read, expected }) => {
    expect(
      read(),
      `The ratification record enumerates "${premise}" as a premise of its decision, ` +
        `recorded as ${expected}. ${source} no longer says ${expected}.\n\n` +
        `This is the trigger firing, not a broken test. Re-evaluate ` +
        `${RECORD_PATH} against the new value before updating this expectation: ` +
        `the record's dispositions were reached under the old one, and at least ` +
        `criterion 3 reasons directly from the schema version and the queue bound.`
    ).toBe(expected);
  });

  it('the record still states the premises this test pins', () => {
    // Guards the other direction: the values could be edited out of the record
    // while the code kept them, leaving these assertions checking nothing.
    const text = recordText();
    expect(text).toContain('| 5 | `MAX_QUEUES` | 20 |');
    expect(text).toContain('`src/queue/queue-registry.ts` (declared)');
    expect(text).toContain("| 6 | The cap's maximum | 20 |");
    expect(text).toContain('| 10 | State schema version | 14');
  });
});
