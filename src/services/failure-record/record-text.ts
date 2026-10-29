// ---------------------------------------------------------------------------
// FR-R4-F15 (feature 243, contract C1) — the summary pipeline.
//
// An issue summary is text the agent wrote about its own failing work. It can quote a secret it was
// shown, a path on the operator's machine, or markup meant for whatever renders it next. The record
// keeps none of that: every summary passes five steps, in this order, before it can enter a record.
//
//   0  delete control and format code points
//   1  redact, with the host's own redaction set
//   2  remove the workspace root, so a workspace path reads relative
//   3  replace every remaining absolute path with `[path]`
//   4  cut to 240 code points
//
// Pure: no I/O, no clock, no state kept between calls. The module holds no secret pattern of its own,
// because a second copy of the redaction set is a second thing that can fall behind the first (hard
// rules 1 and 23); step 1 calls the `sanitize` it is given, which is `SanitizedLogger.sanitize`.
// ---------------------------------------------------------------------------

import { FAILURE_RECORD_SUMMARY_MAX } from '../../contracts/failure-record';
import { REDACTION_SENTINEL } from '../../lib/logger';
import { CONTROL_AND_FORMAT_CODE_POINTS } from '../resume-decision';

/** What the pipeline needs from its caller: the redaction set, and where the workspace is. */
export interface SummaryContext {
  readonly sanitize: (value: string) => string;
  readonly workspaceRoot: string;
  readonly platform: NodeJS.Platform;
}

const PATH_PLACEHOLDER = '[path]';
const TRUNCATION_MARK = '…';

// C1.2 — a path starts at a token boundary: the start of the text, whitespace, or one of these. A `/`
// inside a word (`and/or`, `N/A`, `https://x`) is therefore never the start of one. A `:` is one unless
// `//` follows it, so `file:/home/x`, `jar:file:/home/x/a.jar!/B.class` and `cwd:/home/x` are paths while
// `https://x/home` and `localhost:3000/api` are not; `;`, `|` and `{` join paths the same way (a Windows
// `PATH`, a piped list). `@` is not one: `@/lib/file` is an import alias, not a location.
const BOUNDARY = '(^|[\\s"\'`(\\[<=,;|{]|:(?!\\/\\/))';
// A path runs until whitespace or one of these.
const PATH_BODY = '[^\\s"\'`)\\]>,;]';
// The root is a whole name, not a prefix of a longer one: `/ws/proj` is not inside `/ws/project2`.
const NAME_CONTINUES = '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])';

const FILE_URI = new RegExp(`${BOUNDARY}file:\\/\\/${PATH_BODY}*`, 'gi');
const UNC_PATH = new RegExp(`${BOUNDARY}\\\\\\\\${PATH_BODY}+`, 'g');
const DRIVE_PATH = new RegExp(`${BOUNDARY}[A-Za-z]:[\\\\/]${PATH_BODY}*`, 'g');
const POSIX_PATH = new RegExp(`${BOUNDARY}\\/${PATH_BODY}+`, 'g');

// Whitespace and punctuation carry nothing: `.` (a bare root), `()` and `,` are what a removed path leaves.
const WHITESPACE_AND_PUNCTUATION_ONLY = /^[\s\p{P}]*$/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The spellings of the root a path may use on this platform. On Windows both slashes name it. */
function rootSpellings(root: string, platform: NodeJS.Platform): readonly string[] {
  if (platform !== 'win32') return [root];
  return [...new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])];
}

function removeWorkspaceRoot(text: string, context: SummaryContext): string {
  const root = context.workspaceRoot.replace(/[\\/]+$/, '');
  // A root of `/` or nothing would strip the leading slash of every path and name none of them.
  if (root === '') return text;
  const alternatives = rootSpellings(root, context.platform).map(escapeRegExp).join('|');
  const flags = context.platform === 'win32' ? 'gi' : 'g';
  const prefix = new RegExp(`${BOUNDARY}(?:${alternatives})[\\\\/]+`, flags);
  const bare = new RegExp(`${BOUNDARY}(?:${alternatives})${NAME_CONTINUES}`, flags);
  return text.replace(prefix, '$1').replace(bare, '$1.');
}

function replaceAbsolutePaths(text: string): string {
  const replacement = `$1${PATH_PLACEHOLDER}`;
  return text
    .replace(FILE_URI, replacement)
    .replace(UNC_PATH, replacement)
    .replace(DRIVE_PATH, replacement)
    .replace(POSIX_PATH, replacement);
}

/** C1.1 — whether anything is left once the markers of what was removed are set aside. */
function hasContent(text: string): boolean {
  const remainder = text.split(REDACTION_SENTINEL).join('').split(PATH_PLACEHOLDER).join('');
  return !WHITESPACE_AND_PUNCTUATION_ONLY.test(remainder);
}

function cutToBound(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= FAILURE_RECORD_SUMMARY_MAX) return text;
  return codePoints.slice(0, FAILURE_RECORD_SUMMARY_MAX - 1).join('') + TRUNCATION_MARK;
}

/**
 * Make one issue summary safe to keep, or `null` when nothing of it survives.
 *
 * `null` is a summary that was only a path, only a secret or only the workspace root (C1.1): the
 * builder drops that entry and counts it as omitted, so the record never shows a bullet with nothing
 * in it. The cut counts code points, so it never splits a surrogate pair or leaves a lone one.
 */
export function boundSummary(raw: string, context: SummaryContext): string | null {
  // Step 0 runs BEFORE redaction: a control character planted inside a secret would break the
  // redaction pattern's match, and stripping it afterwards would rejoin the secret unredacted.
  const stripped = raw.replace(CONTROL_AND_FORMAT_CODE_POINTS, '');
  const redacted = context.sanitize(stripped);
  const relative = removeWorkspaceRoot(redacted, context);
  const withoutPaths = replaceAbsolutePaths(relative).trim();
  if (!hasContent(withoutPaths)) return null;
  return cutToBound(withoutPaths);
}
