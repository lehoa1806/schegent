import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  UNFENCED_COMMIT_REASONS,
  isFencedClaim,
  unfencedCommit,
  type UnfencedCommitReason
} from '../../../src/state/ownership-claim';

/**
 * FR-R3-077 (T1039) — the inventory of commits that carry no fence.
 *
 * The item's rule is that a call site which genuinely cannot produce a claim is
 * *a finding about that call site, recorded as one* — never a default parameter
 * and never a documented "callers that do not need this may omit it". The
 * required parameter is what makes `tsc` enumerate the sites; this file is what
 * makes the exemptions countable, so a new one cannot arrive quietly.
 *
 * Three properties, and each of them fails on a different way of cheating:
 *
 *   1. The reason set is exactly what the union says. Adding an arm without
 *      adding it here is a failing test, not a silent widening.
 *   2. `test-fixture` appears in no `src/` file. That arm exists so tests can
 *      write Run records without standing up a lease manager, and it is the one
 *      most obviously available as a production shortcut.
 *   3. `lease-not-held` appears in exactly ONE `src/` file. It is the honest
 *      answer to a real case — a late write after a Run's terminal transition
 *      released its queue — and it is produced by the store, warned once per
 *      queue, and never written at a call site. Spreading it across call sites
 *      would turn it into the opt-out this item exists to remove.
 */
const SRC = resolve(__dirname, '..', '..', '..', 'src');

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Code lines only: a docstring that NAMES a reason is not a use of it. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

function filesUsing(reason: UnfencedCommitReason): readonly string[] {
  const needle = `unfencedCommit('${reason}')`;
  return sourceFiles(SRC)
    .filter((file) => codeOf(file).includes(needle))
    .map((file) => relative(SRC, file));
}

describe('the unfenced-commit inventory (FR-R3-077)', () => {
  it('pins the reason set exactly', () => {
    // Sorted so the assertion is about membership, not declaration order.
    expect([...UNFENCED_COMMIT_REASONS].sort()).toEqual([
      'host-disposal',
      'lease-not-held',
      'pre-election-recovery',
      'state-migration',
      'test-fixture'
    ]);
  });

  it('keeps `test-fixture` out of production code', () => {
    expect(filesUsing('test-fixture')).toEqual([]);
  });

  it('keeps `lease-not-held` to the single site that produces it', () => {
    // One file, and it is the store: the reason is derived there, from the
    // absence of a claim, and warned. If this list grows, the fence has acquired
    // the opt-out the item forbids.
    expect(filesUsing('lease-not-held')).toEqual(['state/workspace-state.ts']);
  });

  it('distinguishes a fenced claim from an unfenced commit', () => {
    expect(isFencedClaim(unfencedCommit('host-disposal'))).toBe(false);
    expect(isFencedClaim({ resource: 'queue:default', ownerId: 'w', fence: 3 })).toBe(true);
  });

  it('carries the reason on the value, so a reader can say which it was', () => {
    expect(unfencedCommit('state-migration')).toEqual({
      kind: 'unfenced',
      reason: 'state-migration'
    });
  });
});
