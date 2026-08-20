// Feature 099 (FR-R3-015) T477 — deterministic serialisation (FR-013).
//
// This function decides whether a save is a change. Every defect in it is silent:
// it either manufactures a version out of a no-op edit, or it swallows a real
// edit by hashing two different bodies alike. So the rules are stated as rules,
// not left to `JSON.stringify`'s defaults:
//
//   - **Object keys sort by UTF-16 code unit.** `localeCompare` is the natural
//     choice here and is locale-dependent: under a locale where `-` sorts
//     differently, the same body canonicalises two ways on two machines and the
//     hash stops meaning anything (SC-010). `Array.prototype.sort()` with no
//     comparator is exactly code-unit order, and it is used deliberately.
//   - **Arrays keep authored order.** A Pipeline's phase order *is* meaning.
//     Sorting an array here would make two different Pipelines hash alike.
//   - **A key whose value is `undefined` is omitted**, so `{a:1}` and
//     `{a:1,b:undefined}` produce the same text. A body round-tripped through the
//     webview with an absent optional must not manufacture a version (FR-014).
//   - **Non-finite numbers are refused**, not serialised. `JSON.stringify` turns
//     `NaN` and both infinities into `null`, which makes three different bodies
//     hash identically to a body that authored `null`.
//   - **Anything that is not a JSON value is refused.** A `Date`, a `Map`, a
//     function, a `bigint`, a `Symbol`: a body arrives from parsed JSON or from
//     the webview boundary, so none of these can appear legitimately, and each
//     would otherwise serialise as something surprising or throw.
//   - **Nesting past `CANONICAL_MAX_DEPTH` is refused.** The walk is recursive, so
//     without a bound a deep enough body raises `RangeError` — an *exception*, out
//     of a module whose every other failure is a returned value, into callers that
//     hold no `try`. A bound the store states is also a bound every machine agrees
//     on; the stack limit is not (SC-010).
//
// No `Intl`, no `localeCompare`, no `toLocaleString` anywhere in this file.

/**
 * How deep a body may nest. The root is depth 0, so a body of `{a: {b: 1}}` is 2.
 *
 * Two orders of magnitude above anything a Phase, Pipeline, or Workflow authors —
 * this is a stack guard, not a schema. The store does not validate definitions
 * (FR-016); it declines to recurse without end.
 */
export const CANONICAL_MAX_DEPTH = 100;

export type CanonicalJsonResult =
  | { readonly outcome: 'canonical'; readonly text: string }
  | {
      readonly outcome: 'refused';
      readonly reason: 'non-finite-number' | 'unsupported-value' | 'cyclic' | 'too-deep';
      /**
       * Where in the body the offending value sits, as a dotted path from the
       * root (`phases[2].timeoutSeconds`). A path *within the body* — never a
       * filesystem path, so this is safe to log (FR-061).
       */
      readonly at: string;
    };

/** Thrown internally and caught before returning; never escapes this module. */
class CanonicalRefusal extends Error {
  constructor(
    readonly reason: 'non-finite-number' | 'unsupported-value' | 'cyclic' | 'too-deep',
    readonly at: string
  ) {
    super(`${reason} at ${at}`);
  }
}

const ROOT = '$';

function describe(path: string, key: string): string {
  return `${path}.${key}`;
}

function index(path: string, position: number): string {
  return `${path}[${position}]`;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** `depth` counts the containers already entered; the root body is entered at 0. */
function write(value: unknown, path: string, seen: Set<object>, depth: number): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      // The whole point of refusing here: `JSON.stringify(NaN)` is `"null"`, so
      // a body with `NaN` would hash identically to one that authored `null`.
      if (!Number.isFinite(value)) throw new CanonicalRefusal('non-finite-number', path);
      // `-0` and `0` are the same number and must produce the same text;
      // `String(-0)` is `"0"`, but `JSON.stringify(-0)` is `"0"` too. Kept
      // explicit so a future edit cannot reintroduce the difference.
      return JSON.stringify(value === 0 ? 0 : value);

    case 'string':
      // `JSON.stringify` on a string is the JSON string grammar, escapes and all.
      // There is no locale in it.
      return JSON.stringify(value);

    case 'object':
      break;

    // `undefined` at a *value* position (an array hole, or the root) is not a
    // JSON value. Object keys holding `undefined` are dropped before recursing,
    // so reaching here means the body used it somewhere it cannot be dropped.
    default:
      throw new CanonicalRefusal('unsupported-value', path);
  }

  const object = value as object;
  if (seen.has(object)) throw new CanonicalRefusal('cyclic', path);
  // Checked before recursing rather than after: this is the frame that would grow
  // the stack, and a body deep enough to exhaust it has to be refused *before* it
  // does. The cycle check above catches the infinite case; this catches the merely
  // enormous one, which no `seen` set can see.
  if (depth >= CANONICAL_MAX_DEPTH) throw new CanonicalRefusal('too-deep', path);
  const nested = depth + 1;
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // Authored order, preserved. Never sorted.
      const parts = object.map((entry, position) =>
        write(entry, index(path, position), seen, nested)
      );
      return `[${parts.join(',')}]`;
    }

    if (!isPlainObject(object)) throw new CanonicalRefusal('unsupported-value', path);

    const source = object as Record<string, unknown>;
    // Own enumerable string keys only, in UTF-16 code-unit order. Symbol keys
    // are not JSON and are not reachable from a parsed body.
    const keys = Object.keys(source).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = source[key];
      // Absent and present-but-undefined canonicalise the same (FR-014).
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${write(entry, describe(path, key), seen, nested)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * The canonical text of a body, or a named refusal.
 *
 * No insignificant whitespace: the output is the shortest text that encodes the
 * value under these rules, so two bodies that differ only in formatting produce
 * identical text and therefore identical hashes.
 */
export function canonicalJson(body: unknown): CanonicalJsonResult {
  try {
    return { outcome: 'canonical', text: write(body, ROOT, new Set<object>(), 0) };
  } catch (error) {
    if (error instanceof CanonicalRefusal) {
      return { outcome: 'refused', reason: error.reason, at: error.at };
    }
    // Nothing else is thrown from `write`: the depth bound is what used to make
    // this branch reachable. Re-thrown rather than swallowed, because a refusal
    // this module cannot name is not one it should invent a reason for.
    throw error;
  }
}
