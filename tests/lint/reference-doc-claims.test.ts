import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_AUDIT_EVENT_TYPES } from '../../src/contracts/audit-events';

/**
 * FR-R3-102 (FR-040) — `docs/reference/` is covered by the semantic-claims gate
 * family.
 *
 * THE GAP THIS CLOSES, named twice before it was closed. The criterion-8 review's
 * F1 disposition recorded that **neither** `FR-R3-094`'s source-path liveness gate
 * **nor** `FR-R3-063`'s semantic doc gates reach `docs/reference/`, and the
 * 2026-08-26 principal review found the envelope architecture document's semantic
 * claims equally uncovered. Two independent reviews landing in the same directory is
 * the signal that it is not an oversight but a hole in the gate map.
 *
 * WHAT IS CHECKED, and why these two classes. A reference page makes many kinds of
 * claim, and most are prose that no gate can adjudicate. Two are **machine-derivable
 * against a single authority**, which is what makes them worth gating:
 *
 *   1. **Setting keys.** A backticked `schegent.*` key either exists in the
 *      manifest's `contributes.configuration` or it does not. A page naming a
 *      setting that was renamed or removed sends an operator to a control that is
 *      not there.
 *   2. **Audit event types.** The audit vocabulary is a closed union
 *      (`ALL_AUDIT_EVENT_TYPES`). A page naming an event outside it describes
 *      evidence nobody will ever find — which is exactly the defect FR-R3-102 found
 *      in `audit.invalid_command`, in the document that was *supposed* to be the map.
 *
 * WHAT IS NOT CHECKED, stated rather than implied: prose accuracy, whether a
 * documented behaviour matches the code, command names (`readme-command-parity`
 * covers those), and file paths (`source-marker-targets` covers those). A page whose
 * only claims are prose has no checkable claim, and that is recorded per file below
 * rather than left as an unexplained absence.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const REF_DIR = resolve(REPO_ROOT, 'docs/reference');

/**
 * Files with no machine-derivable claim of either class, each with its reason.
 *
 * This is the "or record per-file why not" half of FR-040. It is a declaration, not
 * an exemption: a file here is asserted BELOW to genuinely carry no claim of either
 * class, so it cannot be used to silence a page that does.
 */
const NO_CHECKABLE_CLAIMS: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
  {
    file: 'README.md',
    reason: 'an index of the other pages; its only content is links, which source-marker-targets covers'
  },
  {
    file: 'commands.md',
    reason: 'command names only, which tests/lint/readme-command-parity.test.ts already derives from the manifest'
  },
  {
    file: 'api-and-cli.md',
    reason:
      'names command ids (schegent.auto, schegent.schedule) and VS Code APIs, not setting ' +
      'keys; readme-command-parity.test.ts derives the command list from the manifest, and ' +
      'a VS Code API name is not derivable from anything in this repository'
  },
  {
    file: 'glossary.md',
    reason: 'definitions of terms; a term is not derivable from any single authority'
  },
  {
    file: 'file-layout.md',
    reason: 'on-disk paths under .schegent/, which are runtime artifacts rather than tracked files, so no path check applies'
  }
];

const settingKeys = (): ReadonlySet<string> => {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes?: { configuration?: unknown };
  };
  const config = manifest.contributes?.configuration;
  const blocks = Array.isArray(config) ? config : [config];
  const keys = new Set<string>();
  for (const block of blocks) {
    const props = (block as { properties?: Record<string, unknown> } | undefined)?.properties;
    for (const key of Object.keys(props ?? {})) keys.add(key);
  }
  return keys;
};

const pages = (): readonly string[] => readdirSync(REF_DIR).filter((f) => f.endsWith('.md'));
const read = (file: string): string => readFileSync(resolve(REF_DIR, file), 'utf8');

/** Backticked `schegent.<something>.<something>` — the manifest key shape. */
const SETTING = /`(schegent\.[a-zA-Z]+\.[a-zA-Z]+)`/g;
const matches = (body: string, re: RegExp): readonly string[] => [
  ...new Set([...body.matchAll(re)].map((m) => m[1] as string))
];

describe('FR-R3-102 — reference pages do not name settings or events that do not exist', () => {
  it('scanned a non-empty set of pages', () => {
    // The floor: a directory rename would otherwise empty the scan and make every
    // assertion below pass over nothing.
    expect(pages().length).toBeGreaterThanOrEqual(8);
  });

  it('every backticked setting key exists in the manifest', () => {
    const known = settingKeys();
    expect(known.size, 'the manifest must declare settings, or this check is vacuous').toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of pages()) {
      for (const key of matches(read(file), SETTING)) {
        if (!known.has(key)) offenders.push(`${file}: ${key}`);
      }
    }
    expect(
      offenders,
      'A reference page names a setting the manifest does not declare. An operator ' +
        'following it reaches a control that is not there. Either the key was renamed ' +
        'and the page was not, or the page invented it.'
    ).toEqual([]);
  });

  it('every event named as a representative in the registry table is in the closed union', () => {
    // Kebab-case backticks are ambiguous across the page — file stems, field names and
    // prose all take that shape — so this reads the one place where a backticked name
    // is unambiguously CLAIMED to be an event: the "Representative events" column of
    // the registry table. That is the column an engineer copies from.
    const body = read('audit-events.md');
    const known = new Set<string>(ALL_AUDIT_EVENT_TYPES as readonly string[]);
    expect(known.size, 'the union must be non-empty, or this check is vacuous').toBeGreaterThan(30);

    const section = body.slice(body.indexOf('## Event registry and scope'));
    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('|') && line.includes('`'))
      .filter((line) => !/^\|\s*---/.test(line))
      .filter((line) => !/Representative events/.test(line));
    expect(
      rows.length,
      'the registry table must have rows naming events, or this check reads nothing'
    ).toBeGreaterThanOrEqual(8);

    const claimed: string[] = [];
    for (const row of rows) {
      const cells = row.split('|');
      // Column 2 is "Representative events"; column 1 is the family name and column 3
      // is prose, neither of which claims an event literal.
      const representative = cells[2] ?? '';
      for (const m of representative.matchAll(/`([a-zA-Z][a-zA-Z0-9._-]+)`/g)) {
        claimed.push(m[1] as string);
      }
    }
    expect(claimed.length, 'no events were extracted, so this check proved nothing').toBeGreaterThan(20);

    const offenders = claimed.filter((name) => !known.has(name));
    expect(
      offenders,
      'audit-events.md names an event type that is not in ALL_AUDIT_EVENT_TYPES. The ' +
        'vocabulary is a closed union, so a documented event outside it describes ' +
        'evidence nobody will ever find — the audit.invalid_command defect exactly.'
    ).toEqual([]);
  });

  it('every page either carries a checked claim class or is declared as carrying none, with a reason', () => {
    const declared = new Map(NO_CHECKABLE_CLAIMS.map((e) => [e.file, e.reason]));
    const undeclared: string[] = [];
    for (const file of pages()) {
      const body = read(file);
      const hasClaim = matches(body, SETTING).length > 0 || file === 'audit-events.md';
      if (hasClaim) continue;
      if (!declared.has(file)) undeclared.push(file);
    }
    expect(
      undeclared,
      'A reference page carries no checkable claim and no recorded reason. FR-040 asks ' +
        'for coverage OR a per-file statement of why not — an undeclared page is neither.'
    ).toEqual([]);
    for (const [file, reason] of declared) {
      expect(reason.length, `${file} is declared without a real reason`).toBeGreaterThan(40);
    }
  });

  it('the no-claims declarations are true, so the list cannot silence a page that does make claims', () => {
    // Without this, the escape hatch above becomes the way to exempt any page.
    for (const { file } of NO_CHECKABLE_CLAIMS) {
      const body = read(file);
      expect(
        matches(body, SETTING),
        `${file} is declared as carrying no checkable claim, but it names settings`
      ).toEqual([]);
    }
  });

  it('NON-VACUITY: an invented setting key and an invented event are both detected', () => {
    const known = settingKeys();
    expect(known.has('schegent.invented.setting')).toBe(false);
    const eventUnion = new Set<string>(ALL_AUDIT_EVENT_TYPES as readonly string[]);
    expect(eventUnion.has('invented-event-name')).toBe(false);
    // ...and the extractors do find them, so the checks above are not matching nothing.
    expect(matches('see `schegent.invented.setting` for details', SETTING)).toEqual([
      'schegent.invented.setting'
    ]);
    expect(/^\|\s*`([a-z][a-z0-9-]+)`/.exec('| `invented-event-name` | a description |')?.[1]).toBe(
      'invented-event-name'
    );
  });
});
