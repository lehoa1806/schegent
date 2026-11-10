// FR-R6-F09 T007 -- the headless qualification inspection (contract section 6).
//
// WHAT THIS PINS:
//   - each result equals `qualifyBackend` plus `judgeSpawnAdmission` for its identity, with the
//     given grants and bindings;
//   - malformed input throws `InvalidInspectionInputError` naming the field, and the message
//     echoes no input value;
//   - the result carries no path.

import { describe, expect, it } from 'vitest';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import type { AcceptanceBinding, BackendIdentity } from '../../../src/contracts/containment-qualification';
import {
  InvalidInspectionInputError,
  inspectBackendQualification,
  type BackendQualificationInspectionInput
} from '../../../src/headless/backend-qualification-api';
import { judgeSpawnAdmission } from '../../../src/services/containment-qualification/admission';
import { computeFingerprint } from '../../../src/services/containment-qualification/fingerprint';
import { qualifyBackend } from '../../../src/services/containment-qualification/qualify';

const ENV = 'e'.repeat(64);

function identity(kind: BackendRunnerKind, over: Partial<BackendIdentity> = {}): BackendIdentity {
  return { kind, executable: 'resolved', versionMinor: '0.163', os: 'darwin', arch: 'arm64', environmentPolicyDigest: ENV, ...over };
}

const CORPUS: readonly BackendIdentity[] = [
  identity('codex'),
  identity('codex', { os: 'linux', arch: 'x64' }),
  identity('codex', { versionMinor: null }),
  identity('codex', { executable: 'not-found' }),
  identity('claude', { versionMinor: '2.1' }),
  identity('agy', { versionMinor: '1.5' })
];

const CLAUDE_BINDING: AcceptanceBinding = {
  fingerprint: computeFingerprint(identity('claude', { versionMinor: '2.0' })),
  origin: 'consent',
  boundAt: '2026-11-10T00:00:00.000Z'
};

function invalid(input: unknown): InvalidInspectionInputError {
  try {
    inspectBackendQualification(input as BackendQualificationInspectionInput);
  } catch (error) {
    if (error instanceof InvalidInspectionInputError) return error;
    throw error;
  }
  throw new Error('expected InvalidInspectionInputError');
}

describe('FR-R6-F09 T007 -- the inspection equals the pure functions', () => {
  it.each([
    ['no grants', [] as BackendRunnerKind[], {}],
    ['every grant, no binding', ['claude', 'codex', 'agy'] as BackendRunnerKind[], {}],
    ['a stale claude binding', ['claude'] as BackendRunnerKind[], { claude: CLAUDE_BINDING }]
  ])('%s', (_label, granted, bindings: Partial<Record<BackendRunnerKind, AcceptanceBinding>>) => {
    const results = inspectBackendQualification({ identities: CORPUS, granted, bindings });
    expect(results).toHaveLength(CORPUS.length);
    CORPUS.forEach((id, index) => {
      const result = results.at(index);
      expect(result?.record).toEqual(qualifyBackend(id));
      expect(result?.admission).toEqual(
        judgeSpawnAdmission({ identity: id, granted: new Set(granted), binding: bindings[id.kind] ?? null })
      );
    });
  });

  it('accepts 64 identities and 64 grants, the bound (review S6)', () => {
    const identities = Array.from({ length: 64 }, () => identity('claude'));
    const granted = Array.from({ length: 64 }, (): BackendRunnerKind => 'claude');
    expect(inspectBackendQualification({ identities, granted, bindings: {} })).toHaveLength(64);
  });

  it('judges the value it validated, read once (review S6)', () => {
    let reads = 0;
    const shifting = { ...identity('claude', { versionMinor: '2.1' }) };
    Object.defineProperty(shifting, 'os', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'darwin' : 'SECRET';
      }
    });
    const text = JSON.stringify(inspectBackendQualification({ identities: [shifting], granted: [], bindings: {} }));
    expect(text).not.toContain('SECRET');
    expect(text).toContain('darwin');
  });

  it('carries no path', () => {
    const text = JSON.stringify(inspectBackendQualification({ identities: CORPUS, granted: ['claude'], bindings: {} }));
    expect(text).not.toMatch(/[/\\]/);
  });
});

describe('FR-R6-F09 T007 -- malformed input is refused, naming the field', () => {
  const good = { identities: [identity('claude')], granted: [], bindings: {} };
  it.each([
    ['input', 'SECRET-INPUT'],
    ['input', { ...good, extra: 'SECRET' }],
    ['identities', { ...good, identities: 'SECRET' }],
    ['identities[0]', { ...good, identities: [{ ...identity('claude'), path: '/SECRET/bin' }] }],
    ['identities[0].kind', { ...good, identities: [identity('SECRET-KIND' as BackendRunnerKind)] }],
    ['identities[0].executable', { ...good, identities: [identity('claude', { executable: 'SECRET' as 'not-found' })] }],
    ['identities[0].versionMinor', { ...good, identities: [identity('claude', { versionMinor: 'SECRET.1' })] }],
    ['identities[0].os', { ...good, identities: [identity('claude', { os: 'SECRET'.repeat(4) })] }],
    ['identities[0].arch', { ...good, identities: [identity('claude', { arch: '' })] }],
    ['identities[0].os', { ...good, identities: [identity('claude', { os: 'SECRET' })] }],
    ['identities[0].os', { ...good, identities: [identity('claude', { os: 'dar win' })] }],
    ['identities[0].arch', { ...good, identities: [identity('claude', { arch: `x${String.fromCodePoint(0x1b)}[31m` })] }],
    ['identities', { ...good, identities: Array.from({ length: 65 }, () => identity('claude')) }],
    ['granted', { ...good, granted: Array.from({ length: 65 }, () => 'claude') }],
    ['identities[0].environmentPolicyDigest', { ...good, identities: [identity('claude', { environmentPolicyDigest: 'a'.repeat(65) })] }],
    ['granted', { ...good, granted: 'claude' }],
    ['granted[0]', { ...good, granted: ['SECRET-KIND'] }],
    ['bindings', { ...good, bindings: [] }],
    ['bindings', { ...good, bindings: { 'SECRET-KIND': CLAUDE_BINDING } }],
    ['bindings.claude', { ...good, bindings: { claude: { ...CLAUDE_BINDING, origin: 'SECRET' } } }],
    ['bindings.codex', { ...good, bindings: { codex: CLAUDE_BINDING } }]
  ])('%s', (field, input) => {
    const error = invalid(input);
    expect(error.field).toBe(field);
    expect(error.message).toContain(field);
    expect(error.message).not.toContain('SECRET');
  });
});
