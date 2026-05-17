// Doc-drift guard: every top-level subsystem under `src/` must be
// named at least once in ARCHITECTURE.md.
//
// Without this guard, a new subsystem can land in `src/` and stay
// invisible to readers of ARCHITECTURE.md. The check is intentionally
// loose (substring match) so it tolerates phrasing changes; what it
// catches is the strict failure mode "subsystem exists in code but
// nowhere in the architecture doc".
//
// Use the allowlist for directories whose existence is intentionally
// internal/non-architectural (none today).

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const ARCH_PATH = path.join(REPO_ROOT, 'ARCHITECTURE.md');

const ALLOWLIST_DIRS: ReadonlySet<string> = new Set<string>([
  // Internal directories that need not be referenced in ARCHITECTURE.md.
  // Add with a one-line justification.
]);

function listTopLevelSrcDirs(): string[] {
  return fs
    .readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

describe('ARCHITECTURE.md parity', () => {
  it('every top-level src/ subdirectory is referenced in ARCHITECTURE.md', () => {
    const dirs = listTopLevelSrcDirs();
    const archSrc = fs.readFileSync(ARCH_PATH, 'utf8');
    const missing: string[] = [];
    for (const dir of dirs) {
      if (ALLOWLIST_DIRS.has(dir)) continue;
      // Tolerate: `src/controller`, `controller/` (tree-style),
      // `` `controller/` ``, `` `controller` ``.
      const hits =
        archSrc.includes(`src/${dir}`) ||
        archSrc.includes(`${dir}/`) ||
        archSrc.includes(`\`${dir}\``);
      if (!hits) missing.push(dir);
    }
    expect(missing, `top-level src/ dirs missing from ARCHITECTURE.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('ARCHITECTURE.md exists and is non-trivial (>= 4000 lines? at least > 200)', () => {
    const stat = fs.statSync(ARCH_PATH);
    expect(stat.size).toBeGreaterThan(10_000);
  });
});
