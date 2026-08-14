import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCHEMA_PATH = 'src/contracts/state-schema.ts';
const STATE_DIR = 'src/state';

/** The version the build ships, read from source rather than restated here. */
function shippedVersion(source: string): number {
  const match = /export const STATE_SCHEMA_VERSION = (\d+) as const;/.exec(source);
  expect(match, 'STATE_SCHEMA_VERSION declaration not found').not.toBeNull();
  return Number(match![1]);
}

/** `STATE_SCHEMA_VERSION_V<n> = <n>` — the declared rungs of the ladder. */
function declaredRungs(source: string): ReadonlyArray<readonly [number, number]> {
  return [...source.matchAll(/^export const STATE_SCHEMA_VERSION_V(\d+) = (\d+) as const;$/gm)].map(
    (match) => [Number(match[1]), Number(match[2])] as const
  );
}

/**
 * The `N — …` entries of the version-history block.
 *
 * The leading run is 2–3 spaces rather than exactly 3: the block right-aligns
 * the number, so it lost a space when the ladder reached two digits at v10.
 * The alignment is cosmetic, and pinning the padding would fail the next
 * feature for indenting its own entry the same way as every entry before it.
 */
function documentedVersions(source: string): readonly number[] {
  return [...source.matchAll(/^ \*[ ]{2,3}(\d+) — /gm)].map((match) => Number(match[1]));
}

/** Every ``migrateX()`` the history block names. */
function citedMigrators(source: string): readonly string[] {
  return [...new Set([...source.matchAll(/`(migrate[A-Za-z0-9]+)\(\)`/g)].map((m) => m[1]!))];
}

/** Every ``src/….ts`` path the history block names. */
function citedPaths(source: string): readonly string[] {
  return [...new Set([...source.matchAll(/`(src\/[A-Za-z0-9/_-]+\.ts)`/g)].map((m) => m[1]!))];
}

/** Concatenated `src/state/*.ts`, where every migration step is declared. */
function stateSource(): string {
  return readdirSync(STATE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(STATE_DIR, name), 'utf8'))
    .join('\n');
}

describe('release qualification', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
    contributes: { configuration: { properties: Record<string, unknown> } };
  };

  it('ships consolidated verification and auditable release surfaces', () => {
    expect(manifest.scripts['verify:all']).toContain('security:secrets');
    expect(manifest.scripts['verify:all']).toContain('security:actions');
    expect(manifest.scripts['contracts:check']).toBeTruthy();
    expect(existsSync('.github/workflows/release.yml')).toBe(true);
    expect(existsSync('src/commands/export-audit.ts')).toBe(true);
  });

  it('ships state v11 recovery controls without the dead Rust engine', () => {
    expect(manifest.contributes.configuration.properties['schegent.logging.rawTranscriptMode'])
      .toBeTruthy();
    // Pinned to the version the build actually ships, and moved deliberately
    // with each forward-only migration — v10 was feature 092's per-queue
    // `KEYS.queue` step, v11 is feature 093's per-queue `KEYS.run` step. The pin
    // is the point: a version that changed without anyone editing this line is a
    // migration nobody wrote.
    expect(readFileSync('src/contracts/state-schema.ts', 'utf8'))
      .toContain('STATE_SCHEMA_VERSION = 11');
    expect(existsSync('src/services/terminal-transition-coordinator.ts')).toBe(true);
    expect(existsSync('Cargo.toml')).toBe(false);
    expect(existsSync('src/engine/index.ts')).toBe(false);
  });
});

// Feature 089 (T022, US4, FR-025) — the shipped state version and the migration
// ladder move together.
//
// The literal pin above answers "is it 9?". This block answers the question the
// pin cannot: "is 9 the top of the ladder?" — which is the thing that actually
// breaks an upgrade. Two directions, both real:
//
//   **bumped without a step** — the constant is raised because a new field
//   landed, and no rung, no history entry, and no migrator accompany it. Every
//   workspace already at the old version is then read as current, and the new
//   field is absent on every record the runtime believes it just migrated.
//
//   **a step without a bump** — a `migrateV9ToV10` is written, or a version is
//   documented, and the constant stays put. The step never runs, because the
//   runtime never believes it is behind.
//
// Every number below is derived from source text, so no assertion here can be
// satisfied by editing this file.
//
// The limit, stated plainly rather than left to be discovered: the constant, the
// rung constants, and the history block share one file, so a single edit that
// moves all three passes. That edit *is* the accompanying documentation, which
// is the point — the executable half is what the step-function and
// migrator-existence checks below cover.
describe('the state version is the top of the migration ladder (T022, FR-025)', () => {
  const source = readFileSync(SCHEMA_PATH, 'utf8');
  const shipped = shippedVersion(source);

  it('declares a contiguous rung for every version, topping out at the shipped one', () => {
    const rungs = declaredRungs(source);

    expect(rungs.length).toBeGreaterThan(0);
    // A `_V9 = 8` typo names one version and holds another; the runtime would
    // then step to a version nothing else in the ladder agrees on.
    for (const [suffix, value] of rungs) {
      expect(value, `STATE_SCHEMA_VERSION_V${suffix} holds ${value}`).toBe(suffix);
    }
    // v1 is the baseline and has no rung constant, so the ladder starts at 2.
    expect(rungs.map(([suffix]) => suffix)).toEqual(
      Array.from({ length: shipped - 1 }, (_unused, index) => index + 2)
    );
  });

  it('documents a contiguous history whose last entry is the shipped version', () => {
    const documented = documentedVersions(source);

    expect(documented.length).toBeGreaterThan(0);
    expect(documented).toEqual(Array.from({ length: shipped }, (_unused, index) => index + 1));
  });

  it('cites only migrators that exist and files that exist', () => {
    const migrators = citedMigrators(source);
    const paths = citedPaths(source);
    const state = stateSource();

    // Non-empty first: a history block that cites nothing would otherwise pass
    // this test by having nothing to check.
    expect(migrators.length).toBeGreaterThan(0);
    expect(paths.length).toBeGreaterThan(0);
    for (const name of migrators) {
      // Word-bounded, not a substring: `migrateConnectedRunsRenamed` contains
      // the name of the migrator it replaced, and a plain `toContain` would read
      // the rename as the original still being there.
      const declared = new RegExp(String.raw`export function ${name}\b`);
      expect(declared.test(state), `${name}() is cited but not exported from ${STATE_DIR}/`).toBe(
        true
      );
    }
    for (const path of paths) {
      expect(existsSync(path), `${path} is cited but does not exist`).toBe(true);
    }
  });

  it('ships no migration step that climbs past the shipped version', () => {
    const steps = [...stateSource().matchAll(/export function migrateV(\d+)ToV(\d+)\b/g)].map(
      (match) => [Number(match[1]), Number(match[2])] as const
    );
    const rungs = new Set(declaredRungs(source).map(([suffix]) => suffix));

    expect(steps.length).toBeGreaterThan(0);
    for (const [from, to] of steps) {
      // One rung at a time, and only onto a rung the ladder declares.
      expect(to, `migrateV${from}ToV${to} skips a version`).toBe(from + 1);
      expect(rungs.has(to), `migrateV${from}ToV${to} targets an undeclared version`).toBe(true);
      // The direction that fails when a step ships without a bump.
      expect(to, `migrateV${from}ToV${to} climbs past the shipped version`).toBeLessThanOrEqual(
        shipped
      );
    }
  });
});
