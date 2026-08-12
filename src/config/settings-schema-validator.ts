// Feature 056 Track 3 follow-on — activation-time guard for the live
// `schegent.*` settings surface.
//
// `SETTINGS_SCHEMA` is the typed source of truth for every key the
// host accepts. Three things can drift in production:
//
//   1. An operator (or a managed-extension policy) writes a
//      `schegent.X` key that this build of the extension does not
//      know about (older host vs. newer settings file, or a typo).
//   2. The persisted value violates the schema's type, range, enum,
//      or pattern constraints (e.g. a hand-edited `settings.json`
//      with `loop.maxIterations: 0`).
//   3. A settings file shipped by an upstream profile carries a key
//      whose meaning the host has since removed.
//
// VS Code silently accepts these reads — the per-setting `get<T>`
// callsites in the host fall back to the documented default and the
// drift becomes invisible until something downstream rejects.
// This validator runs once at activation and emits a sanitized
// `SanitizedLogger.warn` for every drift, naming the offending key
// so the operator can fix it without re-deriving the symptom.
//
// Intentionally `vscode`-free so it is consumable by tests and by
// any future host adapter that carries its own settings-mirror shape.

import {
  SETTINGS_SCHEMA,
  SETTINGS_SCHEMA_KEYS,
  isSchemaCompliantValue,
  type SettingsSchemaEntry
} from './settings-schema';
import type { SanitizedLogger } from '../lib/logger';

/**
 * Minimal slice of `vscode.WorkspaceConfiguration` consumed by the
 * validator. Keeps the module `vscode`-free so the parity-style tests
 * can pass a fake.
 */
export interface SettingsConfigReader {
  /** Returns the configured value or `undefined` if not set. */
  inspect<T>(key: string): {
    readonly defaultValue?: T;
    readonly globalValue?: T;
    readonly workspaceValue?: T;
    readonly workspaceFolderValue?: T;
  } | undefined;
}

export type SettingsValidationDriftKind =
  | 'unknown-key'
  | 'type-mismatch'
  | 'out-of-range'
  | 'invalid-enum'
  | 'pattern-mismatch';

export interface SettingsValidationDrift {
  readonly key: string;
  readonly kind: SettingsValidationDriftKind;
  readonly layer: 'global' | 'workspace' | 'workspaceFolder';
  /** Detail line included in the warn message — never the raw value. */
  readonly summary: string;
}

/**
 * Inspect the live `schegent.*` settings tree against `SETTINGS_SCHEMA`.
 *
 * Returns the list of drift findings AND emits one
 * `logger.warn(`schegent settings drift: …`)` per finding. Returning
 * the list (rather than logging only) lets the tests assert on the
 * exact findings without parsing the runtime log.
 *
 * The `allKnownSchegentKeys` parameter lets the caller pass the set of
 * `schegent.*` keys observed from `package.json` (or another source);
 * any key that is BOTH known to the package AND present in the user's
 * settings BUT missing from `SETTINGS_SCHEMA` is impossible by parity
 * — this only catches operator-typo / older-host cases.
 *
 * Performance: linear in the number of `schegent.*` keys defined
 * (currently 25). Runs once at activation. No I/O.
 */
export function validateWorkspaceSettings(
  config: SettingsConfigReader,
  logger: SanitizedLogger,
  observedKeys: ReadonlySet<string>
): readonly SettingsValidationDrift[] {
  const drift: SettingsValidationDrift[] = [];

  // 1. Schema-known keys: validate every layer that has a non-default value.
  for (const fullKey of SETTINGS_SCHEMA_KEYS) {
    const entry = SETTINGS_SCHEMA[fullKey];
    const inspected = config.inspect<unknown>(unprefix(fullKey));
    if (!inspected) continue;
    checkLayer('workspaceFolder', inspected.workspaceFolderValue, entry, drift);
    checkLayer('workspace', inspected.workspaceValue, entry, drift);
    checkLayer('global', inspected.globalValue, entry, drift);
  }

  // 2. Operator/observed keys not in the schema. The caller passes the
  //    observed set so we never have to enumerate the user's `settings.json`
  //    ourselves (which VS Code does not expose as a tree).
  for (const observed of observedKeys) {
    if (!SETTINGS_SCHEMA_KEYS.has(observed)) {
      drift.push({
        key: observed,
        kind: 'unknown-key',
        layer: 'workspace',
        summary: `key not recognized by this build of the extension`
      });
    }
  }

  for (const finding of drift) {
    logger.warn(
      `schegent settings drift: ${finding.key} (${finding.kind} @ ${finding.layer}): ${finding.summary}`
    );
  }

  return drift;
}

function unprefix(key: string): string {
  return key.replace(/^schegent\./, '');
}

function checkLayer(
  layer: SettingsValidationDrift['layer'],
  value: unknown,
  entry: SettingsSchemaEntry,
  out: SettingsValidationDrift[]
): void {
  if (value === undefined) return;
  if (isSchemaCompliantValue(entry, value)) {
    // Pattern is a schema field that `isSchemaCompliantValue` does not
    // check (per the schema module's "intentionally narrow" contract).
    // Apply it here so the validator catches an HH:MM that fails the
    // regex even though the type tag accepts it.
    if (
      entry.pattern !== undefined &&
      typeof value === 'string' &&
      !new RegExp(entry.pattern).test(value)
    ) {
      out.push({
        key: entry.key,
        layer,
        kind: 'pattern-mismatch',
        summary: `value does not match required pattern ${entry.pattern}`
      });
    }
    return;
  }
  // Classify the failure for a precise warn message.
  if (value === null || value === undefined) {
    // Only nullable entries accept null; schema validator already rejected.
    out.push({
      key: entry.key,
      layer,
      kind: 'type-mismatch',
      summary: `null is not allowed for non-nullable ${entry.type}`
    });
    return;
  }
  switch (entry.type) {
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        out.push({
          key: entry.key,
          layer,
          kind: 'type-mismatch',
          summary: `expected ${entry.type}, got ${typeof value}`
        });
        return;
      }
      out.push({
        key: entry.key,
        layer,
        kind: 'out-of-range',
        summary: `value out of [${entry.min ?? '-∞'}, ${entry.max ?? '+∞'}]`
      });
      return;
    }
    case 'enum': {
      out.push({
        key: entry.key,
        layer,
        kind: 'invalid-enum',
        summary: `value not in enum ${(entry.enum ?? []).join('|')}`
      });
      return;
    }
    case 'string':
    case 'boolean':
    case 'array': {
      out.push({
        key: entry.key,
        layer,
        kind: 'type-mismatch',
        summary: `expected ${entry.type}, got ${typeof value}`
      });
      return;
    }
  }
}
