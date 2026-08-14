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
//      discovery sweep below fails on an unclassified file, so a seventh site
//      cannot be added silently — the author must classify it, and classifying
//      it as a definition site brings the citation assertion with it.
//   2. A citation is **deleted** or edited away. Each definition site is
//      asserted to name the record.
//   3. The record is **renamed or moved**. The cited path is resolved on disk,
//      so a rename fails here rather than leaving six links pointing nowhere.
//
// This guard checks the citation *link*. The values themselves are held by
// `tests/unit/config/settings-schema-parity.test.ts` (the advertising sites
// agree) and `tests/parity/settings-defaults-parity.test.ts` (the idle
// projections match the manifest). The enforcing sites derive their ceiling
// from `MAX_QUEUES` and so cannot drift from it by restatement.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The authority every definition site must cite, relative to `repo/`. */
const RECORD_PATH = 'docs/architecture/local-queue-parallelism-ratification.md';

/** The token by which a citation is recognised. */
const RECORD_CITATION = 'local-queue-parallelism-ratification.md';

/**
 * The six sites that state the cap's permitted values or its default.
 *
 * Three **advertise** the bound — they tell an operator or a schema consumer
 * what the range is. Three **enforce** it — they refuse a value outside it.
 * The split matters to a reader deciding which site answers a question, and it
 * is recorded here because two in-code comments carried counts (four, and five)
 * that disagreed with each other and with the truth until feature 094
 * enumerated them by inspection.
 */
const CAP_DEFINITION_SITES: ReadonlyArray<{ file: string; role: 'advertises' | 'enforces' }> = [
  { file: 'src/state/workspace-state.ts', role: 'enforces' },
  { file: 'src/queue/queue-manager.ts', role: 'enforces' },
  { file: 'src/contracts/validators/queue-management.ts', role: 'enforces' },
  { file: 'src/config/settings-schema.ts', role: 'advertises' },
  { file: 'src/config/general-settings.ts', role: 'advertises' },
  { file: 'package.json', role: 'advertises' },
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
  // Generated from the schema; the bound they contain is a copy of
  // `settings-schema.ts`, which is a definition site and carries the citation.
  'src/contracts/generated/boundary-contracts.ts',
  'src/contracts/generated/schemas/settings.schema.json',
  // Command handlers — pass an already-validated value through.
  'src/commands/cancel.ts',
  'src/ui/sidebar/commands/cmd-cancel.ts',
  'src/ui/sidebar/commands/cmd-save-queue-settings.ts',
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

  it('names three advertising and three enforcing sites', () => {
    const advertises = CAP_DEFINITION_SITES.filter((s) => s.role === 'advertises');
    const enforces = CAP_DEFINITION_SITES.filter((s) => s.role === 'enforces');
    expect(advertises).toHaveLength(3);
    expect(enforces).toHaveLength(3);
  });

  it('no source file states the cap without being classified', () => {
    const classified = new Set<string>([
      ...CAP_DEFINITION_SITES.map((s) => s.file),
      ...NON_DEFINITION_MENTIONS,
    ]);
    const unclassified = discoverMentioningFiles().filter((f) => !classified.has(f));

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
      source: 'src/queue/queue-registry.ts',
      read: () =>
        /export const MAX_QUEUES\s*=\s*(\d+)/.exec(
          fs.readFileSync(path.join(REPO_ROOT, 'src/queue/queue-registry.ts'), 'utf8')
        )?.[1],
      expected: '20',
    },
    {
      premise: "the cap's maximum",
      source: 'package.json',
      read: () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        const prop =
          pkg.contributes?.configuration?.properties?.['schegent.queue.globalConcurrencyCap'];
        return prop?.maximum === undefined ? undefined : String(prop.maximum);
      },
      expected: '20',
    },
    {
      premise: 'state schema version',
      source: 'src/contracts/state-schema.ts',
      read: () =>
        /export const STATE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(
          fs.readFileSync(path.join(REPO_ROOT, 'src/contracts/state-schema.ts'), 'utf8')
        )?.[1],
      expected: '11',
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
    expect(text).toContain('| 10 | State schema version | 11');
  });
});
