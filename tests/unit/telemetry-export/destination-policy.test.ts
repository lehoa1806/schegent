// FR-R6-F14 T004 — profile evaluation: opt-in, the closed refusal list and its order (FR-001,
// FR-002, FR-013, FR-014).
import { describe, expect, it } from 'vitest';

import {
  PROFILE_REFUSAL_REASONS,
  TELEMETRY_EXPORT_BOUNDS,
  type ProfileEvaluation,
  type ProfileEvaluationContext,
  type ProfileRefusalReason,
  type ResolvedDestination,
  type TelemetryProfile
} from '../../../src/contracts/telemetry-export';
import { evaluateProfiles } from '../../../src/services/telemetry-export/destination-policy';

const TRUSTED: ProfileEvaluationContext = { workspaceTrusted: true, secretStore: 'available' };

function profile(overrides: Partial<TelemetryProfile> = {}): TelemetryProfile {
  return {
    id: 'team-collector',
    revision: 3,
    enabled: true,
    scope: 'user',
    protocol: 'otlp-http-json',
    signals: ['metrics'],
    contentPolicy: 'metadata-only',
    endpoint: 'https://collector.example.test/v1/metrics',
    allowPlaintextLoopback: false,
    credential: { reference: 'telemetry/team-collector', headerName: 'Authorization' },
    ...overrides
  };
}

function destinationOf(evaluation: ProfileEvaluation): ResolvedDestination {
  if (evaluation.kind !== 'authorized') throw new Error(`expected authorized, got ${evaluation.kind}`);
  return evaluation.destination;
}

function reasonOf(evaluation: ProfileEvaluation): ProfileRefusalReason {
  if (evaluation.kind !== 'refused') throw new Error(`expected refused, got ${evaluation.kind}`);
  return evaluation.reason;
}

describe('evaluateProfiles: opt-in', () => {
  it('is disabled with no profile', () => {
    expect(evaluateProfiles([], TRUSTED)).toEqual({ kind: 'disabled' });
  });

  it('is disabled when no profile is enabled, whatever else the profiles say', () => {
    const profiles = [profile({ enabled: false }), profile({ id: 'other', enabled: false, scope: 'workspace' })];
    expect(evaluateProfiles(profiles, TRUSTED)).toEqual({ kind: 'disabled' });
  });

  it('does not treat a truthy non-boolean as enabled', () => {
    const almost = { ...profile(), enabled: 'true' };
    expect(evaluateProfiles([almost, null, 7, 'profile'], TRUSTED)).toEqual({ kind: 'disabled' });
  });

  it('authorizes one valid enabled profile and resolves its destination', () => {
    const destination = destinationOf(evaluateProfiles([profile({ enabled: false, id: 'off' }), profile()], TRUSTED));
    expect(destination).toEqual({
      profileId: 'team-collector',
      profileRevision: 3,
      endpoint: 'https://collector.example.test/v1/metrics',
      plaintextLoopback: false,
      credential: { reference: 'telemetry/team-collector', headerName: 'Authorization' }
    });
    expect(Object.isFrozen(destination)).toBe(true);
  });

  it('uses the endpoint as written, with no path appended', () => {
    const destination = destinationOf(evaluateProfiles([profile({ endpoint: 'https://collector.example.test/custom/path' })], TRUSTED));
    expect(destination.endpoint).toBe('https://collector.example.test/custom/path');
  });
});

describe('evaluateProfiles: refusals', () => {
  it('refuses more than one enabled profile', () => {
    expect(reasonOf(evaluateProfiles([profile(), profile({ id: 'second' })], TRUSTED))).toBe('multiple-active-profiles');
  });

  it.each([
    ['a bad id', { id: 'has space' }],
    ['an empty id', { id: '' }],
    ['a zero revision', { revision: 0 }],
    ['a fractional revision', { revision: 1.5 }],
    ['an unknown scope', { scope: 'machine' }],
    ['an unknown protocol', { protocol: 'zipkin' }],
    ['signals that are not a list', { signals: 'metrics' }],
    ['an empty signal list', { signals: [] }],
    ['an unknown signal', { signals: ['metrics', 'profiles'] }],
    ['an unknown content policy', { contentPolicy: 'everything' }],
    ['a non-text endpoint', { endpoint: 42 }],
    ['a non-boolean plaintext flag', { allowPlaintextLoopback: 'yes' }],
    ['a credential with no reference', { credential: { reference: '', headerName: 'Authorization' } }],
    ['a credential that is not an object', { credential: 'Authorization' }],
    ['a credential carrying a value', { credential: { reference: 'r', headerName: 'Authorization', value: 'marker' } }]
  ])('refuses %s as profile-invalid', (_label, overrides) => {
    const candidate = { ...profile(), ...overrides };
    expect(reasonOf(evaluateProfiles([candidate], TRUSTED))).toBe('profile-invalid');
  });

  it('refuses a workspace-scoped profile', () => {
    expect(reasonOf(evaluateProfiles([profile({ scope: 'workspace' })], TRUSTED))).toBe('scope-not-authorized');
  });

  it('refuses in an untrusted workspace', () => {
    const evaluation = evaluateProfiles([profile()], { workspaceTrusted: false, secretStore: 'available' });
    expect(reasonOf(evaluation)).toBe('workspace-untrusted');
  });

  it.each(['otlp-http-protobuf', 'otlp-grpc'] as const)('refuses the declared protocol %s', (protocol) => {
    expect(reasonOf(evaluateProfiles([profile({ protocol })], TRUSTED))).toBe('protocol-unsupported');
  });

  it.each([[['traces']], [['logs']], [['metrics', 'traces']], [['metrics', 'metrics']]] as const)(
    'refuses signals %j',
    (signals) => {
      expect(reasonOf(evaluateProfiles([profile({ signals })], TRUSTED))).toBe('signal-unsupported');
    }
  );

  it('refuses content export', () => {
    expect(reasonOf(evaluateProfiles([profile({ contentPolicy: 'content' })], TRUSTED))).toBe('content-export-unsupported');
  });

  it.each([
    ['a relative reference', 'collector/v1/metrics'],
    ['another scheme', 'ftp://collector.example.test/v1/metrics'],
    ['a file URL', 'file:///tmp/metrics'],
    ['user information', 'https://user@collector.example.test/v1/metrics'],
    ['a password', 'https://user:word@collector.example.test/v1/metrics'],
    ['a query string', 'https://collector.example.test/v1/metrics?key=marker'],
    ['an empty query string', 'https://collector.example.test/v1/metrics?'],
    ['a fragment', 'https://collector.example.test/v1/metrics#part'],
    ['an empty fragment', 'https://collector.example.test/v1/metrics#'],
    ['a space', 'https://collector.example.test/v1/ metrics'],
    ['a line break', 'https://collector.example.test/v1/metrics\nhost: other'],
    ['no host', 'https:///v1/metrics'],
    ['no authority slashes', 'https:collector.example.test/v1/metrics'],
    ['a backslash', 'https:\\\\collector.example.test\\v1\\metrics'],
    ['an empty string', '']
  ])('refuses an endpoint with %s', (_label, endpoint) => {
    expect(reasonOf(evaluateProfiles([profile({ endpoint })], TRUSTED))).toBe('endpoint-invalid');
  });

  it('refuses an endpoint over the length bound and accepts one at it', () => {
    const base = 'https://collector.example.test/';
    const atBound = base + 'a'.repeat(TELEMETRY_EXPORT_BOUNDS.endpointCharsMax - base.length);
    expect(atBound.length).toBe(2_048);
    expect(evaluateProfiles([profile({ endpoint: atBound })], TRUSTED).kind).toBe('authorized');
    expect(reasonOf(evaluateProfiles([profile({ endpoint: `${atBound}a` })], TRUSTED))).toBe('endpoint-invalid');
  });

  it.each([
    ['plain http to a remote host, even when plaintext loopback is selected', 'http://collector.example.test/v1/metrics', true],
    ['plain http to loopback without the selection', 'http://127.0.0.1:4318/v1/metrics', false],
    ['plain http to a private address', 'http://10.0.0.5:4318/v1/metrics', true],
    ['plain http to the unspecified address', 'http://0.0.0.0:4318/v1/metrics', true],
    ['plain http to a name that only looks local', 'http://localhost.example.test:4318/v1/metrics', true],
    ['plain http to a mapped address', 'http://[::ffff:127.0.0.1]:4318/v1/metrics', true]
  ])('refuses %s', (_label, endpoint, allowPlaintextLoopback) => {
    const evaluation = evaluateProfiles([profile({ endpoint, allowPlaintextLoopback })], TRUSTED);
    expect(reasonOf(evaluation)).toBe('plaintext-not-loopback');
  });

  it.each([
    'http://localhost:4318/v1/metrics',
    'http://LOCALHOST:4318/v1/metrics',
    'http://127.0.0.1:4318/v1/metrics',
    'http://127.200.3.4:4318/v1/metrics',
    'http://[::1]:4318/v1/metrics'
  ])('authorizes plaintext loopback %s when selected', (endpoint) => {
    const destination = destinationOf(evaluateProfiles([profile({ endpoint, allowPlaintextLoopback: true })], TRUSTED));
    expect(destination.plaintextLoopback).toBe(true);
  });

  it('does not mark an https destination as plaintext even when the selection is on', () => {
    const destination = destinationOf(evaluateProfiles([profile({ allowPlaintextLoopback: true })], TRUSTED));
    expect(destination.plaintextLoopback).toBe(false);
  });

  it.each([
    ['a name with a space', 'X Key'],
    ['a name with a colon', 'X-Key:'],
    ['a name with a line break', 'X-Key\nHost'],
    ['an empty name', ''],
    ['a name over 128 characters', `X-${'k'.repeat(127)}`],
    ['host', 'Host'],
    ['content-length', 'Content-Length'],
    ['content-type', 'content-type'],
    ['transfer-encoding', 'Transfer-Encoding'],
    ['connection', 'Connection'],
    ['user-agent', 'User-Agent'],
    ['accept-encoding', 'Accept-Encoding']
  ])('refuses the credential header %s', (_label, headerName) => {
    const evaluation = evaluateProfiles([profile({ credential: { reference: 'r', headerName } })], TRUSTED);
    expect(reasonOf(evaluation)).toBe('credential-header-invalid');
  });

  it.each(['unavailable', 'absent'] as const)('refuses a credential when the secret store is %s', (secretStore) => {
    expect(reasonOf(evaluateProfiles([profile()], { workspaceTrusted: true, secretStore }))).toBe('secret-store-unavailable');
  });

  it.each(['unavailable', 'absent'] as const)('authorizes a profile with no credential while the store is %s', (secretStore) => {
    const destination = destinationOf(evaluateProfiles([profile({ credential: null })], { workspaceTrusted: true, secretStore }));
    expect(destination.credential).toBeNull();
  });
});

describe('evaluateProfiles: order and closure', () => {
  // Each profile fails every later check too; the reported reason is the earliest one.
  const everyLaterFailure = {
    scope: 'workspace',
    protocol: 'otlp-grpc',
    signals: ['traces'],
    contentPolicy: 'content',
    endpoint: 'http://collector.example.test/?q#f',
    credential: { reference: 'r', headerName: 'Host' }
  } as const;
  const untrusted: ProfileEvaluationContext = { workspaceTrusted: false, secretStore: 'unavailable' };

  it.each([
    ['profile-invalid', { ...everyLaterFailure, revision: 0 }],
    ['scope-not-authorized', { ...everyLaterFailure }],
    ['workspace-untrusted', { ...everyLaterFailure, scope: 'user' }]
  ] as const)('reports %s first', (reason, overrides) => {
    expect(reasonOf(evaluateProfiles([{ ...profile(), ...overrides }], untrusted))).toBe(reason);
  });

  it.each([
    ['protocol-unsupported', { ...everyLaterFailure, scope: 'user' }],
    ['signal-unsupported', { ...everyLaterFailure, scope: 'user', protocol: 'otlp-http-json' }],
    ['content-export-unsupported', { ...everyLaterFailure, scope: 'user', protocol: 'otlp-http-json', signals: ['metrics'] }],
    [
      'endpoint-invalid',
      { ...everyLaterFailure, scope: 'user', protocol: 'otlp-http-json', signals: ['metrics'], contentPolicy: 'metadata-only' }
    ],
    [
      'plaintext-not-loopback',
      {
        ...everyLaterFailure,
        scope: 'user',
        protocol: 'otlp-http-json',
        signals: ['metrics'],
        contentPolicy: 'metadata-only',
        endpoint: 'http://collector.example.test/'
      }
    ],
    [
      'credential-header-invalid',
      {
        ...everyLaterFailure,
        scope: 'user',
        protocol: 'otlp-http-json',
        signals: ['metrics'],
        contentPolicy: 'metadata-only',
        endpoint: 'https://collector.example.test/'
      }
    ],
    [
      'secret-store-unavailable',
      {
        ...everyLaterFailure,
        scope: 'user',
        protocol: 'otlp-http-json',
        signals: ['metrics'],
        contentPolicy: 'metadata-only',
        endpoint: 'https://collector.example.test/',
        credential: { reference: 'r', headerName: 'Authorization' }
      }
    ]
  ] as const)('reports %s before the checks after it', (reason, overrides) => {
    const context: ProfileEvaluationContext = { workspaceTrusted: true, secretStore: 'unavailable' };
    expect(reasonOf(evaluateProfiles([{ ...profile(), ...overrides }], context))).toBe(reason);
  });

  it('has a case for every refusal reason and returns nothing but the reason', () => {
    const evaluation = evaluateProfiles([profile({ endpoint: 'https://user:marker@collector.example.test/' })], TRUSTED);
    expect(Object.keys(evaluation).sort()).toEqual(['kind', 'reason']);
    expect(JSON.stringify(evaluation)).not.toContain('marker');
    expect(PROFILE_REFUSAL_REASONS).toHaveLength(11);
  });

  it('never reads a secret: the context carries no port', () => {
    const context = { workspaceTrusted: true, secretStore: 'available' as const, read: () => { throw new Error('read'); } };
    expect(evaluateProfiles([profile()], context).kind).toBe('authorized');
  });
});
