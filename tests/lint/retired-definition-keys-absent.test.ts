/**
 * Feature 099 (T496b, FR-054, FR-063a, SC-013) — the three definition settings
 * keys are gone from the repository, and no configuration key is a catalog write
 * target.
 *
 * This replaces `built-in-layers-empty.test.ts`, which pinned that
 * `BUILT_IN_PHASES` and `BUILT_IN_PIPELINES` resolved to empty arrays. Those
 * bindings no longer exist, so there is no weakened variant of that check to
 * keep: the invariant it defended — an id claimed by a layer nobody authored —
 * cannot recur through a layer that is not there. What CAN recur is the other
 * half of the same mistake: a definition read back out of settings, next to the
 * store, so that two places claim the same id and the surfaces disagree about
 * which one is real.
 *
 * Three checks, because they fail on different mistakes:
 *
 *   1. The literal key strings appear in no source file, manifest, or generated
 *      schema. Repo-wide absence, not "not a write target" — that is what
 *      SC-013 measures, and a key still declared in `package.json` is offered to
 *      every operator's settings UI whether or not the host reads it back.
 *   2. The typed settings schema declares none of them. Redundant with check 1
 *      by construction today and deliberately so: check 1 is a byte scan, and a
 *      schema entry assembled from a variable would slip past it while still
 *      contributing a live property.
 *   3. No configuration key is written as a catalog destination. Checks 1 and 2
 *      both pass on a key renamed to `schegent.definitions`, and that is
 *      precisely the shape a reintroduction takes.
 *
 * Comments are deliberately in scope for check 1. A comment naming a deleted key
 * is how the key comes back: someone reads "`schegent.pipelines` used to hold
 * this" and restores it. Prose that must survive says "the retired Pipeline
 * settings key" or names the feature, not the key.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SETTINGS_SCHEMA } from '../../src/config/settings-schema';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The keys FR-054 deletes. Assembled in pieces so this file is not its own hit. */
const RETIRED_KEYS: readonly string[] = ['phases', 'pipelines', 'workflows'].map(
  (suffix) => `schegent.${suffix}`
);

/**
 * The trees a key could come back through.
 *
 * `package.json` is included because a contributed property is a live operator
 * surface even when nothing reads it, and the generated schemas because they are
 * what external tooling validates a settings file against.
 */
const SCANNED_DIRECTORIES: readonly string[] = ['src', 'webview-ui/src'];
const SCANNED_FILES: readonly string[] = [
  'package.json',
  'src/contracts/generated/schemas/settings.schema.json',
  'src/contracts/generated/schemas/sidebar-ipc.schema.json'
];

const SCANNED_EXTENSIONS: readonly string[] = ['.ts', '.svelte', '.json'];

function walk(directory: string, out: string[]): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension))) out.push(path);
  }
}

function scanFiles(): readonly string[] {
  const files: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) walk(resolve(REPO_ROOT, directory), files);
  for (const file of SCANNED_FILES) files.push(resolve(REPO_ROOT, file));
  return files.map((path) => relative(REPO_ROOT, path)).sort();
}

const FILES = scanFiles();

describe('retired definition settings keys', () => {
  it('scans a non-empty file set', () => {
    // Vacuity guard: a moved directory or a changed extension would otherwise
    // make every assertion below trivially true.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain('package.json');
    expect(FILES).toContain('src/config/settings-schema.ts');
    expect(FILES).toContain('src/contracts/generated/schemas/settings.schema.json');
  });

  it('appear in no source file, manifest, or generated schema', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const contents = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const lines = contents.split('\n');
      for (const key of RETIRED_KEYS) {
        lines.forEach((line, index) => {
          if (line.includes(key)) hits.push(`${file}:${index + 1} ${key}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });

  it('are absent from the typed settings schema', () => {
    for (const key of RETIRED_KEYS) {
      expect(Object.keys(SETTINGS_SCHEMA)).not.toContain(key);
    }
  });

  it('leaves no configuration key as a catalog write target', () => {
    // `updateConfig` is the only configuration writer the save commands may
    // reach, and FR-054 narrows it to the Model Catalog — so its declared key
    // argument IS the allowlist, and a widening shows up here rather than as a
    // second place definitions are stored.
    const routerTypes = readFileSync(
      resolve(REPO_ROOT, 'src/ui/sidebar/commands/router-types.ts'),
      'utf8'
    );
    const declaration = /updateConfig\?*:\s*\([^)]*\)\s*=>\s*Promise<void>;/.exec(routerTypes);
    expect(
      declaration,
      'updateConfig must remain declared on the router deps'
    ).not.toBeNull();
    const accepted = declaration![0];
    expect(accepted).toContain("'models'");
    for (const kind of ['phases', 'pipelines', 'workflows']) {
      expect(accepted, `updateConfig must not accept '${kind}'`).not.toContain(`'${kind}'`);
    }
    // And it takes no destination: a third argument is how a layer comes back.
    expect(accepted).not.toContain('scope');
  });
});
