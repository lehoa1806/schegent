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

/*
 * FR-R3-145 (T1570) -- the `UNCONTRIBUTED` set that stood here is gone.
 *
 * It held exactly one name, `queue.defaultQueueId`, excused for being writable by
 * the host with no manifest contribution behind it. That key is no longer a
 * `KEY_SPECS` payload key -- it was a typed field for a configuration that never
 * existed, and the surfaces that resolve a default queue now resolve it from the
 * store that routes on it. So the set excused nothing, and leaving it standing
 * would have meant the key could come back uncontributed and this gate would
 * still have said nothing. The loop below now reports any accepted key the
 * manifest does not declare, with no exception at all.
 */

describe('declared setting scope matches the manifest (M-05)', () => {
  const manifest = manifestProperties();

  it('reads a non-trivial manifest', () => {
    // Guards the whole file: a parse that silently yields nothing would make
    // every assertion below vacuously true.
    expect(manifest.size).toBeGreaterThan(20);
    expect([...manifest.values()].some((p) => p.scope === 'application')).toBe(true);
    // The same guard from the other side. Both loops below walk `ALLOWED_KEYS`,
    // so an emptied host table would report no mismatches with perfect honesty
    // and no information.
    expect(ALLOWED_KEYS.size).toBeGreaterThan(20);
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
        // An uncontributed setting has no declared scope, no default and no
        // settings-UI presence, so a key that is writable here and absent from
        // the manifest is a finding rather than a tolerable gap. FR-R3-145
        // (T1570) removed the one standing exception; there is nothing left this
        // arm is expected to forgive.
        mismatches.push(`${key}: accepted by the host but absent from the manifest`);
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
    // The seven that reach `writeGeneralSettings` today. Named so that an
    // eighth application-scoped setting becoming writable shows up here as a
    // change to review rather than as a silent workspace write.
    //
    // FR-R3-143 (T024) — four arrived at once: the settings tab could not
    // offer the environment policy, its allowlist, or the probe timeout while
    // the host had no write path for them. Each is `application`-scoped in the
    // manifest, so `configurationTargetFor` sends it to Global, which is the
    // point of this assertion — a workspace cannot set a machine-level policy
    // for the installation, and a review of this line is where that is checked.
    const applicationAndAccepted = [...ALLOWED_KEYS]
      .filter((key) => manifest.get(key)?.scope === 'application')
      .sort();
    expect(applicationAndAccepted).toEqual([
      'agy.path',
      'backend.probeTimeoutSeconds',
      'cli.environmentAllowlist',
      'cli.environmentMode',
      'cli.inheritEnvironment',
      'cli.path',
      'codex.path'
    ]);
  });
});
