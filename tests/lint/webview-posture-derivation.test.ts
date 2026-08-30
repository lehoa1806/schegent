// FR-R3-144 (T024) — the webview renders posture; it never computes one.
//
// THE FINDING THIS GATE HOLDS SHUT
//
// Containment is a policy answer. `src/services/backend-containment-policy.ts`
// owns it, `judgeBackendContainment` refuses a spawn with it, and D-4 projects it
// onto the snapshot so a surface can show it. A webview that re-derived the same
// answer would be a second authority for one fact, and the two would part company
// the first time a backend's mechanism changed — silently, and in the direction
// that shows an operator a grant they do not have.
//
// WHAT IS FORBIDDEN, AND WHAT IS EXPLICITLY ALLOWED
//
// T024 is unusually careful about this, because a gate that fails the correct
// implementation is worse than no gate: it teaches the next author to route around
// it. So:
//
//   ALLOWED — rendering a projected discriminant. `{#if posture.grant ===
//   'not-granted'}`, `{posture.mechanism}`, a `{#each}` over `backendPostures`, a
//   `case` on a projected value. The webview is supposed to branch on what it was
//   handed; that is what a discriminant is for, and `rendersAProjection()` below is
//   asserted to pass every one of those forms.
//
//   FORBIDDEN — three shapes, each a way of *producing* the answer rather than
//   reading it:
//
//     1. The host's containment vocabulary as a literal. `'os-enforced'` and every
//        mechanism identifier have no rendering use — the webview shows the
//        projected value, it does not name it — so their presence at all means
//        something in the webview is deciding. The list is DERIVED from the policy
//        module's own tables, so a mechanism added there is forbidden here on the
//        same day, with no edit to this file.
//     2. A grant state in *producing* position — assigned, returned, an arrow body,
//        a ternary branch, or an object-literal value. That is the webview deciding
//        `granted` versus `not-granted`; comparison position is untouched.
//     3. The uncontained-grant setting key. A webview that read the raw list and
//        tested membership would derive the answer without ever naming a
//        classification, which is rule 2 evaded rather than obeyed.
//
// WHAT IT DOES NOT CATCH, stated rather than implied
//
// `'none'` is excluded from rule 1. It is the mechanism identifier for "no
// containment" AND a CSS keyword (`style.display = 'none'`), and a gate that
// cannot tell those apart would fail on styling. A containment decision needs
// `'os-enforced'` on one side to be a decision at all, so rule 1 still catches the
// derivation; what escapes is a webview that produces only `'none'`, which asserts
// nothing an operator can act on wrongly.
//
// Webview TEST files are out of scope for rules 1 and 2. A test that renders a
// posture has to construct one, and a fixture standing in for the host projection
// is the opposite of the defect — it is the webview being fed, not deciding. Rule 3
// applies to them too: nothing under `webview-ui/src` has business reading the
// setting. The exclusion is bounded by an assertion that the test tree is non-empty,
// so it cannot quietly become "the whole scan".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesReferencing, scanWebviewSources } from './webview-source-scan';
import {
  ALLOW_UNCONTAINED_SETTING,
  containmentByBackend,
  mechanismByBackend
} from '../../src/services/backend-containment-policy';
import type { BackendGrantState } from '../../src/contracts/sidebar-ipc/uncontained-grant';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ANCHOR = 'webview-ui/src/components/settings/GeneralSettingsTab.svelte';

/**
 * The containment vocabulary, read off the policy's own tables.
 *
 * Transcribing it here would make this gate a second copy of the thing it exists
 * to keep single. `'none'` is dropped for the reason the header gives.
 */
const FORBIDDEN_VOCABULARY: readonly string[] = [
  ...new Set([...containmentByBackend().values(), ...mechanismByBackend().values()])
].filter((value) => value !== 'none');

/**
 * The three grant states, tied to the contract at compile time.
 *
 * A union has no runtime members to enumerate, so the tie is the type check below:
 * add a fourth state to `BackendGrantState` without adding it here and this file
 * stops compiling, rather than silently policing two of four.
 */
const GRANT_STATES = ['granted', 'not-granted', 'not-required'] as const;
const _everyStateIsPoliced: BackendGrantState extends (typeof GRANT_STATES)[number]
  ? true
  : never = true;
void _everyStateIsPoliced;

const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `'x'`, `"x"` or `` `x` `` — quoted so `'granted'` cannot match inside `'not-granted'`. */
const quoted = (literal: string): RegExp => new RegExp(`(['"\`])${escape(literal)}\\1`);

/**
 * A literal in *producing* position: assigned, returned, an arrow body, a ternary
 * branch, or an object-literal value.
 *
 * The lookbehind is the whole distinction. `=` matches an assignment but not the
 * tail of `===` or `!==`, so `posture.grant === 'granted'` — the allowed form — is
 * not a match, while `grant = 'granted'` is.
 */
const producing = (literal: string): RegExp =>
  new RegExp(
    `(?:(?<![=!<>])=|=>|\\breturn|\\?|:)\\s*(['"\`])${escape(literal)}\\1`
  );

const isWebviewTest = (path: string): boolean =>
  path.includes('/__tests__/') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Rule 1: any containment-vocabulary literal in this source. */
function containmentVocabularyIn(source: string): string[] {
  return FORBIDDEN_VOCABULARY.filter((literal) => quoted(literal).test(source));
}

/** Rule 2: any grant state this source produces rather than reads. */
function producedGrantStatesIn(source: string): string[] {
  return GRANT_STATES.filter((state) => producing(state).test(source));
}

/** Rule 3: the raw setting key, wherever it appears. */
function readsTheSettingKey(source: string): boolean {
  return source.includes(ALLOW_UNCONTAINED_SETTING);
}

interface Offender {
  readonly file: string;
  readonly found: readonly string[];
}

const shipped = scanWebviewSources().filter((file) => !isWebviewTest(file.path));
const webviewTests = scanWebviewSources().filter((file) => isWebviewTest(file.path));

describe('FR-R3-144 T024 — the webview never computes a containment answer (FR-008, A-3)', () => {
  it('scanned a non-empty webview tree, including the settings surface', () => {
    // Without this every assertion below passes on an empty scan — the failure a
    // forbidding gate can least afford.
    expect(scanWebviewSources().length).toBeGreaterThan(50);
    expect(scanWebviewSources().map((file) => file.path)).toContain(ANCHOR);
    expect(shipped.length).toBeGreaterThan(50);
  });

  it('has a non-empty vocabulary to forbid', () => {
    // The list is derived, so a policy refactor could empty it and leave this gate
    // passing over nothing. It is asserted rather than assumed.
    expect(FORBIDDEN_VOCABULARY).toContain('os-enforced');
    expect(FORBIDDEN_VOCABULARY.length).toBeGreaterThanOrEqual(2);
  });

  it('the test exclusion covers a real, bounded set — not the whole scan', () => {
    expect(webviewTests.length).toBeGreaterThan(0);
    expect(webviewTests.length).toBeLessThan(shipped.length);
  });

  it('no shipped webview source names the containment vocabulary', () => {
    const offenders: Offender[] = [];
    for (const file of shipped) {
      const found = containmentVocabularyIn(file.contents);
      if (found.length > 0) offenders.push({ file: file.path, found });
    }
    expect(offenders).toEqual([]);
  });

  it('no shipped webview source PRODUCES a grant state', () => {
    const offenders: Offender[] = [];
    for (const file of shipped) {
      const found = producedGrantStatesIn(file.contents);
      if (found.length > 0) offenders.push({ file: file.path, found });
    }
    expect(offenders).toEqual([]);
  });

  it('no webview source at all — tests included — reads the uncontained-grant setting', () => {
    expect(filesReferencing(ALLOW_UNCONTAINED_SETTING)).toEqual([]);
    const offenders = scanWebviewSources()
      .filter((file) => readsTheSettingKey(file.contents))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('ALLOWED, and the gate says so: rendering a projected discriminant passes', () => {
    // This is the half T024 asks for explicitly. Each form below is what the
    // correct implementation looks like, and each must be clean under all three
    // rules — otherwise the gate's first effect is to teach the next author to
    // route around it.
    const rendering = [
      `{#if posture.grant === 'not-granted'}<GrantButton kind={posture.kind} />{/if}`,
      `{#each snapshot.backendPostures as posture (posture.kind)}<Row {posture} />{/each}`,
      `<span>{posture.mechanism}</span><span>{posture.containment}</span>`,
      `const needsGrant = $derived(posture.grant !== 'not-required');`,
      `switch (posture.grant) { case 'granted': return label; default: return null; }`,
      `{#if posture.problem}<Problem message={posture.problem} />{/if}`
    ];
    for (const form of rendering) {
      expect(containmentVocabularyIn(form), form).toEqual([]);
      expect(producedGrantStatesIn(form), form).toEqual([]);
      expect(readsTheSettingKey(form)).toBe(false);
    }
  });

  it('NON-VACUITY: a derivation injected into the real settings tab is detected', () => {
    // Derived from the tree rather than authored beside the gate: the surrounding
    // file is the real one, and the injected line is the exact shape D-4 replaced —
    // a component deciding containment from a backend id.
    const real = readFileSync(resolve(REPO_ROOT, ANCHOR), 'utf8');
    const mutated = real.replace(
      /<script lang="ts">/,
      `<script lang="ts">\n  const containment = kind === 'codex' ? 'os-enforced' : 'none';`
    );
    expect(mutated).not.toBe(real);
    expect(containmentVocabularyIn(mutated)).toContain('os-enforced');
    expect(containmentVocabularyIn(real)).toEqual([]);
  });

  it('NON-VACUITY: each forbidden shape is detected, and its allowed twin is not', () => {
    expect(producedGrantStatesIn(`const grant = 'granted';`)).toEqual(['granted']);
    expect(producedGrantStatesIn(`return 'not-required';`)).toEqual(['not-required']);
    expect(producedGrantStatesIn(`const g = () => 'not-granted';`)).toEqual(['not-granted']);
    expect(producedGrantStatesIn(`const g = listed ? 'granted' : 'not-granted';`)).toEqual([
      'granted',
      'not-granted'
    ]);
    expect(producedGrantStatesIn(`const row = { grant: 'granted' };`)).toEqual(['granted']);
    // A webview-side copy of the union is one edit from being a derivation, which
    // is why `webview-ui/src/lib/snapshot-types.ts` imports the type instead. Only
    // the union's first member sits in producing position — the rest follow `|` —
    // and one match is what fails the rule, so the declaration is caught whole.
    expect(producedGrantStatesIn(`type G = 'granted' | 'not-granted' | 'not-required';`)).toEqual([
      'granted'
    ]);

    expect(producedGrantStatesIn(`if (posture.grant === 'granted') {}`)).toEqual([]);
    expect(producedGrantStatesIn(`if (posture.grant !== 'not-required') {}`)).toEqual([]);
    expect(containmentVocabularyIn(`style.display = 'none';`)).toEqual([]);

    expect(readsTheSettingKey(`config.get('${ALLOW_UNCONTAINED_SETTING}')`)).toBe(true);
    expect(readsTheSettingKey(`config.get('schegent.logging.verbose')`)).toBe(false);
  });
});
