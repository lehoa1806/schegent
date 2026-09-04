// FR-R3-157 (T010, FR-007, SC-006, contract C1.4/C1.5) — the grep-provable form of
// "the deprecated switch is resolved in exactly one place".
//
// `forceContinueOnRetryCap` is superseded by `onRetryCap` and will keep loading
// indefinitely, so the identifier does not go away: it stays declared, validated,
// copied and serialized in more than a dozen files. What must not exist twice is a place that
// DECIDES from it. Two readers is how the two forms drift, and the drift is silent —
// each site is individually correct and they disagree only on a phase that carries
// both.
//
// So this gate makes two separate claims:
//
//   1. `src/controller/phase.ts` — the module that used to decide — contains zero
//      occurrences of the identifier (C1.5). It now receives an outcome already
//      resolved.
//   2. Every non-test source file that names the identifier is classified, and
//      exactly one carries the role `reader` (C1.4). A new file naming it fails
//      this test until its author says which role it plays.
//
// **The search term is the FIELD NAME, never the value** (contract C1.6). The value
// `'continue-degraded'` already occurs in `evidence-health-monitor.ts` as an
// unrelated evidence-sink failure policy; a proof written against the value would
// match that and pass while asserting nothing. The last test below pins the
// collision so the trap is visible to whoever edits this file next.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const FIELD = 'forceContinueOnRetryCap';

/**
 * What each non-test source file that names the field is permitted to do with it.
 *
 * `reader` — decides behaviour from it. Exactly one entry may carry this role.
 * `declaration` — declares the field on a type or in the closed authored-field set.
 * `validator` — checks its type and rejects a malformed value.
 * `copy` — carries it across a boundary unread: mapper, catalog, projector.
 * `key-order` — names it in a serialization key list.
 * `prose` — mentions it in a comment or a human-readable rationale string only.
 * `default-source` — names `forceContinueOnRetryCapDefault`, the WORKSPACE default.
 *   That is a different identifier that happens to contain the field name as a
 *   prefix; these files read the workspace setting and hand it to the resolver as
 *   an argument. They never touch the phase's own field. The substring match is
 *   why they appear here at all, and classifying them is better than excluding
 *   them by a cleverer regex — a regex that skipped them would also skip a real
 *   second reader that named its local variable `forceContinueOnRetryCapValue`.
 */
const ROLES: Readonly<Record<string, string>> = {
  'src/contracts/retry-cap-outcome.ts': 'reader',

  'src/contracts/process-definitions.ts': 'declaration',
  'src/config/pipeline-config.ts': 'declaration',
  'src/services/process-yaml/types.ts': 'declaration',
  'webview-ui/src/lib/definition-rows.ts': 'declaration',
  'webview-ui/src/lib/snapshot-types.ts': 'declaration',
  'webview-ui/src/components/PipelineBuilderEditors/types.ts': 'declaration',

  'src/config/process-definition-validator.ts': 'validator',
  'src/services/process-yaml/phase-yaml-validator.ts': 'validator',
  'webview-ui/src/components/settings/RawJsonPhaseEditor.svelte': 'validator',

  'src/services/process-yaml/phase-yaml-mapper.ts': 'copy',
  'src/config/process-catalog.ts': 'copy',
  'src/ui/sidebar/phase-catalog-projection.ts': 'copy',

  'src/services/process-yaml/yaml-serializer.ts': 'key-order',

  'src/config/general-settings-keys.ts': 'prose',
  'src/contracts/configuration-trust-dispositions.ts': 'prose',

  'src/controller/phase-sequencer.ts': 'default-source',
  'src/services/run-driver.ts': 'default-source'
};

const SEARCH_ROOTS = ['src', 'webview-ui/src'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.svelte']);

/**
 * The vacuity controls for the scan below (`scanning-gates-prove-they-scanned`).
 *
 * Every assertion in this file that matters is an EMPTINESS assertion over
 * `filesNamingTheField()`. A moved search root, a renamed field, or an extension
 * filter that stopped matching `.svelte` would empty that scan, and all of them
 * would then pass on any tree at all — including one carrying a second reader,
 * which is the single thing this gate exists to forbid.
 *
 * `MIN_SITES` is a floor, not a count: seventeen files name the field today and the
 * number is expected to drift as the deprecated form is copied to fewer places.
 * Fifteen is low enough not to break on that drift and high enough that an emptied
 * scan cannot reach it. `ANCHOR` is the resolver itself — if the scan cannot find
 * the one file whose role is `reader`, it is not searching the tree this gate
 * claims to search.
 */
const MIN_SITES = 15;
const ANCHOR = 'src/contracts/retry-cap-outcome.ts';

function collectSourceFiles(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `__tests__` and `node_modules` are not source. Test files are excluded by
      // name below, so a fixture that legitimately sets the field does not count.
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collectSourceFiles(full, acc);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

function filesNamingTheField(): string[] {
  const root = process.cwd();
  const found: string[] = [];
  for (const searchRoot of SEARCH_ROOTS) {
    const abs = path.resolve(root, searchRoot);
    for (const file of collectSourceFiles(abs, [])) {
      if (fs.readFileSync(file, 'utf8').includes(FIELD)) {
        found.push(path.relative(root, file));
      }
    }
  }
  return found.sort();
}

describe('FR-R3-157 (FR-007, SC-006) — one resolution site for the deprecated switch', () => {
  it('C1.5: src/controller/phase.ts contains zero occurrences of the field name', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/controller/phase.ts'),
      'utf8'
    );

    const lines = source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes(FIELD));

    expect(
      lines,
      `src/controller/phase.ts must not name \`${FIELD}\` at all (contract C1.5). ` +
        'It receives a `capOutcome` already resolved by ' +
        '`src/contracts/retry-cap-outcome.ts`. Found:\n' +
        lines.map(({ line, number }) => `  :${number} ${line.trim()}`).join('\n')
    ).toEqual([]);
  });

  it('C1.4: every non-test source file naming the field is classified', () => {
    const found = filesNamingTheField();
    // `Object.hasOwn`, not `ROLES[file] === undefined`: the map is typed
    // `Record<string, string>`, so an index lookup is `string` and that comparison
    // is one the type system says can never hold. Presence is the question being
    // asked here — "is this file recorded at all" — and asking it directly stays
    // true whatever the map's value type becomes later.
    const unclassified = found.filter((file) => !Object.hasOwn(ROLES, file));

    expect(
      unclassified,
      `These files name \`${FIELD}\` but have no recorded role in this test:\n` +
        unclassified.map((file) => `  ${file}`).join('\n') +
        '\n\nAdd each to ROLES with the role it plays. If the role is `reader` — ' +
        'if it DECIDES behaviour from the field rather than declaring, checking, ' +
        'copying or listing it — the change is wrong: resolution belongs in ' +
        '`src/contracts/retry-cap-outcome.ts` and nowhere else (FR-007).'
    ).toEqual([]);
  });

  it('C1.4: exactly one classified file carries the role `reader`', () => {
    const readers = Object.entries(ROLES)
      .filter(([, role]) => role === 'reader')
      .map(([file]) => file);

    expect(readers).toEqual(['src/contracts/retry-cap-outcome.ts']);
  });

  it('vacuity control: the scan reaches the tree and finds the resolver', () => {
    const found = filesNamingTheField();

    // Every assertion above is an emptiness assertion over this scan. If the scan
    // returned nothing — a moved search root, a renamed field, an extension filter
    // that stopped matching — all of them would pass on a tree carrying a second
    // reader, which is the one thing this gate exists to forbid.
    expect(
      found.length,
      `The scan of ${SEARCH_ROOTS.join(', ')} found ${found.length} files naming ` +
        `\`${FIELD}\`, below the floor of ${MIN_SITES}. Either the deprecated form is ` +
        'genuinely almost gone — in which case lower MIN_SITES deliberately, in the ' +
        'same change that removed the sites — or this gate is no longer searching ' +
        'the tree it claims to search and every assertion in this file is vacuous.'
    ).toBeGreaterThanOrEqual(MIN_SITES);

    expect(
      found,
      `The scan did not find ${ANCHOR}, the one file whose recorded role is ` +
        '`reader`. That file is the subject of this whole gate; a scan that cannot ' +
        'see it is not proving anything about where the field is resolved.'
    ).toContain(ANCHOR);
  });

  it('vacuity control: the recorded roles describe files that still exist and still name the field', () => {
    const found = new Set(filesNamingTheField());
    const stale = Object.keys(ROLES).filter((file) => !found.has(file));

    expect(
      stale,
      'These files are recorded in ROLES but no longer name the field. Remove them, ' +
        'so the allowlist cannot silently accumulate entries that prove nothing:\n' +
        stale.map((file) => `  ${file}`).join('\n')
    ).toEqual([]);
  });

  // Contract C1.6 / spec A6. Not a claim about this feature's code — a claim about
  // the trap the next author of this file would otherwise fall into.
  it('C1.6: the value literal collides with an unrelated policy, so the proof searches the name', () => {
    const monitor = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/evidence-health/evidence-health-monitor.ts'),
      'utf8'
    );

    expect(
      monitor.includes('continue-degraded'),
      "`continue-degraded` no longer occurs in evidence-health-monitor.ts. The " +
        'collision this test documents is gone, and a proof written against the ' +
        'value would no longer be silently weakened by it. Re-read contract C1.6 ' +
        'before relaxing anything on the strength of that — searching the field ' +
        'name is still the right proof, because a stored value proves nothing ' +
        'about who READS it.'
    ).toBe(true);
  });
});
