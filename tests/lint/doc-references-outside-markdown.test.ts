import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-063 — documentation paths cited from places `docs:check` cannot see.
 *
 * `docs:check` validates Markdown links: 1,229 of them across 276 files, green.
 * It saw none of the five dead references FR-R3-062 found, because they lived in
 * a manifest `markdownDescription` string, three Svelte string literals, and
 * source comments. Those five were reachable from the product UI -- two settings
 * an operator reads in the Settings editor, three banner bodies the webview
 * shows them -- and every one pointed at `docs/operations/trust-scopes.md`, which
 * did not exist.
 *
 * A gate that proves every Markdown link resolves, while the operator-facing
 * references live outside Markdown, measures the wrong population.
 */
const ROOT = resolve(__dirname, '..', '..');

/** Where a doc path can be cited from. */
const SCANNED_DIRS = ['src', 'webview-ui/src', 'scripts'] as const;
const SCANNED_FILES = ['package.json'] as const;
const SCANNED_EXTENSIONS = ['.ts', '.svelte', '.mjs', '.js', '.json'] as const;

/**
 * A `docs/...md` path. Deliberately anchored on the `docs/` segment rather than
 * on any `.md`: a bare filename in prose is not a reference anyone can follow,
 * and treating it as one would make this gate noisy enough to be turned off.
 */
const DOC_PATH = /(?:^|[^\w./-])((?:repo\/)?docs\/[A-Za-z0-9._/-]+\.md)/g;

/**
 * Paths named in order to say they are gone. Each carries a reason, because an
 * allowlist without one becomes a dumping ground -- which is the failure mode
 * this whole item is about.
 */
const KNOWN_ABSENT: ReadonlyMap<string, string> = new Map([
  [
    'docs/architecture/checkpoint-attribution-decision.md',
    'FR-R3-062: cited by run-mutation-ledger.ts to record that the citation was dead'
  ],
  [
    'docs/operations/performance.md',
    'FR-R3-062: cited by claude-cli-monitor.ts to record that the citation was dead'
  ],
  [
    'docs/plans/workspace-isolation-strategy.md',
    'FR-R3-063: named by workspace-folder-picker.ts to record what its citation was retargeted from'
  ]
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.name === '__tests__' || entry.name === '__mocks__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    // Test files carry FIXTURE paths -- `docs/report.md` as a sample output
    // target -- not citations anyone follows. Including them would make this gate
    // noisy enough to be turned off, which is worse than not having it.
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
    if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
}

function scannedFiles(): readonly string[] {
  const out: string[] = [];
  for (const dir of SCANNED_DIRS) {
    const full = resolve(ROOT, dir);
    if (existsSync(full) && statSync(full).isDirectory()) walk(full, out);
  }
  for (const file of SCANNED_FILES) {
    const full = resolve(ROOT, file);
    if (existsSync(full)) out.push(full);
  }
  return out;
}

interface Citation {
  readonly from: string;
  readonly line: number;
  readonly target: string;
}

function citations(): readonly Citation[] {
  const found: Citation[] = [];
  for (const file of scannedFiles()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const match of text.matchAll(DOC_PATH)) {
        found.push({
          from: relative(ROOT, file).split(/[/\\]/).join('/'),
          line: index + 1,
          // `repo/docs/...` and `docs/...` name the same file from different
          // vantage points; both appear in the tree.
          target: match[1]!.replace(/^repo\//, '')
        });
      }
    });
  }
  return found;
}

describe('documentation paths cited outside Markdown resolve (FR-R3-063)', () => {
  const all = citations();

  it('finds citations at all', () => {
    // Without this the regex could stop matching and every assertion below would
    // pass by finding nothing -- the vacuous-gate failure this item is about.
    expect(all.length).toBeGreaterThan(10);
  });

  it('includes the manifest and webview surfaces, not only source comments', () => {
    // The five defects FR-R3-062 found were in exactly these two populations. A
    // scan that covered only `src/**/*.ts` would have missed all of them.
    expect(all.some((c) => c.from === 'package.json')).toBe(true);
    expect(all.some((c) => c.from.endsWith('.svelte'))).toBe(true);
  });

  it('resolves every cited path, or names it as knowingly absent with a reason', () => {
    const broken = all
      .filter((c) => !existsSync(resolve(ROOT, c.target)))
      .filter((c) => !KNOWN_ABSENT.has(c.target))
      .map((c) => `${c.from}:${c.line} -> ${c.target}`);
    expect(broken).toEqual([]);
  });

  it('keeps the knowingly-absent list live', () => {
    // A path that exists again must leave this list, or the list stops describing
    // anything -- the same dead-standing-permission defect this item removed from
    // two other allowlists.
    const resurrected = [...KNOWN_ABSENT.keys()].filter((p) => existsSync(resolve(ROOT, p)));
    expect(resurrected).toEqual([]);
  });

  it('requires a reason for every knowingly-absent entry', () => {
    for (const [path, why] of KNOWN_ABSENT) {
      expect(why.length, `${path} needs a reason`).toBeGreaterThan(20);
    }
  });
});
