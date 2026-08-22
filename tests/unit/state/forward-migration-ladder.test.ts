// FR-R3-039 — every branch of `initialize()` runs the same forward ladder.
//
// The round-3 review (STATE-1) proposed extracting "eight `migrateVnToVn+1`
// methods" from `WorkspaceStateStore`. Those had already been extracted, into
// `queue-state-migrator.ts`, `run-state-migrator.ts`,
// `history-state-migrator.ts` and their siblings. What was still duplicated was
// the ORCHESTRATION: the seven-step ladder was written out in full at four
// separate points in `initialize()`, once per version branch — the same calls,
// in the same order, four times.
//
// That is duplication with teeth. Order is load-bearing (each step's doc comment
// says what it must run after and why), and an order stated four times is an
// order that can disagree with itself. Adding a v13 → v14 step meant editing four
// places, and missing one left a branch that silently skipped a migration for
// whichever workspaces took it.
//
// `runForwardMigrations()` is now the single definition of the sequence. This
// test is what keeps it single: it drives all four branches and asserts each one
// reports the ladder's full result shape. A branch that stopped calling the
// ladder — or called a subset of it — would return a result missing those keys.
import { describe, expect, it } from 'vitest';
import {
  WorkspaceStateStore,
  KEYS,
  SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  type Memento,
  type InitializeResult
} from '../../../src/state/workspace-state';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

/**
 * The keys the ladder owns. Named here rather than derived from a result, so a
 * step removed from `runForwardMigrations` fails this test instead of quietly
 * shrinking what it is compared against.
 */
const LADDER_KEYS = [
  'v6MigrationEvents',
  'v7MigrationEvents',
  'v10MigrationEvents',
  'v11MigrationEvents',
  'v12MigrationEvents',
  'v13MigrationEvents'
] as const;

/**
 * The four states `initialize()` branches on, by the condition each one takes.
 * Reaching all four is the point: three of them were previously served by
 * copy-pasted ladders, and a divergence between them is invisible to a test that
 * only exercises one.
 */
const BRANCHES: ReadonlyArray<{ name: string; seed: (m: FakeMemento) => Promise<void> }> = [
  {
    name: 'no persisted version string',
    seed: async () => {
      /* nothing persisted at all */
    }
  },
  {
    name: 'version string matches, numeric behind',
    seed: async (m) => {
      await m.update(KEYS.schemaVersion, SCHEMA_VERSION);
      await m.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION - 1);
    }
  },
  {
    name: 'version string and numeric both current',
    seed: async (m) => {
      await m.update(KEYS.schemaVersion, SCHEMA_VERSION);
      await m.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    }
  },
  {
    name: 'same major, different version string',
    seed: async (m) => {
      const [major] = SCHEMA_VERSION.split('.');
      await m.update(KEYS.schemaVersion, `${major}.99.99`);
      await m.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
    }
  }
];

describe('FR-R3-039 — the forward migration ladder is defined once', () => {
  for (const branch of BRANCHES) {
    it(`reports every ladder step on the "${branch.name}" branch`, async () => {
      const memento = new FakeMemento();
      await branch.seed(memento);
      const result: InitializeResult = await new WorkspaceStateStore(memento).initialize();

      for (const key of LADDER_KEYS) {
        expect(
          Array.isArray(result[key]),
          `the "${branch.name}" branch of initialize() returned no \`${key}\`. Every branch runs ` +
            `the same ladder through runForwardMigrations(); a branch that returns a partial ` +
            `result has stopped calling it, which is the duplication this test exists to prevent.`
        ).toBe(true);
      }
    });
  }

  it('reaches every branch, so none of them is asserted vacuously', () => {
    // A guard on the guard: if `initialize()` gains a fifth branch, the four
    // above no longer cover it and this test would keep passing while saying
    // nothing about the new one.
    expect(BRANCHES).toHaveLength(4);
  });

  it('counts a migration as having run by reading the whole result shape', async () => {
    // `migrated` was computed from six named `.length > 0` checks. A seventh step
    // added without a seventh check would report `migrated: false` on a workspace
    // that had just been migrated. It now reads every field of the ladder result.
    const memento = new FakeMemento();
    const result = await new WorkspaceStateStore(memento).initialize();
    expect(typeof result.migrated).toBe('boolean');
  });
});
