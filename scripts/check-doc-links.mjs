// Validates that every relative markdown link in the curated docs points at a
// path that exists, and that every section a live document names in another
// file exists too.
//
// Paths. A `#L42` line anchor is stripped and never resolved: it moves with every
// edit, so a gate that failed on one would be noise rather than signal.
//
// Sections (FR-R3-184, built 2026-10-20 on a measured count): a `#heading`
// fragment naming another Markdown file, or a `§` marker directly after a link
// or backticked path, must name a heading the target has. Dated records are not
// read. Same-file anchors and sections named in free prose are not checked. The
// decision, the count it rests on and what would retire it are in
// docs/development/section-reference-check.md.
//
// Why this exists: `docs:check` was a version-and-required-string gate, so a doc
// link could rot through `verify:all` unobserved. Eleven had, by 2026-08-18.
//
// Scope. The execution repository is scanned always. The planning envelope one
// level up is scanned only when it is actually there, so a standalone `repo/`
// clone still passes -- and in that case a link escaping the repo root is
// reported as unverifiable rather than broken, since the file it names is
// genuinely outside the tree being checked.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// GitHub's. That page holds the decision, the count it rests on, and what would retire it:
// docs/development/section-reference-check.md.
// ---------------------------------------------------------------------------------------------

// Dated records, by kind, relative to each tree's root: the prefixes
// tests/lint/basename-line-references.test.ts uses. To them are added the three pages whose
// banners declare them records. A record says what was true on its date, so the sections it
// names are not resolved against today's tree. Its *paths* are still checked above.
const RECORD_PREFIXES = ['specs/', 'docs/features/', 'docs/audits/', 'docs/plans/'];
const DECLARED_RECORDS = {
  envelope: new Set(['ARCHITECTURE.md']),
  repo: new Set(['docs/operations/merge-gate-observation.md', 'docs/operations/release-provenance-observation.md'])
};

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
// A line longer than this is not parsed for section references; some patterns are quadratic in
// line length, and the longest real line in either tree is about 3,400 characters.
const MAX_LINE = 20000;

function linesOf(body) {
  return body.split(/\r?\n/).map((line) => (line.length <= MAX_LINE ? line : ''));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== '#') return Object.hasOwn(ENTITIES, entity.toLowerCase()) ? ENTITIES[entity.toLowerCase()] : whole;
    const codePoint = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
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
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')
    .replace(/\ue001(\d+)\ue001/g, (_whole, codePoint) => String.fromCodePoint(Number(codePoint)))
    .replace(/\ue000(\d+)\ue000/g, (_whole, index) => codes[Number(index)]);
  return decodeEntities(text).trim();
}

/** GitHub's heading anchor: lower-cased, then everything but letters, marks, digits, `_`, `-` and spaces removed, spaces made hyphens. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

function isParagraphLine(line) {
  if (!line || !line.trim()) return false;
  if (ATX.test(line) || FENCE.test(line)) return false;
  if (/^\s*([-*+]|\d+[.)])\s/.test(line)) return false;
  if (/^\s*\|/.test(line) || /^\s*>/.test(line) || /^\s*</.test(line)) return false;
  return true;
}

/** Every heading in a Markdown body with its anchor, and every explicit HTML id or name. */
export function anchorsOf(body) {
  const headings = [];
  const ids = new Set();
  const seen = new Map();
  const lines = linesOf(body);
  // CommonMark: a fence closes only on the same character, at least as long as the one that opened it.
  let fence = null;
  const add = (source) => {
    const text = renderedText(source);
    const base = slugify(text);
    if (!base && !text) return;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ text, anchor: count === 0 ? base : `${base}-${count}` });
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
    const atx = unquoted.match(ATX);
    if (atx) {
      add(atx[2] ?? '');
      continue;
    }
    if (SETEXT.test(raw) && isParagraphLine(lines[i - 1])) {
      let start = i - 1;
      while (start > 0 && isParagraphLine(lines[start - 1])) start -= 1;
      add(lines.slice(start, i).map((line) => line.trim()).join(' '));
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

/** Paragraphs outside fences, joined, with each source line's offset kept to map a match back. */
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
    if (ATX.test(unquoted) || /^\s*([-*+]|\d+[.)])\s/.test(rawLine) || /^\s*\|/.test(rawLine)) flush();
    if (!current) current = { text: '', offsets: [] };
    if (current.text) current.text += ' ';
    current.offsets.push({ offset: current.text.length, line: index + 1 });
    current.text += transformLine(unquoted.trim());
    if (ATX.test(unquoted)) flush();
  });
  flush();
  return paragraphs;
}

function lineAt(paragraph, offset) {
  let line = paragraph.offsets[0].line;
  for (const entry of paragraph.offsets) {
    if (entry.offset <= offset) line = entry.line;
    else break;
  }
  return line;
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
 * Same-file anchors, line anchors and URLs are not returned.
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
  for (const paragraph of paragraphsOf(body, (line) => line.replace(/`[^`]*`/g, ''))) {
    for (const match of paragraph.text.matchAll(LINK)) {
      if (spansLines(paragraph, match.index, match.index + match[0].length)) pushLink(match[1], lineAt(paragraph, match.index));
    }
  }
  for (const paragraph of paragraphsOf(body, maskNonPathCode)) {
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

/** Null when a reference resolves against its target's body, otherwise the reason it does not. */
export function unresolvedReason(reference, targetBody) {
  const { headings, ids } = anchorsOf(targetBody);
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
  const texts = headings.map((heading) => normalizedName(heading.text));
  if (reference.ellipsis) return texts.some((text) => text.startsWith(wanted)) ? null : 'no-such-heading';
  if (texts.includes(wanted)) return null;
  return texts.some((text) => text.startsWith(wanted)) ? 'prefix-only' : 'no-such-heading';
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True for a dated record or a banner-declared record, whose sections are not resolved. */
function isRecord(file, repoRoot, wsRoot) {
  const inRepo = !relative(repoRoot, file).startsWith('..');
  const treeRelative = relative(inRepo ? repoRoot : wsRoot, file).split(sep).join('/');
  if (RECORD_PREFIXES.some((prefix) => treeRelative.startsWith(prefix))) return true;
  return (inRepo ? DECLARED_RECORDS.repo : DECLARED_RECORDS.envelope).has(treeRelative);
}

/**
 * Resolve every section reference in every live document under `repoRoot`, and under `wsRoot`
 * when it holds the planning envelope. Returns the number checked, the number left unverifiable
 * because their target is outside a standalone `repo/` clone, and each failure.
 */
export function checkSectionReferences({ repoRoot = REPO_ROOT, wsRoot = WS_ROOT } = {}) {
  const hasEnvelope = envelopePresent(wsRoot);
  const files = collectMarkdown(repoRoot, []);
  if (hasEnvelope) collectMarkdown(wsRoot, files, WS_SKIP_TOP);
  const reportRoot = hasEnvelope ? wsRoot : repoRoot;
  const bodies = new Map();
  const read = (path) => {
    if (!bodies.has(path)) bodies.set(path, readFileSync(path, 'utf8'));
    return bodies.get(path);
  };
  const failures = [];
  let checked = 0;
  let unverifiable = 0;
  for (const file of files) {
    if (isRecord(file, repoRoot, wsRoot)) continue;
    const ownRoot = relative(repoRoot, file).startsWith('..') ? wsRoot : repoRoot;
    for (const reference of sectionReferencesIn(read(file))) {
      let target;
      if (reference.via === 'code') {
        const roots = [dirname(file), ownRoot, ...(hasEnvelope ? [ownRoot === repoRoot ? wsRoot : repoRoot] : [])];
        target = roots.map((root) => resolve(root, reference.target)).find(isFile);
        if (!target) continue; // a span that names no file is not a section reference
      } else {
        target = resolve(dirname(file), reference.target);
      }
      if (!hasEnvelope && relative(repoRoot, target).startsWith('..')) {
        unverifiable += 1;
        continue;
      }
      // A missing path is the path check's to report; a target that is not Markdown has no headings.
      if (target === file || !target.endsWith('.md') || !isFile(target)) continue;
      checked += 1;
      const reason = unresolvedReason(reference, read(target));
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
  return { hasEnvelope, checked, unverifiable, failures };
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
      broken.push(`${relative(reportRoot, file)}:${link.line} -> ${link.path}`);
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
      console.error(`  ${failure.file}:${failure.line} -> ${failure.target}${named} (${failure.reason})`);
    }
    console.error(
      `\nRepoint the reference at a heading its target has -- never add a heading to\n` +
        `make a stale sentence true. Dated records are not checked; what is, and why,\n` +
        `is in docs/development/section-reference-check.md.`
    );
  }
  if (broken.length || sections.failures.length) process.exit(1);
  const note = unverifiable > 0 ? `, ${unverifiable} outside this tree skipped` : '';
  console.log(
    `Documentation links checked: ${checked} across ${files.length} files ` +
      `(${scope}${note}).`
  );
  const sectionNote = sections.unverifiable > 0 ? `, ${sections.unverifiable} outside this tree skipped` : '';
  console.log(`Section references checked: ${sections.checked} in live documents${sectionNote}.`);
}

// Run as a script; imported (by its gate's test), only the functions above are used.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
