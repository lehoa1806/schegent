// Feature 099 (FR-R3-015) T495a — id legality and containment (FR-033, FR-061).
//
// An id the store accepts becomes a directory name, so this is the security
// boundary as much as the naming one. Two halves:
//
//   1. **Refusal.** An illegal id and a case-colliding id are refused by name, and
//      refused BEFORE anything is written — the refusal is worth nothing if the
//      write already happened.
//   2. **Containment.** The core is segment-addressed and holds no path (FR-057),
//      which is what makes "zero writes outside the store directory" structural
//      rather than a discipline. The claim is checked over every call the store
//      makes during a broad exercise, not over the one call a test remembered to
//      look at.
//
// Containment against a REAL filesystem — that the adapter refuses to resolve a
// segment outside its root — belongs to the integration suite, which has a root to
// resolve against. Here the store has none, and that is the point being asserted.

import { describe, expect, it } from 'vitest';

import { checkIdLegality } from '../../../src/catalog/catalog-paths';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import { createTestStore, type FsCall, type TestStore } from '../../fixtures/catalog-memory-fs';

/** The only first segments the store may ever address. */
const STORE_ROOTS = ['manifest.json', 'phases', 'pipelines', 'workflows'];

async function revisionOf(test: TestStore, kind: CatalogKind): Promise<string> {
  const result = await test.store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  return result.snapshot.revisions[kind];
}

/** Why a call would escape the store, or `null` if it stays inside it. */
function escapeReason(call: FsCall): string | null {
  if (call.op === 'writability') return null;
  if (call.at.length === 0) return 'addresses the store root itself';
  if (!STORE_ROOTS.includes(call.at[0] as string)) return `unknown root segment ${call.at[0]}`;
  for (const segment of call.at) {
    if (segment === '' || segment === '.' || segment === '..') return `traversal segment ${segment}`;
    if (segment.includes('/') || segment.includes('\\')) return `separator inside ${segment}`;
    // A segment is a name, never a path. An absolute one would mean the core got
    // hold of a root, which the port shape is designed to make impossible.
    if (segment.startsWith('/') || /^[a-zA-Z]:/.test(segment)) return `absolute segment ${segment}`;
  }
  return null;
}

describe('checkIdLegality', () => {
  it('accepts the shape the validators accept', () => {
    for (const id of ['a', 'implement', 'phase-1', 'a'.repeat(64)]) {
      expect(checkIdLegality(id, [])).toEqual({ outcome: 'legal' });
    }
  });

  it('refuses an id the pattern does not admit', () => {
    for (const id of ['', 'A', 'Implement', '1phase', '-phase', 'a_b', 'a.b', 'a b', 'a'.repeat(65)]) {
      expect(checkIdLegality(id, [])).toEqual({ outcome: 'refused', reason: 'illegal-id' });
    }
  });

  it('refuses traversal and separators as illegal ids, not as a special case', () => {
    // The pattern already excludes these, so there is no sanitising step and no
    // second code path to keep in agreement with the first.
    for (const id of ['..', '../escape', 'a/b', 'a\\b', './a', '/etc/passwd']) {
      expect(checkIdLegality(id, [])).toEqual({ outcome: 'refused', reason: 'illegal-id' });
    }
  });

  it('treats an id equal to an existing one as an edit, not a collision', () => {
    expect(checkIdLegality('implement', ['implement', 'plan'])).toEqual({ outcome: 'legal' });
  });

  it('has no case collision to report, because uppercase is already illegal', () => {
    // The two refusals do not overlap: a differ-by-case pair needs one spelling the
    // pattern accepts and one it does not. `existing` never holds such a spelling
    // in the assembled store — it comes from the manifest, whose reader applies the
    // same pattern — so the collision arm is unreachable *through the store* and is
    // asserted here at the function's own boundary. It is kept for that boundary:
    // `saveLayer` passes ids claimed within one layer, and a caller that stopped
    // filtering would otherwise silently lose the guarantee.
    expect(checkIdLegality('implement', ['Implement'])).toEqual({
      outcome: 'refused',
      reason: 'id-case-collision'
    });
    expect(checkIdLegality('Implement', ['implement'])).toEqual({
      outcome: 'refused',
      reason: 'illegal-id'
    });
  });

  it('refuses a folded collision against any existing id, not just the first', () => {
    expect(checkIdLegality('implement', ['plan', 'analyze', 'IMPLEMENT'])).toEqual({
      outcome: 'refused',
      reason: 'id-case-collision'
    });
  });
});

describe('catalog store: an illegal id never reaches the filesystem', () => {
  it('refuses before any write, for every hostile spelling', async () => {
    const test = createTestStore();
    // Arrange one legal definition so the store has a manifest to read: the refusal
    // must hold in a populated store, not only in an empty one where every path is
    // short.
    await test.store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: await revisionOf(test, 'phase')
    });
    const revision = await revisionOf(test, 'phase');
    const filesBefore = new Map(test.fs.files);
    test.fs.calls.length = 0;

    for (const id of ['../../etc/passwd', 'a/b', '..', 'Implement', 'a b', '', 'a'.repeat(65)]) {
      const outcome = await test.store.save({
        kind: 'phase',
        id,
        body: { hostile: true },
        expectedRevision: revision
      });
      expect(outcome).toMatchObject({ outcome: 'refused' });
      expect(outcome).not.toMatchObject({ outcome: 'saved' });
    }

    // Zero writes and zero removes across all seven attempts, and the disk is
    // byte-identical to what it was before them.
    expect(test.fs.writeCalls).toEqual([]);
    expect(test.fs.callsOf('remove')).toEqual([]);
    expect([...test.fs.files.entries()]).toEqual([...filesBefore.entries()]);
  });

  it('refuses a layer save the same way, naming the offending id', async () => {
    const test = createTestStore();
    test.fs.calls.length = 0;

    const outcome = await test.store.saveLayer({
      kind: 'pipeline',
      definitions: [
        { id: 'standard', body: { n: 1 } },
        { id: '../escape', body: { n: 2 } }
      ],
      expectedRevision: await revisionOf(test, 'pipeline')
    });

    // The whole layer is refused, not the legal prefix of it: a layer is one
    // ordering decision, so a partial layer would be a catalog the operator never
    // authored.
    expect(outcome).toEqual({ outcome: 'refused', reason: 'illegal-id', id: '../escape' });
    expect(test.fs.writeCalls).toEqual([]);
    expect(test.fs.files.size).toBe(0);
  });
});

describe('catalog store: every address stays inside the store', () => {
  it('addresses nothing outside the store across a full exercise', async () => {
    const test = createTestStore();

    // Every code path that builds segments: first save, subsequent save, all three
    // kinds, a prune (which is the only caller of `removeFile`), a past-version
    // read, a version listing, and a whole-layer write.
    for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
      for (let n = 1; n <= 2; n += 1) {
        await test.store.save({
          kind,
          id: 'shared',
          body: { n },
          expectedRevision: await revisionOf(test, kind)
        });
      }
    }
    for (let n = 3; n <= 52; n += 1) {
      await test.store.save({
        kind: 'phase',
        id: 'shared',
        body: { n },
        expectedRevision: await revisionOf(test, 'phase')
      });
    }
    await test.store.saveLayer({
      kind: 'workflow',
      definitions: [{ id: 'shared', body: { n: 9 } }, { id: 'other', body: { n: 1 } }],
      expectedRevision: await revisionOf(test, 'workflow')
    });
    await test.store.readVersion('phase', 'shared', 'v10');
    await test.store.listVersions('pipeline', 'shared');
    await test.store.listDefinitions('workflow');
    await test.store.read();

    // The vacuity guard: the exercise above must actually have exercised the store.
    expect(test.fs.writeCalls.length).toBeGreaterThan(50);
    expect(test.fs.callsOf('remove').length).toBeGreaterThan(0);

    const escapes = test.fs.calls
      .map((call) => ({ call, reason: escapeReason(call) }))
      .filter((entry) => entry.reason !== null)
      .map((entry) => `${entry.call.op} ${JSON.stringify(entry.call.at)}: ${entry.reason}`);
    expect(escapes).toEqual([]);
  });

  it('holds no absolute path anywhere in what it writes', async () => {
    const test = createTestStore();
    await test.store.save({
      kind: 'phase',
      id: 'implement',
      body: { name: 'Implement' },
      expectedRevision: await revisionOf(test, 'phase')
    });

    // FR-061 restated over content rather than addresses. The core has no root to
    // leak because it never holds one, so this can only fail if a root arrives
    // through a body — and a body is stored verbatim, which is the operator's own
    // content and outside the store's control.
    for (const contents of test.fs.files.values()) {
      expect(contents).not.toMatch(/[A-Za-z]:\\/);
      expect(contents).not.toContain('/Users/');
      expect(contents).not.toContain('.schegent');
    }
  });
});
