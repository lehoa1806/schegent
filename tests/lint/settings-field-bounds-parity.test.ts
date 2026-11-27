// FR-R3-143 (T047) — the General Settings number inputs must not offer a value
// the host will refuse.
//
// Each numeric `FieldSpec` in `GeneralSettingsTab.svelte` carries `min` and
// `max`, which become the `<input type="number">` bounds and are restated in the
// control's hover text. Three of them were wider than the manifest when this
// gate was written:
//
//   `retry.maxAttempts`               offered  0–20, host accepts 1–5
//   `logging.runtimeLogMaxGenerations` offered 1–50, host accepts 0–20
//   `loop.maxIterations`               offered 1–100, host accepts 1–50
//
// The first two arrived with this feature (T012, T013); the third had been
// wrong since Feature 018. All three presented the same way: the operator types
// a value the field accepts, the browser's own constraint validation passes it,
// and the host rejects it after the round trip. `retry.maxAttempts` was the
// sharpest, because its hover text explained what the out-of-range value was
// FOR ("Zero disables retries") — advice to enter a number that cannot be saved.
//
// ONLY THE WIDE DIRECTION FAILS. A field narrower than the manifest declines to
// offer an extreme the host would take, which is a defensible product choice and
// is how several of these are deliberately set (`audit.rotation.sizeMB` caps at
// 100 where the manifest has no maximum at all). A field WIDER than the manifest
// is never a choice: it is an offer the host cannot honour. Checking only the
// direction that can be wrong is what keeps this gate from turning every
// intentional guardrail into a failure.
//
// The manifest is read as JSON rather than through `settings-schema.ts`, because
// the manifest is what VS Code enforces and what
// `tests/unit/config/settings-schema-parity.test.ts` already holds the typed
// schema to. An unparseable spec list fails; a gate that finds no fields has no
// verdict to deliver.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MANIFEST = resolve(REPO_ROOT, 'package.json');
const TAB = resolve(
  REPO_ROOT,
  'webview-ui',
  'src',
  'components',
  'settings',
  'GeneralSettingsTab.svelte'
);

interface NumericField {
  readonly ipcKey: string;
  readonly min: number;
  readonly max: number;
}

interface ManifestBounds {
  readonly minimum?: number;
  readonly maximum?: number;
}

/**
 * Every `FieldSpec` literal in the tab that carries both `min` and `max`.
 *
 * Matched on `ipcKey` … `min` … `max` in that order because that is the order
 * every entry is authored in, and the three appear inside one object literal
 * that never spans another `ipcKey`. A field that stops matching drops out of
 * the count, which the length assertion below is there to catch.
 */
function parseNumericFields(source: string): readonly NumericField[] {
  const pattern = /ipcKey:\s*'([^']+)'[^}]*?\bmin:\s*(\d+)[^}]*?\bmax:\s*(\d+)/g;
  return [...source.matchAll(pattern)].map((match) => ({
    ipcKey: match[1],
    min: Number(match[2]),
    max: Number(match[3])
  }));
}

function manifestBounds(): ReadonlyMap<string, ManifestBounds> {
  const manifest: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const properties = (
    manifest as {
      contributes: { configuration: { properties: Record<string, ManifestBounds> } };
    }
  ).contributes.configuration.properties;
  return new Map(Object.entries(properties));
}

/** Fields offering a value outside what the manifest accepts, described. */
function overWideFields(
  fields: readonly NumericField[],
  bounds: ReadonlyMap<string, ManifestBounds>
): readonly string[] {
  return fields.flatMap((field) => {
    const declared = bounds.get(`schegent.${field.ipcKey}`);
    if (declared === undefined) return [];
    const problems: string[] = [];
    if (declared.minimum !== undefined && field.min < declared.minimum) {
      problems.push(`min ${field.min} below manifest minimum ${declared.minimum}`);
    }
    if (declared.maximum !== undefined && field.max > declared.maximum) {
      problems.push(`max ${field.max} above manifest maximum ${declared.maximum}`);
    }
    return problems.length === 0 ? [] : [`${field.ipcKey}: ${problems.join('; ')}`];
  });
}

describe('settings field bounds parity', () => {
  const fields = parseNumericFields(readFileSync(TAB, 'utf8'));
  const bounds = manifestBounds();

  it('locates the numeric field specs', () => {
    expect(
      fields,
      'no `FieldSpec` with min and max was found in GeneralSettingsTab.svelte. If ' +
        'the specs moved or changed shape, update this gate — an unparseable list ' +
        'is a failure, never a silent pass.'
    ).not.toHaveLength(0);
  });

  it('names a manifest key for every numeric field', () => {
    const unknown = fields
      .filter((field) => !bounds.has(`schegent.${field.ipcKey}`))
      .map((field) => field.ipcKey);
    expect(
      unknown,
      'these fields bind an ipcKey the manifest does not declare, so nothing ' +
        'adjudicates the value the operator types'
    ).toEqual([]);
  });

  it('offers no value the host would reject', () => {
    expect(
      overWideFields(fields, bounds),
      'these number inputs accept values outside the manifest bounds: the field ' +
        'takes the value, the browser passes it, and the host refuses it after ' +
        'the round trip'
    ).toEqual([]);
  });

  describe('the gate detects what it claims to', () => {
    const MANIFEST_SAMPLE = new Map<string, ManifestBounds>([
      ['schegent.retry.maxAttempts', { minimum: 1, maximum: 5 }],
      ['schegent.audit.rotation.sizeMB', { minimum: 1 }]
    ]);

    it('names a field whose maximum exceeds the manifest', () => {
      expect(
        overWideFields([{ ipcKey: 'retry.maxAttempts', min: 1, max: 20 }], MANIFEST_SAMPLE)
      ).toEqual(['retry.maxAttempts: max 20 above manifest maximum 5']);
    });

    it('names a field whose minimum falls below the manifest', () => {
      expect(
        overWideFields([{ ipcKey: 'retry.maxAttempts', min: 0, max: 5 }], MANIFEST_SAMPLE)
      ).toEqual(['retry.maxAttempts: min 0 below manifest minimum 1']);
    });

    it('passes a field narrower than the manifest', () => {
      expect(
        overWideFields([{ ipcKey: 'audit.rotation.sizeMB', min: 1, max: 100 }], MANIFEST_SAMPLE)
      ).toEqual([]);
    });

    it('reads the specs it is pointed at', () => {
      expect(
        parseNumericFields(
          "{ key: 'a', ipcKey: 'x.y', label: 'A', kind: 'number', min: 2, max: 7 },"
        )
      ).toEqual([{ ipcKey: 'x.y', min: 2, max: 7 }]);
    });

    it('ignores a spec that carries no bounds', () => {
      expect(parseNumericFields("{ key: 'a', ipcKey: 'x.y', kind: 'boolean' },")).toEqual([]);
    });
  });
});
