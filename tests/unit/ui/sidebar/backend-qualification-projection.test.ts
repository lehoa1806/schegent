// FR-R6-F09 T008 -- `BackendPosture.qualification`, composed host-side (FR-014, SC-005).
//
// WHAT THIS PINS:
//   - with no qualification source, a row carries no `qualification` key (the FR-R3-144 rows
//     and the visual fixture are unchanged);
//   - with a cached identity, the field carries the identity state, the version, the six
//     `{ effect, outcome, basis }` rows and one admission word;
//   - with none cached, it reads `not-observed` with no effect rows, and never `contained`;
//   - for the same corpus it agrees with the headless inspection (SC-005).

import { describe, expect, it } from 'vitest';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../../../src/contracts/backend-kinds';
import type {
  AdmissionVerdict,
  BackendIdentity,
  BindingInput
} from '../../../../src/contracts/containment-qualification';
import { inspectBackendQualification } from '../../../../src/headless/backend-qualification-api';
import { computeFingerprint } from '../../../../src/services/containment-qualification/fingerprint';
import { composeBackendPostures } from '../../../../src/ui/sidebar/backend-posture-projection';

const ENV = 'e'.repeat(64);

function identity(kind: BackendRunnerKind, over: Partial<BackendIdentity> = {}): BackendIdentity {
  return { kind, executable: 'resolved', versionMinor: '0.163', os: 'darwin', arch: 'arm64', environmentPolicyDigest: ENV, ...over };
}

function source(identities: readonly BackendIdentity[], bindings: Partial<Record<BackendRunnerKind, BindingInput>> = {}) {
  return {
    identityOf: (kind: BackendRunnerKind) => identities.find((entry) => entry.kind === kind) ?? null,
    bindingOf: (kind: BackendRunnerKind) => bindings[kind] ?? null
  };
}

function expectedAdmission(verdict: AdmissionVerdict): string {
  if (verdict.outcome === 'admitted') return verdict.containment === 'contained' ? 'contained' : 'accepted';
  return verdict.reason === 'backend-executable-unresolved' ? 'executable-unresolved' : 'acceptance-required';
}

function rowOf(setting: readonly BackendRunnerKind[], src: ReturnType<typeof source>, kind: BackendRunnerKind) {
  return composeBackendPostures(setting, src).backendPostures.find((row) => row.kind === kind);
}

describe('FR-R6-F09 T008 -- without a source the rows are unchanged', () => {
  it.each(SUPPORTED_BACKENDS)('%s carries no qualification key', (kind) => {
    const row = composeBackendPostures([]).backendPostures.find((entry) => entry.kind === kind);
    expect(row).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(row, 'qualification')).toBe(false);
  });
});

describe('FR-R6-F09 T008 -- with a cached identity', () => {
  it('qualified codex is contained with six observed rows', () => {
    const q = rowOf([], source([identity('codex')]), 'codex')?.qualification;
    expect(q?.identityState).toBe('observed');
    expect(q?.versionMinor).toBe('0.163');
    expect(q?.effects).toHaveLength(6);
    expect(q?.effects.every((cell) => Object.keys(cell).sort().join() === 'basis,effect,outcome')).toBe(true);
    expect(q?.admission).toBe('contained');
  });

  it('an ungranted claude requires acceptance; granted with an equal binding it is accepted', () => {
    const claude = identity('claude', { versionMinor: '2.1' });
    expect(rowOf([], source([claude]), 'claude')?.qualification?.admission).toBe('acceptance-required');
    const bound = { fingerprint: computeFingerprint(claude), origin: 'consent' as const, boundAt: '2026-11-10T00:00:00.000Z' };
    expect(rowOf(['claude'], source([claude], { claude: bound }), 'claude')?.qualification?.admission).toBe('accepted');
  });

  it('an unresolved executable reads executable-unresolved', () => {
    const q = rowOf([], source([identity('agy', { executable: 'not-executable' })]), 'agy')?.qualification;
    expect(q?.admission).toBe('executable-unresolved');
  });

  it('an unverified version reads unverified', () => {
    const q = rowOf([], source([identity('codex', { versionMinor: null })]), 'codex')?.qualification;
    expect(q?.identityState).toBe('unverified');
    expect(q?.versionMinor).toBeNull();
    expect(q?.admission).toBe('acceptance-required');
  });
});

describe('FR-R6-F09 T008 -- with nothing cached', () => {
  it.each(SUPPORTED_BACKENDS)('%s reads not-observed, never contained', (kind) => {
    const ungranted = rowOf([], source([]), kind)?.qualification;
    expect(ungranted).toEqual({ identityState: 'not-observed', versionMinor: null, effects: [], admission: 'acceptance-required' });
    expect(rowOf([kind], source([]), kind)?.qualification?.admission).toBe('accepted');
  });
});

describe('FR-R6-F09 T008 -- agrees with the headless inspection (SC-005)', () => {
  const CORPUS: readonly BackendIdentity[][] = [
    [identity('codex'), identity('claude', { versionMinor: '2.1' }), identity('agy', { versionMinor: '1.5' })],
    [identity('codex', { os: 'linux', arch: 'x64' }), identity('claude', { executable: 'not-found' })],
    [identity('codex', { versionMinor: null }), identity('agy', { versionMinor: null })]
  ];
  const GRANTS: readonly (readonly BackendRunnerKind[])[] = [[], ['claude', 'codex', 'agy']];

  it.each(CORPUS.flatMap((identities) => GRANTS.map((granted) => [identities, granted] as const)))(
    'corpus %#',
    (identities, granted) => {
      const inspected = inspectBackendQualification({ identities, granted, bindings: {} });
      identities.forEach((id, index) => {
        const result = inspected.at(index);
        const q = rowOf(granted, source(identities), id.kind)?.qualification;
        expect(q?.identityState).toBe(result?.record.identityState);
        expect(q?.effects).toEqual(
          result?.record.effects.map(({ effect, outcome, basis }) => ({ effect, outcome, basis }))
        );
        expect(q?.admission).toBe(result === undefined ? undefined : expectedAdmission(result.admission));
      });
    }
  );
});
