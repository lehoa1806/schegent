import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { KEY_SPECS, ALLOWED_KEYS } from '../../../src/config/general-settings';

/**
 * FR-R3-051 (M-05) — the host's idea of a setting's scope must equal the
 * manifest's.
 *
 * `writeGeneralSettings` picks a configuration target from what the host
 * believes about each key. `package.json` is what real VS Code enforces. When
 * those disagree the write is rejected or misapplied by the product while the
 * suite stays green, because the config double accepts any target.
 *
 * Checked in BOTH directions on purpose. A one-way check ("every declaration
 * matches the manifest") passes when a declaration is missing entirely, which is
 * exactly the state a newly added application-scoped setting arrives in.
 */
const MANIFEST_PREFIX = 'schegent.';

interface ManifestProperty {
  readonly scope?: string;
  readonly default?: unknown;
}

function manifestProperties(): ReadonlyMap<string, ManifestProperty> {
  // Read from disk rather than importing: the manifest is data, and the shipped
  // file is the only copy VS Code reads. A checked-in mirror would be one more
  // restatement of the facts this test exists to keep aligned.
  const raw = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'package.json'),
    'utf8'
  );
  const parsed = JSON.parse(raw) as {
    contributes?: { configuration?: unknown };
  };
  const config = parsed.contributes?.configuration;
  const blocks = Array.isArray(config) ? config : [config];
  const out = new Map<string, ManifestProperty>();
  for (const block of blocks) {
    const props = (block as { properties?: Record<string, ManifestProperty> } | undefined)
      ?.properties;
    if (!props) continue;
    for (const [key, value] of Object.entries(props)) {
      if (!key.startsWith(MANIFEST_PREFIX)) continue;
      out.set(key.slice(MANIFEST_PREFIX.length), value);
    }
  }
  return out;
}

/** VS Code's default when a contribution omits `scope`. */
const DEFAULT_MANIFEST_SCOPE = 'window';

/**
 * Writable by the host, contributed by nothing. Found by this gate. It has no
 * declared scope, so it is declared `window` -- VS Code's treatment of an
 * uncontributed key, which keeps its existing workspace target.
 */
const UNCONTRIBUTED = new Set(['queue.defaultQueueId']);

describe('declared setting scope matches the manifest (M-05)', () => {
  const manifest = manifestProperties();

  it('reads a non-trivial manifest', () => {
    // Guards the whole file: a parse that silently yields nothing would make
    // every assertion below vacuously true.
    expect(manifest.size).toBeGreaterThan(20);
    expect([...manifest.values()].some((p) => p.scope === 'application')).toBe(true);
  });

  // There is deliberately NO test here for "every accepted key declares a
  // scope". `KeySpec.scope` is a required field, so a key without one fails to
  // compile -- tsc owns that check, and a runtime assertion for it can never
  // fail. Lint flagged the attempt as an unnecessary condition, which was
  // correct: it was a test of the type system, written as a test of the data.

  it('declares the same scope the manifest does, for every accepted key', () => {
    const mismatches: string[] = [];
    for (const key of ALLOWED_KEYS) {
      const declared = KEY_SPECS[key as keyof typeof KEY_SPECS].scope;
      const property = manifest.get(key);
      if (!property) {
        // One key is writable here with no manifest contribution at all. Named
        // rather than tolerated: a second one appearing is a finding, not a
        // tolerable gap, because an uncontributed setting has no declared scope,
        // no default and no settings-UI presence.
        if (!UNCONTRIBUTED.has(key)) {
          mismatches.push(`${key}: accepted by the host but absent from the manifest`);
        }
        continue;
      }
      const expected = property.scope ?? DEFAULT_MANIFEST_SCOPE;
      if (declared !== expected) {
        mismatches.push(`${key}: host declares ${String(declared)}, manifest says ${expected}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('accounts for every application-scoped manifest key it accepts', () => {
    // The three that reach `writeGeneralSettings` today. Named so that a ninth
    // application-scoped setting becoming writable shows up here as a change to
    // review rather than as a silent workspace write.
    const applicationAndAccepted = [...ALLOWED_KEYS]
      .filter((key) => manifest.get(key)?.scope === 'application')
      .sort();
    expect(applicationAndAccepted).toEqual(['agy.path', 'cli.path', 'codex.path']);
  });
});
