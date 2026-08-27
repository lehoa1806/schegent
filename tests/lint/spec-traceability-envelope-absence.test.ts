import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { envelopePresent, resolveGovernanceScope } from './envelope-presence';

/**
 * FR-R3-118 / FR-047 — the absence path, exercised rather than reasoned about.
 *
 * `spec-traceability-governance` reads the planning envelope above `repo/`. In a
 * clone of the execution repository alone there is no envelope, and both reads
 * used to raise ENOENT — which took down `vitest run`, therefore `test:host`,
 * therefore `verify:all`, therefore `gate`, therefore `release:preflight`. A
 * standalone clone could not reach a green gate and so could not cut a release.
 *
 * The fix is a reported skip. This file proves the skip happens, against a
 * synthetic root built for the purpose, because the alternative — asserting that
 * a guard exists by reading the guard — is the thing FR-R3-063 warned about.
 */
describe('spec traceability governance: the envelope-absent path', () => {
  function withRoot(build: (root: string) => void, assert: (root: string) => void): void {
    const root = mkdtempSync(resolve(tmpdir(), 'schegent-envelope-absence-'));
    try {
      build(root);
      assert(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('reports a skip, rather than throwing, when the parent holds no envelope', () => {
    withRoot(
      () => {
        // Deliberately empty: this is a parent that is not a planning envelope.
      },
      (root) => {
        expect(envelopePresent(root)).toBe(false);
        const scope = resolveGovernanceScope(root);
        expect(scope.kind).toBe('skipped');
        expect(scope.kind === 'skipped' && scope.reason).toContain('no planning envelope');
        expect(scope.kind === 'skipped' && scope.reason).toContain(root);
      }
    );
  });

  it('is not fooled by an unrelated parent that happens to hold one marker', () => {
    withRoot(
      (root) => {
        writeFileSync(resolve(root, 'ARCHITECTURE.md'), '# some other project\n');
      },
      (root) => {
        expect(envelopePresent(root)).toBe(false);
        expect(resolveGovernanceScope(root).kind).toBe('skipped');
      }
    );
  });

  it('recognises a real envelope and governs it', () => {
    withRoot(
      (root) => {
        writeFileSync(resolve(root, 'ARCHITECTURE.md'), '# envelope\n');
        writeFileSync(resolve(root, 'CLAUDE.md'), '# envelope\n');
        mkdirSync(resolve(root, 'docs'));
        mkdirSync(resolve(root, 'specs'));
      },
      (root) => {
        expect(envelopePresent(root)).toBe(true);
        const scope = resolveGovernanceScope(root);
        expect(scope.kind).toBe('envelope');
        expect(scope.kind === 'envelope' && scope.specsRoot).toBe(resolve(root, 'specs'));
      }
    );
  });

  it('requires docs/ to be a directory, not a file of that name', () => {
    withRoot(
      (root) => {
        writeFileSync(resolve(root, 'ARCHITECTURE.md'), '#\n');
        writeFileSync(resolve(root, 'CLAUDE.md'), '#\n');
        writeFileSync(resolve(root, 'docs'), 'not a directory\n');
      },
      (root) => {
        expect(envelopePresent(root)).toBe(false);
      }
    );
  });
});
