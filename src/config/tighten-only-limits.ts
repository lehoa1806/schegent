/**
 * Review gap GC-10 (2026-11-12) — the run limits a repository may tighten and never loosen.
 *
 * These settings are `resource` scope, so a repository's `.vscode/settings.json` reaches them, and
 * VS Code's own resolution lets the innermost layer win. That let a trusted repository raise or
 * clear the operator's spend cap, raise the retry or iteration cap, or set `forceContinueOnCap`.
 * The follow-up (same day) adds the idle window and the wall-clock bound on one invocation, which
 * stop a runaway child: a repository may shorten them and never lengthen them.
 * Here the operator's value is the user layer, else the manifest default, and a workspace or folder
 * value replaces it only when it is schema-valid and strictly tighter. Anything else is ignored and
 * named in `ignoredLayers`, so the caller can say so.
 *
 * Pure: no `vscode`, no I/O. Callers pass `WorkspaceConfiguration.inspect(key)`.
 */
import type { LimitOrigin } from '../contracts/snapshot-projections';
import { normalizeMaxUnchangedComparisons } from '../contracts/unchanged-comparison-bound';
import { SETTINGS_SCHEMA, isSchemaCompliantValue } from './settings-schema';

/** The layers of `WorkspaceConfiguration.inspect` the resolution reads. */
export interface LimitLayers {
  readonly defaultValue?: unknown;
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

export type RepositoryLayer = 'workspace' | 'workspace-folder';

export interface TightenOnlyResolution<T> {
  readonly value: T;
  readonly origin: LimitOrigin;
  /** Repository layers that set a value which was looser than, or not, a valid limit. */
  readonly ignoredLayers: readonly RepositoryLayer[];
}

/** A lower number is tighter; `null` is no bound at all. */
const tighterCeiling = (candidate: number | null, current: number | null): boolean =>
  candidate !== null && (current === null || candidate < current);

/** A lower number is tighter; 0 is no bound at all. */
const tighterOptionalBound = (candidate: number, current: number): boolean => {
  const bound = normalizeMaxUnchangedComparisons(current);
  return candidate !== 0 && (bound === 0 || candidate < bound);
};

/** A shorter bound is tighter. */
const shorter = (candidate: number, current: number): boolean => candidate < current;

const RUN_LIMIT_ORDERS = {
  'spend.maxUsdPerRun': tighterCeiling,
  'spend.maxTokensPerRun': tighterCeiling,
  'retry.maxAttempts': (candidate: number, current: number) => candidate < current,
  // Continuing past the retry cap leaves the gate unverified, so `false` is the tighter value.
  'retry.forceContinueOnCap': (candidate: boolean, current: boolean) => current && !candidate,
  'loop.maxIterations': (candidate: number, current: number) => candidate < current,
  'loop.maxUnchangedComparisons': tighterOptionalBound,
  'invocation.idleTimeoutSeconds': shorter,
  'invocation.maxDurationSeconds': shorter
} as const;

export type RunLimitKey = keyof typeof RUN_LIMIT_ORDERS;
type RunLimitValue<K extends RunLimitKey> = Parameters<(typeof RUN_LIMIT_ORDERS)[K]>[0];

export const RUN_LIMIT_KEYS: ReadonlySet<RunLimitKey> = new Set(
  Object.keys(RUN_LIMIT_ORDERS) as RunLimitKey[]
);

const REPOSITORY_LAYERS: readonly (readonly [RepositoryLayer, keyof LimitLayers])[] = [
  ['workspace', 'workspaceValue'],
  ['workspace-folder', 'workspaceFolderValue']
];

/** Resolves one run limit from `inspect(key)`; `key` is relative to the `schegent` section. */
export function resolveRunLimit<K extends RunLimitKey>(
  key: K,
  layers: LimitLayers | undefined
): TightenOnlyResolution<RunLimitValue<K>> {
  const name = `schegent.${key}`;
  const schema = Object.hasOwn(SETTINGS_SCHEMA, name) ? SETTINGS_SCHEMA[name] : undefined;
  if (schema === undefined) throw new TypeError(`no settings schema entry for run limit "${key}"`);
  const isTighter = RUN_LIMIT_ORDERS[key] as (candidate: unknown, current: unknown) => boolean;

  let value: unknown = schema.default;
  let origin: LimitOrigin = 'default';
  if (layers?.globalValue !== undefined) {
    value = layers.globalValue;
    origin = 'user';
  } else if (layers?.defaultValue !== undefined) {
    value = layers.defaultValue;
  }

  const ignoredLayers: RepositoryLayer[] = [];
  for (const [layer, field] of REPOSITORY_LAYERS) {
    const candidate = layers?.[field];
    if (candidate === undefined || Object.is(candidate, value)) continue;
    if (isSchemaCompliantValue(schema, candidate) && isTighter(candidate, value)) {
      value = candidate;
      origin = layer;
    } else {
      ignoredLayers.push(layer);
    }
  }
  return { value: value as RunLimitValue<K>, origin, ignoredLayers };
}

/**
 * The idle window's layers with the deprecated `invocation.timeoutSeconds` folded in (FR-R3-075):
 * the operator's value is the new key's user layer, else the legacy key's, so a repository cannot
 * set the new key to discard a shorter legacy value the operator chose. The legacy key's repository
 * layers are read only while the new key is set at no layer, which is the order the alias has
 * always had.
 */
export function mergeIdleTimeoutLayers(idle: LimitLayers | undefined, legacy: LimitLayers | undefined): LimitLayers {
  const newKeySet =
    idle?.globalValue !== undefined || idle?.workspaceValue !== undefined || idle?.workspaceFolderValue !== undefined;
  const repository = newKeySet ? idle : legacy;
  return {
    defaultValue: idle?.defaultValue,
    globalValue: idle?.globalValue ?? legacy?.globalValue,
    workspaceValue: repository?.workspaceValue,
    workspaceFolderValue: repository?.workspaceFolderValue
  };
}
