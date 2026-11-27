import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ENVELOPE_ROOT, envelopePresent } from './envelope-presence';
import { SETTINGS_SCHEMA } from '../../src/config/settings-schema';

/**
 * FR-R3-145 — the blueprint's L0 table is checked against the schema it renders.
 *
 * WHAT WAS ACTUALLY WRONG, which is not quite what the bug report said. The
 * preamble reads "32 non-catalog keys in `settings-schema.ts`, the typed single
 * source of truth, parity-tested against `package.json`", and the report took
 * that as the table claiming to be parity-tested and concluded the gate "was
 * never written". Read again: the parity clause attaches to `settings-schema.ts`,
 * and that file IS parity-tested — `tests/unit/config/settings-schema-parity.test.ts`
 * checks it against the manifest in both directions across keys, types, defaults,
 * bounds, enums, patterns, array items and scope. The sentence is true.
 *
 * The defect is the sentence's PLACEMENT. The table is a hand-copied third
 * rendering hanging off the side of a tightly gated pair, and the word
 * "parity-tested" sits in its preamble, where a reader deciding where a key lives
 * transfers the guarantee onto the rows. The report's author did exactly that,
 * which is the evidence that the transfer is the natural reading. So the fix is
 * not to delete a false claim; it is to make the table earn the one the reader
 * already hears.
 *
 * WHAT IT HAD DRIFTED BY, measured 2026-08-31: two rows named `trust.*` keys the
 * manifest does not declare, five declared keys had no row, `defaultPipelineId`
 * documented a default of `speckit-new-feature` against a real `""`, and the
 * stated count of 32 was 35. Eight, in a table whose preamble says parity.
 *
 * WHERE THIS LIVES, and why not the envelope. The report assumed the gate "has to
 * live in the envelope, not in `repo/`, because it reads a file `repo/` cannot
 * see" and offered that as the reason it was never written. `repo/` can see it:
 * `envelope-presence.ts` exists for exactly this, and ten gates here already read
 * the envelope. So it goes where every other parity gate goes, and runs inside
 * `verify:push` rather than beside it.
 *
 * COMPARED AGAINST `SETTINGS_SCHEMA`, not `package.json`, though the blueprint
 * names the manifest. The two are held equal by the parity test above, so the
 * choice is free, and the schema is the typed value this file can import instead
 * of a JSON path it would have to assume the shape of.
 *
 * NOT CHECKED: the Bounds column. "1 MiB–10 GiB", "empty → `.schegent/syslog`" and
 * "operator-additive" are prose written for a reader, and a gate that demanded
 * they render `min`/`max` mechanically would either force the prose into a worse
 * shape or be defeated by any rewording. Keys, defaults and scope are the columns
 * that state facts a machine owns. This is a bounded claim, said here so the next
 * reader does not transfer THIS gate onto the column it does not cover — which is
 * the whole failure mode above.
 */

const BLUEPRINT_REL = 'docs/architecture/blueprint.md';
const TABLE_HEADING = '## L0 — Settings scalars';
const PREFIX = 'schegent.';

interface TableRow {
  readonly key: string;
  readonly documentedDefault: string;
  readonly scope: string;
}

/**
 * The table's key and default cells can each name several settings — the paths
 * row is `cli.path` / `codex.path` / `agy.path` against `claude` / `codex` /
 * `agy`. They pair by position, and a row whose two cells disagree in length is
 * reported rather than zipped short, because silently dropping the tail is how a
 * key stops being checked without anyone deleting a check.
 */
function parseTable(markdown: string): readonly TableRow[] {
  const start = markdown.indexOf(TABLE_HEADING);
  if (start === -1) return [];

  const rows: TableRow[] = [];
  const lines = markdown.slice(start).split('\n');
  let seenTable = false;

  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (seenTable) break;
      continue;
    }
    seenTable = true;
    if (line.startsWith('|---') || line.includes('| Key |')) continue;

    const cells = line.split('|').map((cell) => cell.trim());
    // `.at(1) ?? ''` rather than either `match[1]` or `match[1] ?? ''`, because two
    // gates pull opposite ways on this expression: `noUncheckedIndexedAccess` makes
    // the bare index `string | undefined` and counts it, while the lint program
    // types a capture group as `string` and calls the guard on it
    // `no-unnecessary-condition`. Both drafts were written and both went red, one
    // each. `.at()` is `T | undefined` by signature, so the guard is necessary by
    // type instead of defensive against it, and both gates are satisfied honestly.
    const keys = [...(cells.at(1) ?? '').matchAll(/`([^`]+)`/g)].map((match) => match.at(1) ?? '');
    const defaults = [...(cells.at(3) ?? '').matchAll(/`([^`]*)`/g)].map(
      (match) => match.at(1) ?? ''
    );
    const scope = cells.at(4) ?? '';

    for (const [index, key] of keys.entries()) {
      rows.push({
        key,
        // A single default cell shared by a multi-key row is legitimate only when
        // it holds one value; `MISSING` makes the mismatch visible instead.
        documentedDefault: defaults.length === keys.length ? (defaults.at(index) ?? '') : 'MISSING',
        scope
      });
    }
  }
  return rows;
}

/** The documented cell, rendered as the JSON the schema's value serialises to. */
function normalizeDocumentedDefault(cell: string): string {
  if (cell === "''" || cell === '""') return '""';
  if (cell === 'null' || cell === 'true' || cell === 'false' || cell === '[]') return cell;
  if (/^-?\d+(\.\d+)?$/.test(cell)) return cell;
  return JSON.stringify(cell);
}

/**
 * A schema key may be absent from the table when the blueprint documents it under
 * its own heading — `schegent.models` has one. Derived from the document rather
 * than hard-coded, so deleting that section turns the key back into a gap instead
 * of leaving a stale exemption behind.
 */
function documentedUnderOwnHeading(markdown: string, key: string): boolean {
  return new RegExp(`^#{2,4} .*\`${key.replace(/\./g, '\\.')}\``, 'm').test(markdown);
}

const present = envelopePresent();
const blueprint = present ? readFileSync(resolve(ENVELOPE_ROOT, BLUEPRINT_REL), 'utf8') : '';
const tableRows = parseTable(blueprint);
const documented = new Map(tableRows.map((row) => [`${PREFIX}${row.key}`, row]));

describe('blueprint L0 configuration table matches the settings schema (FR-R3-145)', () => {
  it('reaches the table it governs', () => {
    // Vacuity control. Every assertion below is a set difference, and set
    // differences against nothing are green. If the heading is renamed or the
    // table is reformatted, this is the test that says so.
    if (!present) {
      expect(tableRows).toEqual([]);
      return;
    }
    expect(
      blueprint.includes(TABLE_HEADING),
      `"${TABLE_HEADING}" is gone from ${BLUEPRINT_REL}; this gate is reading nothing`
    ).toBe(true);
    expect(
      tableRows.length,
      'the L0 table parsed to fewer rows than it can possibly have — the format changed'
    ).toBeGreaterThan(25);
    expect(
      tableRows.filter((row) => row.documentedDefault === 'MISSING'),
      'a row names more keys than it gives defaults, so some key has no documented default'
    ).toEqual([]);
  });

  // Two tests rather than two assertions in one, because the first `expect` to
  // fail ends the test: while five keys were missing, the dead-row half of this
  // pair never ran and reported nothing. A gate whose second finding is hidden by
  // its first is the failure mode this whole item is about.
  it('documents every schema key', () => {
    if (!present) return;

    const undocumented = Object.keys(SETTINGS_SCHEMA).filter(
      (key) => !documented.has(key) && !documentedUnderOwnHeading(blueprint, key)
    );
    expect(
      undocumented,
      `These settings ship and the L0 table does not list them. A reader taking the ` +
        `table as the configuration inventory concludes they do not exist — which is ` +
        `worst for the safety and spend controls. Add a row, or document the key under ` +
        `its own heading as \`schegent.models\` is.`
    ).toEqual([]);
  });

  it('names no key the schema does not have', () => {
    if (!present) return;

    const invented = [...documented.keys()].filter((key) => !(key in SETTINGS_SCHEMA));
    expect(
      invented,
      `These rows describe settings an operator cannot set: no such property is ` +
        `declared. A row for a key that does not exist is worse than no row, because ` +
        `it reads as a control that is merely turned off. Delete them.`
    ).toEqual([]);
  });

  it('documents the default each key actually ships with', () => {
    if (!present) return;

    const drifted: string[] = [];
    for (const [key, entry] of Object.entries(SETTINGS_SCHEMA)) {
      const row = documented.get(key);
      if (row === undefined) continue;
      const shipped = JSON.stringify(entry.default);
      const stated = normalizeDocumentedDefault(row.documentedDefault);
      if (stated !== shipped) drifted.push(`${key}: table says ${stated}, ships ${shipped}`);
    }
    expect(
      drifted,
      `The table states a default the product does not ship. \`settings-schema.ts\` is ` +
        `the source of truth and is itself parity-tested against package.json, so the ` +
        `table is the side that is wrong.`
    ).toEqual([]);
  });

  it('documents the scope each key actually has', () => {
    if (!present) return;

    const drifted: string[] = [];
    for (const [key, entry] of Object.entries(SETTINGS_SCHEMA)) {
      const row = documented.get(key);
      if (row === undefined) continue;
      if (row.scope !== entry.scope) {
        drifted.push(`${key}: table says ${row.scope}, schema says ${entry.scope}`);
      }
    }
    expect(
      drifted,
      'Scope decides which settings file a value may be written to, so a wrong scope ' +
        'sends an operator to a file the setting cannot be set in.'
    ).toEqual([]);
  });

  it('states a key count that matches the schema', () => {
    if (!present) return;

    const stated = /(\d+) non-catalog keys/.exec(blueprint);
    expect(stated, 'the preamble no longer states a key count for this gate to check').not.toBeNull();

    const catalog = Object.keys(SETTINGS_SCHEMA).filter((key) =>
      documentedUnderOwnHeading(blueprint, key)
    );
    const nonCatalog = Object.keys(SETTINGS_SCHEMA).length - catalog.length;
    expect(
      Number(stated?.[1] ?? -1),
      `The preamble's count is the one number a reader checks the table's completeness ` +
        `against, so a stale count hides exactly the missing rows it would reveal. ` +
        `Non-catalog keys now: ${nonCatalog} (${catalog.length} documented under own headings).`
    ).toBe(nonCatalog);
  });
});
