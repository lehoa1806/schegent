import { describe, expect, it } from 'vitest';
import {
  HOST_VERIFICATION_MIGRATION_TARGET,
  migrateSnapshotV13ToV14,
  needsHostVerificationMigration,
  type PersistedPlanSnapshot
} from '../../../src/state/host-verification-migrator';
import { STATE_SCHEMA_VERSION } from '../../../src/contracts/state-schema';

describe('FR-R3-117 — host-verification migrator (v13 -> v14)', () => {
  it('targets the current schema version', () => {
    expect(HOST_VERIFICATION_MIGRATION_TARGET).toBe(STATE_SCHEMA_VERSION);
  });

  it('recognises records that predate the resolution rule, and only those', () => {
    expect(needsHostVerificationMigration(13)).toBe(true);
    expect(needsHostVerificationMigration(1)).toBe(true);
    expect(needsHostVerificationMigration(14)).toBe(false);
  });

  it('leaves no phase without an explicit value — a reader never resolves', () => {
    const snapshot: PersistedPlanSnapshot = {
      phases: [{ id: 'a' }, { id: 'b', sideEffects: 'workspace' }, { id: 'c', sideEffects: 'none' }]
    };
    const { snapshot: next, stamped, migrated } = migrateSnapshotV13ToV14(snapshot);
    expect(migrated).toBe(true);
    expect(stamped).toBe(3);
    for (const phase of next.phases ?? []) {
      expect(phase.hostVerification).toBeDefined();
      expect(phase.hostVerificationDeclaredAt).toBeDefined();
    }
  });

  it('PRESERVES the old meaning rather than applying the new default', () => {
    // The direction that looks backwards and is not. A v13 snapshot's absent value
    // MEANT self-report, and a plan snapshot is a frozen record of what the
    // operator approved. Retroactively tightening it would change the meaning of a
    // plan after approval, invisibly: a Run resumed after the upgrade would start
    // failing phases its own snapshot said would advance. The new default applies
    // to plans frozen after the upgrade, where an operator can see it.
    const { snapshot } = migrateSnapshotV13ToV14({ phases: [{ id: 'a', sideEffects: 'workspace' }] });
    expect(snapshot.phases?.[0]?.hostVerification).toBe('model-token');
    expect(snapshot.phases?.[0]?.hostVerificationDeclaredAt).toBe('default');
  });

  it('does not overwrite an authored value, and records it as authored', () => {
    const { snapshot, stamped } = migrateSnapshotV13ToV14({
      phases: [{ id: 'a', hostVerification: 'exit-code' }]
    });
    expect(snapshot.phases?.[0]?.hostVerification).toBe('exit-code');
    expect(snapshot.phases?.[0]?.hostVerificationDeclaredAt).toBe('phase-definition');
    expect(stamped).toBe(0);
  });

  it('is idempotent — running it twice changes nothing the second time', () => {
    const once = migrateSnapshotV13ToV14({ phases: [{ id: 'a' }, { id: 'b', hostVerification: 'exit-code' }] });
    const twice = migrateSnapshotV13ToV14(once.snapshot);
    expect(twice.stamped).toBe(0);
    expect(twice.snapshot).toEqual(once.snapshot);
  });

  it('does not invent a phases array where none exists', () => {
    const { snapshot, migrated, stamped } = migrateSnapshotV13ToV14({ runId: 'r1' });
    expect(migrated).toBe(false);
    expect(stamped).toBe(0);
    expect(snapshot).toEqual({ runId: 'r1' });
  });

  it('carries every other field through untouched', () => {
    const { snapshot } = migrateSnapshotV13ToV14({
      runId: 'r1',
      phases: [{ id: 'a', model: 'opus', sideEffects: 'git', capabilities: ['network'] }]
    });
    const phase = snapshot.phases?.[0];
    expect(phase?.model).toBe('opus');
    expect(phase?.sideEffects).toBe('git');
    expect(phase?.capabilities).toEqual(['network']);
    expect(snapshot.runId).toBe('r1');
  });
});
