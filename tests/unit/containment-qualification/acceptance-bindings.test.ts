// FR-R6-F09 T021 -- the acceptance binding store (research R5, data-model AcceptanceBinding).
//
// WHAT THIS PINS:
//   - a bind then a read round-trips, and there is at most one binding per kind;
//   - a malformed entry (unknown kind, extra key, unknown origin, a bad digest, a component over
//     80 characters) is treated as absent and logged by kind only, never by its stored text;
//   - a stored value over 8 KiB, or one with no schemaVersion, is treated as absent;
//   - a schemaVersion above 1 reads as `future-schema`, is never rewritten, and the admission
//     judgement refuses it with `consentable: false`.

import { describe, expect, it } from 'vitest';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import {
  ACCEPTANCE_BINDINGS_KEY,
  ACCEPTANCE_BINDINGS_MAX_BYTES,
  type AcceptanceBinding,
  type BackendIdentity,
  type BindingInput,
  type FingerprintRecord
} from '../../../src/contracts/containment-qualification';
import {
  AcceptanceBindingStore,
  AcceptanceBindingsFutureSchemaError,
  type AcceptanceMementoPort
} from '../../../src/services/containment-qualification/acceptance-bindings';
import { judgeSpawnAdmission } from '../../../src/services/containment-qualification/admission';
import { computeFingerprint } from '../../../src/services/containment-qualification/fingerprint';

const NOW = new Date('2026-11-10T08:00:00.000Z');

function identityOf(kind: BackendRunnerKind, versionMinor = '2.1'): BackendIdentity {
  return { kind, executable: 'resolved', versionMinor, os: 'darwin', arch: 'arm64', environmentPolicyDigest: 'e'.repeat(64) };
}

function memento(initial?: unknown) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) store.set(ACCEPTANCE_BINDINGS_KEY, initial);
  const writes: unknown[] = [];
  const port: AcceptanceMementoPort = {
    get: (key) => store.get(key),
    update: async (key, value) => {
      writes.push(value);
      store.set(key, value);
    }
  };
  return { port, writes, store };
}

function logger() {
  const lines: string[] = [];
  return { lines, warn: (line: string) => lines.push(line) };
}

function storeWith(initial?: unknown) {
  const m = memento(initial);
  const log = logger();
  return { ...m, log, bindings: new AcceptanceBindingStore(m.port, log, () => NOW) };
}

function bound(value: BindingInput): AcceptanceBinding {
  if (value === null || value === 'future-schema') throw new Error('expected a binding');
  return value;
}

function entry(fingerprint: FingerprintRecord, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { fingerprint, origin: 'consent', boundAt: NOW.toISOString(), ...over };
}

const CLAUDE_FP = computeFingerprint(identityOf('claude'));
const CODEX_FP = computeFingerprint(identityOf('codex', '0.164'));

describe('FR-R6-F09 T021 -- round trip', () => {
  it('reads null when nothing is stored', () => {
    const { bindings, log } = storeWith();
    expect(bindings.read('claude')).toBeNull();
    expect(log.lines).toEqual([]);
  });

  it('binds then reads the same binding, stamped with the injected clock', async () => {
    const { bindings } = storeWith();
    await bindings.bind('claude', CLAUDE_FP, 'legacy-first-use');
    expect(bindings.read('claude')).toEqual({ fingerprint: CLAUDE_FP, origin: 'legacy-first-use', boundAt: NOW.toISOString() });
    expect(bindings.read('codex')).toBeNull();
  });

  it('keeps at most one binding per kind: a rebind replaces it', async () => {
    const { bindings, store } = storeWith();
    await bindings.bind('claude', CLAUDE_FP, 'legacy-first-use');
    const rebound = computeFingerprint(identityOf('claude', '2.2'));
    await bindings.bind('claude', rebound, 'consent');
    await bindings.bind('codex', CODEX_FP, 'consent');
    expect(bound(bindings.read('claude')).fingerprint).toEqual(rebound);
    expect(bound(bindings.read('claude')).origin).toBe('consent');
    const value = store.get(ACCEPTANCE_BINDINGS_KEY) as { schemaVersion: number; bindings: Record<string, unknown> };
    expect(value.schemaVersion).toBe(1);
    expect(Object.keys(value.bindings).sort()).toEqual(['claude', 'codex']);
  });
});

describe('FR-R6-F09 T021 -- a malformed entry is absent and logged by kind only', () => {
  const longComponent = { ...CLAUDE_FP, components: { ...CLAUDE_FP.components, os: 'x'.repeat(81) } };
  it.each([
    ['an extra key', entry(CLAUDE_FP, { note: 'SECRET-NOTE' })],
    ['an unknown origin', entry(CLAUDE_FP, { origin: 'SECRET-ORIGIN' })],
    ['a short digest', entry({ ...CLAUDE_FP, digest: 'abc' })],
    ['a component over 80 characters', entry(longComponent)],
    ['a fingerprint for another backend', entry(CODEX_FP)],
    ['a non-object entry', 'SECRET-STRING']
  ])('%s', (_label, bad) => {
    const { bindings, log } = storeWith({ schemaVersion: 1, bindings: { claude: bad, codex: entry(CODEX_FP) } });
    expect(bindings.read('claude')).toBeNull();
    expect(bound(bindings.read('codex')).fingerprint).toEqual(CODEX_FP);
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.lines.every((line) => line.includes('kind=claude'))).toBe(true);
    expect(log.lines.join('\n')).not.toContain('SECRET');
  });

  it('an unknown kind is logged without echoing it', () => {
    const { bindings, log } = storeWith({ schemaVersion: 1, bindings: { 'SECRET-KIND': entry(CLAUDE_FP) } });
    expect(bindings.read('claude')).toBeNull();
    expect(log.lines.join('\n')).toContain('kind=unknown');
    expect(log.lines.join('\n')).not.toContain('SECRET');
  });

  it('a rebind drops the malformed entries it found', async () => {
    const { bindings, store } = storeWith({ schemaVersion: 1, bindings: { agy: 'garbage', claude: entry(CLAUDE_FP) } });
    await bindings.bind('codex', CODEX_FP, 'consent');
    const value = store.get(ACCEPTANCE_BINDINGS_KEY) as { bindings: Record<string, unknown> };
    expect(Object.keys(value.bindings).sort()).toEqual(['claude', 'codex']);
  });
});

describe('FR-R6-F09 T021 -- a malformed value is absent', () => {
  it.each([
    ['a non-object value', 'SECRET-VALUE'],
    ['an array', [entry(CLAUDE_FP)]],
    ['no schemaVersion', { bindings: { claude: entry(CLAUDE_FP) } }],
    ['a non-integer schemaVersion', { schemaVersion: 'one', bindings: {} }],
    ['bindings that are not an object', { schemaVersion: 1, bindings: 'SECRET' }],
    ['an extra top-level key', { schemaVersion: 1, bindings: {}, extra: true }]
  ])('%s', (_label, value) => {
    const { bindings, log } = storeWith(value);
    expect(bindings.read('claude')).toBeNull();
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.lines.join('\n')).not.toContain('SECRET');
  });

  it('a value over 8 KiB is absent', () => {
    const padded = { schemaVersion: 1, bindings: { claude: entry(CLAUDE_FP) }, pad: 'p'.repeat(ACCEPTANCE_BINDINGS_MAX_BYTES) };
    const { bindings, log } = storeWith(padded);
    expect(bindings.read('claude')).toBeNull();
    expect(log.lines.length).toBeGreaterThan(0);
  });
});

describe('FR-R6-F09 T021 -- a record a newer host wrote', () => {
  const future = { schemaVersion: 2, bindings: { claude: { anything: 'new' } } };

  it('reads as future-schema for every kind', () => {
    const { bindings } = storeWith(future);
    expect(bindings.read('claude')).toBe('future-schema');
    expect(bindings.read('codex')).toBe('future-schema');
  });

  it('is never rewritten', async () => {
    const { bindings, writes, store } = storeWith(future);
    await expect(bindings.bind('claude', CLAUDE_FP, 'consent')).rejects.toBeInstanceOf(AcceptanceBindingsFutureSchemaError);
    expect(writes).toEqual([]);
    expect(store.get(ACCEPTANCE_BINDINGS_KEY)).toEqual(future);
  });

  it('the admission judgement refuses it, not consentable', () => {
    const { bindings } = storeWith(future);
    const verdict = judgeSpawnAdmission({
      identity: identityOf('claude'),
      granted: new Set<BackendRunnerKind>(['claude']),
      binding: bindings.read('claude')
    });
    expect(verdict.outcome === 'refused' && verdict.reason).toBe('acceptance-fingerprint-changed');
    expect(verdict.outcome === 'refused' && verdict.consentable).toBe(false);
  });
});
