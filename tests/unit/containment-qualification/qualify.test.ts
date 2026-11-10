// FR-R6-F09 T005 -- the per-effect qualification record (research R10).
//
// WHAT THIS PINS:
//   - codex 0.163 on darwin arm64 gives the six observed cells, and is qualified;
//   - a different codex minor on the same tuple stales the version-bound observed cells;
//   - an unverified codex version gives `unverified` for those cells;
//   - codex on any other platform is `unverified` on help-syntax evidence;
//   - claude and agy: four effects unsupported, process creation tool-restricted, on help syntax;
//   - descendant lifetime is the host ladder's: observed-enforced on darwin, unverified elsewhere;
//   - invariants over every record (FR-002, FR-012, SC-002).

import { describe, expect, it } from 'vitest';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import {
  CONTAINMENT_EFFECTS,
  type BackendIdentity,
  type ContainmentEffect,
  type EffectQualification,
  type QualificationRecord
} from '../../../src/contracts/containment-qualification';
import { EVIDENCE_MATRIX } from '../../../src/services/containment-qualification/evidence-matrix';
import { qualifyBackend } from '../../../src/services/containment-qualification/qualify';

const ENV = 'e'.repeat(64);

function identity(over: Partial<BackendIdentity> & { kind: BackendRunnerKind }): BackendIdentity {
  return {
    executable: 'resolved',
    versionMinor: '0.163',
    os: 'darwin',
    arch: 'arm64',
    environmentPolicyDigest: ENV,
    ...over
  };
}

function cell(record: QualificationRecord, effect: ContainmentEffect): EffectQualification {
  const found = record.effects.find((entry) => entry.effect === effect);
  if (found === undefined) throw new Error(`no ${effect} cell`);
  return found;
}

const OS_EFFECTS: readonly ContainmentEffect[] = [
  'fs-read',
  'fs-write',
  'process-creation',
  'network',
  'credential-exposure'
];

describe('FR-R6-F09 T005 -- codex on the observed tuple', () => {
  const record = qualifyBackend(identity({ kind: 'codex' }));

  it('is qualified, observed, and keyed on the tuple', () => {
    expect(record.qualified).toBe(true);
    expect(record.identityState).toBe('observed');
    expect(record.key.kind).toBe('codex');
    expect(record.key.versionMinor).toBe('0.163');
    expect(record.key.mechanism).toBe('codex-sandbox-workspace-write');
    expect(record.key.mechanismVersion).toBe('0.163');
    expect(record.key.capabilitySet).toEqual(['--sandbox']);
    expect(record.key.acp).toBe('not-applicable');
    expect(record.key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives fs-write and network observed-enforced through the shell child', () => {
    for (const effect of ['fs-write', 'network'] as const) {
      const entry = cell(record, effect);
      expect(entry.outcome).toBe('observed-enforced');
      expect(entry.basis).toBe('observed-behavior');
      expect(entry.components).toEqual(['shell-child']);
      expect(entry.observedAt).toBe('2026-11-10');
    }
    expect(cell(record, 'fs-write').residuals).toEqual([
      'file-tool-unobserved',
      'hook-unobserved',
      'external-tool-unobserved'
    ]);
  });

  it('names the network residuals and claims no filtering (FR-007)', () => {
    expect(cell(record, 'network').residuals).toEqual([
      'non-loopback-destinations-unobserved',
      'dns-unobserved',
      'redirect-unobserved',
      'proxy-unobserved',
      'no-filtering-claimed'
    ]);
  });

  it('gives fs-read, process creation and credential exposure unsupported, as observed', () => {
    for (const effect of ['fs-read', 'process-creation', 'credential-exposure'] as const) {
      const entry = cell(record, effect);
      expect(entry.outcome).toBe('unsupported');
      expect(entry.basis).toBe('observed-behavior');
    }
  });

  it('gives descendant lifetime observed-enforced by the host ladder, with the standing residual', () => {
    const entry = cell(record, 'descendant-lifetime');
    expect(entry.outcome).toBe('observed-enforced');
    expect(entry.components).toEqual(['host-ladder']);
    expect(entry.residuals).toEqual(['descendants-outside-group-undetectable']);
  });
});

describe('FR-R6-F09 T005 -- codex off the observed tuple', () => {
  it('a different minor on the same tuple stales the version-bound observed cells', () => {
    const record = qualifyBackend(identity({ kind: 'codex', versionMinor: '0.164' }));
    expect(record.qualified).toBe(false);
    expect(record.identityState).toBe('observed');
    for (const effect of OS_EFFECTS) {
      expect(cell(record, effect).outcome).toBe('stale');
      expect(cell(record, effect).basis).toBe('observed-behavior');
    }
    expect(cell(record, 'descendant-lifetime').outcome).toBe('observed-enforced');
  });

  it('an unverified version gives unverified for those cells', () => {
    const record = qualifyBackend(identity({ kind: 'codex', versionMinor: null }));
    expect(record.qualified).toBe(false);
    expect(record.identityState).toBe('unverified');
    expect(record.key.versionMinor).toBe('unverified');
    for (const effect of OS_EFFECTS) {
      expect(cell(record, effect).outcome).toBe('unverified');
      expect(cell(record, effect).basis).toBe('none');
    }
  });

  it.each([
    ['linux', 'x64'],
    ['win32', 'x64'],
    ['darwin', 'x64']
  ])('on %s %s every OS-mechanism effect is unverified on help syntax', (os, arch) => {
    const record = qualifyBackend(identity({ kind: 'codex', os, arch }));
    expect(record.qualified).toBe(false);
    for (const effect of OS_EFFECTS) {
      expect(cell(record, effect).outcome).toBe('unverified');
      expect(cell(record, effect).basis).toBe('help-syntax');
    }
  });
});

describe('FR-R6-F09 T005 -- claude and agy', () => {
  it.each([
    ['claude', 'darwin', 'arm64', '2.1'],
    ['claude', 'linux', 'x64', '2.1'],
    ['agy', 'win32', 'x64', '1.5'],
    ['agy', 'darwin', 'arm64', null]
  ] as const)('%s on %s %s claims nothing and restricts process creation by tool', (kind, os, arch, version) => {
    const record = qualifyBackend(identity({ kind, os, arch, versionMinor: version }));
    expect(record.qualified).toBe(false);
    expect(record.key.mechanism).toBe('none');
    for (const effect of ['fs-read', 'fs-write', 'network', 'credential-exposure'] as const) {
      expect(cell(record, effect).outcome).toBe('unsupported');
      expect(cell(record, effect).basis).toBe('help-syntax');
    }
    expect(cell(record, 'process-creation').outcome).toBe('tool-restricted');
    expect(cell(record, 'process-creation').basis).toBe('help-syntax');
  });
});

describe('FR-R6-F09 T005 -- descendant lifetime is the host ladder', () => {
  it.each(['claude', 'codex', 'agy'] as const)('%s: observed-enforced on darwin, unverified elsewhere', (kind) => {
    expect(cell(qualifyBackend(identity({ kind, arch: 'x64' })), 'descendant-lifetime').outcome).toBe(
      'observed-enforced'
    );
    const linux = cell(qualifyBackend(identity({ kind, os: 'linux', arch: 'x64' })), 'descendant-lifetime');
    expect(linux.outcome).toBe('unverified');
    expect(linux.basis).toBe('none');
  });
});

describe('FR-R6-F09 T005 -- invariants over every generated record', () => {
  const kinds = ['claude', 'codex', 'agy'] as const;
  const tuples = [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64']
  ] as const;
  const versions = ['0.163', '0.164', '2.1', '1.5', null];
  const records: QualificationRecord[] = [];
  for (const kind of kinds) {
    for (const [os, arch] of tuples) {
      for (const versionMinor of versions) {
        records.push(qualifyBackend(identity({ kind, os, arch, versionMinor })));
      }
    }
  }

  it('gives exactly six effects in order and reserves the ACP field', () => {
    for (const record of records) {
      expect(record.effects.map((entry) => entry.effect)).toEqual([...CONTAINMENT_EFFECTS]);
      expect(record.key.acp).toBe('not-applicable');
    }
  });

  it('never claims observed-enforced without observed behaviour naming a component (FR-002, FR-012)', () => {
    for (const record of records) {
      for (const entry of record.effects) {
        if (entry.outcome === 'observed-enforced') {
          expect(entry.basis).toBe('observed-behavior');
          expect(entry.components.length).toBeGreaterThan(0);
        }
        if (entry.basis !== 'observed-behavior') {
          expect(entry.components).toEqual([]);
        }
        expect(entry.residuals.length).toBeLessThanOrEqual(8);
      }
    }
  });

  it('qualifies only codex 0.163 on darwin arm64', () => {
    const qualified = records.filter((record) => record.qualified);
    expect(qualified.map((record) => record.key)).toEqual([
      expect.objectContaining({ kind: 'codex', os: 'darwin', arch: 'arm64', versionMinor: '0.163' })
    ]);
  });

  it('has a frozen matrix whose observed rows all carry a component', () => {
    expect(Object.isFrozen(EVIDENCE_MATRIX)).toBe(true);
    for (const row of EVIDENCE_MATRIX) {
      if (row.outcome === 'observed-enforced') {
        expect(row.basis).toBe('observed-behavior');
        expect(row.components.length).toBeGreaterThan(0);
      }
    }
  });
});
