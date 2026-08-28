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

/**
 * Where a bare `docs/...` citation may resolve, in order.
 *
 * FR-R3-136 — THIS WORKSPACE IS TWO REPOSITORIES. The execution repo (`repo/`,
 * where this gate runs) and the envelope above it each carry their own `docs/`
 * tree, and `AGENTS.md` treats both as first-class. `scripts/gate-attestation.mjs`
 * cites `docs/architecture/release-posture-engineering-preview.md`, which is real
 * and envelope-side, and this gate called it broken. The citation was true; the
 * resolution model had one tree in it. That is worth stating plainly because the
 * failure looks identical to the dead references FR-R3-062 found, and reading it
 * as one would have deleted a working citation.
 *
 * REPO-SIDE WINS, so a citation meant for the execution repo is never satisfied
 * by an envelope file that happens to share its relative path — the order here is
 * load-bearing, not cosmetic.
 *
 * A `repo/docs/...` citation names the execution repo explicitly and is resolved
 * only there. The fallback is for the bare form, which in a two-tree workspace
 * genuinely names either.
 *
 * IN A STANDALONE `repo/` CHECKOUT the second root does not exist and an
 * envelope-side citation goes red here. That is the right outcome and not a
 * portability bug: the standalone clone is not a supported layout of this
 * project, and a fallback that quietly passed when the tree it needs is missing
 * would be the vacuous-gate failure this item is about.
 */
const RESOLUTION_ROOTS = [ROOT, resolve(ROOT, '..')] as const;

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
  /**
   * Whether the citation wrote the `repo/` prefix. Kept because it is the
   * difference between "this file, in the execution repo" and "this file, in
   * whichever tree holds it".
   */
  readonly repoSide: boolean;
}

/**
 * Whether a reader could follow the citation.
 *
 * A named function taking the two fields rather than an inline `existsSync`, so
 * the control below can drive it against paths it fully controls. A resolver that
 * can only be run over the real tree cannot be shown to resolve anything.
 */
export function resolvesForReader(target: string, repoSide: boolean): boolean {
  if (repoSide) return existsSync(resolve(ROOT, target));
  return RESOLUTION_ROOTS.some((root) => existsSync(resolve(root, target)));
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
          target: match[1]!.replace(/^repo\//, ''),
          repoSide: match[1]!.startsWith('repo/')
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
      .filter((c) => !resolvesForReader(c.target, c.repoSide))
      .filter((c) => !KNOWN_ABSENT.has(c.target))
      .map((c) => `${c.from}:${c.line} -> ${c.target}`);
    expect(
      broken,
      'Each of these names a file that exists in neither the execution repo nor ' +
        'the envelope above it. Retarget the citation, or add it to KNOWN_ABSENT ' +
        'with a reason (FR-R3-063).'
    ).toEqual([]);
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

  // ---- controls: the widened resolver's own failure modes, demonstrated ----

  it('CONTROL: the resolver still refuses a path absent from both trees', () => {
    // The hazard in widening resolution is that it stops refusing anything. This
    // is the assertion that says otherwise, and it is the one to read first if
    // this gate ever goes quiet.
    expect(resolvesForReader('docs/no-such-file-for-this-control.md', false)).toBe(false);
    expect(resolvesForReader('docs/no-such-file-for-this-control.md', true)).toBe(false);
  });

  it('CONTROL: it finds a file in each tree, and a repo-side citation does not reach the envelope', () => {
    // One real file per tree, so a broken root shows up here rather than as a
    // clean run. Both are load-bearing documents that will not quietly vanish.
    expect(resolvesForReader('docs/development/lint-gate-census.md', true)).toBe(true);
    expect(
      resolvesForReader('docs/architecture/release-posture-engineering-preview.md', false)
    ).toBe(true);
    // And the envelope-side one is NOT reachable as a repo-side citation, which
    // is the precision the ordered roots exist to keep.
    expect(
      resolvesForReader('docs/architecture/release-posture-engineering-preview.md', true)
    ).toBe(false);
  });

  it('CONTROL: the scan records the repo/ prefix it was given', () => {
    // `repoSide` is what selects between the two behaviours above, so a scan that
    // stopped setting it would silently turn the precision off.
    expect(all.some((c) => c.repoSide)).toBe(true);
    expect(all.some((c) => !c.repoSide)).toBe(true);
  });
});
