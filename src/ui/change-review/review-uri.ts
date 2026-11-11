/**
 * FR-R6-F12 (FR-013; research R5) — review document paths and inert labels.
 *
 * A review document's path is `/<handle>/<display name>`: the handle is the only part the content
 * provider reads, and the display name is the last repository path segment with every control
 * character, line or paragraph separator, bidirectional override and bidirectional mark replaced,
 * capped in length.
 * Repository text therefore never names a file on disk and never reaches the editor as markup or an
 * icon. No editor import, so this module is unit-testable.
 */

import { CHANGE_REVIEW_LIMITS } from '../../contracts/change-review';
import { ABSENT_SIDE } from '../../services/change-review/content-reader';

export const REVIEW_SCHEME = 'schegent-review';
export const ABSENT_SEGMENT = ABSENT_SIDE;

const REPLACEMENT = String.fromCodePoint(0xfffd);
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ICON_OPENER = '$(';
/** `$` followed by a zero-width space: shows the same text and can never open an icon. */
const ICON_BREAK = `$${String.fromCodePoint(0x200b)}(`;

/** The implicit bidirectional marks: LRM, RLM and the Arabic letter mark (review S-1). */
const BIDI_MARKS: ReadonlySet<number> = new Set([0x200e, 0x200f, 0x061c]);

function isUnsafe(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    BIDI_MARKS.has(code) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function sanitise(text: string): string[] {
  return Array.from(text, (char) => (isUnsafe(char.codePointAt(0) ?? 0) ? REPLACEMENT : char));
}

/** The last path segment, made inert and capped at the display limit in code points. */
export function displayName(path: string): string {
  const segment = path.slice(path.lastIndexOf('/') + 1);
  return sanitise(segment).slice(0, CHANGE_REVIEW_LIMITS.displayNameCharsMax).join('');
}

/** The full path as a pick label: inert, and unable to form an icon. */
export function pickLabel(path: string): string {
  return sanitise(path).join('').split(ICON_OPENER).join(ICON_BREAK);
}

/** The document path for one side; `null` is the side that does not exist. */
export function documentPath(handle: string | null, path: string): string {
  return `/${handle ?? ABSENT_SEGMENT}/${displayName(path)}`;
}

/** The handle or absent marker a document path names, or `null` for any other shape. */
export function parseDocumentPath(path: string): string | null {
  const parts = path.split('/');
  if (parts.length !== 3 || parts.at(0) !== '') return null;
  const head = parts.at(1) ?? '';
  const display = parts.at(2) ?? '';
  if (display.length === 0) return null;
  if (head === ABSENT_SEGMENT || HANDLE_PATTERN.test(head)) return head;
  return null;
}
