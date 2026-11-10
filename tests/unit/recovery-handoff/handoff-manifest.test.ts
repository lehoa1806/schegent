import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  serializeHandoffManifest,
  validateHandoffManifest
} from '../../../src/contracts/recovery-handoff/handoff-manifest';
import {
  MAX_HANDOFF_MANIFEST_BYTES,
  MAX_HANDOFF_REFERENCES_PER_ROLE,
  MAX_HANDOFF_WORKSPACE_ENTRIES
} from '../../../src/contracts/recovery-handoff/handoff-types';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

type Raw = Record<string, unknown>;

function validManifest(): Raw {
  return {
    version: 1,
    sourceOutcome: { status: 'incomplete', reason: 'work-remaining' },
    frozenDefinitionDigest: DIGEST_A,
    certainty: 'uncertain',
    coverage: 'partial',
    workspace: {
      entries: [
        { path: 'src/app.ts', attribution: 'attempt' },
        { path: 'README.md', attribution: 'preexisting' }
      ],
      omittedCount: 3
    },
    references: [
      { artifactId: 'art-validated-1', role: 'validated', required: true, digest: DIGEST_B },
      { artifactId: 'art-partial-1', role: 'partial', required: false }
    ],
    excluded: [{ itemId: 'transcript-1', reason: 'raw-transcript' }],
    contextId: null,
    envelope: { artifactId: 'env-1', digest: DIGEST_A }
  };
}

function refusalCode(raw: unknown): string | undefined {
  const result = validateHandoffManifest(raw);
  return result.ok ? undefined : result.code;
}

function withReferences(count: number, role: string): Raw {
  const references = Array.from({ length: count }, (_, index) => ({
    artifactId: `art-${index}`,
    role,
    required: false
  }));
  return { ...validManifest(), references };
}

describe('FR-R6-F08 handoff manifest (T002)', () => {
  it('round-trips a valid manifest through serialize and validate', () => {
    const serialized = serializeHandoffManifest(validManifest());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.bytes).toBe(Buffer.byteLength(serialized.json, 'utf8'));
    expect(serialized.digest).toBe(createHash('sha256').update(serialized.json, 'utf8').digest('hex'));

    const reparsed = validateHandoffManifest(JSON.parse(serialized.json));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const again = serializeHandoffManifest(reparsed.manifest);
    expect(again.ok && again.json).toBe(serialized.json);
  });

  it('emits canonical key order whatever the input order', () => {
    const base = validManifest();
    const shuffled: Raw = {};
    for (const key of Object.keys(base).reverse()) {
      shuffled[key] = base[key];
    }
    const first = serializeHandoffManifest(base);
    const second = serializeHandoffManifest(shuffled);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && first.json).toBe(second.ok && second.json);
  });

  it('returns a frozen manifest', () => {
    const result = validateHandoffManifest(validManifest());
    expect(result.ok && Object.isFrozen(result.manifest)).toBe(true);
    expect(result.ok && Object.isFrozen(result.manifest.references)).toBe(true);
  });

  it('refuses an unknown key at any level as invalid', () => {
    expect(refusalCode({ ...validManifest(), extra: 1 })).toBe('invalid');
    const manifest = validManifest();
    expect(
      refusalCode({ ...manifest, workspace: { entries: [], omittedCount: 0, note: 'x' } })
    ).toBe('invalid');
    expect(
      refusalCode({
        ...manifest,
        references: [{ artifactId: 'a1', role: 'evidence', required: true, content: 'x' }]
      })
    ).toBe('invalid');
  });

  it('refuses a non-object input as invalid', () => {
    expect(refusalCode(null)).toBe('invalid');
    expect(refusalCode([])).toBe('invalid');
    expect(refusalCode('manifest')).toBe('invalid');
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent path', 'src/../../secret'],
    ['a Windows drive path', 'C:/x'],
    ['a path over 512 bytes', 'a/'.repeat(256) + 'b']
  ])('refuses %s as invalid-path', (_label, path) => {
    const manifest = validManifest();
    expect(
      refusalCode({ ...manifest, workspace: { entries: [{ path, attribution: 'attempt' }], omittedCount: 0 } })
    ).toBe('invalid-path');
  });

  it.each([
    ['an artifact id over 128 bytes', 'a'.repeat(129)],
    ['an artifact id with a slash', 'dir/file'],
    ['an artifact id with a leading dot', '.hidden'],
    ['an empty artifact id', '']
  ])('refuses %s as invalid-ref', (_label, artifactId) => {
    expect(
      refusalCode({ ...validManifest(), references: [{ artifactId, role: 'evidence', required: true }] })
    ).toBe('invalid-ref');
  });

  it('refuses an invalid excluded item id or context id as invalid-ref', () => {
    expect(refusalCode({ ...validManifest(), excluded: [{ itemId: '/abs', reason: 'policy-denied' }] })).toBe(
      'invalid-ref'
    );
    expect(refusalCode({ ...validManifest(), contextId: 'x'.repeat(129) })).toBe('invalid-ref');
  });

  it('refuses more references in one role than the bound as over-limit', () => {
    expect(refusalCode(withReferences(MAX_HANDOFF_REFERENCES_PER_ROLE, 'evidence'))).toBeUndefined();
    expect(refusalCode(withReferences(MAX_HANDOFF_REFERENCES_PER_ROLE + 1, 'evidence'))).toBe('over-limit');
  });

  it('refuses more workspace entries than the bound as over-limit', () => {
    const entries = Array.from({ length: MAX_HANDOFF_WORKSPACE_ENTRIES + 1 }, (_, index) => ({
      path: `f${index}.ts`,
      attribution: 'attempt'
    }));
    expect(refusalCode({ ...validManifest(), workspace: { entries, omittedCount: 0 } })).toBe('over-limit');
  });

  it('refuses more than 32 excluded items as over-limit', () => {
    const excluded = Array.from({ length: 33 }, (_, index) => ({ itemId: `item-${index}`, reason: 'over-limit' }));
    expect(refusalCode({ ...validManifest(), excluded })).toBe('over-limit');
  });

  it('refuses one artifact under two roles as invalid, so a partial is never also validated', () => {
    expect(
      refusalCode({
        ...validManifest(),
        references: [
          { artifactId: 'art-1', role: 'partial', required: false },
          { artifactId: 'art-1', role: 'validated', required: true }
        ]
      })
    ).toBe('invalid');
  });

  it('refuses coverage complete with omitted entries as invalid', () => {
    expect(refusalCode({ ...validManifest(), coverage: 'complete' })).toBe('invalid');
    const manifest = validManifest();
    expect(
      refusalCode({ ...manifest, coverage: 'complete', workspace: { entries: [], omittedCount: 0 } })
    ).toBeUndefined();
  });

  it('refuses a serialized size over the byte bound as over-limit', () => {
    const entries = Array.from({ length: MAX_HANDOFF_WORKSPACE_ENTRIES }, (_, index) => ({
      path: `${'d'.repeat(150)}/${index}.ts`,
      attribution: 'attempt'
    }));
    const manifest = { ...validManifest(), workspace: { entries, omittedCount: 0 } };
    const json = JSON.stringify(manifest);
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(MAX_HANDOFF_MANIFEST_BYTES);
    expect(refusalCode(manifest)).toBe('over-limit');
  });

  it('refuses a future version as unsupported-version, even with unknown fields', () => {
    expect(refusalCode({ ...validManifest(), version: 2 })).toBe('unsupported-version');
    expect(refusalCode({ version: 2, somethingNew: true })).toBe('unsupported-version');
    expect(refusalCode({ ...validManifest(), version: 0 })).toBe('invalid');
    expect(refusalCode({ ...validManifest(), version: 1.5 })).toBe('invalid');
  });

  it('refuses a value outside each closed list as invalid', () => {
    expect(refusalCode({ ...validManifest(), excluded: [{ itemId: 'i1', reason: 'too-big' }] })).toBe('invalid');
    expect(refusalCode({ ...validManifest(), certainty: 'probably' })).toBe('invalid');
    expect(refusalCode({ ...validManifest(), coverage: 'most' })).toBe('invalid');
    expect(refusalCode({ ...validManifest(), sourceOutcome: { status: 'done', reason: 'nope' } })).toBe('invalid');
    expect(
      refusalCode({ ...validManifest(), references: [{ artifactId: 'a1', role: 'source', required: true }] })
    ).toBe('invalid');
    expect(refusalCode({ ...validManifest(), frozenDefinitionDigest: 'ABC' })).toBe('invalid');
    expect(refusalCode({ ...validManifest(), envelope: { artifactId: 'env-1', digest: 'short' } })).toBe('invalid');
  });

  it('serialize refuses what validate refuses', () => {
    const result = serializeHandoffManifest({ ...validManifest(), version: 2 });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.code).toBe('unsupported-version');
  });
});
