// Review gap GC-21 (2026-11-12) — every contributed setting has a row in the settings reference.
//
// WHAT THIS PINS:
//   - `docs/reference/settings.md` is the operator's reference for `schegent.*`, and
//     `tests/unit/config/settings-schema-parity.test.ts` holds the schema to `package.json`. Nothing
//     held the doc to either: eleven keys (`acp.profile`, `lanes.*`, `telemetry.export.*`) shipped
//     with no row, and the doc gates that existed checked that cited paths resolve, not that every
//     key was covered;
//   - both directions: a key the manifest contributes needs a row, and a row needs a key the
//     manifest still contributes, so a retired key cannot linger as documentation;
//   - a row is a table line whose first cell is exactly the backticked key.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SETTINGS_DOC = resolve(REPO_ROOT, 'docs', 'reference', 'settings.md');

/** A settings table row: the first cell is one backticked `schegent.*` key. */
const ROW_KEY = /^\| `(schegent\.[A-Za-z0-9.]+)` \|/;

function manifestKeys(): string[] {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, unknown> } };
  };
  return Object.keys(manifest.contributes.configuration.properties).sort();
}

function documentedKeys(): string[] {
  const keys = new Set<string>();
  for (const line of readFileSync(SETTINGS_DOC, 'utf8').split('\n')) {
    const key = ROW_KEY.exec(line)?.at(1);
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

describe('GC-21 — settings.md documents exactly the contributed settings', () => {
  it('reads keys from both sides before comparing them', () => {
    expect(manifestKeys().length).toBeGreaterThan(40);
    expect(documentedKeys().length).toBeGreaterThan(40);
  });

  it('has a row for every key package.json contributes', () => {
    const documented = new Set(documentedKeys());

    expect(
      manifestKeys().filter((key) => !documented.has(key)),
      'these settings ship with no row in docs/reference/settings.md'
    ).toEqual([]);
  });

  it('has no row for a key package.json no longer contributes', () => {
    const contributed = new Set(manifestKeys());

    expect(
      documentedKeys().filter((key) => !contributed.has(key)),
      'these rows document settings the manifest does not contribute'
    ).toEqual([]);
  });
});
