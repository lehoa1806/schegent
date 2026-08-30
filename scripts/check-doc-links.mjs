// Validates that every relative markdown link in the curated docs points at a
// path that exists. Path existence only -- `#anchor` and `#L42` fragments are
// stripped and never resolved, because line anchors move with every edit and a
// gate that fails on them would be noise rather than signal.
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
import { dirname, resolve, join, relative } from 'node:path';
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

/** True when `..` holds the planning envelope rather than an unrelated parent. */
function envelopePresent() {
  return (
    existsSync(join(WS_ROOT, 'ARCHITECTURE.md')) &&
    existsSync(join(WS_ROOT, 'CLAUDE.md')) &&
    isDir(join(WS_ROOT, 'docs'))
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

const scope = hasEnvelope ? 'repository + planning envelope' : 'repository only';
if (broken.length) {
  console.error(`Broken documentation links (${broken.length}):`);
  for (const entry of broken) console.error(`  ${entry}`);
  console.error(
    `\nEither repoint the link or, when the target is gone for good, replace it\n` +
      `with inline code and record why -- a historical report is not repaired by\n` +
      `rewriting it to match today's tree.`
  );
  process.exit(1);
}
const note = unverifiable > 0 ? `, ${unverifiable} outside this tree skipped` : '';
console.log(
  `Documentation links checked: ${checked} across ${files.length} files ` +
    `(${scope}${note}).`
);
