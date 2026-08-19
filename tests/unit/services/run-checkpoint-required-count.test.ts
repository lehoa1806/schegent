// FR-R3-004 (T317) — the in-flight count and the ledger stay *required*
// constructor parameters.
//
// This is the one rule of the checkpoint hard rule that a well-meaning edit
// erodes silently. `countInFlightRuns` defaulted to `() => 1` looks harmless and
// keeps every existing call site compiling, but it means "sole run" — the one
// path that writes a whole-tree patch without consulting the ledger. A service
// constructed with that default would snapshot a shared tree and present the
// result as attributable, which is exactly the failure the parameter exists to
// prevent, and the failure would be invisible: a valid-looking `.patch` with a
// valid-looking `attribution.mode: 'sole-run'` beside it.
//
// So there are two assertions here, doing different jobs. The source assertion
// is the one that catches the edit, because a default is not observable from
// outside — a defaulted service behaves like a correctly-wired sole-run one. The
// runtime assertion pins what happens when a caller sidesteps the type system
// anyway: it throws out of `checkpoint()` and the Git-capable phase is blocked.
// Fail-closed, and deliberately *not* a decline — a decline is a considered
// answer about a tree, and a service with no way to count Runs has not
// considered anything.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RunCheckpointService } from '../../../src/services/run-checkpoint-service';
import { makeCheckpointHarness } from '../../fixtures/services/checkpoint-harness';

const SOURCE = path.join(__dirname, '../../../src/services/run-checkpoint-service.ts');

/** The constructor parameter list, as written. */
async function constructorParameters(): Promise<string> {
  const source = await fs.readFile(SOURCE, 'utf8');
  const open = source.indexOf('constructor(');
  expect(open).toBeGreaterThan(-1);
  const close = source.indexOf(') {}', open);
  expect(close).toBeGreaterThan(open);
  return source.slice(open, close);
}

describe('RunCheckpointService — required dependencies (T317, FR-R3-004)', () => {
  it('declares the in-flight count and the ledger without optionality or a default', async () => {
    const parameters = await constructorParameters();

    for (const name of ['countInFlightRuns', 'ledger']) {
      const declaration = parameters
        .split('\n')
        .find((line) => line.includes(`${name}:`) || line.includes(`${name}?:`));
      expect(declaration, `${name} is not declared in the constructor`).toBeDefined();
      // `name?:` makes it optional; `name: T = …` gives it a default. Either
      // turns a wiring mistake into a silent sole-run snapshot. The arrow of a
      // function type carries its own `=`, so it goes first.
      expect(declaration).not.toContain(`${name}?:`);
      expect(declaration!.replace(/=>/g, '')).not.toContain('=');
    }
  });

  it('throws out of checkpoint() when a caller omits the count', async () => {
    const h = await makeCheckpointHarness();
    try {
      const run = h.run('run-a');
      h.run('run-b');
      await h.phase(run, () => h.write('a.txt', 'written by run-a\n'));

      // Only reachable past the type system, which is the point: this is the
      // behaviour under the mistake the signature is meant to make impossible.
      const service = new (RunCheckpointService as unknown as new (
        ...args: readonly unknown[]
      ) => RunCheckpointService)(h.storageRoot, h.workspaceRoot, { warn: () => {} }, undefined);

      await expect(service.checkpoint(run, 'speckit-implement')).rejects.toThrow();
      // And it wrote nothing — neither a patch that would read as attributable
      // nor a marker that would read as a considered refusal.
      expect(await h.artifacts('run-a')).toEqual([]);
    } finally {
      await h.dispose();
    }
  });
});
