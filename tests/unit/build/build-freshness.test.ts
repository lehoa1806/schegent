/**
 * Feature 106 (T597c, FR-019 to FR-022, SC-011, SC-012) — the staleness refusal,
 * observed one build half at a time.
 *
 * `vsce package` reads `dist/` without building it, so `package:smoke` could
 * always pass — or fail — on output from an earlier checkout. The check that fixed
 * that makes two independent mtime comparisons, and the reason for two rather
 * than one is only visible if each is exercised alone: a fresh host bundle must
 * not be able to vouch for a webview build from last week. SC-011 requires both
 * halves backdated separately, so that is what this file does.
 *
 * The fixture is a synthetic tree, not the real repository. Backdating the real
 * `dist/` would leave the working copy in a state where the next `package:smoke`
 * refuses, and a test that has to be undone by hand is a test nobody runs twice.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Loaded dynamically, like every other test that reaches into `scripts/`. The
 * pattern is not stylistic: a static import of an ES module from this CommonJS
 * test program is TS1479, and naming its type directly is TS1542. Inferring the
 * type through the loader is what `typecheck:tests` accepts.
 */
async function loadFreshness() {
  return import('../../../scripts/check-build-freshness.mjs');
}

let freshness: Awaited<ReturnType<typeof loadFreshness>>;

beforeAll(async () => {
  freshness = await loadFreshness();
});

/** Fixed epoch seconds, so a failure message reads the same on every machine. */
const SOURCE_TIME = 1_700_000_000;
const BUILD_TIME = SOURCE_TIME + 10;
const BACKDATED = SOURCE_TIME - 10;

const HOST_OUTPUT = 'dist/extension.js';
const WEBVIEW_OUTPUT = 'dist/webview/index.js';

/**
 * Both fixture test files are paths that exist in the real tree, and both are
 * webview-side because that is where every one of the 138 test files under the
 * scanned source roots lives — `src/` has none. `tests/lint/lint-anchor-grounding`
 * scans this directory and reads a `src/`-shaped literal as a claim about the
 * repository, which is the correct reading: a fixture named after a file that does
 * not exist pre-excuses whatever is written at that path next.
 *
 * The two are skipped by different branches, so both are exercised. `routes.test.ts`
 * sits beside its subject and is excluded by the filename filter; the `__tests__`
 * one is excluded by the directory skip, which nothing observed before.
 */
const NAMED_TEST_FILE = 'webview-ui/src/dashboard/routes.test.ts';
const TEST_DIRECTORY_FILE = 'webview-ui/src/lib/__tests__/host-transport.test.ts';

let root: string;

function write(relative: string, contents: string, seconds: number): void {
  const full = join(root, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  utimesSync(full, seconds, seconds);
}

function touch(relative: string, seconds: number): void {
  utimesSync(join(root, relative), seconds, seconds);
}

function stateOf(half: 'host' | 'webview'): string {
  const found = freshness.buildFreshness(root).find((entry) => entry.half === half);
  if (found === undefined) throw new Error(`no such build half: ${half}`);
  return found.state;
}

function refusal(): string {
  try {
    freshness.assertBuildOutputIsFresh(root);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

/** Every file under a directory, with its bytes and its mtime. */
function snapshot(relative: string, into = new Map<string, string>()): Map<string, string> {
  const full = join(root, relative);
  if (!existsSync(full)) return into;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      snapshot(child, into);
      continue;
    }
    const path = join(root, child);
    into.set(child, `${statSync(path).mtimeMs}:${readFileSync(path, 'utf8')}`);
  }
  return into;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'build-freshness-'));
  write('src/extension.ts', 'export const host = 1;\n', SOURCE_TIME);
  write('webview-ui/src/App.svelte', '<main></main>\n', SOURCE_TIME);
  write(NAMED_TEST_FILE, 'test file\n', SOURCE_TIME);
  write(TEST_DIRECTORY_FILE, 'test file\n', SOURCE_TIME);
  write(HOST_OUTPUT, 'host bundle\n', BUILD_TIME);
  write(WEBVIEW_OUTPUT, 'webview bundle\n', BUILD_TIME);
  write('dist/webview/chunks/RunsSurface.js', 'chunk\n', BUILD_TIME);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('both halves current', () => {
  it('passes and says nothing', () => {
    expect(freshness.buildFreshness(root).map((half) => half.state)).toEqual(['fresh', 'fresh']);
    expect(() => freshness.assertBuildOutputIsFresh(root)).not.toThrow();
  });

  it('is not disturbed by a test edit beside its subject (T593a)', () => {
    // A refusal a reader learns to ignore is worse than no refusal, and editing a
    // test cannot change what gets packaged. Skipped by the filename filter.
    touch(NAMED_TEST_FILE, BUILD_TIME + 1_000);
    expect(stateOf('webview')).toBe('fresh');
    expect(() => freshness.assertBuildOutputIsFresh(root)).not.toThrow();
  });

  it('is not disturbed by an edit inside a __tests__ directory either', () => {
    // The other skip branch: 137 of the 138 test files under the scanned roots are
    // in such a directory, so this is the one that carries the weight.
    touch(TEST_DIRECTORY_FILE, BUILD_TIME + 1_000);
    expect(stateOf('webview')).toBe('fresh');
    expect(() => freshness.assertBuildOutputIsFresh(root)).not.toThrow();
  });

  it('treats output newer than its sources as current, not merely equal', () => {
    touch(HOST_OUTPUT, SOURCE_TIME);
    expect(stateOf('host')).toBe('fresh');
  });
});

describe('each half is compared on its own (SC-011)', () => {
  it('refuses on a stale host bundle while the webview half is current', () => {
    touch(HOST_OUTPUT, BACKDATED);
    expect(stateOf('host')).toBe('stale');
    expect(stateOf('webview')).toBe('fresh');

    const message = refusal();
    expect(message).toContain('[packaging] refusing to package: 1 of 2 build halves not current');
    // The host output is one file, so it is named once, not twice.
    expect(message).toContain(
      'host build output is older than its sources: dist/extension.js at 2023-11-14T22:13:10.000Z, ' +
        'source src/extension.ts at 2023-11-14T22:13:20.000Z — run npm run build:host'
    );
    expect(message).not.toContain('dist/extension.js newest');
    expect(message).not.toContain('webview build output');
  });

  it('refuses on a stale webview bundle while the host half is current', () => {
    // The webview build sets `emptyOutDir: true`, so the newest file under
    // `dist/webview/` dates the build — backdating one of two is not enough.
    touch(WEBVIEW_OUTPUT, BACKDATED);
    touch('dist/webview/chunks/RunsSurface.js', BACKDATED);
    expect(stateOf('webview')).toBe('stale');
    expect(stateOf('host')).toBe('fresh');

    const message = refusal();
    expect(message).toContain('1 of 2 build halves not current');
    // The webview output is a directory, so the file that dates it is named too —
    // that is the one thing the reader cannot work out from the configured path.
    expect(message).toContain(
      'webview build output is older than its sources: dist/webview newest ' +
        'dist/webview/chunks/RunsSurface.js at 2023-11-14T22:13:10.000Z, ' +
        'source webview-ui/src/App.svelte at 2023-11-14T22:13:20.000Z — run npm run build:webview'
    );
    expect(message).not.toContain('host build output');
  });

  it('the newest file in the webview tree is what dates the build', () => {
    touch(WEBVIEW_OUTPUT, BACKDATED);
    expect(stateOf('webview')).toBe('fresh');
  });

  it('reports both halves in one refusal, pluralised', () => {
    touch(HOST_OUTPUT, BACKDATED);
    touch(WEBVIEW_OUTPUT, BACKDATED);
    touch('dist/webview/chunks/RunsSurface.js', BACKDATED);
    const message = refusal();
    expect(message).toContain('2 of 2 build halves not current');
    expect(message).toContain('host build output is older');
    expect(message).toContain('webview build output is older');
  });
});

describe('an undatable half refuses rather than reading as fresh', () => {
  it('names absent output and the command that produces it', () => {
    rmSync(join(root, HOST_OUTPUT));
    expect(stateOf('host')).toBe('absent');
    expect(refusal()).toContain(
      'host build output is absent (dist/extension.js) — run npm run build:host'
    );
  });

  it('refuses a source tree it cannot date instead of passing over nothing', () => {
    // The directory survives; only the files the scan will count are gone. A
    // sentinel time here — 0 for missing sources — would read as "fresh", which is
    // the vacuity this check exists to remove.
    rmSync(join(root, 'src/extension.ts'));
    expect(stateOf('host')).toBe('unscannable');
    expect(refusal()).toContain(
      'host source scan found no file under src — refusing rather than reporting fresh'
    );
  });

  it('refuses an absent source tree too', () => {
    rmSync(join(root, 'webview-ui'), { recursive: true });
    expect(stateOf('webview')).toBe('unscannable');
  });

  it('a tree holding nothing but tests is unscannable, not fresh', () => {
    // Every skip branch firing at once is the same vacuity from the other side:
    // the scan ran, found only files it must ignore, and must not report fresh.
    rmSync(join(root, 'webview-ui/src/App.svelte'));
    expect(stateOf('webview')).toBe('unscannable');
  });
});

describe('the refusal does not repair (FR-021, SC-012)', () => {
  it('leaves the output tree byte-for-byte and mtime-for-mtime unchanged', () => {
    touch(HOST_OUTPUT, BACKDATED);
    const before = snapshot('dist');
    expect(before.size).toBe(3);

    expect(() => freshness.assertBuildOutputIsFresh(root)).toThrow(/refusing to package/);

    expect([...snapshot('dist').entries()].sort()).toEqual([...before.entries()].sort());
  });

  it('creates nothing beside the output tree either', () => {
    rmSync(join(root, HOST_OUTPUT));
    const before = readdirSync(root).sort();
    expect(() => freshness.assertBuildOutputIsFresh(root)).toThrow(/refusing to package/);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(existsSync(join(root, HOST_OUTPUT))).toBe(false);
  });
});

describe('the halves are the two the build actually has', () => {
  it('names one output and one rebuild command per half', () => {
    expect(freshness.BUILD_HALVES.map((half) => half.half)).toEqual(['host', 'webview']);
    expect(freshness.BUILD_HALVES.map((half) => half.output)).toEqual(['dist/extension.js', 'dist/webview']);
    expect(freshness.BUILD_HALVES.map((half) => half.rebuild)).toEqual([
      'npm run build:host',
      'npm run build:webview'
    ]);
    for (const half of freshness.BUILD_HALVES) {
      expect(half.sources.length).toBeGreaterThan(0);
    }
  });

  it('checks every half, so a half cannot be added without being compared', () => {
    expect(freshness.buildFreshness(root)).toHaveLength(freshness.BUILD_HALVES.length);
  });
});
