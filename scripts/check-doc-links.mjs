// Validates that every relative markdown link in the curated docs points at a
// path that exists, and that the sections live documents name in other files
// exist too.
//
// Paths. A `#L42` line anchor is stripped and never resolved: it moves with every
// edit, so a gate that failed on one would be noise rather than signal.
//
// Sections (FR-R3-184, built 2026-10-20 on a measured count): in every live
// document this script walks, a `#heading` fragment naming another Markdown
// file, or a `§` marker directly after a link or backticked path, must name a
// heading the target has. Records are not read. Same-file anchors and sections
// named in free prose are not checked. The decision, the count it rests on and
// what would reopen it are in docs/development/section-reference-check.md.
//
// Why this exists: `docs:check` was a version-and-required-string gate, so a doc
// link could rot through `verify:all` unobserved. Eleven had, by 2026-08-18.
//
// Scope. The execution repository is scanned always. The planning envelope one
// level up is scanned only when it is actually there, so a standalone `repo/`
// clone still passes -- and in that case a link escaping the repo root is
// reported as unverifiable rather than broken, since the file it names is
// genuinely outside the tree being checked.
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WS_ROOT = resolve(REPO_ROOT, '..');

// Directory names never walked, wherever they appear.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.vscode-test',
  '.svelte-kit'
]);

// Planning-envelope trees left out of THIS gate.
//   repo/     -- walked as the primary tree already, not a second time via `..`.
//   .specify/ -- speckit templates, whose placeholder links are not real targets.
//   .claude/  -- tool-managed skill files.
//   specs/    -- covered by scripts/spec-links-name-the-repo.sh in the envelope.
//
// The specs/ line said "Spec Driven Development workflow output; auto-generated
// history" until 2026-08-31. Both halves were false, and the exclusion they
// justified hid a real breakage for three and a half months. These are
// hand-authored contracts, not generated; and calling them "history" made
// skipping them sound principled when what it actually skipped was the
// 2026-05-17 restructure never being swept through them. Measured that day:
// 1,848 of 6,134 local links under specs/** did not resolve, and 1,396 of those
// pointed at files that still existed, one directory level away, under repo/.
//
// The tree stays out of this gate on the boundary — specs/ is envelope, and this
// script runs in a repo/ clone that has no `..` to read. The envelope gate owns
// it, and refuses rather than passes when it cannot see repo/. What changed is
// that the exclusion is now a division of labour with a named owner instead of a
// claim about the files that was not true.
const WS_SKIP_TOP = new Set(['repo', 'specs', '.specify', '.claude']);

/** True when `wsRoot` (`..` unless a caller says otherwise) holds the planning envelope rather than an unrelated parent. */
function envelopePresent(wsRoot = WS_ROOT) {
  return (
    existsSync(join(wsRoot, 'ARCHITECTURE.md')) &&
    existsSync(join(wsRoot, 'CLAUDE.md')) &&
    isDir(join(wsRoot, 'docs'))
  );
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectMarkdown(dir, files, skipTop = null) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipTop?.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectMarkdown(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

/**
 * Relative link targets in one markdown file, with their line numbers.
 * Fenced blocks and inline code spans are stripped first: both routinely quote
 * link syntax that is documentation of a link, not a link.
 */
function linksIn(body) {
  const found = [];
  let inFence = false;
  body.split(/\r?\n/).forEach((rawLine, index) => {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = rawLine.replace(/`[^`]*`/g, '');
    const push = (target) => {
      const clean = target.replace(/^<|>$/g, '');
      if (/^(https?:|mailto:|#|\/\/)/.test(clean)) return;
      const path = clean.split('#')[0].split('?')[0];
      if (!path) return; // anchor-only, same-file
      found.push({ path, line: index + 1 });
    };
    // Inline and image links, with an optional "title" after the target.
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) push(m[1]);
    // Reference-style definitions.
    const def = line.match(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/);
    if (def) push(def[1]);
  });
  return found;
}


// ---------------------------------------------------------------------------------------------
// Section references (FR-R3-184, feature 219)
//
// Ported from the measurement that decided this check, which feature 219 committed with its
// self-test as specs/219-prose-hops-resolve/measure/section-refs-sweep.mjs. The anchor rule is
// GitHub's. That page holds the decision, the count it rests on, and what would reopen it:
// docs/development/section-reference-check.md.
// ---------------------------------------------------------------------------------------------

// A record says what was true on its date, so the sections it names are not resolved against
// today's tree. Its *paths* are still checked above. A page is a record when it carries the
// marker on its own line near its top, the rule tests/lint/current-control-claims.test.ts reads;
// when it lies under one of the envelope's dated-record directories; or when it is the
// envelope's ARCHITECTURE.md, whose banner declares it one. The directories are the envelope's
// alone: repo/docs/features/ holds user guides, which are live.
const RECORD_MARKER = '<!-- doc-class: record -->';
const MARKER_WINDOW = 10;
const ENVELOPE_RECORD_DIRS = ['docs/features/', 'docs/audits/', 'docs/plans/'];
const ENVELOPE_DECLARED_RECORDS = new Set(['ARCHITECTURE.md']);

// linksIn's own fence test, so the citing documents are read exactly as the path check reads them.
const FENCE = /^\s*(```|~~~)/;
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/;
const PATH_LIKE_CODE = /^[\w./-]+$/;
const ANCHOR_SOURCE = String.raw`(?:\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\x60([\w./-]+)\x60)`;
const S_MARKER = new RegExp(
  ANCHOR_SOURCE +
    String.raw`[ \t]*§[ \t]*(?:"([^"]+)"|“([^”]+)”|\*{1,2}([^*]+?)\*{1,2}|_{1,2}([^_]+?)_{1,2}|([A-Za-z]?\d+(?:\.\d+)*)(?![A-Za-z0-9]))`,
  'g'
);
// A line, or a paragraph joined from shorter lines, is not parsed for section references when it is
// longer than MAX_LINE characters or holds more than MAX_OPENERS of the characters the patterns
// here start a match from: `[`, `<`, a backtick and `§`. It is counted and reported instead. In a
// target, such a line is not read either, and a setext heading over either cap is not indexed, so
// a reference to it fails. Each pattern costs about its openers times the passage's length, so the
// two caps bound what one passage can cost, and a hostile file's cost grows with its size alone.
// The longest live line is about 3,300 characters and the longest live paragraph about 5,700. The
// most openers on one line of any tracked page in either tree is 151, in a live paragraph 102, and
// in a heading 8, so nothing real goes unread.
const MAX_LINE = 10000;
const MAX_OPENERS = 256;
const OPENERS = /[[<`§]/g;

function openersIn(text) {
  return text.match(OPENERS)?.length ?? 0;
}

function withinCaps(text) {
  return text.length <= MAX_LINE && openersIn(text) <= MAX_OPENERS;
}

function linesOf(body) {
  return body.split(/\r?\n/).map((line) => (withinCaps(line) ? line : ''));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(text) {
  // CommonMark: a numeric reference has 1-7 decimal or 1-6 hex digits, and one naming zero, a
  // surrogate or a code point past U+10FFFF renders as U+FFFD.
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== '#') return Object.hasOwn(ENTITIES, entity.toLowerCase()) ? ENTITIES[entity.toLowerCase()] : whole;
    const codePoint = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    const scalar = codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
    return String.fromCodePoint(scalar ? codePoint : 0xfffd);
  });
}

/** The text GitHub renders for a heading's inline Markdown, before it is slugged. */
export function renderedText(source) {
  // Code spans and escapes are parked behind Private Use Area placeholders while the markup around
  // them is stripped; no real heading carries those code points.
  const codes = [];
  let text = source.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_whole, _ticks, body) => {
    codes.push(body);
    return `\ue000${codes.length - 1}\ue000`;
  });
  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    // An emoji shortcode becomes a symbol the slug deletes, as it deletes the emoji GitHub renders.
    .replace(/:[a-z][a-z0-9_+-]*:/g, '□')
    .replace(/\\([!-/:-@[-`{-~])/g, (_whole, char) => `\ue001${char.codePointAt(0)}\ue001`)
    .replace(/\*+/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1');
  // Entities are decoded while code spans and escapes are still parked: GitHub decodes neither, so
  // `&amp;` in backticks, or after a backslash, stays as written. A placeholder the source itself
  // happened to contain is restored as written.
  return decodeEntities(text)
    .replace(/\ue001(\d+)\ue001/g, (whole, codePoint) => (Number(codePoint) <= 0x10ffff ? String.fromCodePoint(Number(codePoint)) : whole))
    .replace(/\ue000(\d+)\ue000/g, (whole, index) => codes[Number(index)] ?? whole)
    .trim();
}

/** GitHub's heading anchor: lower-cased, then everything but letters, marks, digits, `_`, `-` and spaces removed, spaces made hyphens. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

const ATX_OPENING = /^ {0,3}#{1,6}(?=[ \t]|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

const isBlank = (char) => char === ' ' || char === '\t';

/**
 * An ATX heading's text, or null when the line is not one. It gives the answer the sweep's pattern,
 * /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/, gives, in one pass: that pattern
 * backtracks quadratically over a long run of spaces. Its `.` stops at a line terminator, so a line
 * holding one is not a heading here either.
 */
function atxText(line) {
  const opening = ATX_OPENING.exec(line);
  if (!opening) return null;
  const rest = line.slice(opening[0].length);
  if (/[\n\r\u2028\u2029]/.test(rest)) return null;
  let start = 0;
  while (start < rest.length && isBlank(rest[start])) start += 1;
  let end = rest.length;
  while (end > start && isBlank(rest[end - 1])) end -= 1;
  const text = rest.slice(start, end);
  // A closing run of `#` counts only when blanks separate it from the text before it.
  let hashes = text.length;
  while (hashes > 0 && text[hashes - 1] === '#') hashes -= 1;
  if (hashes === text.length || hashes === 0 || !isBlank(text[hashes - 1])) return text;
  let cut = hashes;
  while (cut > 0 && isBlank(text[cut - 1])) cut -= 1;
  return text.slice(0, cut);
}

function isParagraphLine(line) {
  if (!line || !line.trim()) return false;
  // A setext underline ends a paragraph: read as text, each one rescanned every line above it.
  if (atxText(line) !== null || FENCE.test(line) || SETEXT.test(line)) return false;
  if (/^\s*([-*+]|\d+[.)])\s/.test(line)) return false;
  if (/^\s*\|/.test(line) || /^\s*>/.test(line) || /^\s*</.test(line)) return false;
  return true;
}

/** Every heading in a Markdown body with its anchor, and every explicit HTML id or name. */
export function anchorsOf(body) {
  const headings = [];
  const ids = new Set();
  // github-slugger's rule: a taken slug gets the next free `-n` counted from its own slug, and every
  // anchor handed out is taken, so `Foo`, `Foo 1`, `Foo` give foo, foo-1, foo-2.
  const occurrences = new Map();
  const lines = linesOf(body);
  // CommonMark: a fence closes only on the same character, at least as long as the one that opened it.
  let fence = null;
  const add = (source) => {
    const text = renderedText(source);
    const base = slugify(text);
    if (!base && !text) return;
    let anchor = base;
    while (occurrences.has(anchor)) {
      occurrences.set(base, occurrences.get(base) + 1);
      anchor = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(anchor, 0);
    headings.push({ text, anchor });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const unquoted = raw.replace(/^(\s*>)+\s?/, '');
    const marker = unquoted.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) {
        fence = { char: marker[1][0], length: marker[1].length };
        continue;
      }
      if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
        continue;
      }
    }
    if (fence) continue;
    for (const match of raw.matchAll(/<[A-Za-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/g)) ids.add(match[1]);
    const atx = atxText(unquoted);
    if (atx !== null) {
      add(atx);
      continue;
    }
    if (SETEXT.test(raw) && isParagraphLine(lines[i - 1])) {
      let start = i - 1;
      while (start > 0 && isParagraphLine(lines[start - 1])) start -= 1;
      // Joined from lines each within the caps, a setext heading can still exceed them, and
      // rendering it would cost the square of its length.
      const text = lines.slice(start, i).map((line) => line.trim()).join(' ');
      if (withinCaps(text)) add(text);
    }
  }
  return { headings, ids };
}

function splitTarget(target) {
  const clean = target.replace(/^<|>$/g, '');
  const hashAt = clean.indexOf('#');
  const before = hashAt === -1 ? clean : clean.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : clean.slice(hashAt + 1);
  if (/^(https?:|mailto:|\/\/)/.test(clean)) return { path: before, fragment, url: true };
  return { path: before.split('?')[0], fragment };
}

function isLineAnchor(fragment) {
  return /^L\d+(C\d+)?(-L\d+(C\d+)?)?$/.test(fragment);
}

function maskNonPathCode(line) {
  return line.replace(/`([^`]*)`/g, (whole, body) => (PATH_LIKE_CODE.test(body) ? whole : ' '.repeat(whole.length)));
}

/**
 * Paragraphs outside fences, joined, with each source line's offset kept to map a match back.
 * `length` and `openers` are counted before `transformLine`, which never lengthens a line, so a
 * paragraph is judged too long or too dense to parse the same way whichever transform reads it.
 */
function paragraphsOf(body, transformLine) {
  const paragraphs = [];
  let current = null;
  let inFence = false;
  const flush = () => {
    if (current) paragraphs.push(current);
    current = null;
  };
  linesOf(body).forEach((rawLine, index) => {
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      flush();
      return;
    }
    if (inFence || !rawLine.trim()) {
      flush();
      return;
    }
    const unquoted = rawLine.replace(/^(\s*>)+\s?/, '');
    const heading = atxText(unquoted) !== null;
    if (heading || /^\s*([-*+]|\d+[.)])\s/.test(rawLine) || /^\s*\|/.test(rawLine)) flush();
    if (!current) current = { text: '', offsets: [], length: 0, openers: 0 };
    if (current.text) {
      current.text += ' ';
      current.length += 1;
    }
    current.offsets.push({ offset: current.text.length, line: index + 1 });
    current.text += transformLine(unquoted.trim());
    current.length += unquoted.trim().length;
    current.openers += openersIn(unquoted);
    if (heading) flush();
  });
  flush();
  return paragraphs;
}

function paragraphWithinCaps(paragraph) {
  return paragraph.length <= MAX_LINE && paragraph.openers <= MAX_OPENERS;
}

/** Lines, and paragraphs joined from shorter lines, too long or too dense to parse: not read, and counted. */
function unreadIn(body) {
  const overCaps = body.split(/\r?\n/).filter((line) => !withinCaps(line)).length;
  return overCaps + paragraphsOf(body, (line) => line).filter((paragraph) => !paragraphWithinCaps(paragraph)).length;
}

/** The source line a joined paragraph's offset falls on, by binary search over its line offsets. */
function lineAt(paragraph, offset) {
  const { offsets } = paragraph;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle].offset <= offset) low = middle;
    else high = middle - 1;
  }
  return offsets[low].line;
}

function spansLines(paragraph, start, end) {
  return lineAt(paragraph, start) !== lineAt(paragraph, end - 1);
}

function sMarkerOf(match, line) {
  const via = match[1] !== undefined ? 'link' : 'code';
  const target = via === 'link' ? splitTarget(match[1]).path : match[2];
  const identifier = match[7];
  let named = identifier ?? match[3] ?? match[4] ?? match[5] ?? match[6];
  let ellipsis = false;
  if (!identifier && /(…|\.\.\.)\s*$/.test(named)) {
    ellipsis = true;
    named = named.replace(/(…|\.\.\.)\s*$/, '').trim();
  }
  return { line, form: 'S', via, target, kind: identifier ? 'identifier' : 'name', named: named.trim(), ellipsis };
}

/**
 * Every section reference in one Markdown body, wrapped ones included:
 * - F, a link fragment, read with linksIn's grammar plus the links that wrap across a line;
 * - S, a § marker directly after a link or backticked path, with only whitespace between.
 * Same-file anchors, line anchors and URLs are not returned. A line or paragraph over MAX_LINE
 * characters or MAX_OPENERS openers is not read; unreadIn counts those.
 */
export function sectionReferencesIn(body) {
  const found = [];
  const pushLink = (target, line) => {
    const { path, fragment, url } = splitTarget(target);
    if (url || !path || !fragment || isLineAnchor(fragment)) return;
    found.push({ line, form: 'F', via: 'link', target: path, named: fragment });
  };
  let inFence = false;
  linesOf(body).forEach((rawLine, index) => {
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = rawLine.replace(/`[^`]*`/g, '');
    for (const match of line.matchAll(LINK)) pushLink(match[1], index + 1);
    const definition = line.match(REFERENCE_DEFINITION);
    if (definition) pushLink(definition[1], index + 1);
    for (const match of maskNonPathCode(rawLine).matchAll(S_MARKER)) found.push(sMarkerOf(match, index + 1));
  });
  // Only a paragraph of two or more lines can hold a reference that wraps; the line pass read the rest.
  const readable = (paragraph) => paragraph.offsets.length > 1 && paragraphWithinCaps(paragraph);
  for (const paragraph of paragraphsOf(body, (line) => line.replace(/`[^`]*`/g, '')).filter(readable)) {
    for (const match of paragraph.text.matchAll(LINK)) {
      if (spansLines(paragraph, match.index, match.index + match[0].length)) pushLink(match[1], lineAt(paragraph, match.index));
    }
  }
  for (const paragraph of paragraphsOf(body, maskNonPathCode).filter(readable)) {
    for (const match of paragraph.text.matchAll(S_MARKER)) {
      if (spansLines(paragraph, match.index, match.index + match[0].length)) found.push(sMarkerOf(match, lineAt(paragraph, match.index)));
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function normalizedName(text) {
  return renderedText(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function leadingIdentifier(headingText) {
  const match = headingText.replace(/^§\s*/, '').match(/^([A-Za-z]?\d+(?:\.\d+)*)(?=$|[^A-Za-z0-9.]|\.(?!\d))/);
  return match ? match[1].toLowerCase() : null;
}

/** A target's anchors and its headings' names, built once per target however often it is cited. */
function headingIndex(body) {
  const { headings, ids } = anchorsOf(body);
  return { headings, ids, names: headings.map((heading) => normalizedName(heading.text)) };
}

/** Null when a reference resolves against its target's heading index, otherwise the reason it does not. */
export function unresolvedReason(reference, index) {
  const { headings, ids, names } = index;
  if (reference.form === 'F') {
    let wanted = reference.named;
    try {
      wanted = decodeURIComponent(wanted);
    } catch {
      // a malformed escape is compared as written
    }
    if (headings.some((heading) => heading.anchor === wanted) || ids.has(wanted)) return null;
    const lower = wanted.toLowerCase();
    const caseOnly = headings.some((heading) => heading.anchor.toLowerCase() === lower) || [...ids].some((id) => id.toLowerCase() === lower);
    return caseOnly ? 'case-only' : 'no-such-anchor';
  }
  if (reference.kind === 'identifier') {
    const wanted = reference.named.toLowerCase();
    return headings.some((heading) => leadingIdentifier(heading.text) === wanted) ? null : 'no-such-identifier';
  }
  const wanted = normalizedName(reference.named);
  if (reference.ellipsis) return names.some((name) => name.startsWith(wanted)) ? null : 'no-such-heading';
  if (names.includes(wanted)) return null;
  return names.some((name) => name.startsWith(wanted)) ? 'prefix-only' : 'no-such-heading';
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` lies outside `root`: above it, or, across Windows drives, on another root. */
function isOutside(root, path) {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** True for a record, whose sections are not resolved: by its marker, its directory or its banner. */
function isRecord(file, body, repoRoot, wsRoot) {
  if (body.split('\n', MARKER_WINDOW).some((line) => line.trim() === RECORD_MARKER)) return true;
  if (!isOutside(repoRoot, file)) return false;
  const envelopeRelative = relative(wsRoot, file).split(sep).join('/');
  return ENVELOPE_RECORD_DIRS.some((dir) => envelopeRelative.startsWith(dir)) || ENVELOPE_DECLARED_RECORDS.has(envelopeRelative);
}

/**
 * Resolve every section reference in every live document under `repoRoot`, and under `wsRoot`
 * when it holds the planning envelope. Returns the number checked; the number left unverifiable
 * because their target, symlinks resolved, lies outside both trees or cannot be read; the number
 * of lines and paragraphs too long to read; and each failure.
 */
export function checkSectionReferences({ repoRoot = REPO_ROOT, wsRoot = WS_ROOT } = {}) {
  const hasEnvelope = envelopePresent(wsRoot);
  const files = collectMarkdown(repoRoot, []);
  if (hasEnvelope) collectMarkdown(wsRoot, files, WS_SKIP_TOP);
  const reportRoot = hasEnvelope ? wsRoot : repoRoot;
  // The trees being checked, symlinks resolved, each on its own: `repo/` itself may be a symlink.
  const realRoots = [realpathSync(repoRoot), ...(hasEnvelope ? [realpathSync(wsRoot)] : [])];
  const bodies = new Map();
  const read = (path) => {
    if (!bodies.has(path)) bodies.set(path, readFileSync(path, 'utf8'));
    return bodies.get(path);
  };
  const indexes = new Map();
  /**
   * A target's heading index, or null when its real path lies outside both trees or it cannot be
   * read. Only the two filesystem calls are guarded: a fault in the parser must still surface.
   */
  const indexOf = (path) => {
    if (indexes.has(path)) return indexes.get(path);
    let body = null;
    try {
      const real = realpathSync(path);
      if (realRoots.some((root) => !isOutside(root, real))) body = read(real);
    } catch {
      body = null; // gone or unreadable since it was listed: unverifiable, as an outside target is
    }
    const index = body === null ? null : headingIndex(body);
    indexes.set(path, index);
    return index;
  };
  const failures = [];
  let checked = 0;
  let unverifiable = 0;
  let unread = 0;
  for (const file of files) {
    const body = read(file);
    if (isRecord(file, body, repoRoot, wsRoot)) continue;
    unread += unreadIn(body);
    const ownRoot = isOutside(repoRoot, file) ? wsRoot : repoRoot;
    for (const reference of sectionReferencesIn(body)) {
      let target;
      if (reference.via === 'code') {
        const roots = [dirname(file), ownRoot, ...(hasEnvelope ? [ownRoot === repoRoot ? wsRoot : repoRoot] : [])];
        target = roots.map((root) => resolve(root, reference.target)).find(isFile);
        if (!target) continue; // a span that names no file is not a section reference
      } else {
        target = resolve(dirname(file), reference.target);
      }
      if (!hasEnvelope && isOutside(repoRoot, target)) {
        unverifiable += 1;
        continue;
      }
      // A missing path is the path check's to report; a target that is not Markdown has no headings.
      if (target === file || !target.endsWith('.md') || !isFile(target)) continue;
      // Read nothing outside the trees being checked, whether a path or a symlink leads there.
      const index = indexOf(target);
      if (!index) {
        unverifiable += 1;
        continue;
      }
      checked += 1;
      const reason = unresolvedReason(reference, index);
      if (reason) {
        failures.push({
          file: relative(reportRoot, file).split(sep).join('/'),
          line: reference.line,
          form: reference.form,
          target: relative(reportRoot, target).split(sep).join('/'),
          named: reference.named,
          reason
        });
      }
    }
  }
  return { hasEnvelope, checked, unverifiable, unread, failures };
}

/**
 * Text from a document with its control, format and separator characters shown as `?`: escape
 * sequences, bidirectional overrides and zero-width characters never reach the terminal.
 */
function printable(text) {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
}

function main() {
  const hasEnvelope = envelopePresent();
  const files = collectMarkdown(REPO_ROOT, []);
  if (hasEnvelope) collectMarkdown(WS_ROOT, files, WS_SKIP_TOP);
  // Report paths against whichever root is actually being checked, so a standalone
  // clone does not name an unrelated parent directory.
  const reportRoot = hasEnvelope ? WS_ROOT : REPO_ROOT;

  const broken = [];
  let unverifiable = 0;
  let checked = 0;

  for (const file of files) {
    for (const link of linksIn(readFileSync(file, 'utf8'))) {
      const target = resolve(dirname(file), link.path);
      if (!hasEnvelope && relative(REPO_ROOT, target).startsWith('..')) {
        unverifiable += 1;
        continue;
      }
      checked += 1;
      if (existsSync(target)) continue;
      // Shown printable too: an escape sequence left open here would hide the lines printed after it.
      broken.push(printable(`${relative(reportRoot, file)}:${link.line} -> ${link.path}`));
    }
  }

  const sections = checkSectionReferences();
  const scope = hasEnvelope ? 'repository + planning envelope' : 'repository only';
  if (broken.length) {
    console.error(`Broken documentation links (${broken.length}):`);
    for (const entry of broken) console.error(`  ${entry}`);
    console.error(
      `\nEither repoint the link or, when the target is gone for good, replace it\n` +
        `with inline code and record why -- a historical report is not repaired by\n` +
        `rewriting it to match today's tree.`
    );
  }
  if (sections.failures.length) {
    console.error(`Unresolved section references (${sections.failures.length}):`);
    for (const failure of sections.failures) {
      const named = failure.form === 'F' ? `#${failure.named}` : ` §${failure.named}`;
      console.error(printable(`  ${failure.file}:${failure.line} -> ${failure.target}${named} (${failure.reason})`));
    }
    console.error(
      `\nRepoint the reference at a heading its target has -- never add a heading to\n` +
        `make a stale sentence true. Records are not checked; what is, and why,\n` +
        `is in docs/development/section-reference-check.md.`
    );
  }
  if (broken.length || sections.failures.length) process.exit(1);
  const note = unverifiable > 0 ? `, ${unverifiable} outside this tree skipped` : '';
  console.log(
    `Documentation links checked: ${checked} across ${files.length} files ` +
      `(${scope}${note}).`
  );
  const sectionNotes = [
    sections.unverifiable > 0 ? `, ${sections.unverifiable} skipped as outside this tree or unreadable` : '',
    sections.unread > 0 ? `, ${sections.unread} ${sections.unread === 1 ? 'passage' : 'passages'} too long or too dense to read` : ''
  ].join('');
  console.log(`Section references checked: ${sections.checked} in live documents${sectionNotes}.`);
}

/**
 * True when Node was started on this file, by any path to it. Both sides are resolved, because
 * `import.meta.url` names the file with its symlinks resolved and `process.argv[1]` does not: a
 * direct comparison was false through any symlinked directory, macOS's `/tmp` included, and the
 * gate then exited 0 having checked nothing.
 */
function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run as a script; imported (by its gate's test), only the functions above are used.
if (invokedAsScript()) main();
