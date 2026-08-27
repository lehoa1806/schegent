// Feature 101 (FR-R3-017) T012 — what a publish would change (FR-008, FR-009).
//
// Field-name comparison, never a text diff. A diff of two JSON bodies answers
// "which characters moved", and the question the operator has before a publish is
// "which parts of my definition are different" — a reordering of two Phases is one
// fact, and a diff renders it as several unrelated line changes. That is also why
// there is no diffing dependency here and why there should not be one: the output
// is a list of field names, not a rendering.
//
// Pure by construction, like the rest of `src/catalog/`: no `vscode`, no Node
// built-in, no clock, no randomness. `tests/lint/catalog-purity.test.ts` walks this
// module's import closure and enforces that.
//
// Equality is the *canonical* form, borrowed from `canonical-json.ts` rather than
// re-derived. That module is already the authority on what "the same body" means —
// it is what the content hash is taken over — and a second notion of sameness here
// would let the summary say "unchanged" about a body the store would write a new
// version for, or the reverse.

import { canonicalJson } from './canonical-json';

// FR-R3-132 (T1502) — moved to `src/contracts/snapshot-vocabulary.ts` so the webview
// imports them instead of restating them. Re-exported unchanged.
import type { ChangedScalarField, ChangedCollectionField, ChangedField, ChangedFieldSummary } from '../contracts/snapshot-vocabulary';

export type { ChangedScalarField, ChangedCollectionField, ChangedField, ChangedFieldSummary };










/**
 * The four collections whose entries are accounted for individually.
 *
 * These four and no others because these four are the ones whose *order* is part
 * of the definition's meaning — a Pipeline's Phase sequence, its bindings, a
 * Workflow's nodes and the edges between them. Every other field is a value that
 * either matches or does not.
 */
const ORDERED_COLLECTIONS: ReadonlySet<string> = new Set([
  'phaseIds',
  'bindings',
  'nodes',
  'connections'
]);

/** A body that cannot be canonicalised has no representable identity. */
const UNREPRESENTABLE = '<unrepresentable>';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical text of a value, or `null` when it has none. */
function canonicalText(value: unknown): string | null {
  const result = canonicalJson(value);
  return result.outcome === 'canonical' ? result.text : null;
}

/**
 * Whether two values are **not provably equal**.
 *
 * A value with no canonical form counts as differing. That is the safe direction:
 * a summary that says "changed" about an unchanged field costs the operator a
 * second look, and one that says "unchanged" about a changed field costs them the
 * publish they were trying to check.
 */
function differs(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return false;
  const leftText = canonicalText(left);
  const rightText = canonicalText(right);
  return leftText === null || rightText === null || leftText !== rightText;
}

/**
 * The field names either body defines, sorted.
 *
 * A key whose value is `undefined` is not a field: `canonical-json.ts` holds that
 * absent and present-but-undefined canonicalise the same (099 FR-014), so treating
 * them differently here would report a field as changed that the store considers
 * identical. Sorted because the two bodies' own key orders differ and the summary's
 * order must not depend on which one it happened to read first.
 */
function definedFieldNames(
  draft: Readonly<Record<string, unknown>>,
  active: Readonly<Record<string, unknown>>
): readonly string[] {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(draft)) if (value !== undefined) names.add(key);
  for (const [key, value] of Object.entries(active)) if (value !== undefined) names.add(key);
  return [...names].sort();
}

/**
 * One end of a connection, or `null` when the entry does not spell one.
 *
 * `null` rather than a best effort: `String(undefined)` names a malformed endpoint
 * `"undefined"`, and two differently-malformed connections would then share one
 * key. The multiset tagging treats a shared key as a repeat, so an addition and a
 * removal of two unrelated broken entries would cancel and the collection would
 * report nothing changed.
 */
function endpointKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const { nodeId, portId } = value;
  if (typeof nodeId !== 'string' || typeof portId !== 'string') return null;
  return `${nodeId}.${portId}`;
}

/**
 * A binding's identity: what it binds, not where it sits.
 *
 * Bindings address a Phase *position* rather than a bare id because `phaseIds` may
 * repeat (082 research R3), so the index is part of the identity and not a
 * substitute for one. The list position is not: reordering the bindings must read
 * as a reordering, which it cannot if position is what names them.
 */
function bindingKey(entry: Readonly<Record<string, unknown>>): string {
  const { kind, phaseIndex } = entry;
  // Both halves of the identity, or neither. A binding missing its index or its
  // key is malformed, and `String(undefined)` would name every such binding the
  // same thing — see `endpointKey` for what a shared key does to the accounting.
  const port = kind === 'input' ? entry.inputKey : kind === 'output' ? entry.outputKey : undefined;
  if (typeof phaseIndex === 'number' && typeof port === 'string') {
    return `${String(kind)}:${phaseIndex}.${port}`;
  }
  return canonicalText(entry) ?? UNREPRESENTABLE;
}

/**
 * How one entry of an ordered collection is named in the summary.
 *
 * Every arm falls back to the entry's canonical text, because the store does not
 * validate bodies (099 FR-010) and an entry can be any shape at all. A canonical
 * fallback is unreadable but correct; guessing a name from a malformed entry would
 * be readable and wrong.
 */
function entryKey(field: string, entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (!isRecord(entry)) return canonicalText(entry) ?? UNREPRESENTABLE;
  if (field === 'bindings') return bindingKey(entry);
  if (field === 'nodes' && typeof entry.nodeId === 'string') return entry.nodeId;
  if (field === 'connections') {
    const from = endpointKey(entry.from);
    const to = endpointKey(entry.to);
    if (from !== null && to !== null) return `${from}->${to}`;
  }
  return canonicalText(entry) ?? UNREPRESENTABLE;
}

/**
 * Entry identities tagged by occurrence, so a repeated entry is two things.
 *
 * `['build', 'build']` against `['build']` is one addition, and an untagged set
 * comparison reports none — the repeat is invisible because the name is already
 * present. Tagging makes the multiset arithmetic ordinary set arithmetic.
 */
function taggedKeys(field: string, entries: readonly unknown[]): readonly string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const key = entryKey(field, entry);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return `${key}#${ordinal}`;
  });
}

/** The bare identity a tagged key was built from. */
function untag(tagged: string): string {
  return tagged.slice(0, tagged.lastIndexOf('#'));
}

/** Bare identities, first occurrence order preserved and duplicates collapsed. */
function bareKeys(tagged: readonly string[]): readonly string[] {
  return [...new Set(tagged.map(untag))];
}

/**
 * Entries in both lists whose position among the shared entries moved.
 *
 * Both lists are first reduced to the entries they share, so an insertion or a
 * removal elsewhere cannot move anything: what is compared is the order of the
 * common subsequence, which is the only thing "reordered" can honestly mean when
 * the two lists are different lengths.
 */
function reorderedTags(
  draftTags: readonly string[],
  activeTags: readonly string[]
): readonly string[] {
  const inActive = new Set(activeTags);
  const inDraft = new Set(draftTags);
  const sharedDraft = draftTags.filter((tag) => inActive.has(tag));
  const sharedActive = activeTags.filter((tag) => inDraft.has(tag));
  const activePosition = new Map(sharedActive.map((tag, position) => [tag, position]));
  return sharedDraft.filter((tag, position) => activePosition.get(tag) !== position);
}

function collectionChange(field: string, draftValue: unknown, activeValue: unknown): ChangedField {
  if (!Array.isArray(draftValue) || !Array.isArray(activeValue)) {
    return { field, change: 'differs' };
  }
  const draftTags = taggedKeys(field, draftValue);
  const activeTags = taggedKeys(field, activeValue);
  const inActive = new Set(activeTags);
  const inDraft = new Set(draftTags);
  const added = bareKeys(draftTags.filter((tag) => !inActive.has(tag)));
  const removed = bareKeys(activeTags.filter((tag) => !inDraft.has(tag)));
  const accounted = new Set([...added, ...removed]);
  return {
    field,
    change: 'collection',
    added,
    removed,
    reordered: bareKeys(reorderedTags(draftTags, activeTags)).filter((key) => !accounted.has(key))
  };
}

/**
 * What publishing `draftBody` over `activeBody` would change (FR-008, FR-009).
 *
 * `activeBody` is `null` when the definition has never been published — the
 * caller passes the pointer's absence through rather than substituting an empty
 * body, because an empty body and no body are different situations and only the
 * caller can tell them apart.
 *
 * A body that is not an object is compared whole. Neither the draft nor the active
 * version is validated anywhere on this path (099 FR-010), so both can be a string,
 * a number, or a list; naming fields inside a value that has none would be an
 * invention, and the honest report is that it differs.
 */
export function compareForPublish(draftBody: unknown, activeBody: unknown | null): ChangedFieldSummary {
  if (activeBody === null) return { kind: 'no-prior-version' };
  if (!isRecord(draftBody) || !isRecord(activeBody)) {
    return differs(draftBody, activeBody) ? { kind: 'changed', fields: [] } : { kind: 'unchanged' };
  }
  const fields: ChangedField[] = [];
  for (const field of definedFieldNames(draftBody, activeBody)) {
    if (!differs(draftBody[field], activeBody[field])) continue;
    fields.push(
      ORDERED_COLLECTIONS.has(field)
        ? collectionChange(field, draftBody[field], activeBody[field])
        : { field, change: 'differs' }
    );
  }
  return fields.length === 0 ? { kind: 'unchanged' } : { kind: 'changed', fields };
}
