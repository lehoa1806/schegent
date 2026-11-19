// FR-R7-05 (SC-002) — shrink-only cast ratchet for `SidebarCommand`.
//
// Before FR-R7-05, hand-written inbound IPC validators carried 71 `as SidebarCommand`
// (and `as unknown as SidebarCommand`) casts across `src/contracts/runtime-validators.ts`
// and `src/contracts/validators/*.ts`. Generated validators construct statically typed
// command members and return `ok(command)` directly without casting.
//
// This ratchet pins the ceiling at 0 across `src/` so casts cannot return silently.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Shrink-only ceiling — pinned at 0 once generated validators replaced hand-written ones. */
const MAX_SIDEBAR_COMMAND_CASTS = 0;

/** Matches both `as SidebarCommand` and `as unknown as SidebarCommand` (with arbitrary whitespace). */
const SIDEBAR_COMMAND_CAST_RE = /\bas\s+(?:unknown\s+as\s+)?SidebarCommand\b/g;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(abs));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out.sort();
}

function findCastsInText(source: string): number[] {
  const hits: number[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Ignore pure single-line comments so explanatory prose does not trip the cast detector.
    if (/^\s*\/\//.test(line)) continue;
    SIDEBAR_COMMAND_CAST_RE.lastIndex = 0;
    if (SIDEBAR_COMMAND_CAST_RE.test(line)) {
      hits.push(i + 1);
    }
  }
  return hits;
}

describe('no-sidebar-command-casts ratchet (FR-R7-05 / SC-002)', () => {
  it('scans a substantial TypeScript tree under src/ (vacuity control)', () => {
    const files = walkTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const validatorFiles = files.filter((f) =>
      path.relative(REPO_ROOT, f).startsWith('src/contracts/generated/validators/')
    );
    expect(validatorFiles.length).toBe(9);
  });

  it('catches both direct and double casts in synthetic inputs (non-vacuity control)', () => {
    const sample = [
      'return ok({ type: CMD_START, correlationId, payload } as SidebarCommand);',
      'return ok({ type: CMD_SAVE_MODELS, correlationId, payload } as unknown as SidebarCommand);',
      '// explanatory comment mentioning as SidebarCommand',
      'const clean: StartCommand = { type: CMD_START, correlationId, payload };'
    ].join('\n');
    expect(findCastsInText(sample)).toEqual([1, 2]);
  });

  it(`keeps SidebarCommand casts across src/ at or below ${MAX_SIDEBAR_COMMAND_CASTS}`, () => {
    const files = walkTsFiles(SRC_ROOT);
    const violations: string[] = [];
    for (const abs of files) {
      const text = fs.readFileSync(abs, 'utf8');
      const lines = findCastsInText(text);
      for (const line of lines) {
        violations.push(`${path.relative(REPO_ROOT, abs)}:${line}`);
      }
    }
    expect(
      violations.length,
      `Found ${violations.length} SidebarCommand cast(s) in src/ (ceiling ${MAX_SIDEBAR_COMMAND_CASTS}):\n` +
        violations.map((v) => `  - ${v}`).join('\n')
    ).toBeLessThanOrEqual(MAX_SIDEBAR_COMMAND_CASTS);
  });
});
