#!/usr/bin/env node
// Feature 249 (FR-R4-F21) — `npm run security:advisory-diff -- base | capture | compare`: which
// dependency advisories a candidate commit introduced or worsened, as against an explicit base.
//
//   base     prints the selected base commit, so the operator can capture it.
//   capture  audits one tree at one commit and writes a capture. The only step that contacts the
//            registry, through npm.
//   compare  reads the base and candidate captures of both trees and prints the report. Offline.
//
// REPORTS, NEVER ENFORCES. `compare` exits 0 whatever it finds and `capture` exits 0 whatever the
// audit did, `failed` and `rejected` captures included. The exit code is not a verdict, nothing in
// the repository reads it, and `tests/lint/advisory-diff-is-report-only.test.ts` keeps this command
// out of every chain. `npm run security:audit` is unchanged and still gives the absolute answer.
//
// ONE SHELL OVER PURE MODULES. Capture, comparison and the report are pure over injected seams
// (`advisory-capture.mjs`, `advisory-compare.mjs`, `advisory-report.mjs`); this file binds the seams
// to git, npm, the file system and the clock and decides nothing about advisories. Importing it runs
// nothing. The contract is `specs/249-dependency-advisory-baselines/contracts/cli.md` in the
// workspace.
//
// OUTPUTS. An output path the operator names is opened first, exclusively, owner-only, without
// following a link, and never under a `.schegent` directory; when it cannot be opened nothing is
// written, the stdout report included. The tool never retains, rotates or deletes an earlier output.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { captureTree } from './advisory-capture.mjs';
import { compareTrees, selectBase } from './advisory-compare.mjs';
import { applyDispositions, parseDispositionList } from './advisory-dispositions.mjs';
import { BOUNDS, TREES, TREE_NAMES, isObjectId, parseInstant } from './advisory-model.mjs';
import { buildRecord, escapeForTerminal, renderReport, serializeRecord } from './advisory-report.mjs';
import { invokedAsScript } from './invoked-as-script.mjs';

const EXIT_OK = 0;
const EXIT_OUTPUT = 1;
const EXIT_USAGE = 2;

const SHORT_COMMIT_LENGTH = 7;
const OUTPUT_MODE = 0o600;
const SCHEGENT_DIR = '.schegent';

/** What each subcommand accepts: flags taking one value, flags that may repeat, and required flags. */
const SUBCOMMANDS = Object.freeze({
  base: { single: ['--candidate', '--target'], multi: [], required: [] },
  capture: { single: ['--tree', '--commit', '--out'], multi: [], required: ['--tree', '--commit', '--out'] },
  compare: {
    single: ['--candidate', '--target', '--base', '--dispositions', '--at', '--out'],
    multi: ['--base-capture', '--candidate-capture'],
    required: []
  }
});

const USAGE =
  'usage: advisory-diff base [--candidate <rev>] [--target <branch>] | ' +
  'capture --tree <root|webview-ui> --commit <rev> --out <path> | ' +
  'compare [--candidate <rev>] [--target <branch> | --base <rev>] ' +
  '[--base-capture <tree>=<path>] [--candidate-capture <tree>=<path>] ' +
  '[--dispositions <path>] [--at <ISO-8601 UTC>] [--out <path>]';

function usageError(message) {
  return { ok: false, message };
}

/** A `<tree>=<path>` value, as `[tree, path]`, or `null` when it is not one. */
function splitTreePath(value) {
  const at = value.indexOf('=');
  if (at <= 0 || at === value.length - 1) return null;
  const tree = value.slice(0, at);
  return TREE_NAMES.includes(tree) ? [tree, value.slice(at + 1)] : null;
}

/** Collect the flags of one subcommand: unknown, repeated and valueless flags are refused. */
function collectFlags(spec, tokens) {
  const values = new Map();
  const multi = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (value === undefined) return usageError(`${flag} needs a value`);
    if (spec.single.includes(flag)) {
      if (values.has(flag)) return usageError(`${flag} was given more than once`);
      values.set(flag, value);
    } else if (spec.multi.includes(flag)) {
      multi.set(flag, [...(multi.get(flag) ?? []), value]);
    } else {
      return usageError(`${flag} is not a flag of this command`);
    }
  }
  return { ok: true, values, multi };
}

/** The `--<side>-capture` flags as a map from tree to path, refusing a repeated tree. */
function captureMap(flag, entries) {
  const paths = {};
  for (const entry of entries) {
    const parsed = splitTreePath(entry);
    if (parsed === null) return usageError(`${flag} must be <root|webview-ui>=<path>`);
    const [tree, path] = parsed;
    if (Object.hasOwn(paths, tree)) return usageError(`${flag} names ${tree} more than once`);
    paths[tree] = path;
  }
  return { ok: true, paths };
}

/** Check the values A2 constrains. Returns an error result, or `null` when all are fine. */
function checkValues(command, values) {
  for (const flag of ['--candidate', '--commit', '--target']) {
    if (values.get(flag)?.startsWith('-')) return usageError(`${flag} must not begin with a dash`);
  }
  for (const flag of ['--out', '--dispositions']) {
    if (values.get(flag) === '') return usageError(`${flag} must not be empty`);
  }
  if (command === 'capture' && !TREE_NAMES.includes(values.get('--tree'))) {
    return usageError('--tree must be root or webview-ui');
  }
  if (values.has('--at') && Number.isNaN(parseInstant(values.get('--at')))) {
    return usageError('--at must be an ISO-8601 UTC instant such as 2026-10-30T09:00:00Z');
  }
  if (values.has('--target') && values.has('--base')) {
    return usageError('--target and --base are mutually exclusive');
  }
  return null;
}

/**
 * Parse the arguments strictly (A2). An unknown flag, a repeated single-valued flag, a repeated
 * tree on one side and a missing required flag are all refused, and no flag narrows the two trees.
 */
function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const spec = Object.hasOwn(SUBCOMMANDS, command ?? '') ? SUBCOMMANDS[command] : undefined;
  if (spec === undefined) return usageError('the first argument must be base, capture or compare');
  const collected = collectFlags(spec, tokens);
  if (!collected.ok) return collected;
  const { values, multi } = collected;
  for (const flag of spec.required) if (!values.has(flag)) return usageError(`${flag} is required`);
  const invalid = checkValues(command, values);
  if (invalid !== null) return invalid;
  const sides = {};
  for (const flag of spec.multi) {
    const mapped = captureMap(flag, multi.get(flag) ?? []);
    if (!mapped.ok) return mapped;
    sides[flag] = mapped.paths;
  }
  return { ok: true, command, values, captures: sides };
}

/** `git <args>` in the working directory: the trimmed output, or `null` when git exits non-zero. */
function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: BOUNDS.lockfileBytes + 1
    }).trim();
  } catch {
    return null;
  }
}

/** The full commit a revision names, or `null`. The revision is passed after `--end-of-options`. */
function resolveCommit(revision) {
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  return isObjectId(commit) ? commit : null;
}

function blobAt(commit, path) {
  const blob = git(['rev-parse', '--verify', '--end-of-options', `${commit}:${path}`]);
  return isObjectId(blob) ? blob : null;
}

/** The content of a blob as text. Callers bound its size first with `git cat-file -s`. */
function catBlob(spec) {
  return execFileSync('git', ['cat-file', 'blob', spec], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: BOUNDS.lockfileBytes + 1
  });
}

/** The output of `npm <args>` in `dir`, or `null` when npm cannot be started or exits non-zero. */
function npmOutput(args, dir) {
  const result = spawnSync('npm', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: BOUNDS.auditTimeoutMs
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const text = result.stdout.trim();
  return text === '' ? null : text;
}

/** The nine seams capture is pure over, bound to git, npm, the file system and the clock. */
function captureSeams() {
  return {
    gitRevParse: (args) => git(['rev-parse', ...args]),
    gitCatFileSize: (spec) => {
      const size = git(['cat-file', '-s', spec]);
      return size !== null && /^\d+$/.test(size) ? Number(size) : null;
    },
    gitCatFileBlob: catBlob,
    writeFile: (dir, name, content) => writeFileSync(join(dir, name), content, { mode: OUTPUT_MODE }),
    npmVersion: (dir) => npmOutput(['--version'], dir),
    npmRegistry: (dir) => npmOutput(['config', 'get', 'registry'], dir),
    runAudit: (dir, argv) => {
      const result = spawnSync('npm', argv, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: BOUNDS.auditTimeoutMs,
        maxBuffer: BOUNDS.reportBytes + 1
      });
      const code = result.error?.code;
      return {
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        exitCode: result.status,
        timedOut: code === 'ETIMEDOUT',
        spawnError: result.error !== undefined && code !== 'ETIMEDOUT' && code !== 'ENOBUFS',
        overflow: code === 'ENOBUFS'
      };
    },
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'advisory-diff-')),
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    now: () => new Date()
  };
}

/**
 * Open an output path first, before any other work (A4): exclusive, owner-only, no link followed,
 * the parent present and not under a `.schegent` directory. Returns the descriptor and the path, or
 * the sentence that names why not.
 */
function openOutput(flagValue) {
  const target = resolve(flagValue);
  let parent;
  try {
    parent = realpathSync(dirname(target));
  } catch {
    return { ok: false, message: 'the parent directory of --out does not exist' };
  }
  if (parent.split(sep).includes(SCHEGENT_DIR)) {
    return { ok: false, message: `--out must not be under a ${SCHEGENT_DIR} directory` };
  }
  try {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
    return { ok: true, fd: openSync(target, flags, OUTPUT_MODE), path: target };
  } catch (error) {
    const exists = error?.code === 'EEXIST' || error?.code === 'ELOOP';
    return {
      ok: false,
      message: exists ? '--out already exists or is a symbolic link' : '--out could not be opened'
    };
  }
}

/** Write the whole text to the descriptor and close it. On failure the file this run created is removed. */
function writeOutput(output, text) {
  try {
    const bytes = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(output.fd, bytes, written);
    closeSync(output.fd);
    return true;
  } catch {
    try {
      closeSync(output.fd);
    } catch {
      // The descriptor is already closed; the file is removed below either way.
    }
    try {
      unlinkSync(output.path);
    } catch {
      // The file was never created or is already gone.
    }
    return false;
  }
}

function abandonOutput(output) {
  if (output === null) return;
  try {
    closeSync(output.fd);
  } catch {
    // Already closed.
  }
  try {
    unlinkSync(output.path);
  } catch {
    // Already gone.
  }
}

function say(text) {
  process.stdout.write(text);
}

function complain(message) {
  process.stderr.write(`advisory-diff: ${escapeForTerminal(message)}\n`);
}

function shortOf(commit) {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

function runBase(parsed) {
  const candidate = resolveCommit(parsed.values.get('--candidate') ?? 'HEAD');
  if (candidate === null) {
    complain('--candidate does not resolve to a commit');
    return EXIT_USAGE;
  }
  let selection;
  try {
    selection = selectBase({ candidate, target: parsed.values.get('--target') }, git);
  } catch (error) {
    complain(error instanceof Error ? error.message : '--target is not usable');
    return EXIT_USAGE;
  }
  if (selection.commit === null) {
    complain(`no base was selected (${selection.detail})`);
    return EXIT_OUTPUT;
  }
  say(`${selection.commit}\n`);
  return EXIT_OK;
}

function captureLine(capture) {
  const { outcome } = capture;
  const parts = [capture.tree, shortOf(capture.commit), outcome.status];
  if (outcome.reason !== undefined) parts.push(outcome.reason);
  if (outcome.bound !== undefined) parts.push(outcome.bound);
  if (outcome.status === 'succeeded') {
    const count = capture.findings.length;
    parts.push(`${String(count)} finding${count === 1 ? '' : 's'}`);
  }
  return `${parts.join(' ')}\n`;
}

function runCapture(parsed) {
  const commit = resolveCommit(parsed.values.get('--commit'));
  if (commit === null) {
    complain('--commit does not resolve to a commit');
    return EXIT_USAGE;
  }
  const output = openOutput(parsed.values.get('--out'));
  if (!output.ok) {
    complain(output.message);
    return EXIT_OUTPUT;
  }
  let capture;
  try {
    capture = captureTree({ tree: parsed.values.get('--tree'), commit }, captureSeams());
  } catch {
    abandonOutput(output);
    complain('the capture could not be taken');
    return EXIT_OUTPUT;
  }
  if (!writeOutput(output, `${JSON.stringify(capture, null, 2)}\n`)) {
    complain('--out could not be written');
    return EXIT_OUTPUT;
  }
  say(captureLine(capture));
  return EXIT_OK;
}

/** A named capture file, read within the bound: its text, or the fact that it was too large or unreadable. */
function readCaptureInput(path) {
  if (path === undefined) return null;
  try {
    if (statSync(path).size > BOUNDS.captureBytes) return { overBound: true };
    return { text: readFileSync(path, 'utf8') };
  } catch {
    return { unreadable: true };
  }
}

/** A tree's lockfile at a commit, parsed within the bound, or `null` when it cannot be read. */
function readLockfileAt(commit, tree) {
  if (commit === null) return null;
  const spec = `${commit}:${TREES[tree].lockfile}`;
  const size = git(['cat-file', '-s', spec]);
  if (size === null || !/^\d+$/.test(size) || Number(size) > BOUNDS.lockfileBytes) return null;
  try {
    return JSON.parse(catBlob(spec));
  } catch {
    return null;
  }
}

/**
 * The disposition list a path names, read within the bound and never written. A path that is
 * missing or cannot be read is an unusable list, not a bad invocation: the comparison goes on and
 * every verdict is unknown.
 */
function readDispositions(path) {
  if (path === undefined) return { state: 'not-supplied' };
  try {
    if (statSync(path).size > BOUNDS.dispositionBytes) return { state: 'unusable', defect: 'over-bound' };
    return parseDispositionList(readFileSync(path, 'utf8'));
  } catch {
    return { state: 'unusable', defect: 'unreadable' };
  }
}

/** What the record states about the list: nothing when none was named, else its state and defect. */
function dispositionsState(list) {
  if (list.state === 'not-supplied') return undefined;
  return list.state === 'read' ? { state: 'read' } : { state: 'unusable', defect: list.defect };
}

function runCompare(parsed) {
  const candidate = resolveCommit(parsed.values.get('--candidate') ?? 'HEAD');
  if (candidate === null) {
    complain('--candidate does not resolve to a commit');
    return EXIT_USAGE;
  }
  let selection;
  try {
    selection = selectBase(
      { candidate, target: parsed.values.get('--target'), base: parsed.values.get('--base') },
      git
    );
  } catch (error) {
    complain(error instanceof Error ? error.message : '--target is not usable');
    return EXIT_USAGE;
  }
  const outFlag = parsed.values.get('--out');
  let output = null;
  if (outFlag !== undefined) {
    const opened = openOutput(outFlag);
    if (!opened.ok) {
      complain(opened.message);
      return EXIT_OUTPUT;
    }
    output = opened;
  }
  const evaluatedAt = parsed.values.get('--at') ?? new Date().toISOString();
  const baseCaptures = parsed.captures['--base-capture'];
  const candidateCaptures = parsed.captures['--candidate-capture'];
  const captures = {};
  const lockfiles = {};
  for (const tree of TREE_NAMES) {
    captures[tree] = {
      base: readCaptureInput(baseCaptures[tree]),
      candidate: readCaptureInput(candidateCaptures[tree])
    };
    lockfiles[tree] = {
      base: readLockfileAt(selection.commit, tree),
      candidate: readLockfileAt(candidate, tree)
    };
  }
  const list = readDispositions(parsed.values.get('--dispositions'));
  let record;
  try {
    const compared = compareTrees({ candidate: { commit: candidate }, base: selection, captures, lockfiles, evaluatedAt, blobAt });
    const result = applyDispositions(compared, list, evaluatedAt);
    record = buildRecord(result, {
      candidate: { commit: candidate },
      base: selection,
      evaluatedAt,
      dispositions: dispositionsState(list)
    });
  } catch {
    abandonOutput(output);
    complain('the comparison could not be made');
    return EXIT_OUTPUT;
  }
  if (output !== null && !writeOutput(output, serializeRecord(record))) {
    complain('--out could not be written');
    return EXIT_OUTPUT;
  }
  say(renderReport(record));
  return EXIT_OK;
}

/**
 * Run the command over `argv` (the arguments after the script) and return its exit code. Never
 * throws and never exits the process: the caller owns the process.
 */
function main(argv) {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    complain(parsed.message);
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (parsed.command === 'base') return runBase(parsed);
  if (parsed.command === 'capture') return runCapture(parsed);
  return runCompare(parsed);
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
