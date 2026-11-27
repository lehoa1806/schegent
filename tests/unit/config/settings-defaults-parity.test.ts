import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { KEY_SPECS } from '../../../src/config/general-settings';
import { IDLE_GENERAL_SETTINGS as HOST_IDLE } from '../../../src/ui/sidebar/snapshot';

/**
 * FR-R3-051 (M-06) — one default, stated four times, must not drift.
 *
 * `package.json` is what VS Code applies. `KEY_SPECS[key].defaultValue` is the
 * host fallback. Two idle snapshots feed the sidebar before real settings
 * arrive. Two of the four had already drifted when this gate was written
 * (`logging.rawTranscriptMode` and the webview's `invocationTimeoutSeconds`),
 * and both survived because the existing tests sample specific keys. A gate on
 * some keys is not a gate on "all four agree".
 *
 * The webview file is READ from a host test rather than sharing a module,
 * because the webview must not import host code. A reader is the only mechanism
 * that can see both sides. Both idle surfaces are imported as values, not
 * parsed, so the comparison is of real values and not of a regex's opinion.
 */
const MANIFEST_PREFIX = 'schegent.';

function manifestDefaults(): ReadonlyMap<string, unknown> {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')
  ) as { contributes?: { configuration?: unknown } };
  const config = parsed.contributes?.configuration;
  const blocks = Array.isArray(config) ? config : [config];
  const out = new Map<string, unknown>();
  for (const block of blocks) {
    const props = (block as { properties?: Record<string, { default?: unknown }> } | undefined)
      ?.properties;
    if (!props) continue;
    for (const [key, value] of Object.entries(props)) {
      if (!key.startsWith(MANIFEST_PREFIX)) continue;
      out.set(key.slice(MANIFEST_PREFIX.length), value.default);
    }
  }
  return out;
}

/** Keyed by the unprefixed setting id, so all four surfaces are comparable. */
function hostFallbackDefaults(): ReadonlyMap<string, unknown> {
  return new Map(
    Object.entries(KEY_SPECS).map(([key, spec]) => [key, spec.defaultValue])
  );
}

/** The `typedField` each key projects to, which is how a snapshot names it. */
function typedFieldOf(): ReadonlyMap<string, string> {
  return new Map(Object.entries(KEY_SPECS).map(([key, spec]) => [key, spec.typedField]));
}

function idleDefaults(
  snapshot: Readonly<Record<string, unknown>>
): ReadonlyMap<string, unknown> {
  const fields = typedFieldOf();
  const out = new Map<string, unknown>();
  for (const [key, field] of fields) {
    if (!(field in snapshot)) continue;
    out.set(key, snapshot[field]);
  }
  return out;
}

/*
 * FR-R3-145 (T1570) -- the `UNCONTRIBUTED` set that stood here is gone, matching
 * the deletions in `settings-scope-parity.test.ts` and
 * `tests/parity/settings-defaults-parity.test.ts`.
 *
 * It held one name, `queue.defaultQueueId`, excused from the manifest comparison
 * for being "writable by the host with no manifest contribution", and it cited
 * `settings-scope-parity.test.ts` as where that was found -- a citation that had
 * already gone stale, since that file's copy of the set is deleted. The key is no
 * longer an accepted settings key at all: a default queue is a value in the queue
 * settings the store routes on, not a configuration a manifest could contribute.
 * Emptying the set changed no assertion, which is the whole problem with it -- an
 * exemption excusing nothing still stands ready to excuse the key silently if it
 * ever returns uncontributed. Both loops below now compare the manifest with no
 * exception at all.
 */

describe('every default agrees on all four surfaces (M-06)', () => {
  const manifest = manifestDefaults();
  const hostFallback = hostFallbackDefaults();
  const hostIdle = idleDefaults(HOST_IDLE as unknown as Record<string, unknown>);
  // Imported dynamically: the webview is an ES module and this suite compiles as
  // CommonJS, so a static import cannot resolve it. Still an import rather than a
  // parse -- the point is to compare the real frozen values.
  let webviewIdle: ReadonlyMap<string, unknown> = new Map();
  beforeAll(async () => {
    const mod = await import('../../../webview-ui/src/lib/snapshot-types.js');
    webviewIdle = idleDefaults(
      mod.IDLE_GENERAL_SETTINGS as unknown as Record<string, unknown>
    );
  });

  it('reads four non-trivial surfaces', () => {
    // Without this, a reader that silently returned nothing would make every
    // comparison below vacuously true -- the failure mode this gate replaces.
    expect(manifest.size).toBeGreaterThan(20);
    expect(hostFallback.size).toBeGreaterThan(20);
    expect(hostIdle.size).toBeGreaterThan(15);
    expect(webviewIdle.size).toBeGreaterThan(15);
  });

  it('states the same value on every surface that states one', () => {
    const mismatches: string[] = [];
    for (const [key, fallback] of hostFallback) {
      const surfaces: Array<[string, unknown]> = [
        ['manifest', manifest.get(key)],
        ['hostFallback', fallback],
        ['hostIdle', hostIdle.get(key)],
        ['webviewIdle', webviewIdle.get(key)]
      ];
      const present = surfaces.filter(([name]) =>
        name === 'manifest'
          ? manifest.has(key)
          : name === 'hostIdle'
            ? hostIdle.has(key)
            : name === 'webviewIdle'
              ? webviewIdle.has(key)
              : true
      );
      const encoded = present.map(([, value]) => JSON.stringify(value ?? null));
      if (new Set(encoded).size > 1) {
        mismatches.push(
          `${key}: ${present.map(([n], i) => `${n}=${encoded[i]}`).join(' ')}`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('states every writable key on every surface, in both directions', () => {
    const gaps: string[] = [];
    for (const key of hostFallback.keys()) {
      if (!manifest.has(key)) gaps.push(`${key}: absent from manifest`);
      if (!hostIdle.has(key)) gaps.push(`${key}: absent from the host idle snapshot`);
      if (!webviewIdle.has(key)) gaps.push(`${key}: absent from the webview idle snapshot`);
    }
    expect(gaps).toEqual([]);
  });
});
