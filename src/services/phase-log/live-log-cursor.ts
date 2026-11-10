// FR-R6-F07 (FR-002, FR-005, FR-006, FR-015) — opaque live-log cursors.
//
// A cursor is `plc1.<digest16>.<generation>.<offset>.<fp16>`:
//   - `digest16`   first 16 hex of SHA-256 over the workspace root and selection;
//   - `generation` the source file identity: dev and ino in base 36, plus the
//                  creation time on win32, where ino can be 0;
//   - `offset`     a decimal byte offset at a record boundary;
//   - `fp16`       first 16 hex of SHA-256 over up to 64 bytes ending at the
//                  offset, empty at offset 0.
//
// A cursor is never read authority. The selection resolves the file through the
// containment check; the cursor only positions the read inside that file, so a
// forged one can reach no other file. Cursors are unsigned on purpose: they must
// survive a host restart, and a signature would add no authority beyond the
// containment check (research R2).
//
// Validation order (the first failure decides): version, shape, stream digest,
// generation, offset within size, newline before the offset, fingerprint. This
// module opens nothing: the caller passes the opened handle's facts and a
// bounded reader.

import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

export const CURSOR_VERSION = 'plc1';
export const CURSOR_MAX_LENGTH = 160;
export const FINGERPRINT_WINDOW_BYTES = 64;

const DIGEST_HEX_CHARS = 16;
const NEWLINE_BYTE = 0x0a;
const CURSOR_SHAPE =
  /^plc1\.([0-9a-f]{16})\.([0-9a-z]{1,13}(?:-[0-9a-z]{1,13}){1,2})\.(0|[1-9][0-9]{0,15})\.([0-9a-f]{16})?$/;
const VERSION_PREFIX = /^plc[0-9]+\./;

export interface CursorSelection {
  readonly queueId: string;
  readonly taskId: string;
  readonly pipelineId: string;
  readonly phaseId: string;
  readonly iterationN: number | null;
}

export interface CursorFileFacts {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}

export interface LiveLogCursorFields {
  readonly digest: string;
  readonly generation: string;
  readonly offset: number;
  readonly fingerprint: string;
}

export type ParsedCursor =
  | { readonly outcome: 'parsed'; readonly fields: LiveLogCursorFields }
  | { readonly outcome: 'unknown-version' }
  | { readonly outcome: 'malformed' };

export type CursorResetCause =
  | 'malformed'
  | 'foreign-stream'
  | 'generation-changed'
  | 'offset-past-size'
  | 'not-at-boundary'
  | 'fingerprint-mismatch';

export type CursorValidation =
  | { readonly outcome: 'accepted'; readonly offset: number }
  | { readonly outcome: 'unknown-version' }
  | { readonly outcome: 'reset'; readonly cause: CursorResetCause };

export interface CursorExpectation {
  readonly digest: string;
  readonly generation: string;
  readonly size: number;
}

/** Reads `length` bytes ending at `offset`. Never asked for more than 64 bytes. */
export type ReadBytesBefore = (offset: number, length: number) => Promise<Buffer>;

function shortHash(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex').slice(0, DIGEST_HEX_CHARS);
}

/** The stream identity digest: workspace root plus every selection field. */
export function streamDigest(workspaceRoot: string, selection: CursorSelection): string {
  const identity = JSON.stringify([
    'live-log-stream',
    workspaceRoot,
    selection.queueId,
    selection.taskId,
    selection.pipelineId,
    selection.phaseId,
    selection.iterationN
  ]);
  return shortHash(identity);
}

/** The source generation of an opened file. */
export function generationOf(facts: CursorFileFacts, platform: NodeJS.Platform): string {
  const base = `${facts.dev.toString(36)}-${facts.ino.toString(36)}`;
  if (platform !== 'win32') return base;
  return `${base}-${Math.trunc(facts.birthtimeMs).toString(36)}`;
}

/** The fingerprint of the bytes before an offset; empty for no bytes. */
export function fingerprintOf(bytesBefore: Buffer): string {
  if (bytesBefore.length === 0) return '';
  return shortHash(bytesBefore);
}

export function issueCursor(fields: LiveLogCursorFields): string {
  return `${CURSOR_VERSION}.${fields.digest}.${fields.generation}.${fields.offset}.${fields.fingerprint}`;
}

/** A bounded reader over an already-opened handle; it opens nothing itself. */
export function readBeforeFromHandle(handle: FileHandle): ReadBytesBefore {
  return async (offset, length) => {
    const out = Buffer.alloc(length);
    const { bytesRead } = await handle.read(out, 0, length, offset - length);
    return out.subarray(0, bytesRead);
  };
}

/** Issues the cursor for `offset`, fingerprinting the bytes before it. */
export async function cursorAtOffset(
  stream: { readonly digest: string; readonly generation: string },
  offset: number,
  readBefore: ReadBytesBefore
): Promise<string> {
  const window = Math.min(FINGERPRINT_WINDOW_BYTES, offset);
  const before = window === 0 ? Buffer.alloc(0) : await readBefore(offset, window);
  return issueCursor({ ...stream, offset, fingerprint: fingerprintOf(before) });
}

export function parseCursor(text: string): ParsedCursor {
  if (typeof text !== 'string' || text.length > CURSOR_MAX_LENGTH) {
    return { outcome: 'malformed' };
  }
  if (VERSION_PREFIX.test(text) && !text.startsWith(`${CURSOR_VERSION}.`)) {
    return { outcome: 'unknown-version' };
  }
  const match = CURSOR_SHAPE.exec(text);
  if (match === null) return { outcome: 'malformed' };
  const offset = Number(match.at(3));
  const fingerprint = match.at(4) ?? '';
  if (!Number.isSafeInteger(offset)) return { outcome: 'malformed' };
  if ((offset === 0) !== (fingerprint === '')) return { outcome: 'malformed' };
  return {
    outcome: 'parsed',
    fields: { digest: match.at(1) ?? '', generation: match.at(2) ?? '', offset, fingerprint }
  };
}

export async function validateCursor(
  text: string,
  expected: CursorExpectation,
  readBefore: ReadBytesBefore
): Promise<CursorValidation> {
  const parsed = parseCursor(text);
  if (parsed.outcome === 'unknown-version') return parsed;
  if (parsed.outcome === 'malformed') return { outcome: 'reset', cause: 'malformed' };
  const { fields } = parsed;
  if (fields.digest !== expected.digest) return { outcome: 'reset', cause: 'foreign-stream' };
  if (fields.generation !== expected.generation) {
    return { outcome: 'reset', cause: 'generation-changed' };
  }
  if (fields.offset > expected.size) return { outcome: 'reset', cause: 'offset-past-size' };
  if (fields.offset === 0) return { outcome: 'accepted', offset: 0 };
  const window = Math.min(FINGERPRINT_WINDOW_BYTES, fields.offset);
  const before = await readBefore(fields.offset, window);
  if (before.length !== window || before.at(-1) !== NEWLINE_BYTE) {
    return { outcome: 'reset', cause: 'not-at-boundary' };
  }
  if (fingerprintOf(before) !== fields.fingerprint) {
    return { outcome: 'reset', cause: 'fingerprint-mismatch' };
  }
  return { outcome: 'accepted', offset: fields.offset };
}
