// FR-R6-F15 T024 — the rules of an edit: what a replacement source may change, what it may
// not, the limits it stays under and the order the sources keep.
import { describe, expect, it } from 'vitest';

import type { HandoffManifest, ManifestSource } from '../../../src/contracts/phase-context/context-manifest';
import { buildManifest, parseManifest, serializeManifest, type ManifestInput } from '../../../src/services/phase-context/manifest';
import { renderContext } from '../../../src/services/phase-context/renderer';
import { editRevision, preparedOf } from '../../../src/services/phase-context/revision-edit';
import { artifactRef, digestOf, manifestInput, manifestSource, omission, textOfBytes } from '../../fixtures/phase-context/builders';

const plan = manifestSource('plan', { artifacts: [artifactRef(), artifactRef({ artifactId: 'artifact-2' })] });
const research = manifestSource('research', { required: false });
const notes = manifestSource('notes', { required: false, coverage: 'partial', selectedBy: { kind: 'binding', id: 'input-notes' } });

function baseOf(overrides: Partial<ManifestInput> = {}, sources: readonly ManifestSource[] = [plan, research, notes]): HandoffManifest {
  return buildManifest(manifestInput(sources, overrides));
}

function edited(replacement: unknown, base: HandoffManifest = baseOf()): HandoffManifest {
  const result = editRevision(base, replacement);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result.prepared.manifest;
}

function refusal(failure: string, detail: string): { ok: false; failure: string; detail: string } {
  return { ok: false, failure, detail };
}

function entries(count: number, bytes = 10): string[] {
  return Array.from({ length: count }, (_unused, index) => textOfBytes(bytes - 3, 'a') + String(index).padStart(3, '0'));
}

describe('preparedOf', () => {
  it('gives the one text, its digest and the one rendering of a manifest', () => {
    const manifest = baseOf();

    const prepared = preparedOf(manifest);

    expect(prepared.manifest).toBe(manifest);
    expect(prepared.serialized).toBe(serializeManifest(manifest));
    expect(prepared.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.rendered).toEqual(renderContext(manifest));
  });
});

describe('an edit', () => {
  it('writes the next revision with the replacement sources and the frame of its base', () => {
    const base = baseOf({ revision: 3, previousRevision: 2, omissions: [omission('audit')], omissionsUnlisted: 2, approval: 'manual' });
    const shorter = { ...plan, outcomes: ['One step is left.'], artifacts: [artifactRef()] };

    const result = edited([shorter, research], base);

    expect(result).toEqual({ ...base, revision: 4, previousRevision: 3, origin: 'edited', sources: [shorter, research] });
    expect(parseManifest(JSON.parse(serializeManifest(result)))).toEqual({ kind: 'valid', manifest: result });
  });

  it('keeps the sources in the order of the base, whatever order they are given in', () => {
    expect(edited([notes, research, plan]).sources.map((source) => source.producer.nodePath)).toEqual(['plan', 'research', 'notes']);
  });

  it('lets a source drop entries, its summary and artifacts, and change its text', () => {
    const rewritten = {
      ...plan,
      outcomes: [],
      decisions: ['Keep the queue.'],
      constraints: ['No new dependency.'],
      unresolvedIssues: ['The retry count is open.'],
      summary: 'A shorter plan.',
      artifacts: []
    };

    expect(edited([rewritten]).sources).toEqual([rewritten]);
  });

  it('lets every optional source go', () => {
    expect(edited([plan]).sources).toEqual([plan]);
  });

  it('gives equal results for equal input', () => {
    const base = baseOf();

    expect(editRevision(base, [plan, notes])).toEqual(editRevision(base, [plan, notes]));
  });

  it('marks the result edited even when nothing changed', () => {
    const result = edited([plan, research, notes]);

    expect(result.origin).toBe('edited');
    expect(result.sources).toEqual([plan, research, notes]);
  });

  it.each([
    ['sources that are not a list', { 0: plan }, 'invalid-source', 'sources'],
    ['more than 32 sources', Array.from({ length: 33 }, () => plan), 'capacity-exceeded', 'source-count'],
    ['a source that is not a record', [plan, 'research'], 'invalid-source', 'source-shape'],
    ['a source with a key the contract does not name', [{ ...plan, note: 'extra' }], 'invalid-source', 'source-shape'],
    ['a source with an entry over 2 KiB', [{ ...plan, outcomes: [textOfBytes(2049)] }], 'invalid-source', 'entry-text'],
    ['a source with 33 entries in one collection', [{ ...plan, outcomes: entries(33) }], 'invalid-source', 'entry-count'],
    ['a source with a control character in its text', [{ ...plan, decisions: [`a${String.fromCharCode(7)}b`] }], 'invalid-source', 'entry-text'],
    ['a source accepted after the cutoff', [{ ...plan, acceptedSequence: 11 }], 'invalid-source', 'source-after-cutoff'],
    ['one source twice', [plan, research, plan], 'invalid-source', 'source-duplicate'],
    ['a source the base did not select', [plan, manifestSource('audit', { required: false })], 'invalid-source', 'edit-unknown-source'],
    ['another attempt of a selected node', [{ ...plan, producer: { ...plan.producer, attemptId: 'att-plan-2' } }], 'invalid-source', 'edit-unknown-source'],
    ['a source with another accepted sequence', [{ ...plan, acceptedSequence: 2 }], 'invalid-source', 'edit-source-attribution'],
    ['a required source made optional', [{ ...plan, required: false }], 'invalid-source', 'edit-source-attribution'],
    ['an optional source made required', [plan, { ...research, required: true }], 'invalid-source', 'edit-source-attribution'],
    ['partial coverage made complete', [plan, { ...notes, coverage: 'complete' }], 'invalid-source', 'edit-source-attribution'],
    ['a source asked for by another request', [plan, { ...notes, selectedBy: { kind: 'selector', id: 'input-notes' } }], 'invalid-source', 'edit-source-attribution'],
    ['an artifact the base source did not carry', [{ ...plan, artifacts: [artifactRef({ artifactId: 'artifact-9' })] }], 'invalid-source', 'edit-unknown-artifact'],
    ['an artifact of another version', [{ ...plan, artifacts: [artifactRef({ immutableVersion: 'v2' })] }], 'invalid-source', 'edit-unknown-artifact'],
    ['an artifact with another digest', [{ ...plan, artifacts: [artifactRef({ digestHex: digestOf('f') })] }], 'invalid-source', 'edit-unknown-artifact'],
    ['an artifact of another size', [{ ...plan, artifacts: [artifactRef({ byteSize: 121 })] }], 'invalid-source', 'edit-unknown-artifact'],
    ['an artifact that belongs to another source', [plan, { ...research, artifacts: [artifactRef()] }], 'invalid-source', 'edit-unknown-artifact'],
    ['no required source', [research, notes], 'invalid-source', 'edit-required-removed'],
    ['no source at all', [], 'invalid-source', 'edit-required-removed'],
    ['33 entries of one kind across the sources', [{ ...plan, outcomes: entries(20) }, { ...research, outcomes: entries(13) }], 'capacity-exceeded', 'aggregate-entry-count'],
    ['a manifest over 64 KiB', [{ ...plan, outcomes: entries(32, 2048) }], 'capacity-exceeded', 'manifest-bytes'],
    ['a rendered context over the bound', [{ ...plan, outcomes: entries(20, 2000) }], 'capacity-exceeded', 'rendered-bytes']
  ])('refuses %s', (_label, replacement, failure, detail) => {
    expect(editRevision(baseOf(), replacement)).toEqual(refusal(failure, detail));
  });

  it('measures the rendered context against the bound of the base, not the largest bound', () => {
    const base = baseOf({ renderedBytesMax: 2_000 }, [manifestSource('plan', { outcomes: ['Short.'] })]);
    const longer = manifestSource('plan', { outcomes: entries(2, 1_000) });

    expect(editRevision(base, [longer])).toEqual(refusal('capacity-exceeded', 'rendered-bytes'));
    expect(editRevision(baseOf({ renderedBytesMax: 4_000 }, [manifestSource('plan', { outcomes: ['Short.'] })]), [longer]).ok).toBe(true);
  });

  it('carries no text of a refused source in the refusal', () => {
    const seeded = { ...plan, outcomes: [textOfBytes(2049, 'z')] };

    expect(JSON.stringify(editRevision(baseOf(), [seeded]))).not.toContain('zzzz');
  });
});
