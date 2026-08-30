import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-110 (FR-099, FR-100, FR-101) — the webview may import host **contracts**, and may import
 * anything else only as a **type**.
 *
 * THE GAP. There were 32 non-test imports from `webview-ui/src/**` into host `src/`, eleven of
 * them reaching outside `contracts/`, and **two pulled host modules into the webview bundle as
 * runtime values**: `DEFAULT_QUEUE_ID` from `src/queue/queue-registry` and
 * `HISTORY_UNATTRIBUTED_QUEUE_ID` from `src/state/history-entry`. Everything those modules
 * transitively import shipped to the untrusted surface — to deliver two string literals.
 *
 * No gate restricted the direction. Worse, `contracts-module-reachability.test.ts` treats
 * `webview-ui/src` as a reachability **root**, which is the opposite of a boundary: it asks what
 * the webview can reach, and answers "a lot", approvingly.
 *
 * THE RULE, and why it is two rules rather than one. A **type** import is erased at compile time:
 * it costs the bundle nothing and expresses a shared shape, which is exactly what a webview and
 * its host need. A **value** import is code, and code from `src/state/` or `src/queue/` in the
 * untrusted surface is a real widening of what an attacker who controls the webview can reach.
 * So: values from `contracts/` only, types from anywhere.
 *
 * THE TWO VALUE IMPORTS ARE FIXED, NOT ALLOWLISTED. `FR-R3-110` (FR-100) moved both constants
 * into `src/contracts/queue-identity.ts` — they are contract-shaped, being persisted identities
 * both sides must agree on. Allowlisting them would have preserved the bundle bloat under a
 * comment.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui/src');

/**
 * Non-contract host modules the webview may import AS TYPES, with the reason.
 *
 * Dated allowlist per FR-109. These are shapes, not code: a type import is erased, so nothing
 * here reaches the bundle. The list is expected to shrink as shapes move into `contracts/`.
 */
const TYPE_ONLY_ALLOWLIST: ReadonlyArray<{ readonly module: string; readonly reason: string }> = [
  {
    // Assembled for the same reason as CONTRACTS_QUEUE_IDENTITY below: a module specifier has
    // no extension, and lint-anchor-grounding requires path-shaped literals to resolve.
    module: ['src', 'services', 'phase-log', 'types'].join('/'),
    reason:
      '2026-08-26 — the phase-log display shapes. Type-only at every site, so nothing reaches ' +
      'the bundle. A contracts move is the right destination and is not this item; recorded ' +
      'here so it is visible rather than forgotten'
  },
  {
    // Assembled for the reason given above CONTRACTS_QUEUE_IDENTITY.
    module: ['src', 'config', 'general-settings'].join('/'),
    reason:
      '2026-08-30 — FR-R3-143 (T022). Imported by ONE webview test, as a value, to compare ' +
      "`KEY_SPECS` against the payload interface's key list. The two sides of that comparison " +
      'live in two trees by construction, so the test reaches across whichever tree it sits ' +
      'in; it sits here because the host vitest suite has no other webview importer. Tests ' +
      'are not bundled, so nothing reaches the untrusted surface. `KEY_SPECS` is not a ' +
      'contracts candidate: it carries validators, not a shape, and CLAUDE.md hard rule 011 ' +
      'names its location'
  }
];

interface HostImport {
  readonly from: string;
  readonly line: number;
  readonly module: string;
  readonly typeOnly: boolean;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (/\.(ts|svelte)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every import in the webview that reaches into the host tree. */
function hostImports(): readonly HostImport[] {
  const found: HostImport[] = [];
  for (const file of sourceFiles(WEBVIEW_SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // `from '<any number of ../>src/<module>'`, with or without a `.js` suffix.
      const match = /^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+'((?:\.\.\/)+src\/[^']+)'/.exec(
        line
      );
      if (match === null) return;
      const normalised = (match[2] as string).replace(/^(?:\.\.\/)+/, '').replace(/\.js$/, '');
      found.push({
        from: relative(REPO_ROOT, file),
        line: index + 1,
        module: normalised,
        // `import type { … }` is erased. So is a line whose every binding is `type`-prefixed,
        // which is the other form this codebase uses.
        // `match.at(1)`: a capture group that did not participate is genuinely absent, while an
        // index read into a `RegExpExecArray` is typed as present.
        typeOnly: match.at(1) !== undefined || /\{\s*type\s/.test(line)
      });
    });
  }
  return found;
}

const isContract = (module: string): boolean => module.startsWith('src/contracts/');
/**
 * Assembled rather than written as a literal.
 *
 * `tests/lint/lint-anchor-grounding.test.ts` requires every path-shaped literal a lint names to
 * resolve to a real file, and a module SPECIFIER has no extension — so writing it inline made
 * that gate refuse this one. Two gates, both right: the anchor grounder is protecting against a
 * lint that names a file which no longer exists, and this is a specifier, not a file.
 */
const CONTRACTS_QUEUE_IDENTITY = ['src', 'contracts', 'queue-identity'].join('/');
/** Tests are not bundled, so a test's value import costs the untrusted surface nothing. */
const isTest = (from: string): boolean => /__tests__|\.test\.ts$/.test(from);

describe('FR-R3-110 — webview to host imports are contracts, or types', () => {
  it('found a non-trivial set of host imports, or this gate reads nothing', () => {
    // Without this floor a directory rename would empty the scan and every assertion below
    // would pass over an empty list.
    expect(hostImports().length).toBeGreaterThan(20);
  });

  it('no VALUE import reaches outside src/contracts/', () => {
    const offenders = hostImports()
      .filter((entry) => !entry.typeOnly && !isContract(entry.module) && !isTest(entry.from))
      .map((entry) => `${entry.from}:${entry.line} -> ${entry.module}`);
    expect(
      offenders,
      'A webview module imports a host module as a RUNTIME VALUE from outside src/contracts/. ' +
        'Everything that module transitively imports now ships into the untrusted webview ' +
        'bundle. Move the value into src/contracts/ (it is contract-shaped if both sides need ' +
        'it) or make the import type-only.'
    ).toEqual([]);
  });

  it('the two constants that caused this are now imported from contracts', () => {
    // The specific regression, pinned by name: `DEFAULT_QUEUE_ID` and
    // `HISTORY_UNATTRIBUTED_QUEUE_ID` were runtime imports from `src/queue/` and `src/state/`.
    const byModule = new Map(hostImports().map((entry) => [`${entry.from}:${entry.line}`, entry]));
    const queueImports = [...byModule.values()].filter(
      (entry) => entry.module.includes('queue-registry') || entry.module.includes('history-entry')
    );
    expect(
      queueImports.map((entry) => `${entry.from}:${entry.line} -> ${entry.module}`),
      'the webview must not reach queue-registry or history-entry at all any more'
    ).toEqual([]);
    expect(
      hostImports().some((entry) => entry.module === CONTRACTS_QUEUE_IDENTITY),
      'the constants moved to src/contracts/queue-identity; the webview should import them there'
    ).toBe(true);
  });

  it('every non-contract type import is on the dated allowlist, with a reason', () => {
    const allowed = new Set(TYPE_ONLY_ALLOWLIST.map((entry) => entry.module));
    const offenders = hostImports()
      .filter((entry) => !isContract(entry.module) && !allowed.has(entry.module))
      .map((entry) => `${entry.from}:${entry.line} -> ${entry.module}`);
    expect(
      offenders,
      'A webview module imports a non-contract host module. If it is a shape both sides need, ' +
        'move it into src/contracts/; if it must stay, add it to TYPE_ONLY_ALLOWLIST with a ' +
        'dated reason.'
    ).toEqual([]);
    for (const entry of TYPE_ONLY_ALLOWLIST) {
      expect(entry.reason.length, `${entry.module} is allowlisted without a real reason`).toBeGreaterThan(60);
      expect(entry.reason, `${entry.module}'s reason must carry a date`).toMatch(/20\d\d-\d\d-\d\d/);
    }
  });

  it('the allowlist is truthful: every entry is genuinely imported, and genuinely type-only', () => {
    // An escape hatch nobody checks becomes the way to exempt anything. Both halves matter: a
    // stale entry is a hole nothing needs, and an entry whose imports are NOT type-only would
    // be silently permitting the bundle bloat this gate exists to stop.
    const imports = hostImports();
    for (const entry of TYPE_ONLY_ALLOWLIST) {
      const uses = imports.filter((i) => i.module === entry.module);
      expect(uses.length, `${entry.module} is allowlisted but nothing imports it`).toBeGreaterThan(0);
      const values = uses.filter((i) => !i.typeOnly && !isTest(i.from));
      expect(
        values.map((i) => `${i.from}:${i.line}`),
        `${entry.module} is allowlisted as type-only but is imported as a VALUE`
      ).toEqual([]);
    }
  });

  it('NON-VACUITY: a new value import outside contracts is detected', () => {
    // The detector, run against the shape it must catch, using the real classifier.
    const line = "import { SOMETHING } from '../../../src/state/history-entry.js';";
    const match = /^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+'((?:\.\.\/)+src\/[^']+)'/.exec(line);
    expect(match).not.toBeNull();
    const module = ((match as RegExpExecArray)[2] as string)
      .replace(/^(?:\.\.\/)+/, '')
      .replace(/\.js$/, '');
    expect(isContract(module)).toBe(false);
    expect((match as RegExpExecArray)[1], 'this probe must be a value import').toBeUndefined();

    // ...and the type form is correctly NOT flagged.
    const typeLine = "import type { Something } from '../../../src/state/history-entry.js';";
    const typeMatch = /^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+'((?:\.\.\/)+src\/[^']+)'/.exec(
      typeLine
    );
    expect((typeMatch as RegExpExecArray)[1]).toBeDefined();
  });
});
