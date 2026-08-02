/**
 * Shared mutation-intent algebra for revisioned complete-layer saves.
 *
 * A scoped save carries the whole proposed layer plus a declared intent
 * (`create | edit | duplicate | remove | reset`). The host re-derives what the
 * layer actually changed and rejects the save when the observed diff does not
 * match the declared intent, so a webview cannot smuggle an extra edit through
 * a narrower-looking mutation.
 *
 * Feature 081 established this algebra for the Phase catalog; feature 082
 * extracts it here (research R6) so the Pipeline catalog reuses the identical
 * behavior. Everything below is entity-agnostic and parameterized by a
 * {@link LayerIntentAdapter}; nothing here reads configuration or imports
 * `vscode`.
 */

/** The identity pattern shared by Phase and Pipeline ids. */
export const LAYER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export type LayerMutationKind = 'create' | 'edit' | 'duplicate' | 'remove' | 'reset';

/**
 * The entity-agnostic view of a declared save intent. `targetId` is the id
 * being created, edited, duplicated to, or removed; `reset` carries none.
 */
export interface LayerMutationIntent {
  readonly kind: LayerMutationKind;
  readonly targetId: string | null;
}

export interface LayerDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

export interface LayerIdentities {
  readonly counts: ReadonlyMap<string, number>;
  readonly versions: ReadonlyMap<string, ReadonlySet<number>>;
}

/** The minimum every layer definition must expose for host version assignment. */
export interface VersionedDefinition {
  readonly version: number;
}

export interface LayerIntentAdapter<T extends VersionedDefinition> {
  /** Per-row identity, including the synthetic id used for unparseable rows. */
  readonly sourceIdentity: (row: unknown, index: number) => string;
  /** Identity of a parsed definition. */
  readonly identityOf: (definition: T) => string;
  /** Parses one raw row, returning `null` when it does not validate. */
  readonly parse: (row: unknown) => T | null;
}

/**
 * Key-sorted JSON with `undefined` values and `version` removed, so two
 * definitions compare equal exactly when their *authored* fields match. Host
 * version assignment is the one thing a save must never be able to dictate.
 */
export function stableAuthoredJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableAuthoredJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined && key !== 'version')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableAuthoredJson(record[key])}`)
    .join(',')}}`;
}

export function authoredEqual(a: unknown, b: unknown): boolean {
  return stableAuthoredJson(a) === stableAuthoredJson(b);
}

export function definitionMap<T extends VersionedDefinition>(
  definitions: readonly T[],
  adapter: LayerIntentAdapter<T>
): Map<string, T> {
  return new Map(definitions.map((definition) => [adapter.identityOf(definition), definition]));
}

export function layerIdentities<T extends VersionedDefinition>(
  rows: readonly unknown[],
  adapter: LayerIntentAdapter<T>
): LayerIdentities {
  const counts = new Map<string, number>();
  const versions = new Map<string, Set<number>>();
  for (const [index, raw] of rows.entries()) {
    const identity = adapter.sourceIdentity(raw, index);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
    const row =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const version =
      Number.isSafeInteger(row.version) && (row.version as number) > 0
        ? (row.version as number)
        : 1;
    const known = versions.get(identity) ?? new Set<number>();
    known.add(version);
    versions.set(identity, known);
  }
  return { counts, versions };
}

export function layerDiff<T extends VersionedDefinition>(
  current: ReadonlyMap<string, T>,
  proposed: ReadonlyMap<string, T>
): LayerDiff {
  const added = [...proposed.keys()].filter((id) => !current.has(id));
  const removed = [...current.keys()].filter((id) => !proposed.has(id));
  const changed = [...proposed.keys()].filter((id) => {
    const prior = current.get(id);
    return prior !== undefined && !authoredEqual(prior, proposed.get(id)!);
  });
  return { added, removed, changed };
}

function countsMatchExcept(
  current: ReadonlyMap<string, number>,
  proposed: ReadonlyMap<string, number>,
  exceptId: string
): boolean {
  const ids = new Set([...current.keys(), ...proposed.keys()]);
  for (const id of ids) {
    if (id === exceptId) continue;
    if ((current.get(id) ?? 0) !== (proposed.get(id) ?? 0)) return false;
  }
  return true;
}

/**
 * Returns `true` when the observed diff is exactly what the declared mutation
 * is allowed to produce, and nothing more.
 */
export function mutationMatches(
  mutation: LayerMutationIntent,
  diff: LayerDiff,
  proposedCount: number,
  currentCounts: ReadonlyMap<string, number>,
  proposedCounts: ReadonlyMap<string, number>
): boolean {
  if (mutation.kind === 'reset') return proposedCount === 0;
  const targetId = mutation.targetId;
  if (targetId === null) return false;
  const none = (values: readonly string[]) => values.length === 0;
  const only = (values: readonly string[], id: string) =>
    values.length === 1 && values[0] === id;
  switch (mutation.kind) {
    case 'create':
    case 'duplicate':
      return (
        (currentCounts.get(targetId) ?? 0) === 0 &&
        only(diff.added, targetId) &&
        none(diff.removed) &&
        none(diff.changed)
      );
    case 'edit':
      return (
        (currentCounts.get(targetId) ?? 0) === 1 &&
        (proposedCounts.get(targetId) ?? 0) === 1 &&
        countsMatchExcept(currentCounts, proposedCounts, targetId) &&
        diff.added.every((id) => id === targetId) &&
        diff.removed.every((id) => id === targetId) &&
        diff.changed.every((id) => id === targetId)
      );
    case 'remove': {
      const currentCount = currentCounts.get(targetId) ?? 0;
      const proposedCountForId = proposedCounts.get(targetId) ?? 0;
      return (
        currentCount === proposedCountForId + 1 &&
        countsMatchExcept(currentCounts, proposedCounts, targetId) &&
        diff.added.every((id) => id === targetId) &&
        diff.removed.every((id) => id === targetId) &&
        diff.changed.every((id) => id === targetId)
      );
    }
  }
}

/**
 * An `edit` may legitimately rewrite the id of a row that cannot otherwise be
 * addressed — one whose id violates the pattern, or one of a repeated pair.
 * Returns the replacement id when the diff is exactly that repair, else `null`.
 */
export function identityRepairTarget(
  mutation: LayerMutationIntent,
  currentCounts: ReadonlyMap<string, number>,
  proposedCounts: ReadonlyMap<string, number>,
  diff: LayerDiff
): string | null {
  const targetId = mutation.targetId;
  if (
    mutation.kind !== 'edit' ||
    targetId === null ||
    ((currentCounts.get(targetId) ?? 0) === 1 && LAYER_ID_PATTERN.test(targetId)) ||
    (currentCounts.get(targetId) ?? 0) < 1 ||
    (proposedCounts.get(targetId) ?? 0) !== (currentCounts.get(targetId) ?? 0) - 1 ||
    diff.removed.length !== 0 ||
    diff.changed.some((id) => id !== targetId)
  ) {
    return null;
  }

  const additions = [...proposedCounts].filter(
    ([id, count]) => count - (currentCounts.get(id) ?? 0) === 1
  );
  if (additions.length !== 1 || diff.added.length !== 1 || diff.added[0] !== additions[0][0]) {
    return null;
  }
  const replacementId = additions[0][0];
  const allIds = new Set([...currentCounts.keys(), ...proposedCounts.keys()]);
  for (const id of allIds) {
    const delta = (proposedCounts.get(id) ?? 0) - (currentCounts.get(id) ?? 0);
    if (id === targetId) {
      if (delta !== -1) return null;
    } else if (id === replacementId) {
      if (delta !== 1) return null;
    } else if (delta !== 0) return null;
  }
  return replacementId;
}

interface LayerEntry {
  readonly identity: string;
  readonly fingerprint: string;
}

function layerEntries<T extends VersionedDefinition>(
  rows: readonly unknown[],
  adapter: LayerIntentAdapter<T>
): LayerEntry[] {
  return rows.map((row, index) => ({
    identity: adapter.sourceIdentity(row, index),
    fingerprint: stableAuthoredJson(adapter.parse(row) ?? row)
  }));
}

function fingerprintsWithoutOne(entries: readonly LayerEntry[], identity: string): string[][] {
  return entries.flatMap((entry, index) =>
    entry.identity === identity
      ? [entries.filter((_unused, candidate) => candidate !== index).map((item) => item.fingerprint)]
      : []
  );
}

function sameFingerprints(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Positional counterpart to {@link mutationMatches}: the untouched rows must
 * appear in the same order on both sides, so a mutation cannot silently
 * reorder the layer it claims only to add to or remove from.
 */
export function layerShapeMatches<T extends VersionedDefinition>(
  mutation: LayerMutationIntent,
  currentRows: readonly unknown[],
  proposedRows: readonly unknown[],
  repairTargetId: string | null,
  adapter: LayerIntentAdapter<T>
): boolean {
  if (mutation.kind === 'reset') return proposedRows.length === 0;
  const targetId = mutation.targetId;
  if (targetId === null) return false;
  const current = layerEntries(currentRows, adapter);
  const proposed = layerEntries(proposedRows, adapter);
  if (mutation.kind === 'create' || mutation.kind === 'duplicate') {
    const currentFingerprints = current.map((entry) => entry.fingerprint);
    return fingerprintsWithoutOne(proposed, targetId).some((candidate) =>
      sameFingerprints(currentFingerprints, candidate)
    );
  }
  if (mutation.kind === 'remove') {
    const proposedFingerprints = proposed.map((entry) => entry.fingerprint);
    return fingerprintsWithoutOne(current, targetId).some((candidate) =>
      sameFingerprints(candidate, proposedFingerprints)
    );
  }
  const proposedTarget = repairTargetId ?? targetId;
  return fingerprintsWithoutOne(current, targetId).some((currentCandidate) =>
    fingerprintsWithoutOne(proposed, proposedTarget).some((proposedCandidate) =>
      sameFingerprints(currentCandidate, proposedCandidate)
    )
  );
}

/**
 * Assigns the persisted `version` for every proposed definition. The version is
 * host-owned: it holds steady when no authored field changed, increments by one
 * when it did, and starts above the highest previously seen version when an id
 * is reintroduced.
 */
export function withHostVersions<T extends VersionedDefinition>(
  proposed: readonly T[],
  current: ReadonlyMap<string, T>,
  currentCounts: ReadonlyMap<string, number>,
  currentVersions: ReadonlyMap<string, ReadonlySet<number>>,
  mutation: LayerMutationIntent,
  adapter: LayerIntentAdapter<T>
): readonly T[] {
  return proposed.map((definition) => {
    const identity = adapter.identityOf(definition);
    const prior = current.get(identity);
    const candidates = currentVersions.get(identity);
    const sourceVersion = candidates?.has(definition.version)
      ? definition.version
      : candidates?.size
        ? Math.max(...candidates)
        : null;
    const preservingDuplicateSurvivor =
      mutation.kind === 'edit' &&
      mutation.targetId === identity &&
      (currentCounts.get(identity) ?? 0) > 1;
    const version =
      preservingDuplicateSurvivor && sourceVersion !== null
        ? sourceVersion
        : mutation.kind === 'remove' && mutation.targetId === identity && sourceVersion !== null
          ? sourceVersion
          : prior
            ? authoredEqual(prior, definition)
              ? prior.version
              : prior.version + 1
            : sourceVersion !== null
              ? sourceVersion + 1
              : 1;
    return Object.freeze({ ...definition, version });
  });
}
