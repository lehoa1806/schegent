// FR-R6-F12 T012 (FR-013; research R5) — review document paths and inert labels.
//
// WHAT THIS PINS:
//   - the display name is the last path segment, with every control, line or paragraph separator
//     bidirectional override and implicit bidirectional mark replaced by U+FFFD, capped at 120
//     characters;
//   - a quick pick label cannot form an icon;
//   - parsing a document path yields only the handle, the absent marker, or `null`.

import { describe, expect, it } from 'vitest';
import { CHANGE_REVIEW_LIMITS } from '../../../src/contracts/change-review';
import {
  ABSENT_SEGMENT,
  REVIEW_SCHEME,
  displayName,
  documentPath,
  parseDocumentPath,
  pickLabel
} from '../../../src/ui/change-review/review-uri';

const HANDLE = 'AbCdEfGhIjKlMnOpQrSt_-';
const REPLACEMENT = String.fromCodePoint(0xfffd);

function cp(code: number): string {
  return String.fromCodePoint(code);
}

describe('review-uri', () => {
  it('uses its own scheme', () => {
    expect(REVIEW_SCHEME).toBe('schegent-review');
  });

  it('shows the last path segment', () => {
    expect(displayName('src/deep/file.ts')).toBe('file.ts');
    expect(displayName('top.txt')).toBe('top.txt');
  });

  it('replaces controls, separators and bidirectional overrides', () => {
    const hostile = [0x00, 0x0a, 0x1b, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069];
    for (const code of hostile) {
      expect(displayName(`dir/a${cp(code)}b`)).toBe(`a${REPLACEMENT}b`);
    }
    expect(displayName('dir/plain-ascii_é.txt')).toBe('plain-ascii_é.txt');
  });

  it('replaces the implicit bidirectional marks too (review S-1)', () => {
    for (const code of [0x200e, 0x200f, 0x061c]) {
      expect(displayName(`dir/a${cp(code)}b`)).toBe(`a${REPLACEMENT}b`);
      expect(pickLabel(`a${cp(code)}b/c`)).toBe(`a${REPLACEMENT}b/c`);
    }
  });

  it('caps the display name', () => {
    const long = 'x'.repeat(500);
    expect(Array.from(displayName(`a/${long}`))).toHaveLength(CHANGE_REVIEW_LIMITS.displayNameCharsMax);
    const astral = cp(0x1f600).repeat(200);
    const capped = displayName(astral);
    expect(Array.from(capped)).toHaveLength(CHANGE_REVIEW_LIMITS.displayNameCharsMax);
    expect(capped.endsWith(cp(0x1f600))).toBe(true);
  });

  it('breaks icon syntax in a pick label and keeps the full path', () => {
    const label = pickLabel('dir/$(zap)/x.ts');
    expect(label.includes('$(')).toBe(false);
    expect(label.startsWith('dir/$')).toBe(true);
    expect(pickLabel(`a${cp(0x202e)}b/c`)).toBe(`a${REPLACEMENT}b/c`);
  });

  it('builds and parses a document path', () => {
    expect(documentPath(HANDLE, 'dir/file.ts')).toBe(`/${HANDLE}/file.ts`);
    expect(documentPath(null, 'dir/file.ts')).toBe(`/${ABSENT_SEGMENT}/file.ts`);
    expect(parseDocumentPath(`/${HANDLE}/file.ts`)).toBe(HANDLE);
    expect(parseDocumentPath(`/${ABSENT_SEGMENT}/file.ts`)).toBe(ABSENT_SEGMENT);
  });

  it.each([
    [''],
    ['/'],
    [`/${HANDLE}`],
    [`${HANDLE}/file.ts`],
    [`/${HANDLE}x/file.ts`],
    [`/${HANDLE.slice(1)}/file.ts`],
    [`/${HANDLE}/a/b`],
    ['/../etc/passwd'],
    [`/absent2/file.ts`]
  ])('refuses the path %j', (path) => {
    expect(parseDocumentPath(path)).toBeNull();
  });
});
