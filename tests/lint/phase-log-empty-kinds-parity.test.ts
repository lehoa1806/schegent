// Feature 203 (T063-T067, D9, V3, V3.1, FR-021, FR-023, FR-026, FR-027,
// FR-028, FR-029, FR-030, SC-010) — the two statements of the empty-kind
// vocabulary that cannot be imports are held equal to the authority here.
//
// THE COPIES (F7, F19). The vocabulary was written by hand in four places: the
// authority in `src/services/phase-log/types.ts`, a wire-contract duplicate, the
// visual fixture, and the architecture blueprint. The wire duplicate became an
// `import type` (D6). The other two cannot import anything — the fixture is JSON
// a visual harness consumes, the blueprint is prose in a live document — so they
// are read as text and compared with the authority read as a VALUE. The
// authority is a runtime `as const` array (D1) precisely so this file can
// iterate it rather than restate it: a gate written against an erased union
// would carry a fifth copy, and be the one copy nothing checks.
//
// RULE 67 (AGENTS.md:985-992 at HEAD) — THE NARROWING, STATED (V3.1, F17).
// This gate searches for MEMBER STRING LITERALS, which are distinctive. It does
// NOT search for `verboseDiagnosticsState`, which is not: F17 records a file
// that carries that identifier while never comparing it (the store forwards the
// field and decides nothing by it), so a gate keyed on the field name would
// report on a population it was not written about. What is read is therefore
// exactly two named locations. The blueprint's block is found by the array
// declaration inside its enclosing code fence, never by a line number; the
// fixture is not searched at all — it is parsed as JSON and the one field the
// visual harness renders the classification from is read by its address.
//
// BOTH DIRECTIONS, AS TWO TESTS. Equal counts are not the property: eight
// equals eight is satisfied by two lists that disagree about two members. Each
// direction is its own `it` because the first `expect` to fail ends a test, and
// a second difference hidden behind the first would go unreported — the
// reasoning `blueprint-configuration-parity.test.ts` already records for the
// gate this one is modelled on. Every failure names the members, never a count.
//
// ENVELOPE-DEPENDENT. The blueprint lives in the planning envelope above
// `repo/`, which a standalone execution-repository clone does not have.
// `envelopePresent()` is decided once at module scope and every blueprint `it`
// returns early when it is absent, with the reason stated beside the return —
// a skip, never a silent pass. The fixture and the parser control live inside
// `repo/` and run everywhere.
//
// HERMETIC — `node:fs` only. Spawns nothing, imports nothing from
// `node:child_process` (`lint-gates-are-hermetic.test.ts`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ENVELOPE_ROOT, envelopePresent } from './envelope-presence';
import { PHASE_LOG_EMPTY_KINDS } from '../../src/services/phase-log/types';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BLUEPRINT_REL = 'docs/architecture/blueprint.md';
const FIXTURE_REL = 'tests/visual/fixtures/phase-log-response.json';

/** The declaration the blueprint block opens with. Exactly one, or this gate stops. */
const ARRAY_ANCHOR = 'const PHASE_LOG_EMPTY_KINDS = [';
const FENCE = '```';

/** A member is a kebab-case literal in single quotes inside the array. */
const MEMBER_LITERAL = /'([a-z][a-z0-9-]*)'/g;

/**
 * Floors under the two parses. The vocabulary is eight members today; a parse
 * that returns fewer than five found a fragment or a reformatted block, not a
 * smaller vocabulary. Vocabulary changes are reported by the two direction
 * tests below, by name — these floors only say whether there was anything to
 * compare. Each was demonstrated red against an emptied input before it was
 * trusted (T069).
 */
const MIN_BLUEPRINT_MEMBERS = 5;
const MIN_FIXTURE_KINDS = 1;

/**
 * The parser control (D9): a block whose members are known here, so the parser
 * is proven to extract what it is shown before it is trusted on the blueprint.
 * It carries the three things the real block carries that must NOT count — a
 * trailing comment on the opening line, a quoted literal inside a comment, and
 * a literal after the closing bracket — and runs without the envelope, because
 * the parser is what the envelope tests lean on.
 */
const PARSER_CONTROL = [
  "## A block shaped like the blueprint's",
  '',
  '```ts',
  'const PHASE_LOG_EMPTY_KINDS = [        // a trailing comment, like the real block',
  "  'first-kind',                        // 'quoted-in-a-comment' must not count",
  "  'second-kind'",
  '] as const;',
  "type Unrelated = 'after-the-bracket';",
  '```'
].join('\n');
const PARSER_CONTROL_MEMBERS = ['first-kind', 'second-kind'];

/**
 * The fenced code block containing `index`, or `null` when the index sits in
 * prose. A fence opened before the index and not yet closed encloses it; an
 * even count of fences before the index means every one of them has closed.
 */
function enclosingFence(markdown: string, index: number): string | null {
  const before = markdown.slice(0, index);
  const fencesBefore = before.split(FENCE).length - 1;
  if (fencesBefore % 2 === 0) return null;
  const fenceEnd = markdown.indexOf(FENCE, index);
  if (fenceEnd === -1) return null;
  return markdown.slice(before.lastIndexOf(FENCE), fenceEnd);
}

/**
 * The members the blueprint's `PHASE_LOG_EMPTY_KINDS` block declares, in order.
 *
 * Returns `[]` when the declaration is absent or quoted outside a fence, so the
 * module loads without the envelope; the vacuity control is what turns that
 * empty result red when the envelope IS present. Throws on a second
 * declaration: two blocks would mean this gate reports on whichever came first
 * and stays silent about the other.
 */
function blueprintMembers(markdown: string): readonly string[] {
  const start = markdown.indexOf(ARRAY_ANCHOR);
  if (start === -1) return [];
  if (markdown.indexOf(ARRAY_ANCHOR, start + 1) !== -1) {
    throw new Error(
      `${BLUEPRINT_REL} contains ${JSON.stringify(ARRAY_ANCHOR)} more than once. ` +
        'This gate reads exactly one declaration of the vocabulary; two means it would ' +
        'report on whichever came first and stay silent about the other.'
    );
  }
  const fence = enclosingFence(markdown, start);
  if (fence === null) return [];

  const declaration = fence.slice(fence.indexOf(ARRAY_ANCHOR) + ARRAY_ANCHOR.length);
  const uncommented = declaration
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const close = uncommented.indexOf(']');
  if (close === -1) {
    throw new Error(`${BLUEPRINT_REL}: the array opened by ${ARRAY_ANCHOR} never closes.`);
  }
  return [...uncommented.slice(0, close).matchAll(MEMBER_LITERAL)].map(
    (match) => match.at(1) ?? ''
  );
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

/**
 * The classification the fixture carries, read by its address: the visual
 * harness renders `manifest.verboseDiagnosticsState`, and this reads the same
 * field of the same document. A shape the address does not fit yields nothing,
 * and the floor reports it rather than passing over it.
 */
function fixtureKinds(json: string): readonly string[] {
  const response: unknown = JSON.parse(json);
  const kind = field(field(field(response, 'manifest'), 'verboseDiagnosticsState'), 'kind');
  return typeof kind === 'string' ? [kind] : [];
}

const present = envelopePresent();
const blueprint = present ? readFileSync(resolve(ENVELOPE_ROOT, BLUEPRINT_REL), 'utf8') : '';
const blueprintKinds = blueprintMembers(blueprint);
const fixtureClassifications = fixtureKinds(readFileSync(resolve(REPO_ROOT, FIXTURE_REL), 'utf8'));
const authority: ReadonlySet<string> = new Set(PHASE_LOG_EMPTY_KINDS);

describe('feature 203 — the two textual copies of the empty-kind vocabulary agree with the authority', () => {
  it('the parser extracts exactly the members of a block it is shown', () => {
    expect(blueprintMembers(PARSER_CONTROL)).toEqual(PARSER_CONTROL_MEMBERS);
  });

  it('reaches the blueprint block and the fixture classification it governs', () => {
    // Vacuity control. Every assertion below is a set difference, and a set
    // difference against nothing is green. If the declaration is renamed, moved
    // out of its fence or reformatted, this is the test that says so.
    expect(
      fixtureClassifications.length,
      `${FIXTURE_REL} carries no classification at manifest.verboseDiagnosticsState.kind; ` +
        'the fixture half of this gate is reading nothing'
    ).toBeGreaterThanOrEqual(MIN_FIXTURE_KINDS);
    if (!present) {
      // No planning envelope above repo/: the blueprint is not here to read, and
      // an empty parse is the correct result rather than a finding.
      expect(blueprintKinds).toEqual([]);
      return;
    }
    expect(
      blueprint.includes(ARRAY_ANCHOR),
      `"${ARRAY_ANCHOR}" is gone from ${BLUEPRINT_REL}; this gate is reading nothing`
    ).toBe(true);
    expect(
      blueprintKinds.length,
      `the ${BLUEPRINT_REL} block parsed to fewer members than it can possibly have — ` +
        'the format changed, or the declaration left its code fence'
    ).toBeGreaterThanOrEqual(MIN_BLUEPRINT_MEMBERS);
  });

  // Two tests rather than two assertions in one, because the first `expect` to
  // fail ends the test, and a member missing from the blueprint would hide a
  // member the blueprint invented.
  it('the blueprint declares every member the authority has', () => {
    if (!present) return; // no envelope, so no blueprint to hold to the authority

    const declared = new Set(blueprintKinds);
    const missing = PHASE_LOG_EMPTY_KINDS.filter((member) => !declared.has(member));
    expect(
      missing,
      `These members are in PHASE_LOG_EMPTY_KINDS and not in the ${BLUEPRINT_REL} block. ` +
        'A reader of the architecture document concludes the situation does not exist. ' +
        "Add them to the block, in the authority's order."
    ).toEqual([]);
  });

  it('the blueprint declares no member the authority lacks', () => {
    if (!present) return; // no envelope, so no blueprint to hold to the authority

    const invented = blueprintKinds.filter((member) => !authority.has(member));
    expect(
      invented,
      `These members are in the ${BLUEPRINT_REL} block and not in PHASE_LOG_EMPTY_KINDS. ` +
        'A documented kind of nothing that no read can produce is a card nobody will ever ' +
        'see (FR-037). Remove them, or add them to the authority with a production site.'
    ).toEqual([]);
  });

  it('the fixture classifies with a member of the authority', () => {
    const foreign = fixtureClassifications.filter((kind) => !authority.has(kind));
    expect(
      foreign,
      `${FIXTURE_REL} carries a classification the authority does not declare. The visual ` +
        'harness would render a card for a kind of nothing the host can never report — a ' +
        'retired member surviving in a fixture is exactly how the last vocabulary outlived itself.'
    ).toEqual([]);
  });
});
