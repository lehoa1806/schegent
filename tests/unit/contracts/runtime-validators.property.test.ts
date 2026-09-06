// Property-based adversarial coverage for validateInboundMessage.
//
// `validateInboundMessage` in `src/contracts/runtime-validators.ts` is the
// single door every webview→host message comes through. The example files that
// drive chosen inputs at it are surveyed, with a date, in
// `docs/development/ipc-fuzz-hazard-map.md`; this file drives inputs nobody
// wrote, and
// pins the one promise the example tests never state as a property: for any
// input at all, the validator returns a well-shaped result and never throws.
//
// Seeded PRNG rather than `fast-check`, for the same reason
// `tests/unit/lib/logger-secret-patterns.property.test.ts` chose one: a
// deterministic generator makes a red reproducible from the file plus an
// integer, and adding a property-testing framework for a second use site is a
// dependency this repository has not needed yet. See
// `docs/development/ipc-fuzz-hazard-map.md` for the survey that decided which
// hazard classes are worth generating and which the example suite already
// covers.
//
// The two-tier generator is not stylistic. Three guards sit at the front of
// the validator — not-an-object, missing-or-non-string-type,
// invalid-correlationId — and every other refusal sits behind them. A
// generator that randomises the envelope satisfies all three essentially
// never, so it would report green having exercised three refusal reasons out
// of the thirty-nine that exist. Most cases therefore carry a well-formed
// envelope and inject the hazard behind the guards, and the run asserts a
// floor on how many distinct reasons it actually reached.

import { describe, it, expect } from 'vitest';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';
import { COMMAND_TYPES, CMD_SET_CONFIRM_SUPPRESSION } from '../../../src/contracts/sidebar-ipc';
import { ACTION_KEYS } from '../../../src/contracts/action-keys';

// ---- Bounds -----------------------------------------------------------------
// Every number in this file is named here with its reason. An inline bound is
// a number nobody can argue with, because nobody can tell what it was for.

/** Generated cases per property block. Six blocks, so 1200 cases per run. */
const ITERATIONS = 200;

/** Nesting depth for the structural class. Deep enough to exercise a
 *  recursive walk, shallow enough that a failure still renders. */
const MAX_DEPTH = 12;

/** Longest generated string. Must exceed both CORRELATION_ID_MAX (64) and
 *  QUEUE_ID_MAX (256) or the length guards are never actually crossed. */
const MAX_STRING_LEN = 300;

/** Keys planted on a generated object. */
const MAX_KEYS = 8;

/** Characters of a generated input reproduced in a failure message. */
const RENDER_MAX = 240;

/** Share of cases that attack the three front-door guards directly. The rest
 *  carry a valid envelope so they reach the refusal sites behind them. */
const ENVELOPE_TIER_SHARE = 0.15;

// ---- Floors -----------------------------------------------------------------
// Deliberate numbers, set below what the tree reaches today with headroom.
// They are not transcriptions of a current count: they are the point below
// which the property has stopped testing anything.

/** The command set must not have collapsed. Not `> 0`: an empty derivation
 *  makes every count agree at zero and a property without floors passes over
 *  nothing, while `> 0` still admits a set that shrank to three. */
const COMMAND_SET_FLOOR = 50;

/** Same, for the action-key set. */
const ACTION_KEY_SET_FLOOR = 15;

/** Distinct refusal reasons a run must reach. This is the assertion that
 *  fails when the generator degrades into hitting the doormat 1200 times —
 *  the single most likely way this file rots. It counts what the validator
 *  reported, not which lines ran, so it needs no coverage tooling and
 *  survives any refactor of the validator's internals. */
const DISTINCT_REASON_FLOOR = 12;

/** Cases that must carry a well-formed envelope. Below the derived set's own
 *  size, exhaustive command coverage is arithmetically impossible; this is
 *  the floor a future reduction of ITERATIONS may not cross. */
const PAYLOAD_CASE_FLOOR = COMMAND_TYPES.length;

/** The action-key class must not go inert. */
const ACTION_KEY_CASE_FLOOR = 1;

/** Envelope-tier cases whose refusal reason was asserted, not merely counted.
 *  The attribution assertion is the property's only defence against a guard
 *  that is weakened rather than removed (see `envelopeCase`), so it needs a
 *  floor of its own: an envelope tier that quietly stopped producing cases
 *  would take the whole defence with it and leave every other floor green. */
const ATTRIBUTION_FLOOR = 120;

/** Normalisation-collider cases whose refusal reason was asserted. The
 *  collider is the single payload-tier refusal this file pins (see `unicode`),
 *  and that pin is worth exactly as much as the number of cases standing
 *  behind it. `fullwidthFirstLetter` returns its input unchanged for a source
 *  that does not begin with an ASCII capital, so a renamed command set could
 *  empty this class out while every other floor here stayed green. */
const COLLIDER_FLOOR = 25;

// ---- Seeds ------------------------------------------------------------------
// One per block. 0x1337, 0xc0de, 0xbeef and 0xface are taken by the logger
// property file; these six are distinct from those and from each other.
const SEED_TYPE_CONFUSION = 0xfeed;
const SEED_UNKNOWN_KEY = 0xdead;
const SEED_STRUCTURAL = 0xcafe;
const SEED_PROTOTYPE = 0xb0b0;
const SEED_UNICODE = 0xd00d;
const SEED_NUMERIC = 0xfade;

/** Second seed for the SC-001 verification: coverage must not depend on it. */
const SEED_COVERAGE_RECHECK = 0x51de;

// ---- Deterministic seeded PRNG (mulberry32) ---------------------------------
// Copied, deliberately, from tests/unit/lib/logger-secret-patterns.property.test.ts:14-35,
// and byte-identical to it. Extraction was considered on the evidence of this
// second site and declined: a seeded PRNG is what a property test's determinism
// contract rests on, and sharing one couples two determinism guarantees that
// have nothing to do with each other. An "improvement" to mulberry32 or to this
// alphabet would change which inputs both suites cover, in both trees, with
// nothing going red — each suite stays perfectly deterministic, just
// deterministic over a different set. Two independent copies cannot fail that
// way. Reasoning in full: specs/207-ipc-validator-fuzz/evidence.md §5.
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, maxExclusive: number): number {
  return min + Math.floor(rng() * (maxExclusive - min));
}

function randAlnum(rng: () => number, len: number): string {
  const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPH[randInt(rng, 0, ALPH.length)];
  }
  return out;
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[randInt(rng, 0, xs.length)] as T;
}

// ---- The derivation and its floors ------------------------------------------
// Both sets are imported as values, never transcribed. User Story 2 exists to
// prove that: adding a command to the contract widens this fuzz surface with
// no edit to this file.

function assertDerivationFloors(): void {
  expect(
    COMMAND_TYPES.length,
    'the derived command set collapsed; every downstream count would agree at zero'
  ).toBeGreaterThan(COMMAND_SET_FLOOR);
  expect(
    ACTION_KEYS.length,
    'the derived action-key set collapsed; the action-key class would be generating nothing'
  ).toBeGreaterThan(ACTION_KEY_SET_FLOOR);
}

/**
 * The command schedule: a shuffled permutation, walked and cycled.
 *
 * Selection is exhaustive by construction, not random. The seed decides the
 * order and never the coverage. Drawing uniformly instead would leave SC-001
 * to luck: over the commands on this tree, the probability that a uniform
 * draw covers all of them within one block's payload budget is about 0.02,
 * against a coupon-collector expectation of roughly 281 draws — so the
 * coverage assertion would fail intermittently in most runs, which is exactly
 * how a property test earns its deletion.
 */
function makeCommandCursor(rng: () => number): () => string {
  const order: string[] = [...COMMAND_TYPES];
  for (let i = order.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i + 1);
    [order[i], order[j]] = [order[j] as string, order[i] as string];
  }
  let cursor = 0;
  return () => {
    const value = order[cursor % order.length] as string;
    cursor += 1;
    return value;
  };
}

// ---- Safe rendering ---------------------------------------------------------

/**
 * `JSON.stringify` typed the way it actually behaves.
 *
 * The lib signature says `string`, but the function returns `undefined` for
 * `undefined`, a function and a symbol — and the type-confusion class
 * generates all three. Stated once here so the caller's `??` is honest rather
 * than a condition the type system believes can never hold.
 */
function stringifyOrUndefined(value: unknown): string | undefined {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? `${v.toString()}n` : v
  ) as string | undefined;
}

/**
 * A bounded, non-throwing description of a generated input.
 *
 * Measured on this tree, `JSON.stringify` throws on all three shapes this
 * file deliberately generates: a cyclic object (TypeError), a BigInt
 * (TypeError), and an object with a throwing getter (the getter's own error
 * propagates). A bare stringify in the failure path destroys exactly the case
 * that mattered — the run goes red on the renderer and the input is gone.
 */
function safeRender(value: unknown): string {
  let text: string;
  try {
    text = stringifyOrUndefined(value) ?? String(value);
  } catch {
    text = describeStructurally(value);
  }
  return text.length > RENDER_MAX ? `${text.slice(0, RENDER_MAX)}…[truncated]` : text;
}

function describeStructurally(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return `${typeof value}(unrenderable)`;
  // Read through the prototype rather than off the value: an object built by
  // `Object.create(null)` has no `constructor` at all, and casting to
  // `object` would assert otherwise.
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  const name = proto?.constructor?.name ?? 'Object';
  let keyCount = -1;
  try {
    keyCount = Object.keys(value as object).length;
  } catch {
    // A proxy or a hostile getter can refuse even this. The renderer still
    // returns; a failure message with less detail beats no failure message.
  }
  return `<unserialisable ${name}, ${keyCount < 0 ? 'unknown' : keyCount} own keys>`;
}

// ---- The run-level tally ----------------------------------------------------

interface PenetrationRecord {
  readonly reasonsReached: Set<string>;
  readonly classesExercised: Set<string>;
  readonly commandsExercised: Set<string>;
  payloadCases: number;
  actionKeyCases: number;
  attributedCases: number;
  colliderCases: number;
}

function emptyRecord(): PenetrationRecord {
  return {
    reasonsReached: new Set<string>(),
    classesExercised: new Set<string>(),
    commandsExercised: new Set<string>(),
    payloadCases: 0,
    actionKeyCases: 0,
    attributedCases: 0,
    colliderCases: 0
  };
}

const record = emptyRecord();

// ---- Hazard classes ---------------------------------------------------------
// Six families, from the filing's §3. Each produces the value that lands in
// the payload slot; the unicode class may also override the discriminator,
// because a normalisation collider only means anything at that position.

interface HazardCase {
  readonly payload: unknown;
  readonly typeOverride?: string;
}

type HazardGen = (rng: () => number) => HazardCase;

/** A non-object where the validator expects one, behind the front door. */
const typeConfusion: HazardGen = (rng) => ({
  payload: pick(rng, [
    randAlnum(rng, randInt(rng, 1, 24)),
    [] as unknown,
    [randAlnum(rng, 4)] as unknown,
    null,
    randInt(rng, -1000, 1000),
    rng() < 0.5,
    () => undefined
  ])
});

/**
 * A key one character away from a real one, and a required key absent.
 *
 * The near miss is derived by mutating a member of the contract sets — never
 * written as a literal, which would be the transcription FR-006 forbids
 * wearing a different hat.
 */
const unknownKey: HazardGen = (rng) => {
  const source = rng() < 0.5 ? pick(rng, COMMAND_TYPES) : pick(rng, ACTION_KEYS);
  const at = randInt(rng, 0, source.length);
  const mutated = `${source.slice(0, at)}${randAlnum(rng, 1)}${source.slice(at + 1)}`;
  if (rng() < 0.25) return { payload: undefined };
  const out: Record<string, unknown> = { [mutated]: randAlnum(rng, 6) };
  const extra = randInt(rng, 0, MAX_KEYS);
  for (let i = 0; i < extra; i++) out[randAlnum(rng, randInt(rng, 1, 12))] = randInt(rng, 0, 100);
  return { payload: out };
};

/** Depth, length, sparseness and one cyclic object. */
const structural: HazardGen = (rng) => {
  const roll = rng();
  if (roll < 0.3) {
    let nested: Record<string, unknown> = { leaf: randAlnum(rng, 4) };
    for (let d = 0; d < MAX_DEPTH; d++) nested = { nested };
    return { payload: nested };
  }
  if (roll < 0.55) {
    return { payload: { id: randAlnum(rng, MAX_STRING_LEN) } };
  }
  if (roll < 0.8) {
    const sparse = new Array<unknown>(randInt(rng, 2, 12));
    sparse[sparse.length - 1] = randAlnum(rng, 3);
    return { payload: { items: sparse } };
  }
  // Cyclic. `postMessage` structured-clone cannot deliver this shape, so it
  // is a robustness claim about the validator rather than a reachable attack
  // — and it is the reason safeRender exists.
  const cyclic: Record<string, unknown> = { id: randAlnum(rng, 5) };
  cyclic['self'] = cyclic;
  return { payload: cyclic };
};

/**
 * Prototype-shaped keys, planted so they are real own keys.
 *
 * `{ __proto__: x }` is prototype-assignment syntax: it creates no own
 * property, `Object.keys` returns [], and `hasUnexpectedKeys` — which
 * iterates `Object.keys` — would never see it. A literal-built generator here
 * would run its whole budget containing no prototype-shaped key at all and
 * pass, with no outward sign. Hence JSON.parse and defineProperty only.
 */
const prototypeShaped: HazardGen = (rng) => {
  const key = pick(rng, ['__proto__', 'constructor', 'prototype']);
  if (rng() < 0.5) {
    return {
      payload: JSON.parse(`{"${key}":{"polluted":true},"id":"${randAlnum(rng, 5)}"}`) as unknown
    };
  }
  const target: Record<string, unknown> = { id: randAlnum(rng, 5) };
  Object.defineProperty(target, key, {
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true
  });
  return { payload: target };
};

/** Fullwidth Latin capital, which NFKC folds onto its ASCII counterpart. */
function fullwidthFirstLetter(source: string): string {
  const code = source.charCodeAt(0);
  const isUpper = code >= 0x41 && code <= 0x5a;
  if (!isUpper) return source;
  return `${String.fromCharCode(code - 0x41 + 0xff21)}${source.slice(1)}`;
}

/**
 * Lone surrogate, NUL, RTL override, and a normalisation collider.
 *
 * The collider is derived from a real command name, not written out. On this
 * tree it is unequal to its source raw and equal to it after NFKC, and the
 * validator switches on the raw string, so it is refused today. Its refusal is
 * asserted, not merely counted — see the `expectedReason` `payloadCase`
 * derives — so a future "normalise the discriminator before dispatch" change
 * cannot silently promote a near miss into a recognised command. Counting
 * alone would not catch it: an accepted collider is still a well-shaped
 * result, and every other floor in this file would stay green.
 */
const unicode: HazardGen = (rng) => {
  if (rng() < 0.3) {
    return { payload: { id: randAlnum(rng, 4) }, typeOverride: fullwidthFirstLetter(pick(rng, COMMAND_TYPES)) };
  }
  // Written as escapes, never as literal characters: a raw NUL makes this
  // file read as binary to grep and ripgrep, and every later audit sweep
  // over it then silently returns nothing.
  const hostile = pick(rng, [
    '\ud800', // lone high surrogate
    '\u0000', // NUL
    '\u202e', // right-to-left override
    '\ufeff', // zero-width no-break space / BOM
    '\u200b' //  zero-width space
  ]);
  const where = rng();
  if (where < 0.5) return { payload: { id: `${randAlnum(rng, 4)}${hostile}${randAlnum(rng, 4)}` } };
  return { payload: { [`${hostile}${randAlnum(rng, 4)}`]: randAlnum(rng, 4) } };
};

/** Values at the edges of the number line, where coercion hides. */
const numericBoundary: HazardGen = (rng) => {
  const value = pick(rng, [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    2 ** 53,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    -1,
    Number.EPSILON
  ]);
  const field = pick(rng, ['id', 'index', 'position', 'iterationN', 'length']);
  return { payload: { [field]: value } };
};

const HAZARD_CLASSES: ReadonlyArray<{ id: string; seed: number; gen: HazardGen }> = [
  { id: 'type-confusion', seed: SEED_TYPE_CONFUSION, gen: typeConfusion },
  { id: 'unknown-key', seed: SEED_UNKNOWN_KEY, gen: unknownKey },
  { id: 'structural', seed: SEED_STRUCTURAL, gen: structural },
  { id: 'prototype-shaped', seed: SEED_PROTOTYPE, gen: prototypeShaped },
  { id: 'unicode', seed: SEED_UNICODE, gen: unicode },
  { id: 'numeric-boundary', seed: SEED_NUMERIC, gen: numericBoundary }
];

// ---- The two tiers ----------------------------------------------------------

/** An envelope case, paired with the refusal the case was built to provoke. */
interface EnvelopeCase {
  readonly input: unknown;
  /** The `reason` this case must be refused with, by construction. */
  readonly expectedReason: string;
}

/**
 * Attacks the three front-door guards directly.
 *
 * Every branch declares the reason its case was *built* to trip, so `runBlock`
 * can assert attribution instead of merely counting refusals. That assertion is
 * what makes the property sensitive to a guard that is silently weakened. The
 * T024 negative control measured the alternative directly: with the
 * `correlationId` length bounds disabled in the validator, a purely
 * floor-and-shape property stayed **green**, because those cases simply
 * rerouted to other reasons and every floor still cleared. Counting refusals
 * cannot see a validator that refuses for the wrong reason.
 *
 * This is never an assertion that a message is *accepted* (FR-022). Every case
 * here is constructed invalid; the claim is only that it is refused, and
 * refused by the guard it was aimed at.
 */
function envelopeCase(rng: () => number, hazard: HazardCase): EnvelopeCase {
  const roll = rng();
  if (roll < 0.2) {
    const input = pick(rng, [undefined, null, randAlnum(rng, 6), randInt(rng, 0, 99), [] as unknown]);
    // An array is an object: it clears guard one and fails on `type` instead.
    // Deriving the expectation rather than asserting one for the whole branch
    // is the difference between a real attribution check and a rubber stamp.
    return {
      input,
      expectedReason: Array.isArray(input) ? 'missing-or-non-string-type' : 'not-an-object'
    };
  }
  if (roll < 0.45) {
    return {
      input: { correlationId: randAlnum(rng, 8), payload: hazard.payload },
      expectedReason: 'missing-or-non-string-type'
    };
  }
  if (roll < 0.6) {
    return {
      input: { type: pick(rng, [42, null, {}, ['x']]), correlationId: randAlnum(rng, 8) },
      expectedReason: 'missing-or-non-string-type'
    };
  }
  // An empty string is a string. This case clears both of the first two guards
  // and reaches the switch default, so its expectation is `unknown-type`, not
  // a front-door reason — the one branch here that does not trip a guard.
  if (roll < 0.75) {
    return {
      input: { type: '', correlationId: randAlnum(rng, 8) },
      expectedReason: 'unknown-type'
    };
  }
  if (roll < 0.85) {
    return {
      input: { type: pick(rng, COMMAND_TYPES), payload: hazard.payload },
      expectedReason: 'invalid-correlationId'
    };
  }
  if (roll < 0.95) {
    return {
      input: { type: pick(rng, COMMAND_TYPES), correlationId: '' },
      expectedReason: 'invalid-correlationId'
    };
  }
  return {
    input: { type: pick(rng, COMMAND_TYPES), correlationId: randAlnum(rng, MAX_STRING_LEN) },
    expectedReason: 'invalid-correlationId'
  };
}

/**
 * A well-formed envelope with the hazard injected behind the guards.
 *
 * The discriminator comes from the cycled permutation, never from a uniform
 * draw, so every command is reached within one pass at any seed.
 */
function payloadCase(
  rng: () => number,
  nextCommand: () => string,
  hazard: HazardCase
): { input: unknown; type: string; actionKeyCase: boolean; expectedReason: string | null } {
  const type = hazard.typeOverride ?? nextCommand();
  // The one refusal this tier claims by construction. A normalisation collider
  // is a discriminator the contract does not contain, so it must reach the
  // switch default. Derived from the set rather than assumed from the branch:
  // `fullwidthFirstLetter` hands back its input unchanged for a source that
  // does not begin with an ASCII capital, and a command named that way would
  // make this override a genuine member — for which the honest expectation is
  // no expectation at all, not `unknown-type`.
  const isMember = (COMMAND_TYPES as readonly string[]).includes(type);
  const expectedReason = hazard.typeOverride !== undefined && !isMember ? 'unknown-type' : null;
  const correlationId = randAlnum(rng, randInt(rng, 1, 33));
  let payload = hazard.payload;
  // The one place ACTION_KEYS reach this validator: a payload field, not a
  // discriminator. The filing's "18 ActionKeys" and the validator's command
  // discriminators are two different vocabularies.
  const actionKeyCase = type === CMD_SET_CONFIRM_SUPPRESSION;
  if (actionKeyCase) {
    payload =
      rng() < 0.5
        ? { actionKey: pick(rng, ACTION_KEYS), suppressed: hazard.payload }
        : { actionKey: hazard.payload, suppressed: rng() < 0.5 };
  }
  const input: Record<string, unknown> = { type, correlationId };
  if (payload !== undefined) input['payload'] = payload;
  // The tally is the caller's, never this function's. Written that way after
  // the T022a demonstration showed the reproducibility block — which builds
  // cases but never validates them — silently incrementing a run-level floor
  // counter. A floor fed by something that is not measuring the run is a
  // floor that can pass without the run having earned it.
  return { input, type, actionKeyCase, expectedReason };
}

// ---- The property -----------------------------------------------------------

/**
 * The validator's central promise, asserted per case so the first violation
 * fails the run.
 *
 * "Did not throw" alone is not enough: a path that fell through and returned
 * undefined satisfies it while being exactly as broken and considerably
 * harder to notice.
 */
function assertWellShaped(result: unknown, label: string): void {
  expect(result, label).toBeTypeOf('object');
  expect(result, label).not.toBeNull();
  const r = result as { ok?: unknown; reason?: unknown };
  expect(typeof r.ok, label).toBe('boolean');
  if (r.ok === false) {
    expect(typeof r.reason, label).toBe('string');
    expect((r.reason as string).length, label).toBeGreaterThan(0);
  }
}

function runBlock(classId: string, seed: number, gen: HazardGen, iterations = ITERATIONS): void {
  assertDerivationFloors();
  const rng = makeRng(seed);
  const nextCommand = makeCommandCursor(rng);
  for (let i = 0; i < iterations; i++) {
    const hazard = gen(rng);
    const envelope = rng() < ENVELOPE_TIER_SHARE;
    let input: unknown;
    let expectedReason: string | null = null;
    if (envelope) {
      const built = envelopeCase(rng, hazard);
      input = built.input;
      expectedReason = built.expectedReason;
    } else {
      const built = payloadCase(rng, nextCommand, hazard);
      input = built.input;
      expectedReason = built.expectedReason;
      record.payloadCases += 1;
      // A collider is not a command. Recording it here would put a string the
      // contract does not contain into a set named for the ones it does.
      if (built.expectedReason === null) record.commandsExercised.add(built.type);
      if (built.actionKeyCase) record.actionKeyCases += 1;
    }
    record.classesExercised.add(classId);

    // The index plus this file identifies the case exactly: the seed is a
    // visible constant a few lines up, so it is not repeated per message.
    const label = `${classId} case ${i}: ${safeRender(input)}`;
    let result: unknown;
    expect(() => {
      result = validateInboundMessage(input);
    }, `${label} — validateInboundMessage threw`).not.toThrow();
    assertWellShaped(result, label);
    const r = result as { ok?: unknown; reason?: unknown };
    if (r.ok === false && typeof r.reason === 'string') record.reasonsReached.add(r.reason);

    // Attribution. A case may only claim a reason it was built to provoke.
    // The envelope tier claims one for every case: it knows which guard it
    // aimed at. The payload tier claims one for exactly the normalisation
    // collider, whose discriminator is a non-member by construction — for
    // every other payload case, which reason a malformed payload earns is the
    // contract's business, not the generator's. The two are tallied apart so
    // that neither floor can be held up by the other's cases.
    if (expectedReason !== null) {
      expect(r.ok, `${label} — built to be refused, but was not`).toBe(false);
      expect(
        r.reason,
        `${label} — refused, but not by the guard it was aimed at`
      ).toBe(expectedReason);
      if (envelope) record.attributedCases += 1;
      else record.colliderCases += 1;
    }
  }
}

// ---- Blocks -----------------------------------------------------------------
// The floors run first so an empty derivation fails before anything generates.

describe('runtime-validators property: the derivation', () => {
  it('derives both key sets from the contract modules, above their floors', () => {
    assertDerivationFloors();
  });
});

describe('runtime-validators property: validateInboundMessage never throws and always answers', () => {
  for (const hazardClass of HAZARD_CLASSES) {
    it(`survives ${ITERATIONS} generated \`${hazardClass.id}\` cases`, () => {
      runBlock(hazardClass.id, hazardClass.seed, hazardClass.gen);
    });
  }
});

describe('runtime-validators property: safeRender reports the case instead of destroying it', () => {
  // Example assertions, not generated cases. The renderer is the thing that
  // reports a failure, so its own correctness must not depend on the
  // generator happening to reach the shape.
  it('renders a cyclic object without throwing', () => {
    const cyclic: Record<string, unknown> = { id: 'a' };
    cyclic['self'] = cyclic;
    expect(() => JSON.stringify(cyclic)).toThrow();
    expect(safeRender(cyclic)).toContain('unserialisable');
  });

  it('renders a BigInt without throwing', () => {
    const value = { big: BigInt(2) ** BigInt(70) };
    expect(() => JSON.stringify(value)).toThrow();
    expect(safeRender(value)).toContain('n');
  });

  it('renders an object with a throwing getter without throwing', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter refused');
      }
    });
    expect(() => JSON.stringify(hostile)).toThrow();
    expect(safeRender(hostile)).toContain('unserialisable');
  });

  it('truncates at the named bound and says so', () => {
    const long = { id: 'x'.repeat(RENDER_MAX * 2) };
    const rendered = safeRender(long);
    expect(rendered.endsWith('…[truncated]')).toBe(true);
    expect(rendered.length).toBeLessThanOrEqual(RENDER_MAX + '…[truncated]'.length);
  });
});

describe('runtime-validators property: reproducibility', () => {
  it('produces the same inputs in the same order from the same seed', () => {
    const capture = (seed: number): string[] => {
      const rng = makeRng(seed);
      const nextCommand = makeCommandCursor(rng);
      const out: string[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const hazard = unknownKey(rng);
        out.push(safeRender(payloadCase(rng, nextCommand, hazard).input));
      }
      return out;
    };
    expect(capture(SEED_UNKNOWN_KEY)).toEqual(capture(SEED_UNKNOWN_KEY));
  });

  it('reads no clock, no Math.random, no environment', () => {
    // Guarded here rather than in a lint rule because the property this
    // protects is local: an unseeded generator turns a red build into a coin
    // flip, and a coin-flip test is deleted within a week.
    expect(makeRng(SEED_STRUCTURAL)()).toBe(makeRng(SEED_STRUCTURAL)());
  });
});

describe('runtime-validators property: run-level floors', () => {
  // These run last on purpose: they judge the whole run, not a case.

  it('exercised all six hazard classes', () => {
    expect([...record.classesExercised].sort()).toEqual(
      HAZARD_CLASSES.map((c) => c.id).sort()
    );
  });

  it('reached past the three front-door guards into the refusal surface behind them', () => {
    expect(
      record.reasonsReached.size,
      `only reached: ${[...record.reasonsReached].sort().join(', ')}`
    ).toBeGreaterThanOrEqual(DISTINCT_REASON_FLOOR);
  });

  it('asserted the refusal reason of the envelope-tier cases, not just their count', () => {
    expect(
      record.attributedCases,
      `envelope cases whose reason was asserted: ${record.attributedCases}`
    ).toBeGreaterThanOrEqual(ATTRIBUTION_FLOOR);
  });

  it('asserted that a normalisation collider is still refused as an unknown type', () => {
    expect(
      record.colliderCases,
      `collider cases whose reason was asserted: ${record.colliderCases}`
    ).toBeGreaterThanOrEqual(COLLIDER_FLOOR);
  });

  it('generated at least as many payload-tier cases as the contract has commands', () => {
    expect(record.payloadCases).toBeGreaterThanOrEqual(PAYLOAD_CASE_FLOOR);
  });

  it('drove action keys at their real position, on the command that carries them', () => {
    expect(record.actionKeyCases).toBeGreaterThanOrEqual(ACTION_KEY_CASE_FLOOR);
  });

  it('exercised every command in the derived set', () => {
    const missed = COMMAND_TYPES.filter((c) => !record.commandsExercised.has(c));
    expect(missed, `commands never generated: ${missed.join(', ')}`).toEqual([]);
  });

  it('exercises every command at a different seed too, because the schedule decides coverage and the seed does not', () => {
    // SC-001's stated verification. The claim under test is that coverage is
    // exhaustive by construction; a single seed cannot distinguish that from
    // a lucky draw.
    const seen = new Set<string>();
    const rng = makeRng(SEED_COVERAGE_RECHECK);
    const nextCommand = makeCommandCursor(rng);
    for (let i = 0; i < COMMAND_TYPES.length; i++) seen.add(nextCommand());
    expect(seen.size).toBe(COMMAND_TYPES.length);
  });
});
