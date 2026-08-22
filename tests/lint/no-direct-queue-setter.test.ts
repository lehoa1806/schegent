import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files;
}

describe('serialized queue mutation boundary', () => {
  it('forbids direct setQueue calls in production code', () => {
    const src = path.resolve(process.cwd(), 'src');
    const violations = sourceFiles(src)
      .filter((file) => !file.endsWith(path.join('state', 'workspace-state.ts')))
      .flatMap((file) => {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        return lines
          .map((line, index) => ({ file, line, index: index + 1 }))
          .filter(({ line }) => /\.setQueue\s*\(/.test(line));
      });

    expect(violations, 'Use WorkspaceStateStore.updateQueue(mutate, queueId) so reads occur inside the serialized mutation chain').toEqual([]);
  });

  // Vacuity control. The assertion above collects violations and expects none,
  // so it passes identically whether the tree is clean or the scan found no
  // files and the pattern matched nothing. `process.cwd()` as a scan root makes
  // that a live risk rather than a theoretical one: it depends on where the
  // runner was invoked from, not on this file's location.
  //
  // There is no in-tree anchor to use. `src/` contains ZERO `.setQueue(` call
  // sites — which is the point of the gate, but it means nothing legitimate
  // exists for the scan to find. `workspace-state.ts` only DECLARES the method
  // (`public setQueue(...)`, no leading dot), so the filter that excludes it
  // excludes a file the pattern would never have matched anyway. That exclusion
  // is inert, and is left in place because it documents intent cheaply.
  //
  // So the control is split: prove the scan reaches the tree, and prove the
  // pattern still recognises a call when it sees one.
  it('reaches the source tree', () => {
    const src = path.resolve(process.cwd(), 'src');
    expect(
      sourceFiles(src).length,
      `No .ts files under ${src}. The scan root is resolved from process.cwd(), so ` +
        `this fails when the runner's working directory is not the repo root — and ` +
        `an unreachable tree is indistinguishable from a compliant one above.`
    ).toBeGreaterThan(100);
  });

  it('recognises a direct setQueue call, and spares the declaration', () => {
    const pattern = /\.setQueue\s*\(/;
    // The forms that must be caught, including the spacing the pattern tolerates.
    expect(pattern.test('await store.setQueue(next, queueId);')).toBe(true);
    expect(pattern.test('this.deps.state.setQueue (next);')).toBe(true);
    // The declaration must NOT be caught, or workspace-state.ts would offend on
    // its own definition and the exclusion above would be load-bearing rather
    // than inert.
    expect(pattern.test('public setQueue(queue: QueueState, queueId: string) {')).toBe(false);
  });
});
