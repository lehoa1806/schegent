#!/usr/bin/env node
// FR-R4-F09 (contracts RP1, RP2, RP4) -- the command line of release preparation.
//
// The mechanism lives in `release-candidate.mjs`; this file is the shell that parses the
// arguments, binds each effect to the real world and owns the process exit code, which is the
// split `gate-recorder.mjs` and `record-gate-run.mjs` make for the same reason: the pure module
// can be driven through every refusal without a build, and this file stays too thin to hide one.
//
//   npm run release -- --advisory-capture root=<path> --advisory-capture webview-ui=<path>
//
// Exit codes: 0 accepted, with a record written; 1 refused, with a named reason on stderr and no
// record; 2 a usage error, with nothing touched. Every outcome ends with the line that says
// nothing was tagged, published or uploaded, because no step here could do any of them: this file
// spawns `npm run <script>` and `vsce package`, and nothing else.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { TREE_NAMES } from './advisory-model.mjs';
import { escapeForTerminal } from './advisory-report.mjs';
import { GATE_COMMAND_SPEC, REPO_ROOT, readTreeState } from './gate-attestation.mjs';
import { invokedAsScript } from './invoked-as-script.mjs';
import { NOTHING_PUBLISHED, releaseCandidate, resolveInsideRoot } from './release-candidate.mjs';

const CAPTURE_FLAG = '--advisory-capture';
const USAGE = `usage: npm run release -- ${CAPTURE_FLAG} root=<path> ${CAPTURE_FLAG} webview-ui=<path>`;

/**
 * Parse the arguments: `--advisory-capture <tree>=<path>`, exactly once for each tree. Anything
 * else is a usage error, so a typo cannot silently drop the evidence a release needs.
 *
 * @param {readonly string[]} argv
 * @returns {{ ok: true, advisoryCaptures: Record<string, string> } | { ok: false, message: string }}
 */
export function parseArguments(argv) {
  const advisoryCaptures = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (argv[at] !== CAPTURE_FLAG) {
      return { ok: false, message: `unexpected argument ${JSON.stringify(argv[at])}` };
    }
    const value = argv[at + 1];
    const split = value === undefined ? -1 : value.indexOf('=');
    if (value === undefined || split <= 0 || split === value.length - 1) {
      return { ok: false, message: `${CAPTURE_FLAG} needs <tree>=<path>, not ${JSON.stringify(value)}` };
    }
    const tree = value.slice(0, split);
    if (!TREE_NAMES.includes(tree)) {
      return { ok: false, message: `${JSON.stringify(tree)} is not a tree (${TREE_NAMES.join(', ')})` };
    }
    if (Object.hasOwn(advisoryCaptures, tree)) {
      return { ok: false, message: `${CAPTURE_FLAG} was given twice for the ${tree} tree` };
    }
    advisoryCaptures[tree] = value.slice(split + 1);
  }
  const absent = TREE_NAMES.filter((tree) => !Object.hasOwn(advisoryCaptures, tree));
  if (absent.length > 0) {
    return { ok: false, message: `${CAPTURE_FLAG} is required for the ${absent.join(' and ')} tree` };
  }
  return { ok: true, advisoryCaptures };
}

/**
 * Create `path` and write `text`, failing when the path exists, with `mode` as its permissions.
 * A write that fails after the file was created removes that file again, so a half-written record
 * is never left beside a candidate; a file that already existed is never touched.
 *
 * @param {string} path Absolute.
 * @param {string} text
 * @param {number} mode
 */
export function writeExclusiveFile(path, text, mode) {
  const handle = openSync(path, 'wx', mode);
  try {
    writeSync(handle, text, 0, 'utf8');
    fsyncSync(handle);
  } catch (cause) {
    closeSync(handle);
    try {
      unlinkSync(path);
    } catch {
      // The write failed first and that is the error worth reporting.
    }
    throw cause;
  }
  closeSync(handle);
}

/** The status of a finished child, or 1 when it never ran or died on a signal. */
const statusOf = (result) => (result.error || result.status === null ? 1 : result.status);

/**
 * Bind every seam of the driver to the real world.
 *
 * `shell: false` everywhere: the argument vectors are fixed here, and a release path is the last
 * place to hand a shell a string to re-split. The `npm` executable is resolved by the gate's own
 * rule (`npm.cmd` on Windows), so there is one answer to that question.
 *
 * @param {Record<string, string>} advisoryCaptures Absolute capture paths, one per tree.
 */
export function makeRealDeps(advisoryCaptures) {
  const root = REPO_ROOT;
  const absolute = (path) => (isAbsolute(path) ? path : resolve(root, path));
  const npm = GATE_COMMAND_SPEC.executableFor(process.platform);
  const vscePath = createRequire(import.meta.url).resolve('@vscode/vsce/vsce');
  return {
    repoRoot: root,
    advisoryCaptures,
    readTreeState,
    gitBlob: (spec) =>
      execFileSync('git', ['rev-parse', spec], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim(),
    readFile: (path) => readFileSync(absolute(path)),
    // The one removal in this file. `resolveInsideRoot` re-checks what the driver already checked,
    // and `rmSync` on a symbolic link removes the link, not what it points to.
    removePath: (path) => rmSync(resolveInsideRoot(root, path), { recursive: true, force: true }),
    ensureDirectory: (path, mode) => {
      mkdirSync(resolveInsideRoot(root, path), { recursive: true, mode });
    },
    runScript: (name) => statusOf(spawnSync(npm, ['run', name], { cwd: root, stdio: 'inherit', shell: false })),
    runVsce: (outPath) =>
      statusOf(
        spawnSync(
          process.execPath,
          [vscePath, 'package', '--no-dependencies', '--out', resolveInsideRoot(root, outPath)],
          { cwd: root, stdio: 'inherit', shell: false }
        )
      ),
    rename: (from, to) => renameSync(resolveInsideRoot(root, from), resolveInsideRoot(root, to)),
    writeExclusive: (path, text, mode) => writeExclusiveFile(resolveInsideRoot(root, path), text, mode),
    now: () => Date.now(),
    log: (line) => console.log(line),
    error: (line) => console.error(line)
  };
}

/**
 * Run the command: parse, and only if the arguments are usable, bind the seams and prepare.
 * Returns the exit code and never calls `process.exit`, so a test can drive it.
 *
 * @param {readonly string[]} argv
 * @param {{ makeDeps: (captures: Record<string, string>) => object,
 *   releaseCandidate: (deps: object) => { exitCode: number },
 *   log: (line: string) => void, error: (line: string) => void }} io
 */
export function runCli(argv, io) {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    for (const line of [`prepare-release: ${parsed.message}`, `  ${USAGE}`, NOTHING_PUBLISHED]) {
      io.error(escapeForTerminal(line));
    }
    return 2;
  }
  // Relative paths mean relative to where the operator typed them.
  const captures = Object.fromEntries(
    Object.entries(parsed.advisoryCaptures).map(([tree, path]) => [tree, resolve(process.cwd(), path)])
  );
  return io.releaseCandidate(io.makeDeps(captures)).exitCode;
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2), {
    makeDeps: makeRealDeps,
    releaseCandidate,
    log: (line) => console.log(line),
    error: (line) => console.error(line)
  });
}
