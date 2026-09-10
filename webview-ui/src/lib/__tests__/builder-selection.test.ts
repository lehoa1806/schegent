// BUG-002 (101) — the re-selection rule, at the level the three tabs share it.
//
// `builder-keeps-the-open-definition.test.ts` drives this through the surfaces,
// which is where the defect was observed. These cases exist for the two
// outcomes that surface cannot reach: an id claimed by two rows at once, which
// the catalog admits and only a hand-built projection produces, and the exact
// ordering of the key match against the id match.

import { describe, expect, it } from 'vitest';
import { identityAt, reselectIndex, type DefinitionIdentity } from '../builder-selection';

interface Row {
  readonly sourceKey: string;
  readonly id: string;
}

const identity = (row: Row): DefinitionIdentity => ({ sourceKey: row.sourceKey, id: row.id });

const rows = (...entries: readonly Row[]): readonly Row[] => entries;

describe('reselectIndex', () => {
  it('is null when nothing was open', () => {
    expect(reselectIndex(rows({ sourceKey: 'a::0', id: 'a' }), null, identity)).toBeNull();
  });

  it('matches the record key first, wherever the row has moved to', () => {
    const list = rows(
      { sourceKey: 'newcomer::0', id: 'newcomer' },
      { sourceKey: 'a::1', id: 'a' }
    );
    expect(reselectIndex(list, { sourceKey: 'a::1', id: 'a' }, identity)).toBe(1);
  });

  it('falls back to the authored id when the key moved', () => {
    // The two ways a key moves: a created draft re-keyed by the projection, and
    // a stored row re-keyed by a sibling changing the listing order.
    const list = rows({ sourceKey: 'draft::a::0', id: 'a' });
    expect(reselectIndex(list, { sourceKey: 'draft::a', id: 'a' }, identity)).toBe(0);

    const reordered = rows({ sourceKey: 'b::0', id: 'b' }, { sourceKey: 'a::1', id: 'a' });
    expect(reselectIndex(reordered, { sourceKey: 'a::0', id: 'a' }, identity)).toBe(1);
  });

  it('prefers the exact key over another row claiming the same id', () => {
    const list = rows({ sourceKey: 'a::0', id: 'a' }, { sourceKey: 'a::1', id: 'a' });
    expect(reselectIndex(list, { sourceKey: 'a::1', id: 'a' }, identity)).toBe(1);
  });

  it('is null when the id is ambiguous and no key matches', () => {
    // Two records claiming one id is a state the catalog admits — both resolve
    // `invalid` — and the Builder renders both. Guessing between them would open
    // a definition the operator did not select.
    const list = rows({ sourceKey: 'a::0', id: 'a' }, { sourceKey: 'a::1', id: 'a' });
    expect(reselectIndex(list, { sourceKey: 'draft::a', id: 'a' }, identity)).toBeNull();
  });

  it('is null when the definition is gone, which is the containment', () => {
    const list = rows({ sourceKey: 'b::0', id: 'b' });
    expect(reselectIndex(list, { sourceKey: 'a::0', id: 'a' }, identity)).toBeNull();
    expect(reselectIndex([], { sourceKey: 'a::0', id: 'a' }, identity)).toBeNull();
  });
});

describe('identityAt', () => {
  it('reads the identity of the selected row', () => {
    const list = rows({ sourceKey: 'a::0', id: 'a' }, { sourceKey: 'b::1', id: 'b' });
    expect(identityAt(list, 1, identity)).toEqual({ sourceKey: 'b::1', id: 'b' });
  });

  it('is null for no selection and for an index no row has', () => {
    const list = rows({ sourceKey: 'a::0', id: 'a' });
    expect(identityAt(list, null, identity)).toBeNull();
    expect(identityAt(list, 4, identity)).toBeNull();
  });
});
