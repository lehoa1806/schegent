#!/usr/bin/env node
// FR-R4-F06 (FR-029, FR-033; contract Q, Q3; research R39) -- the offline help capture.
//
// WHAT IT DOES. For each backend named on the command line, finds its CLI on PATH and runs
// `--version` and `--help`, then prints: the normalized version, whether each command exited 0, and,
// for every capability flag the planner's SURFACES table names for that backend, whether `--help`
// lists it, with the one help line that does, every absolute path replaced by `<path>`. Its output is
// pasted into sections 7 and 8 of docs/architecture/backend-containment-qualification.md, and
// src/services/capability-confirmed-flags.ts is transcribed from it in the same commit.
//
// WHY IT IS ISOLATED. `--help` and `--version` need no account and no model call, but a CLI started
// with the operator's own home can read their configuration, and a record built from that would
// describe the operator's setup rather than the CLI. Each command therefore runs under the minimal
// policy's shape -- an overlay and nothing ambient: exactly PATH plus HOME, XDG_CONFIG_HOME,
// CLAUDE_CONFIG_DIR and CODEX_HOME, pointed into a fresh mkdtemp home with empty config directories --
// with `shell: false` and a 10-second bound. The builder the product uses is TypeScript, which a .mjs
// cannot import, so the shape is written out here.
//
// WHAT IT NEVER DOES. Write outside its temporary home, which it removes in `finally`. Make a model
// call. Print an absolute path, an environment name or an environment value. Run in any tier: it is
// run by hand at implement, and its test (tests/unit/scripts/capture-backend-help.test.ts) runs it
// against a stub.
import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const COMMAND_BOUND_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const HELP_LINE_MAX_CHARS = 200;
const USAGE = 'usage: node scripts/capture-backend-help.mjs <claude|codex|agy>...';

// The capability flags of SURFACES[kind] in src/services/capability-enforcement-plan.ts, by flag name:
// the flag an unrestricted run is spawned with, and every flag a withheld capability maps to. A flag
// added to the planner must be added here, or the record cannot qualify it.
const SURFACE_FLAGS = {
  claude: ['--dangerously-skip-permissions', '--disallowedTools', '--permission-mode'],
  codex: ['--sandbox'],
  agy: ['--dangerously-skip-permissions', '--sandbox']
};

// src/runner/cli-version-probe.ts: CLI_VERSION_MAX_LEN.
const CLI_VERSION_MAX_LEN = 64;

/** The same rule as `normalizeCliVersion` in src/runner/cli-version-probe.ts, re-implemented. */
function normalizeCliVersion(line) {
  const first = (line.split('\n')[0] ?? '').trim();
  if (first.length === 0) return null;
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(first);
  return (match?.[1] ?? first).slice(0, CLI_VERSION_MAX_LEN);
}

/** Replace every absolute path, and the temporary home first, with `<path>`. */
function redactPaths(text, home) {
  return text
    .split(home)
    .join('<path>')
    .replace(/(?<![\w.<>-])\/[\w.@+~%-]+(?:\/[\w.@+~%-]+)*/g, '<path>')
    .replace(/(?<![\w.])~\/[\w.@+~%/-]*/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s"'`]*/g, '<path>');
}

/** The first executable named `name` on PATH, or null. */
async function findOnPath(name) {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Run one command; resolve with its exit code (null when it did not exit) and its stdout. */
function runCommand(executable, args, env, cwd) {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { env, cwd, shell: false, timeout: COMMAND_BOUND_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, text: `${stdout}\n${stderr}` });
      }
    );
  });
}

/** The help line that lists `flag`, or null. Matches the flag as a whole token. */
function helpLineFor(help, flag) {
  const token = new RegExp(`(^|[\\s,|\\[(])${flag.replace(/[-]/g, '\\-')}([\\s=,<\\[|)\\]]|$)`);
  return help.split('\n').find((line) => token.test(line)) ?? null;
}

async function capture(backend, home) {
  const lines = [`backend: ${backend}`];
  const executable = await findOnPath(backend);
  if (executable === null) {
    lines.push('  executable: not installed');
    return lines;
  }
  lines.push('  executable: found');

  const configDirs = {
    XDG_CONFIG_HOME: join(home, 'xdg'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CODEX_HOME: join(home, 'codex')
  };
  for (const dir of Object.values(configDirs)) await mkdir(dir, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', HOME: home, ...configDirs };

  const version = await runCommand(executable, ['--version'], env, home);
  const help = await runCommand(executable, ['--help'], env, home);
  lines.push(`  version: ${normalizeCliVersion(version.text.trim()) ?? 'unknown'}`);
  lines.push(`  --version exit: ${version.code === null ? 'did not exit' : version.code}`);
  lines.push(`  --help exit: ${help.code === null ? 'did not exit' : help.code}`);
  lines.push('  flags:');
  for (const flag of SURFACE_FLAGS[backend]) {
    const line = helpLineFor(help.text, flag);
    lines.push(`    ${flag}: ${line === null ? 'not listed' : 'listed'}`);
    if (line !== null) {
      const shown = redactPaths(line.trim().replace(/\s+/g, ' '), home).slice(0, HELP_LINE_MAX_CHARS);
      lines.push(`      help line: ${shown}`);
    }
  }
  return lines;
}

async function main() {
  const backends = process.argv.slice(2);
  if (backends.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const unknown = backends.filter((name) => !Object.hasOwn(SURFACE_FLAGS, name));
  if (unknown.length > 0) {
    process.stderr.write(`unknown backend; ${USAGE}\n`);
    return 2;
  }
  const home = await mkdtemp(join(tmpdir(), 'schegent-help-capture-'));
  try {
    for (const backend of backends) {
      process.stdout.write(`${(await capture(backend, home)).join('\n')}\n`);
    }
    return 0;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

process.exitCode = await main();
