// FR-R6-F12 T005 (FR-006, FR-013, FR-015; research R1) — the inventory parser.
//
// WHAT THIS PINS:
//   - each status letter and the gitlink mode map to one change kind;
//   - Git's own binary verdict (numstat `-`) and a rename's similarity are kept;
//   - a path holding a newline, tab, quote, command text or a leading dash stays exact;
//   - an unknown status, a truncated record or a raw/numstat count mismatch is `malformed`, never
//     a shorter inventory;
//   - every record is counted, and only the first `keep` are returned, in Git's order.

import { describe, expect, it } from 'vitest';
import { parseInventory } from '../../../src/services/change-review/diff-inventory-parser';

const Z = '\u0000';
const NULL_SHA = '0'.repeat(40);
const OLD = '1'.repeat(40);
const NEW = '2'.repeat(40);

function raw(oldMode: string, newMode: string, oldSha: string, newSha: string, status: string, ...paths: string[]): string {
  return `:${oldMode} ${newMode} ${oldSha} ${newSha} ${status}${Z}${paths.map((p) => `${p}${Z}`).join('')}`;
}

function num(added: string, deleted: string, path: string): string {
  return `${added}\t${deleted}\t${path}${Z}`;
}

function numRename(added: string, deleted: string, oldPath: string, newPath: string): string {
  return `${added}\t${deleted}\t${Z}${oldPath}${Z}${newPath}${Z}`;
}

describe('parseInventory', () => {
  it('maps every kind and keeps each side', () => {
    const out =
      raw('000000', '100644', NULL_SHA, NEW, 'A', 'added.txt') +
      raw('100644', '000000', OLD, NULL_SHA, 'D', 'gone.txt') +
      raw('100644', '100644', OLD, NEW, 'M', 'mod.txt') +
      raw('100644', '100644', OLD, NEW, 'R087', 'from.txt', 'to.txt') +
      raw('100644', '120000', OLD, NEW, 'T', 'link') +
      raw('000000', '160000', NULL_SHA, NEW, 'A', 'sub') +
      num('1', '0', 'added.txt') +
      num('0', '1', 'gone.txt') +
      num('2', '1', 'mod.txt') +
      numRename('1', '1', 'from.txt', 'to.txt') +
      num('1', '1', 'link') +
      num('0', '0', 'sub');
    const result = parseInventory(out, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(6);
    expect(result.records.map((r) => r.kind)).toEqual(['added', 'deleted', 'modified', 'renamed', 'type-changed', 'submodule']);
    expect(result.records.at(0)).toEqual({
      kind: 'added',
      oldPath: null,
      newPath: 'added.txt',
      oldMode: null,
      newMode: '100644',
      oldBlob: null,
      newBlob: NEW,
      binary: false,
      similarity: null
    });
    expect(result.records.at(1)).toMatchObject({ oldPath: 'gone.txt', newPath: null, oldBlob: OLD, newBlob: null });
    expect(result.records.at(3)).toMatchObject({ oldPath: 'from.txt', newPath: 'to.txt', similarity: 87 });
    expect(result.records.at(4)).toMatchObject({ oldMode: '100644', newMode: '120000' });
    expect(result.records.at(5)).toMatchObject({ kind: 'submodule', newMode: '160000' });
  });

  it('gives a gitlink on the old side the submodule kind', () => {
    const out = raw('160000', '000000', OLD, NULL_SHA, 'D', 'sub') + num('0', '0', 'sub');
    const result = parseInventory(out, 1000);
    expect(result.ok && result.records.at(0)?.kind).toBe('submodule');
  });

  it('keeps the numstat binary verdict', () => {
    const out =
      raw('000000', '100644', NULL_SHA, NEW, 'A', 'img.png') +
      raw('100644', '100644', OLD, NEW, 'R100', 'a.bin', 'b.bin') +
      num('-', '-', 'img.png') +
      numRename('-', '-', 'a.bin', 'b.bin');
    const result = parseInventory(out, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((r) => r.binary)).toEqual([true, true]);
    expect(result.records.at(1)?.similarity).toBe(100);
  });

  it('keeps hostile paths exactly', () => {
    const hostile = ['new\nline.txt', 'tab\there', 'quote"\'.txt', '$(touch x)', '[a](command:x)', '-rf', ':colon'];
    const out =
      hostile.map((p) => raw('000000', '100644', NULL_SHA, NEW, 'A', p)).join('') + hostile.map((p) => num('1', '0', p)).join('');
    const result = parseInventory(out, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((r) => r.newPath)).toEqual(hostile);
  });

  it('reads an empty output as an empty inventory', () => {
    expect(parseInventory('', 1000)).toEqual({ ok: true, total: 0, records: [] });
  });

  it.each([
    ['an unknown status', raw('100644', '100644', OLD, NEW, 'X', 'a') + num('1', '1', 'a')],
    ['a copy status', raw('100644', '100644', OLD, NEW, 'C090', 'a', 'b') + numRename('1', '1', 'a', 'b')],
    ['a short header', `:100644 100644 ${OLD} M${Z}a${Z}` + num('1', '1', 'a')],
    ['a bad identity', raw('100644', '100644', 'xyz', NEW, 'M', 'a') + num('1', '1', 'a')],
    ['a bad mode', raw('10064x', '100644', OLD, NEW, 'M', 'a') + num('1', '1', 'a')],
    ['a missing numstat record', raw('100644', '100644', OLD, NEW, 'M', 'a')],
    ['an extra numstat record', raw('100644', '100644', OLD, NEW, 'M', 'a') + num('1', '1', 'a') + num('1', '1', 'b')],
    ['a truncated rename', `${raw('100644', '100644', OLD, NEW, 'R100', 'a').slice(0, -1)}`],
    ['a bad numstat count', raw('100644', '100644', OLD, NEW, 'M', 'a') + num('x', '1', 'a')],
    ['a numstat path that disagrees', raw('100644', '100644', OLD, NEW, 'M', 'a') + num('1', '1', 'b')],
    ['a similarity over 100', raw('100644', '100644', OLD, NEW, 'R101', 'a', 'b') + numRename('1', '1', 'a', 'b')],
    ['no trailing separator', `${raw('100644', '100644', OLD, NEW, 'M', 'a')}1\t1\ta`]
  ])('reads %s as malformed', (_label, out) => {
    expect(parseInventory(out, 1000)).toEqual({ ok: false });
  });

  it('counts every record and keeps the first ones in order', () => {
    const count = 1050;
    const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
    const out =
      names.map((n) => raw('000000', '100644', NULL_SHA, NEW, 'A', n)).join('') + names.map((n) => num('1', '0', n)).join('');
    const result = parseInventory(out, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(count);
    expect(result.records).toHaveLength(1000);
    expect(result.records.at(0)?.newPath).toBe('f0000.txt');
    expect(result.records.at(999)?.newPath).toBe('f0999.txt');
  });
});
