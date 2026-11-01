/**
 * FR-R4-F10 (contract SS; research R1 to R4) -- the staged half of the secret scan: what a commit
 * would carry, read from the Git index and never from the working tree.
 *
 * WHAT THIS CLOSES. `scan-secrets.mjs` in tree mode reads the files on disk. A secret that is
 * staged and then edited out of the working copy is committed all the same, and the tree scan,
 * which reads the clean working copy, passes. Staged mode takes its scope from
 * `git diff-index --cached --raw -z --no-renames`, reads each scanned blob by id through one
 * `git cat-file --batch`, and hands the bytes to the same engine tree mode runs.
 *
 * WHY THE BLOBS ARE WRITTEN TO A DIRECTORY. The obvious alternative, scanning each blob's text in
 * memory, is not the same scan: the engine's content entry point treats every input as text, and
 * the GCP rule's `.p12` check reads `source.filePath` from disk, which would be the working tree
 * again. So each scanned blob is written, under its repository path, into a private directory
 * outside the repository, and the engine reads those files. The directory is removed on every
 * exit, signals included.
 *
 * WHAT IT NEVER DOES. It never writes the index, the working tree, a ref or the stash, never takes
 * a lock (every git child runs with `GIT_OPTIONAL_LOCKS=0`), never runs a shell, and never reads a
 * working-tree file for content. `git add`, `stash`, `update-index` and `read-tree` are not called.
 *
 * This module has no entry point: `scan-secrets.mjs` dispatches to it, prints the outcome, and owns
 * the engine. The ignore matcher is a parameter, because `isIgnored` lives in `scan-secrets.mjs`,
 * whose body would form an import cycle.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const STAGED_DIRECTORY_PREFIX = 'schegent-staged-scan-';
const CONFIG_PATH = '.secretlintrc.json';
const IGNORE_PATH = '.secretlintignore';
const GITLINK_MODE = '160000';
const REGULAR_MODE = /^100[0-7]{3}$/;
const SYMLINK_MODE = '120000';
const RAW_HEADER = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_ID = /^0+$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const GIT_TIMEOUT_MS = 120_000;
const MAX_CHILD_OUTPUT_BYTES = 512 * 1024 * 1024;
const DETAIL_LIMIT = 200;

/**
 * A named reason the staged scan cannot answer. `cause` is one of the data-model's refusal causes
 * (`unknown-argument`, `git-failed`, `unmerged-path`, `config-missing`, `config-unparseable`,
 * `ignore-missing`, `blob-unreadable`, `path-escape`, `engine-failed`, `temp-failed`), and
 * `detail` is a short sanitized sentence for the operator.
 */
export class StagedRefusal extends Error {
  /**
   * @param {string} cause the refusal cause
   * @param {string} detail what was found, without secret material or temporary paths
   */
  constructor(cause, detail) {
    super(detail);
    this.name = 'StagedRefusal';
    this.cause = cause;
    this.detail = detail;
  }
}

/** One line of a git error, bounded, with control characters removed. */
function firstLine(text) {
  const line = String(text).split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, DETAIL_LIMIT);
}

function gitEnvironment() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };
}

/**
 * Run one git child with no shell, at the repository root, taking no optional lock. Returns the
 * raw result for the caller to judge.
 */
function runGit(root, args, input) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: gitEnvironment(),
    input,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    timeout: GIT_TIMEOUT_MS,
    shell: false
  });
  if (result.error !== undefined) {
    throw new StagedRefusal('git-failed', `could not run git: ${firstLine(result.error.message)}`);
  }
  return result;
}

/** Run git and require exit 0. A failure is `git-failed`, or `failureCause` when one is given. */
function runGitChecked(root, args, input, failureCause = 'git-failed') {
  const result = runGit(root, args, input);
  if (result.status !== 0) {
    throw new StagedRefusal(failureCause, `git ${args.at(0)} failed: ${firstLine(result.stderr.toString('utf8'))}`);
  }
  return result.stdout;
}

/**
 * Parse the NUL-separated output of `git diff-index --cached --raw -z --no-renames`.
 *
 * Each entry is a header `:<oldMode> <newMode> <oldBlob> <newBlob> <status>` and then the path,
 * both NUL-terminated. A header that does not match, a missing path or output cut short is
 * refused as `git-failed`, never read as fewer entries: a rename status such as `R100` carries a
 * score and a second path, so it is refused here instead of being half-read.
 *
 * @param {Buffer} buffer the git output
 * @returns {Array<{status: string, oldMode: string, newMode: string, oldBlob: string, blob: string, path: string}>}
 */
export function parseRawDiffIndex(buffer) {
  if (buffer.length === 0) return [];
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) !== '') {
    throw new StagedRefusal('git-failed', 'the staged change list ended inside an entry');
  }
  fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = RAW_HEADER.exec(fields.at(index) ?? '');
    const path = fields.at(index + 1);
    if (match === null || path === undefined || path.length === 0) {
      throw new StagedRefusal('git-failed', 'the staged change list is not in the raw format');
    }
    entries.push({
      status: match[5],
      oldMode: match[1],
      newMode: match[2],
      oldBlob: match[3],
      blob: match[4],
      path
    });
  }
  return entries;
}

/**
 * Decide, per staged entry, whether its content is read, and count every skip with its cause.
 *
 * An unmerged entry refuses the whole scan: a commit cannot be made from an unmerged index, so
 * meeting one means the scan was started by hand mid-merge. Order of the skips: a deletion, a
 * gitlink (a submodule pointer holds no file), a path the staged ignore list names, and a path
 * whose blob is the base's blob (a mode-only change, which carries no new content). Everything
 * else is scanned at its new path, whatever the similarity to a path it was renamed or copied from.
 *
 * @param {ReadonlyArray<{status: string, oldMode: string, newMode: string, oldBlob: string, blob: string, path: string}>} entries
 * @param {ReadonlyArray<string>} ignorePatterns the staged `.secretlintignore` patterns
 * @param {(file: string, patterns: ReadonlyArray<string>) => boolean} isIgnored the scan's matcher
 * @returns {{scan: Array<object>, skipped: {ignored: number, deleted: number, gitlink: number, unchanged: number}}}
 */
export function classifyStaged(entries, ignorePatterns, isIgnored) {
  if (entries.some((entry) => entry.status === 'U')) {
    throw new StagedRefusal('unmerged-path', 'the index holds an unmerged path; resolve it before scanning');
  }
  const scan = [];
  const skipped = { ignored: 0, deleted: 0, gitlink: 0, unchanged: 0 };
  for (const entry of entries) {
    if (entry.status === 'D') {
      skipped.deleted += 1;
    } else if (!['A', 'M', 'T'].includes(entry.status)) {
      throw new StagedRefusal('git-failed', `an unexpected change status ${entry.status} for a staged path`);
    } else if (entry.newMode === GITLINK_MODE) {
      skipped.gitlink += 1;
    } else if (isIgnored(entry.path, ignorePatterns)) {
      skipped.ignored += 1;
    } else if (!REGULAR_MODE.test(entry.newMode) && entry.newMode !== SYMLINK_MODE) {
      throw new StagedRefusal('git-failed', `an unexpected file mode ${entry.newMode} for a staged path`);
    } else if (entry.status === 'M' && entry.oldBlob === entry.blob && !ZERO_ID.test(entry.blob)) {
      skipped.unchanged += 1;
    } else {
      scan.push(entry);
    }
  }
  return { scan, skipped };
}

/**
 * Parse the output of one `git cat-file --batch`: for each object asked for, in order,
 * `<id> blob <size>\n<size bytes>\n`. A `missing` reply, a reply for another object, a declared
 * size the body does not match, output cut short or left over is `blob-unreadable`.
 *
 * @param {Buffer} buffer the git output
 * @param {ReadonlyArray<string>} ids the object ids that were asked for, in order
 * @returns {Map<string, Buffer>} the blob bytes by id
 */
export function parseCatFileBatch(buffer, ids) {
  const blobs = new Map();
  let position = 0;
  for (const id of ids) {
    const headerEnd = buffer.indexOf(0x0a, position);
    if (headerEnd === -1) {
      throw new StagedRefusal('blob-unreadable', 'the blob stream ended before every object was read');
    }
    const header = buffer.subarray(position, headerEnd).toString('utf8');
    if (header === `${id} missing`) {
      throw new StagedRefusal('blob-unreadable', 'git reported a staged object as missing');
    }
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (match === null || match[1] !== id) {
      throw new StagedRefusal('blob-unreadable', 'the blob stream answered for a different object');
    }
    const size = Number(match[2]);
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || bodyEnd + 1 > buffer.length) {
      throw new StagedRefusal('blob-unreadable', 'a staged object was cut short');
    }
    if (buffer.at(bodyEnd) !== 0x0a) {
      throw new StagedRefusal('blob-unreadable', 'a staged object did not match its declared size');
    }
    blobs.set(id, Buffer.from(buffer.subarray(bodyStart, bodyEnd)));
    position = bodyEnd + 1;
  }
  if (position !== buffer.length) {
    throw new StagedRefusal('blob-unreadable', 'the blob stream held more than was asked for');
  }
  return blobs;
}

/**
 * Write each file under `dir` at its repository-relative path, files mode 0600 and any parent
 * directory 0700. A path that is absolute, empty, or resolves outside `dir` is `path-escape`, and
 * nothing at that path is written. So is a path that lands on a file or directory already written
 * (two names that differ only by case, in a case-insensitive directory).
 *
 * @param {string} dir an existing private directory
 * @param {ReadonlyArray<{path: string, content: Uint8Array}>} files the files to write
 * @returns {string[]} the absolute paths written, in input order
 */
export function materialize(dir, files) {
  const root = resolve(dir);
  const written = [];
  for (const file of files) {
    const target = resolve(root, file.path);
    const escapes =
      file.path.length === 0 || file.path.includes('\0') || isAbsolute(file.path) || !target.startsWith(root + sep);
    if (escapes) {
      throw new StagedRefusal('path-escape', 'a staged path resolves outside the scan directory');
    }
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // `wx`: a file already written is never replaced. A case-insensitive directory folds
      // `Foo.txt` and `foo.txt` into one file, and replacing the first would scan the second twice.
      writeFileSync(target, file.content, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTDIR') throw error;
      throw new StagedRefusal('path-escape', 'two staged paths name one file in the scan directory');
    }
    written.push(target);
  }
  return written;
}

/** The base the commit is measured against: `HEAD`, or the empty tree before the first commit. */
function resolveBase(root) {
  const head = runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.status === 0) return { name: 'HEAD', ref: 'HEAD' };
  if (head.status !== 1) {
    throw new StagedRefusal('git-failed', `could not resolve HEAD: ${firstLine(head.stderr.toString('utf8'))}`);
  }
  // `hash-object` without `-w` writes nothing, and names the empty tree for either hash algorithm.
  const emptyTree = runGitChecked(root, ['hash-object', '-t', 'tree', '--stdin'], '').toString('utf8').trim();
  if (!OBJECT_ID.test(emptyTree)) {
    throw new StagedRefusal('git-failed', 'git did not name the empty tree');
  }
  return { name: 'empty-tree', ref: emptyTree };
}

/** The stage-0 blob ids of the two configuration files, by path. */
function stageZeroIds(root) {
  const listing = runGitChecked(root, ['ls-files', '-s', '-z', '--', CONFIG_PATH, IGNORE_PATH]).toString('utf8');
  const ids = new Map();
  for (const record of listing.split('\0').filter(Boolean)) {
    const match = /^[0-7]{6} ([0-9a-f]+) 0\t(.+)$/s.exec(record);
    if (match !== null) ids.set(match[2], match[1]);
  }
  return ids;
}

/** One `git cat-file --batch` over `ids`, parsed. An empty list reads nothing. */
function readBlobs(root, ids) {
  if (ids.length === 0) return new Map();
  const output = runGitChecked(root, ['cat-file', '--batch'], `${ids.join('\n')}\n`, 'blob-unreadable');
  return parseCatFileBatch(output, ids);
}

/** Parse the staged configuration. Anything but a JSON object holding a `rules` array is refused. */
function parseConfig(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new StagedRefusal('config-unparseable', `the staged ${CONFIG_PATH} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
    throw new StagedRefusal('config-unparseable', `the staged ${CONFIG_PATH} has no rules list`);
  }
  return parsed;
}

/** The ignore list's patterns: non-empty lines that are not comments, as tree mode reads them. */
function parseIgnorePatterns(bytes) {
  return bytes
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Gather everything the staged scan needs from the index: the base, the staged configuration and
 * ignore list, the classified scope, and the scanned blobs. Reads git only; writes nothing.
 *
 * @param {string} root the repository root
 * @param {(file: string, patterns: ReadonlyArray<string>) => boolean} isIgnored the scan's matcher
 * @returns {{base: 'HEAD' | 'empty-tree', config: object, ignorePatterns: string[], scan: Array<object>, skipped: object, blobs: Map<string, Buffer>}}
 * @throws {StagedRefusal} when the scan cannot be answered
 */
export function collectStagedSubject(root, isIgnored) {
  const base = resolveBase(root);
  const entries = parseRawDiffIndex(
    runGitChecked(root, ['diff-index', '--cached', '--raw', '-z', '--no-renames', base.ref])
  );
  const configIds = stageZeroIds(root);
  const configId = configIds.get(CONFIG_PATH);
  const ignoreId = configIds.get(IGNORE_PATH);
  if (configId === undefined) {
    throw new StagedRefusal('config-missing', `${CONFIG_PATH} is not in the index`);
  }
  if (ignoreId === undefined) {
    throw new StagedRefusal('ignore-missing', `${IGNORE_PATH} is not in the index`);
  }
  const configBlobs = readBlobs(root, [...new Set([configId, ignoreId])]);
  const config = parseConfig(configBlobs.get(configId) ?? Buffer.alloc(0));
  const ignorePatterns = parseIgnorePatterns(configBlobs.get(ignoreId) ?? Buffer.alloc(0));
  const { scan, skipped } = classifyStaged(entries, ignorePatterns, isIgnored);
  const blobs = readBlobs(root, [...new Set(scan.map((entry) => entry.blob))]);
  return { base: base.name, config, ignorePatterns, scan, skipped, blobs };
}

/** Remove the scan directory, but only when it is the directory this process created. */
function removeOwnDirectory(dir, tmpRoot) {
  if (dir === undefined) return;
  try {
    const ours =
      dirname(dir) === tmpRoot && basename(dir).startsWith(STAGED_DIRECTORY_PREFIX) && lstatSync(dir).isDirectory();
    if (ours) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Already gone, or not ours to remove: neither is a reason to mask the scan's own outcome.
  }
}

/**
 * Write the subject's scanned blobs into a private `0700` directory, run `run(dir, paths)` over
 * them, and remove the directory on every exit: normal return, a throw, and `SIGINT`, `SIGTERM`
 * and `SIGHUP`, which remove it and exit 1. The signal handlers are registered before the
 * directory is created, so no signal can arrive between the two.
 *
 * @template T
 * @param {{scan: Array<{path: string, blob: string}>, blobs: Map<string, Buffer>}} subject the collected subject
 * @param {(dir: string, paths: string[]) => Promise<T>} run receives the directory and the absolute paths written
 * @returns {Promise<T>} what `run` returned
 */
export async function withStagedFiles(subject, run) {
  let tmpRoot;
  let dir;
  const onSignal = () => {
    removeOwnDirectory(dir, tmpRoot);
    process.exit(1);
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  try {
    try {
      tmpRoot = realpathSync(tmpdir());
      dir = mkdtempSync(join(tmpRoot, STAGED_DIRECTORY_PREFIX));
    } catch (error) {
      throw new StagedRefusal('temp-failed', `could not create the scan directory: ${firstLine(error.message)}`);
    }
    const files = subject.scan.map((entry) => ({
      path: entry.path,
      content: subject.blobs.get(entry.blob) ?? Buffer.alloc(0)
    }));
    const paths = materialize(dir, files);
    return await run(dir, paths);
  } finally {
    removeOwnDirectory(dir, tmpRoot);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }
}
