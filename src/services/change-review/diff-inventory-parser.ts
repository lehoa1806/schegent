/**
 * FR-R6-F12 (FR-006, FR-013, FR-015; research R1) — parses one `diff-tree -r -z -M --raw
 * --numstat` output into change records.
 *
 * The output is every raw record (`:oldmode newmode oldsha newsha STATUS`, then one path, or two
 * for a rename), followed by one numstat record per raw record in the same order. Paths are
 * NUL-separated and never re-split, so a path survives exactly as the Git runner decoded it. The
 * runner decodes output as UTF-8, so a path whose bytes are not valid UTF-8 shows U+FFFD where
 * they fail (review R-1). Content is read by blob id, never by path, so it is unaffected.
 *
 * Anything the parser does not recognise makes the whole output `malformed`: a shorter inventory
 * is never returned in place of an unreadable one. Pure: no I/O, no clock.
 */

import type { ChangeKind } from '../../contracts/change-review';

const FIELD_SEPARATOR = '\u0000';
const HEADER_PATTERN = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ADMT]|R\d{1,3})$/;
const NUMSTAT_PATTERN = /^(-|\d+)\t(-|\d+)\t(.*)$/s;
const ABSENT_MODE = '000000';
const GITLINK_MODE = '160000';
const BINARY_COUNT = '-';
const SIMILARITY_MAX = 100;

const KIND_BY_STATUS: Readonly<Record<string, ChangeKind>> = Object.freeze({
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'type-changed',
  R: 'renamed'
});

export interface InventoryRecord {
  readonly kind: ChangeKind;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  readonly binary: boolean;
  /** 0 to 100 for `renamed`, otherwise `null`. */
  readonly similarity: number | null;
}

export type ParsedInventory =
  | { readonly ok: true; readonly total: number; readonly records: readonly InventoryRecord[] }
  | { readonly ok: false };

interface RawRecord {
  readonly status: string;
  readonly similarity: number | null;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldSha: string;
  readonly newSha: string;
  readonly oldPath: string;
  readonly newPath: string;
}

class Cursor {
  private position = 0;
  constructor(private readonly fields: readonly string[]) {}
  peek(): string | undefined {
    return this.fields.at(this.position);
  }
  next(): string | undefined {
    const field = this.fields.at(this.position);
    this.position += 1;
    return field;
  }
  rest(): readonly string[] {
    return this.fields.slice(this.position);
  }
}

function readRaw(cursor: Cursor): RawRecord | null {
  const header = HEADER_PATTERN.exec(cursor.next() ?? '');
  if (header === null) return null;
  const [, oldMode = '', newMode = '', oldSha = '', newSha = '', statusField = ''] = header;
  const status = statusField.charAt(0);
  const similarity = status === 'R' ? Number(statusField.slice(1)) : null;
  if (similarity !== null && similarity > SIMILARITY_MAX) return null;
  const first = cursor.next();
  if (first === undefined || first.length === 0) return null;
  const second = status === 'R' ? cursor.next() : first;
  if (second === undefined || second.length === 0) return null;
  return { status, similarity, oldMode, newMode, oldSha, newSha, oldPath: first, newPath: second };
}

/** Reads one numstat record and returns its binary verdict, or `null` when it does not match `raw`. */
function readNumstat(cursor: Cursor, raw: RawRecord): boolean | null {
  const match = NUMSTAT_PATTERN.exec(cursor.next() ?? '');
  if (match === null) return null;
  const [, added, deleted, path] = match;
  if (raw.status === 'R') {
    if (path !== '' || cursor.next() !== raw.oldPath || cursor.next() !== raw.newPath) return null;
  } else if (path !== raw.newPath) {
    return null;
  }
  return added === BINARY_COUNT && deleted === BINARY_COUNT;
}

function toRecord(raw: RawRecord, binary: boolean): InventoryRecord {
  const gitlink = raw.oldMode === GITLINK_MODE || raw.newMode === GITLINK_MODE;
  const hasOld = raw.oldMode !== ABSENT_MODE;
  const hasNew = raw.newMode !== ABSENT_MODE;
  return {
    kind: gitlink ? 'submodule' : (KIND_BY_STATUS[raw.status] ?? 'modified'),
    oldPath: hasOld ? raw.oldPath : null,
    newPath: hasNew ? raw.newPath : null,
    oldMode: hasOld ? raw.oldMode : null,
    newMode: hasNew ? raw.newMode : null,
    oldBlob: hasOld ? raw.oldSha : null,
    newBlob: hasNew ? raw.newSha : null,
    binary,
    similarity: raw.similarity
  };
}

function sidesAgree(raw: RawRecord): boolean {
  if (raw.status === 'A') return raw.oldMode === ABSENT_MODE && raw.newMode !== ABSENT_MODE;
  if (raw.status === 'D') return raw.oldMode !== ABSENT_MODE && raw.newMode === ABSENT_MODE;
  return raw.oldMode !== ABSENT_MODE && raw.newMode !== ABSENT_MODE;
}

/** Parses `output`, counting every record and keeping the first `keep` in Git's order. */
export function parseInventory(output: string, keep: number): ParsedInventory {
  if (output.length === 0) return { ok: true, total: 0, records: [] };
  if (!output.endsWith(FIELD_SEPARATOR)) return { ok: false };
  const cursor = new Cursor(output.slice(0, -1).split(FIELD_SEPARATOR));
  const raws: RawRecord[] = [];
  while (cursor.peek()?.startsWith(':') === true) {
    const raw = readRaw(cursor);
    if (raw === null || !sidesAgree(raw)) return { ok: false };
    raws.push(raw);
  }
  const records: InventoryRecord[] = [];
  for (const raw of raws) {
    const binary = readNumstat(cursor, raw);
    if (binary === null) return { ok: false };
    if (records.length < keep) records.push(toRecord(raw, binary));
  }
  if (cursor.rest().length > 0) return { ok: false };
  return { ok: true, total: raws.length, records };
}
