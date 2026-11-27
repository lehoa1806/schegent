// FR-R6-F15 T016 — the manifest: one text per manifest, a parse that checks every bound again,
// and entry sizes that sum to the serialized size.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PHASE_CONTEXT_LIMITS } from '../../../src/contracts/phase-context/context-policy';
import type { ManifestSource } from '../../../src/contracts/phase-context/context-manifest';
import { handoffIdOf } from '../../../src/services/phase-context/identity';
import {
  buildManifest,
  manifestDigestOf,
  manifestEntryBytes,
  manifestOmissionBytes,
  parseManifest,
  serializeManifest
} from '../../../src/services/phase-context/manifest';
import {
  artifactRef,
  digestOf,
  identity,
  manifestInput,
  manifestSource,
  omission,
  producer,
  textOfBytes,
  wideTextOfBytes
} from '../../fixtures/phase-context/builders';

type Raw = Record<string, unknown>;

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The serialized manifest read back as a value a test can change. */
function rawOf(sources: readonly ManifestSource[] = [manifestSource()], overrides: Parameters<typeof manifestInput>[1] = {}): Raw {
  return JSON.parse(serializeManifest(buildManifest(manifestInput(sources, overrides)))) as Raw;
}

function firstSourceOf(raw: Raw): Raw {
  const first = (raw.sources as Raw[]).at(0);
  if (first === undefined) throw new Error('the manifest has no source');
  return first;
}

function withArtifacts(count: number, prefix: string): ManifestSource['artifacts'] {
  return Array.from({ length: count }, (_unused, index) => artifactRef({ artifactId: `${prefix}-${index}` }));
}

describe('buildManifest', () => {
  it('names the manifest version and derives the handoff identity from the lineage', () => {
    const input = manifestInput();
    const manifest = buildManifest(input);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.handoffId).toBe(handoffIdOf(input.identity));
    expect(manifest.sources).toHaveLength(1);
  });
});

describe('serializeManifest', () => {
  it('gives equal text for equal manifests whatever the key order of the input objects', () => {
    const forward = manifestSource('plan', { artifacts: [artifactRef()] });
    const reversedArtifact = Object.fromEntries(Object.entries(artifactRef()).reverse());
    const reversed = Object.fromEntries(Object.entries({ ...forward, artifacts: [reversedArtifact] }).reverse()) as unknown as ManifestSource;
    const reversedInput = Object.fromEntries(Object.entries(manifestInput([reversed])).reverse()) as unknown as ReturnType<typeof manifestInput>;
    expect(serializeManifest(buildManifest(reversedInput))).toBe(serializeManifest(buildManifest(manifestInput([forward]))));
  });

  it('does not depend on the order of the source attempts in the identity', () => {
    const attempts = [producer('plan', 'occ-1', 'att-plan'), producer('design', 'occ-1', 'att-design')];
    const one = buildManifest(manifestInput([manifestSource()], { identity: identity({ sourceAttempts: attempts }) }));
    const other = buildManifest(manifestInput([manifestSource()], { identity: identity({ sourceAttempts: [...attempts].reverse() }) }));
    expect(serializeManifest(one)).toBe(serializeManifest(other));
    expect(one.handoffId).toBe(other.handoffId);
  });

  it('keeps the order of the sources: a different order is a different text', () => {
    const plan = manifestSource('plan');
    const design = manifestSource('design');
    expect(serializeManifest(buildManifest(manifestInput([plan, design])))).not.toBe(
      serializeManifest(buildManifest(manifestInput([design, plan])))
    );
  });
});

describe('manifestDigestOf', () => {
  it('is the SHA-256 of the serialized text', () => {
    const text = serializeManifest(buildManifest(manifestInput()));
    expect(manifestDigestOf(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(manifestDigestOf(`${text} `)).not.toBe(manifestDigestOf(text));
  });
});

describe('parseManifest', () => {
  it('reads a serialized manifest back to a manifest that serializes to the same text', () => {
    const sources = [
      manifestSource('plan', { summary: wideTextOfBytes(301), artifacts: [artifactRef()] }),
      manifestSource('design', { required: false, coverage: 'partial', selectedBy: { kind: 'binding', id: 'bind-design' } })
    ];
    const built = buildManifest(
      manifestInput(sources, { omissions: [omission('review', { reason: 'after-cutoff' })], omissionsUnlisted: 3 })
    );
    const text = serializeManifest(built);
    const parsed = parseManifest(JSON.parse(text));
    expect(parsed.kind).toBe('valid');
    if (parsed.kind !== 'valid') return;
    expect(serializeManifest(parsed.manifest)).toBe(text);
    expect(parsed.manifest).toEqual(built);
  });

  it('reads a later revision that names the one before it', () => {
    const parsed = parseManifest(rawOf([manifestSource()], { revision: 3, previousRevision: 2, origin: 'edited' }));
    expect(parsed.kind).toBe('valid');
  });

  it('preserves a manifest of a newer version as received and refuses it', () => {
    const raw = { ...rawOf(), manifestVersion: 2, somethingNew: true };
    const parsed = parseManifest(raw);
    expect(parsed.kind).toBe('unsupported-version');
    if (parsed.kind !== 'unsupported-version') return;
    expect(parsed.preserved).toBe(raw);
  });

  it.each([
    ['null', null],
    ['a list', []],
    ['text', 'manifest'],
    ['an object with a prototype', new Date(0)]
  ])('refuses %s as a manifest', (_label, value) => {
    expect(parseManifest(value)).toEqual({ kind: 'invalid', detail: 'manifest-shape' });
  });

  it.each<[string, (raw: Raw) => void, string]>([
    ['version 0', (raw) => void (raw.manifestVersion = 0), 'manifest-version'],
    ['a version that is text', (raw) => void (raw.manifestVersion = '1'), 'manifest-version'],
    ['a key the contract does not name', (raw) => void (raw.extra = 1), 'manifest-shape'],
    ['a missing key', (raw) => void delete raw.omissions, 'manifest-shape'],
    ['a handoff identity that is not a digest', (raw) => void (raw.handoffId = 'abc'), 'handoff-id'],
    ['a handoff identity that is not the digest of the lineage', (raw) => void (raw.handoffId = digestOf('f')), 'handoff-id'],
    ['revision 0', (raw) => void (raw.revision = 0), 'revision'],
    ['a first revision that names an earlier one', (raw) => void (raw.previousRevision = 1), 'previous-revision'],
    ['a later revision that names none', (raw) => void (raw.revision = 2), 'previous-revision'],
    [
      'a later revision that skips one',
      (raw) => {
        raw.revision = 3;
        raw.previousRevision = 1;
      },
      'previous-revision'
    ],
    ['an unknown origin', (raw) => void (raw.origin = 'copied'), 'origin'],
    ['a policy digest that is not a digest', (raw) => void (raw.policyDigest = 'x'), 'policy-digest'],
    ['an unknown approval mode', (raw) => void (raw.approval = 'always'), 'approval'],
    ['an unknown session policy', (raw) => void (raw.session = 'reuse'), 'session'],
    ['a negative cutoff', (raw) => void (raw.cutoffSequence = -1), 'cutoff'],
    ['an instructions digest that is not a digest', (raw) => void (raw.targetInstructionsDigest = 7), 'instructions-digest'],
    ['a rendered bound of zero', (raw) => void (raw.renderedBytesMax = 0), 'rendered-bound'],
    ['a rendered bound over 32 KiB', (raw) => void (raw.renderedBytesMax = 32 * 1024 + 1), 'rendered-bound'],
    ['a negative unlisted count', (raw) => void (raw.omissionsUnlisted = -1), 'omissions-unlisted'],
    ['an unlisted count over the 256 candidates one preparation reads', (raw) => void (raw.omissionsUnlisted = 257), 'omissions-unlisted'],
    ['an identity with a key missing', (raw) => void delete (raw.identity as Raw).workspaceId, 'identity-shape'],
    ['sources that are not a list', (raw) => void (raw.sources = {}), 'source-count'],
    ['a source with a key the contract does not name', (raw) => void (firstSourceOf(raw).note = 'x'), 'source-shape'],
    ['a source that is not an object', (raw) => void (raw.sources = ['plan']), 'source-shape'],
    ['a source with no exact producer', (raw) => void (firstSourceOf(raw).producer = { nodePath: 'plan' }), 'source-producer'],
    ['a source with a negative sequence', (raw) => void (firstSourceOf(raw).acceptedSequence = -1), 'source-sequence'],
    ['a source accepted after the cutoff', (raw) => void (firstSourceOf(raw).acceptedSequence = 11), 'source-after-cutoff'],
    ['a source with coverage unavailable', (raw) => void (firstSourceOf(raw).coverage = 'unavailable'), 'source-coverage'],
    ['a source whose required flag is text', (raw) => void (firstSourceOf(raw).required = 'yes'), 'source-required'],
    ['a source selected by an unknown kind of request', (raw) => void (firstSourceOf(raw).selectedBy = { kind: 'name', id: 'x' }), 'source-request'],
    ['a source selected by a request with a key added', (raw) => void (firstSourceOf(raw).selectedBy = { kind: 'selector', id: 'x', n: 1 }), 'source-request'],
    ['an entry one byte over 2 KiB', (raw) => void (firstSourceOf(raw).outcomes = [textOfBytes(2049)]), 'entry-text'],
    ['an entry with a control character', (raw) => void (firstSourceOf(raw).decisions = [`a${String.fromCharCode(0x1b)}b`]), 'entry-text'],
    ['33 entries in one collection', (raw) => void (firstSourceOf(raw).constraints = Array.from({ length: 33 }, () => 'c')), 'entry-count'],
    ['a summary one byte over 8 KiB', (raw) => void (firstSourceOf(raw).summary = textOfBytes(8193)), 'summary'],
    ['an empty summary', (raw) => void (firstSourceOf(raw).summary = ''), 'summary'],
    ['65 artifacts in one source', (raw) => void (firstSourceOf(raw).artifacts = withArtifacts(65, 'a')), 'artifact-count'],
    ['an artifact with no digest', (raw) => void (firstSourceOf(raw).artifacts = [{ ...artifactRef(), digestHex: 'none' }]), 'artifact'],
    ['one artifact identity twice in a source', (raw) => void (firstSourceOf(raw).artifacts = [artifactRef(), artifactRef()]), 'artifact-duplicate'],
    ['omissions that are not a list', (raw) => void (raw.omissions = null), 'omission-count'],
    ['an omission with an unknown reason', (raw) => void (raw.omissions = [{ ...omission('review'), reason: 'forgotten' }]), 'omission'],
    ['an omission with no producer', (raw) => void (raw.omissions = [{ producer: null, request: null, reason: 'after-cutoff' }]), 'omission'],
    ['an omission with a malformed request', (raw) => void (raw.omissions = [{ ...omission('review'), request: { kind: 'selector' } }]), 'omission'],
    ['an omission with a key added', (raw) => void (raw.omissions = [{ ...omission('review'), note: 1 }]), 'omission']
  ])('refuses %s', (_label, change, detail) => {
    const raw = rawOf();
    change(raw);
    expect(parseManifest(raw)).toEqual({ kind: 'invalid', detail });
  });

  it('refuses 33 sources', () => {
    const sources = Array.from({ length: 33 }, (_unused, index) => manifestSource(`node-${index}`, { outcomes: [] }));
    // The identity can name 32 attempts at most; the count of sources is what is under test.
    const raw = rawOf(sources, { identity: identity() });
    expect(parseManifest(raw)).toEqual({ kind: 'invalid', detail: 'source-count' });
  });

  it('refuses one producer attempt selected twice', () => {
    const raw = rawOf([manifestSource('plan'), manifestSource('plan')], { identity: identity() });
    expect(parseManifest(raw)).toEqual({ kind: 'invalid', detail: 'source-duplicate' });
  });

  it('refuses a source whose producer attempt the identity does not name', () => {
    const raw = rawOf([manifestSource('design')], { identity: identity() });
    expect(parseManifest(raw)).toEqual({ kind: 'invalid', detail: 'source-not-in-identity' });
  });

  it.each(['outcomes', 'decisions', 'constraints', 'unresolvedIssues'] as const)(
    'accepts 32 %s across the sources and refuses 33',
    (collection) => {
      const entries = (count: number): string[] => Array.from({ length: count }, () => 'entry');
      const base = { outcomes: [], decisions: [], constraints: [], unresolvedIssues: [] };
      const atLimit = [manifestSource('plan', { ...base, [collection]: entries(16) }), manifestSource('design', { ...base, [collection]: entries(16) })];
      const over = [manifestSource('plan', { ...base, [collection]: entries(16) }), manifestSource('design', { ...base, [collection]: entries(17) })];
      expect(parseManifest(rawOf(atLimit)).kind).toBe('valid');
      expect(parseManifest(rawOf(over))).toEqual({ kind: 'invalid', detail: 'aggregate-entry-count' });
    }
  );

  it('accepts 64 artifacts across the sources and refuses 65', () => {
    const atLimit = [manifestSource('plan', { artifacts: withArtifacts(32, 'p') }), manifestSource('design', { artifacts: withArtifacts(32, 'd') })];
    const over = [manifestSource('plan', { artifacts: withArtifacts(32, 'p') }), manifestSource('design', { artifacts: withArtifacts(33, 'd') })];
    expect(parseManifest(rawOf(atLimit)).kind).toBe('valid');
    expect(parseManifest(rawOf(over))).toEqual({ kind: 'invalid', detail: 'aggregate-artifact-count' });
  });

  it('accepts an unlisted count of the candidate limit', () => {
    expect(parseManifest(rawOf([manifestSource()], { omissionsUnlisted: PHASE_CONTEXT_LIMITS.candidatesMax })).kind).toBe('valid');
  });

  it('accepts 32 omissions and refuses 33', () => {
    const omissions = (count: number): ReturnType<typeof omission>[] => Array.from({ length: count }, (_unused, index) => omission(`node-${index}`));
    expect(parseManifest(rawOf([manifestSource()], { omissions: omissions(32) })).kind).toBe('valid');
    expect(parseManifest(rawOf([manifestSource()], { omissions: omissions(33) }))).toEqual({ kind: 'invalid', detail: 'omission-count' });
  });

  it('accepts a manifest of at most 64 KiB and refuses a larger one', () => {
    const sized = (summaryBytes: number): ManifestSource[] => [
      ...Array.from({ length: 7 }, (_unused, index) => manifestSource(`node-${index}`, { outcomes: [], summary: textOfBytes(8192) })),
      manifestSource('last', { outcomes: [], summary: textOfBytes(summaryBytes) })
    ];
    const emptyLast = bytesOf(serializeManifest(buildManifest(manifestInput(sized(1))))) - 1;
    const room = PHASE_CONTEXT_LIMITS.manifestBytesMax - emptyLast;
    expect(room).toBeGreaterThan(1);
    expect(room).toBeLessThan(8192);
    const atLimit = rawOf(sized(room));
    expect(bytesOf(JSON.stringify(atLimit))).toBe(PHASE_CONTEXT_LIMITS.manifestBytesMax);
    expect(parseManifest(atLimit).kind).toBe('valid');
    expect(parseManifest(rawOf(sized(room + 1)))).toEqual({ kind: 'invalid', detail: 'manifest-bytes' });
  });
});

describe('manifestEntryBytes and manifestOmissionBytes', () => {
  it('sum to the serialized size: the manifest with no source, plus each entry, less one separator', () => {
    const sources = [
      manifestSource('plan', { summary: wideTextOfBytes(777), artifacts: [artifactRef()] }),
      manifestSource('design', { outcomes: ['a "quoted" line\nand a second line'], required: false }),
      manifestSource('review', { coverage: 'partial', unresolvedIssues: [wideTextOfBytes(64)] })
    ];
    const withSources = bytesOf(serializeManifest(buildManifest(manifestInput(sources))));
    const withNone = bytesOf(serializeManifest(buildManifest(manifestInput(sources, { sources: [] }))));
    const entries = sources.reduce((sum, source) => sum + manifestEntryBytes(source), 0);
    expect(withSources).toBe(withNone + entries - 1);
  });

  it('count one source alone as its text and one separator', () => {
    const source = manifestSource('plan');
    const withOne = bytesOf(serializeManifest(buildManifest(manifestInput([source]))));
    const withNone = bytesOf(serializeManifest(buildManifest(manifestInput([source], { sources: [] }))));
    expect(manifestEntryBytes(source)).toBe(withOne - withNone + 1);
  });

  it('size the omissions the same way', () => {
    const omissions = [
      omission('review', { reason: 'after-cutoff' }),
      omission('design', { reason: 'optional-capacity', request: { kind: 'selector', id: 'sel-design' } })
    ];
    const withOmissions = bytesOf(serializeManifest(buildManifest(manifestInput([], { omissions }))));
    const withNone = bytesOf(serializeManifest(buildManifest(manifestInput([]))));
    const entries = omissions.reduce((sum, entry) => sum + manifestOmissionBytes(entry), 0);
    expect(withOmissions).toBe(withNone + entries - 1);
  });
});
