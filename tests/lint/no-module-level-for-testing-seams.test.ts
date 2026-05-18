import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Feature 057 Track 4 — regression guard. The four phase-runner files
// must NOT introduce module-level test-only seam exports
// (`anythingForTesting`, `xxxForTest`, etc.). Constructor injection is
// the canonical seam pattern, matching the cycle-1 047 precedent
// (`PhaseSequencer` / `RetryHandler`).
//
// FR-008 / SC-004 / User Story 2 — pinned by spec 057.

const REPO_ROOT = resolve(__dirname, '..', '..');

const FILES_UNDER_GUARD = [
  'src/controller/phase-runner.ts',
  'src/controller/phase-sidecar-reader.ts',
  'src/controller/phase-retry-evaluator.ts',
  'src/controller/phase-outcome-mapper.ts'
] as const;

const FOR_TESTING_PATTERN = /\bexport\s+(?:const|let|var|function|class|interface|type|async\s+function)\s+[a-zA-Z0-9_]*ForTesting\b/;

describe('no module-level ForTesting seams across feature 057 modules', () => {
  for (const relPath of FILES_UNDER_GUARD) {
    it(`${relPath} contains zero \`\\w+ForTesting\` exports`, () => {
      const contents = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      const matches = contents.match(new RegExp(FOR_TESTING_PATTERN, 'g')) ?? [];
      expect(matches).toEqual([]);
    });
  }
});
