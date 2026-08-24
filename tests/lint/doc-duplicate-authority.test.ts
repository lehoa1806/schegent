import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-063 — two documents with the same body are two authorities.
 *
 * The review missed a 98 KB duplicate in the tree it had inventoried. Byte-identical
 * bodies are worse than a stale page: an edit lands in one copy, both remain
 * plausible, and a reader has no way to tell which is current.
 *
 * Scans the whole envelope, not just this repository, because the duplication
 * that matters here crosses that boundary -- `specs/`, `.specify/templates/` and
 * the two skill trees are all outside `repo/`.
 */
const REPO = resolve(__dirname, '..', '..');
const ENVELOPE = resolve(REPO, '..');

/** Below this, an identical body is boilerplate rather than an authority. */
const MIN_BYTES = 2000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test']);

/**
 * Duplication that is deliberate, each with its reason. Keyed by the sorted pair
 * so a group is named exactly once.
 */
const ALLOWED_DUPLICATES: ReadonlyMap<string, string> = new Map([
  [
    '.agents/skills|.claude/skills',
    'the same skill definition read by two agent runtimes from two fixed paths; ' +
      'one file cannot serve both, and drift between them is a functional bug rather ' +
      'than a documentation one'
  ],
  [
    '.specify/templates/plan-template.md|specs/068-enhance-system-log/plan.md',
    'FR-R3-063 finding: feature 068 committed the UNFILLED plan template as its plan. ' +
      'Recorded rather than rewritten -- back-filling a completed feature\'s plan now ' +
      'would be fabrication, and the empty template is the honest evidence that it was ' +
      'never written'
  ]
]);

function markdownUnder(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      markdownUnder(full, out);
      continue;
    }
    if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** The allowlist key for a group: sorted, and collapsed to the skill-tree pair. */
function groupKey(paths: readonly string[]): string {
  const skillTrees = paths.every((p) => p.includes('/skills/'));
  if (skillTrees && paths.some((p) => p.startsWith('.agents/'))) {
    return '.agents/skills|.claude/skills';
  }
  return [...paths].sort().join('|');
}

describe('no two documents share a body (FR-R3-063)', () => {
  const byHash = new Map<string, string[]>();
  for (const file of markdownUnder(ENVELOPE)) {
    const body = readFileSync(file);
    if (body.length < MIN_BYTES) continue;
    const hash = createHash('sha256').update(body).digest('hex');
    const rel = relative(ENVELOPE, file).split(/[/\\]/).join('/');
    byHash.set(hash, [...(byHash.get(hash) ?? []), rel]);
  }
  const groups = [...byHash.values()].filter((paths) => paths.length > 1);

  it('scans a substantial tree', () => {
    // Guards the whole file: a scan that reached nothing would report no
    // duplicates and look like a pass.
    expect([...byHash.values()].flat().length).toBeGreaterThan(100);
  });

  it('has no unexplained duplicate body', () => {
    const unexplained = groups
      .filter((paths) => !ALLOWED_DUPLICATES.has(groupKey(paths)))
      .map((paths) => paths.join(' == '));
    expect(unexplained).toEqual([]);
  });

  it('keeps the allowlist live: an entry whose duplication is gone must leave it', () => {
    const live = new Set(groups.map(groupKey));
    const stale = [...ALLOWED_DUPLICATES.keys()].filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });

  it('requires a reason for every allowed duplicate', () => {
    for (const [key, why] of ALLOWED_DUPLICATES) {
      expect(why.length, `${key} needs a reason`).toBeGreaterThan(40);
    }
  });
});
