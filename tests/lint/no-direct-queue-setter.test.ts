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
});
