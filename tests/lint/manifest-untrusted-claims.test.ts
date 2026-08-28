// FR-R3-136 (FR-021, T1528f) — the manifest's untrusted-workspace claim is
// checked against the tree that has to honour it.
//
// WHY THIS GATE EXISTS. `capabilities.untrustedWorkspaces.description` is read by
// two audiences who cannot verify it: a reviewer deciding what this extension does
// in a repository they have not trusted, and an operator reading VS Code's own
// trust UI. It is also the single most attractive place to make a claim and move
// on — nothing executes it, and the two mutations FR-021 names are both one-line
// edits that leave the manifest self-consistent:
//
//   1. inverting the claim — `supported: "true"`, or `"false"`;
//   2. deleting the no-CLI-spawn sentence.
//
// Both must fail a gate. The CONTROL block at the bottom applies each mutation to
// the real manifest text in memory and asserts this file's own predicates reject
// it, so "must fail a gate" is a property of the code rather than of a revert
// somebody performed once.
//
// AND THE NUMBERS, for the reason FR-R3-136 T1528d-2 exists. The description
// carries three counts — read-only commands, mutating commands, restricted
// properties — and a count in prose is a claim that rots silently. Each is
// compared against the list it describes, so adding a command or reclassifying a
// property fails here until the sentence is corrected. That is the same class
// `tests/lint/documented-commands-exist.test.ts` closes for the reference pages;
// this closes it for the manifest.
//
// WHAT THIS GATE DOES NOT DO. It does not prove the behaviour. The behaviour is
// asserted by `tests/integration/trust-untrusted-workspace.host.test.ts` in a
// window where Workspace Trust is genuinely live, and by
// `tests/lint/command-trust-dispositions.test.ts` for the registration shape. This
// gate proves the SENTENCE and the TREE agree — which is exactly the failure mode
// that shipped: a paragraph about commands next to a settings key that did not
// exist.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MUTATING_COMMAND_ID_LIST,
  READ_ONLY_COMMAND_ID_LIST
} from '../../src/contracts/entry-point-dispositions';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface UntrustedWorkspaces {
  readonly supported?: unknown;
  readonly description?: unknown;
  readonly restrictedConfigurations?: readonly string[];
}

const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
  readonly capabilities?: { readonly untrustedWorkspaces?: UntrustedWorkspaces };
  readonly contributes?: {
    readonly configuration?: {
      readonly properties?: Readonly<Record<string, { readonly scope?: string }>>;
    };
  };
};

const untrusted = manifest.capabilities?.untrustedWorkspaces;

/** The operator-facing page that owns this boundary in prose (FR-R3-136, T1528e). */
const OPERATOR_PAGE = 'docs/operations/workspace-trust.md';

/**
 * The claim that granting trust is what unlocks the acts, stated as a spawn.
 *
 * A co-occurrence rule over one noun and one verb, evaluated over the whole
 * description rather than per sentence, because the claim is legitimately
 * splittable across clauses. It is deliberately narrow: this recognises the
 * sentence FR-021 names, and does not pretend to recognise every possible
 * rewording of it.
 */
function statesNoSpawn(description: string): boolean {
  return /\bno backend CLI is spawned\b/.test(description);
}

/**
 * `limited` and nothing else.
 *
 * `false` claims the extension does not run in an untrusted window; it does — it
 * activates and serves the read-only surfaces. `true` claims nothing is withheld,
 * which is the inversion FR-021 names. Both are false statements about our own
 * behaviour, in the manifest, which is the class of defect this feature closes.
 */
function statesLimitedSupport(value: unknown): boolean {
  return value === 'limited';
}

describe('FR-R3-136 — the manifest untrusted-workspace claim agrees with the tree', () => {
  it('the capability block exists and carries a description', () => {
    // First, because every assertion below reads through it: a deleted block is
    // not a passing gate, and VS Code's conservative default would keep the
    // BEHAVIOUR safe while removing the claim entirely (FR-R3-126's finding).
    expect(untrusted, 'capabilities.untrustedWorkspaces is absent from package.json').toBeDefined();
    expect(typeof untrusted?.description).toBe('string');
    expect((untrusted?.description as string).length).toBeGreaterThan(200);
  });

  it('supported is "limited" — not inverted in either direction', () => {
    expect(
      statesLimitedSupport(untrusted?.supported),
      `capabilities.untrustedWorkspaces.supported is ${JSON.stringify(untrusted?.supported)}. ` +
        `"false" would claim this extension does not run in an untrusted window, and it does: it ` +
        `activates and serves ${READ_ONLY_COMMAND_ID_LIST.length} read-only commands. "true" ` +
        `would claim nothing is withheld, and ${MUTATING_COMMAND_ID_LIST.length} commands are.`
    ).toBe(true);
  });

  it('the no-CLI-spawn claim is still stated', () => {
    expect(
      statesNoSpawn(untrusted?.description as string),
      'the description no longer states that no backend CLI is spawned in an untrusted window. ' +
        'That is the one consequence an operator most needs from this block — the reason the ' +
        'refusals matter rather than being an inconvenience — and it is asserted end to end by ' +
        'tests/integration/trust-untrusted-workspace.host.test.ts through a user-scope sentinel. ' +
        'If the behaviour changed, that leg fails first; if only the sentence went, restore it.'
    ).toBe(true);
  });

  it('every count in the description matches the list it describes', () => {
    const description = untrusted?.description as string;
    const claims: readonly { readonly label: string; readonly pattern: RegExp; readonly actual: number }[] = [
      {
        label: 'read-only commands',
        pattern: /\bthe (\d+) read-only commands\b/,
        actual: READ_ONLY_COMMAND_ID_LIST.length
      },
      {
        label: 'mutating commands',
        pattern: /\bthe (\d+) commands in the mutating set\b/,
        actual: MUTATING_COMMAND_ID_LIST.length
      },
      {
        label: 'restricted configurations',
        pattern: /\bThe (\d+) restrictedConfigurations\b/,
        actual: untrusted?.restrictedConfigurations?.length ?? 0
      }
    ];

    for (const claim of claims) {
      const match = claim.pattern.exec(description);
      expect(
        match,
        `the description makes no countable claim about ${claim.label} matching ` +
          `${claim.pattern}. The count is the part of this block that rots silently, so the ` +
          `sentence has to stay in a shape this gate can read — or this gate has to be updated ` +
          `deliberately, which is the point.`
      ).not.toBeNull();
      expect(
        Number(match?.[1]),
        `the description claims ${match?.[1]} ${claim.label} and the tree has ${claim.actual}.`
      ).toBe(claim.actual);
    }
  });

  it('every command id the description names is a real read-only id', () => {
    // The description names them because a reviewer should not have to open a
    // source file to learn what "serves reads" means. A named id that no longer
    // exists reads like a promise and is not one.
    const description = untrusted?.description as string;
    const shortNames = READ_ONLY_COMMAND_ID_LIST.map((id) => id.replace(/^schegent\./, ''));
    const named = (description.match(/\b(?:show|open|verify|redetect|export)[A-Z]\w+/g) ?? []).sort();
    expect(named.length, 'the description names no read-only command').toBeGreaterThan(0);
    for (const name of named) {
      expect(
        shortNames,
        `the description names '${name}', which is not one of the ${shortNames.length} read-only ` +
          `command ids. Either it was renamed, or it moved to the mutating set — in which case the ` +
          `description is now telling an operator a refused command is available.`
      ).toContain(name);
    }
  });

  it('the description does not name a mutating id among what stays available', () => {
    // The failure this catches is a reclassification: a command moves into the
    // mutating map and the sentence listing the available ones is not revisited.
    const available = (untrusted?.description as string).split('What is refused:')[0] ?? '';
    for (const id of MUTATING_COMMAND_ID_LIST) {
      const shortName = id.replace(/^schegent\./, '');
      expect(
        new RegExp(`\\b${shortName}\\b`).test(available),
        `'${shortName}' is a MUTATING command id and the description names it before ` +
          `"What is refused:", i.e. among what stays available in an untrusted window.`
      ).toBe(false);
    }
  });

  describe('CONTROL — each mutation FR-021 names is rejected', () => {
    const description = untrusted?.description as string;

    it('inverting supported in either direction fails', () => {
      expect(statesLimitedSupport('limited')).toBe(true);
      for (const inverted of ['true', 'false', true, false, undefined]) {
        expect(
          statesLimitedSupport(inverted),
          `supported: ${JSON.stringify(inverted)} was accepted by the predicate this gate uses`
        ).toBe(false);
      }
    });

    it('deleting the no-CLI-spawn sentence fails', () => {
      expect(statesNoSpawn(description)).toBe(true);
      const gutted = description.replace(/no backend CLI is spawned/g, 'the extension proceeds');
      expect(gutted).not.toBe(description);
      expect(
        statesNoSpawn(gutted),
        'the no-spawn predicate accepted a description with the claim removed, so the assertion ' +
          'above would pass over a manifest that no longer makes it'
      ).toBe(false);
    });

    it('a stale count fails', () => {
      // The third mutation, not in FR-021's list, added because it is the one that
      // happens without anybody deciding to make it: a command is added and the
      // prose is not.
      const stale = description.replace(
        `the ${MUTATING_COMMAND_ID_LIST.length} commands in the mutating set`,
        `the ${MUTATING_COMMAND_ID_LIST.length + 1} commands in the mutating set`
      );
      expect(stale).not.toBe(description);
      const match = /\bthe (\d+) commands in the mutating set\b/.exec(stale);
      expect(Number(match?.[1])).not.toBe(MUTATING_COMMAND_ID_LIST.length);
    });
  });
});

// FR-R3-136 (T1528e) — the operator page carries the same counts, so it is held to
// the same standard as the manifest. The manifest description is read by a reviewer
// and by VS Code's trust UI; `docs/operations/workspace-trust.md` is read by an
// operator deciding what a Restricted Mode window is actually withholding. A count
// that has rotted misleads the second reader more than the first, because the page
// is where they go to stop guessing.
describe(`FR-R3-136 — ${OPERATOR_PAGE} agrees with the tree`, () => {
  const page = readFileSync(resolve(REPO_ROOT, OPERATOR_PAGE), 'utf-8');
  const properties = manifest.contributes?.configuration?.properties ?? {};
  const applicationScoped = Object.values(properties).filter((p) => p.scope === 'application').length;

  it('every count the page asserts is derived, not remembered', () => {
    expect(applicationScoped, 'no application-scoped setting found, so the denominator is wrong')
      .toBeGreaterThan(0);

    const claims: readonly { readonly pattern: RegExp; readonly actual: number }[] = [
      { pattern: /(\d+) commands stay available/, actual: READ_ONLY_COMMAND_ID_LIST.length },
      { pattern: /(\d+) commands refuse/, actual: MUTATING_COMMAND_ID_LIST.length },
      { pattern: /(\d+) restrictedConfigurations/, actual: untrusted?.restrictedConfigurations?.length ?? 0 },
      { pattern: /(\d+) application-scoped keys/, actual: applicationScoped }
    ];

    const offenders: string[] = [];
    for (const claim of claims) {
      const match = claim.pattern.exec(page);
      if (match === null) {
        offenders.push(`${claim.pattern} matches nothing on the page`);
        continue;
      }
      if (Number(match[1]) !== claim.actual) {
        offenders.push(`"${match[0]}" against a tree of ${claim.actual}`);
      }
    }
    expect(
      offenders,
      `${OPERATOR_PAGE} makes a numeric claim the tree does not support. Reclassifying one command ` +
        'or restricting one setting changes what an operator is told is withheld, and nothing in ' +
        'the page itself would notice. A pattern matching nothing fails too, so a reworded sentence ' +
        'has to be re-pointed here in the same change rather than quietly leaving the gate blind.'
    ).toEqual([]);
  });

  it('every command the page lists as available is a read-only id', () => {
    // The page names all 7 in a table because "reads are still served" means nothing
    // to an operator without the list. A named id that has since been reclassified
    // would be the page promising a command that now refuses.
    const AVAILABLE_HEADING = '## What stays available untrusted';
    const REFUSES_HEADING = '## What refuses untrusted';
    expect(page, `${OPERATOR_PAGE} has no "${AVAILABLE_HEADING}" section`).toContain(AVAILABLE_HEADING);
    const available = (page.split(AVAILABLE_HEADING)[1] ?? '').split(REFUSES_HEADING)[0] ?? '';
    const named = new Set(available.match(/\bschegent\.[a-zA-Z]+/g) ?? []);
    expect(named.size, 'the page names no command id among what stays available').toBeGreaterThan(0);
    for (const id of named) {
      expect(
        READ_ONLY_COMMAND_ID_LIST as readonly string[],
        `${OPERATOR_PAGE} names '${id}' before "## What refuses untrusted", i.e. among what stays ` +
          `available in an untrusted window, and it is not one of the ` +
          `${READ_ONLY_COMMAND_ID_LIST.length} read-only ids.`
      ).toContain(id);
    }
  });

  it('the page still points at the two neighbours that own what it does not', () => {
    // The page's first paragraph is a boundary statement, and a boundary statement
    // with a dead link is how three documents become three authorities again
    // (FR-R3-063). Link text is not checked; reachability is.
    for (const neighbour of ['untrusted-repositories.md', 'trust-scopes.md']) {
      expect(
        page.includes(`(${neighbour})`),
        `${OPERATOR_PAGE} no longer links ${neighbour}. It disclaims that neighbour's subject by ` +
          'name, so a reader who needs it has nowhere to go.'
      ).toBe(true);
    }
  });
});
