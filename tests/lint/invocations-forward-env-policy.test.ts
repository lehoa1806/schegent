import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';
import {
  ENV_POLICY_CALL_SITES,
  INVOKE_CALL_SITE_COUNT,
  PARITY_CALL_SITE_COUNT
} from '../fixtures/env-policy-call-sites';

/**
 * FR-R3-049 (M-11) — every production invocation forwards the environment policy.
 *
 * WHY A GUARD AS WELL AS A REQUIRED FIELD
 *
 * Making the policy required on an internal invoker's options catches a new
 * INVOKER that forgets it -- at compile time. It does not catch a new `.invoke`
 * call added inside an existing invoker, which would still compile and would
 * reproduce the original defect exactly: the watchdog's poll forwarded none of the
 * three policy fields, all three are optional on the request, so it compiled, read
 * like its two siblings, and sent the complete ambient environment to a spawn
 * nobody triggered.
 *
 * WHY THE CHECK IS PER CALL SITE, NOT PER FILE
 *
 * The first version of this gate asked whether the FILE mentioned the helper
 * anywhere. That passes on the one case the gate exists for: adding a second,
 * policy-less `.invoke` to `credit-watchdog.ts` leaves the file still mentioning
 * the helper on the line above, so the gate stayed green while the defect was back
 * in the tree (measured). So each call site's own arguments are read.
 *
 * WHY A SOURCE SCAN AND NOT A REGISTRY
 *
 * A runtime registry is exact, but it needs every invoker to enrol -- and a
 * forgotten enrolment is the *same defect class* as a forgotten policy. It would
 * reproduce this finding one level up. A scan catches a new call site with nobody
 * remembering anything; its weakness is matching a comment or a test file, which
 * masking comments and scoping to `src/` closes.
 */

/**
 * The root of the seeded fixtures' paths. Built, not written as a `src/...` literal, because
 * `lint-anchor-grounding.test.ts` reads a literal that starts that way as a claim about a file that exists,
 * and a seeded fixture's path is by construction not one.
 */
const SEEDED_SRC = 'src';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

/** The single helper every call site must route its policy through. */
const POLICY_HELPER = 'policyRequestFields';

const INVOKE_MARKER = '.invoke(';

/**
 * The name the seeded cases below report under.
 *
 * A real path on purpose: `lint-anchor-grounding.test.ts` fails a gate that names
 * a `src/` path which does not exist, on the grounds that an entry for a deleted
 * file pre-excuses whatever is written there next. A made-up fixture name is the
 * same hazard with no upside.
 */
const SEEDED_FILE = 'src/watchdog/credit-watchdog.ts';

/**
 * A delegating call: it hands on a whole `request` somebody else built rather
 * than originating a spawn of its own.
 *
 * The backend adapters (`src/runner/agy-cli.ts`, `src/runner/codex-cli.ts`) pass
 * `{ request, args, env: buildSpawnEnv(request), … }` down to the shared process
 * lifecycle, so the policy already travelled with the request they received.
 *
 * This is deliberately a *role* test rather than the directory skip the first
 * version used. That skip excluded all of `src/runner` on the stated grounds that
 * "the runner package defines `invoke`, it does not call one" -- which is not true
 * of those two adapters, and which meant a genuine new internal invoker placed
 * anywhere under `src/runner` would have escaped the gate entirely.
 *
 * A SPREAD IS NOT DELEGATION
 *
 * The first version of this pattern also exempted `...request`. That reopened the
 * exact hole the gate exists for: an invoker that builds its own request literal,
 * hoists it into a `const request`, and calls `.invoke({ ...request, … })` forwards
 * no policy and was reported as delegating (measured -- zero offenders). Only a
 * request handed IN is delegation, and the two adapters that do it pass it as the
 * shorthand property `request,`. A spread of a locally built object originates the
 * spawn, so it must forward a policy like any other originating site.
 */
const DELEGATES_A_REQUEST = /(^|[\s,{])request\s*[,}]/;

/** Characters after which a `/` opens a regular expression rather than dividing. */
const REGEX_MAY_FOLLOW = new Set(['', ...'(,=:[!&|?{};+-*%~^<>']);

/** Keywords after which the same is true, which the punctuation set alone misses. */
const REGEX_MAY_FOLLOW_WORD = new Set([
  'return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'yield', 'await', 'throw'
]);

interface MaskedSource {
  /** Same length and line breaks as the input; comment and literal bodies blanked. */
  readonly text: string;
  /** The lexer ran off the end of a literal or comment -- i.e. it misread the file. */
  readonly unterminated: boolean;
}

/**
 * Comments and string-literal BODIES blanked in place, so offsets and line
 * numbering survive and a report can still name a line.
 *
 * STRING-AWARE ON PURPOSE
 *
 * The first version stripped comments with two regular expressions and knew
 * nothing about literals, so a quoted comment marker was read as a comment.
 * Measured, and fails OPEN -- the one direction this gate must never fail:
 *
 *     this.logger.info('see https://x'); await this.runner.invoke({ ... });
 *
 * reported ZERO call sites, because the `//` inside the URL blanked the rest of
 * its line; and a quoted glob opened a phantom block comment that swallowed every
 * call up to the next close marker. A vanished call site is not an offender, so
 * the gate stayed green with nothing examined, and the non-vacuity floor below
 * only notices once the count drops under three.
 *
 * Regex literals are tracked for the same reason in reverse: a pattern matching a
 * quote character would otherwise open a phantom string. A `/` is read as a regex
 * only in expression position -- the standard heuristic -- and a candidate that
 * does not close on its own line is treated as division rather than guessed at.
 *
 * An unterminated literal or comment means the lexer misread the file, so it is
 * reported rather than absorbed: every call site in that file becomes unreadable,
 * which `callSitesIn` already fails closed on.
 */
function maskCommentsAndLiterals(
  source: string,
  options: { readonly keepLiterals?: boolean } = {}
): MaskedSource {
  const keepLiterals = options.keepLiterals === true;
  const out = source.split('');
  const blank = (index: number): void => {
    if (out[index] !== '\n') out[index] = ' ';
  };
  let unterminated = false;
  let previousChar = '';
  let previousWord = '';
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (pair === '//') {
      while (index < source.length && source[index] !== '\n') { blank(index); index += 1; }
      continue;
    }
    if (pair === '/*') {
      const close = source.indexOf('*/', index + 2);
      if (close === -1) unterminated = true;
      const end = close === -1 ? source.length : close + 2;
      while (index < end) { blank(index); index += 1; }
      continue;
    }
    const char = source[index];
    const isRegex =
      char === '/' &&
      (REGEX_MAY_FOLLOW.has(previousChar) || REGEX_MAY_FOLLOW_WORD.has(previousWord));
    if (char === "'" || char === '"' || char === '`' || isRegex) {
      const body = index + 1;
      let cursor = body;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '\\') { cursor += 2; continue; }
        if (source[cursor] === char) { closed = true; break; }
        // A regex cannot span lines, so an unclosed candidate was division.
        if (isRegex && source[cursor] === '\n') break;
        cursor += 1;
      }
      previousChar = char;
      previousWord = '';
      if (!closed && isRegex) {
        index += 1;
        continue;
      }
      if (!closed) unterminated = true;
      // FR-R4-F06 (FR-006) -- the importer census must READ a module specifier, so it asks
      // for comments blanked and literals kept. The `.invoke(` scan blanks both, as before.
      if (!keepLiterals) {
        for (let at = body; at < Math.min(cursor, source.length); at += 1) blank(at);
      }
      index = closed ? cursor + 1 : source.length;
      continue;
    }
    if (!/\s/.test(char)) {
      previousChar = char;
      previousWord = /[A-Za-z0-9_$]/.test(char) ? previousWord + char : '';
    }
    index += 1;
  }
  return { text: out.join(''), unterminated };
}

export interface CallSite {
  /** Repo-relative, `/`-separated, with the 1-indexed line — always nameable. */
  readonly at: string;
  /** The call's argument text, or null when the parentheses do not balance. */
  readonly args: string | null;
}

/**
 * Every `.invoke(` call in one source text, with its own arguments.
 *
 * An unbalanced call reports `args: null` rather than being skipped. Following
 * `lint-gates-are-hermetic.test.ts`: an argument the gate cannot read is not
 * assumed benign, because an unreadable call is exactly how an omission gets in.
 */
function callSitesIn(name: string, source: string): CallSite[] {
  const masked = maskCommentsAndLiterals(source);
  const src = masked.text;
  const out: CallSite[] = [];
  for (
    let at = src.indexOf(INVOKE_MARKER);
    at !== -1;
    at = src.indexOf(INVOKE_MARKER, at + INVOKE_MARKER.length)
  ) {
    const open = at + INVOKE_MARKER.length - 1;
    const line = src.slice(0, at).split('\n').length;
    let depth = 0;
    let end = open;
    for (; end < src.length; end += 1) {
      if (src[end] === '(') depth += 1;
      else if (src[end] === ')' && --depth === 0) break;
    }
    out.push({
      at: `${name}:${line}`,
      args:
        !masked.unterminated && depth === 0 && end < src.length
          ? src.slice(open + 1, end)
          : null
    });
  }
  return out;
}

/** Repo-relative and `/`-separated on every platform, including Windows. */
function displayPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

/** Every `.invoke(` call under `src/`. */
function productionCallSites(): CallSite[] {
  return filesUnder(SRC_ROOT, { extensions: ['.ts'] }).flatMap((file) =>
    callSitesIn(displayPath(file), readFileSync(file, 'utf8'))
  );
}

/** Call sites that originate a spawn, so must forward a policy themselves. */
function originatingCallSites(sites: readonly CallSite[]): CallSite[] {
  return sites.filter((site) => site.args === null || !DELEGATES_A_REQUEST.test(site.args));
}

/** The sites that forward no policy — the gate's whole output. */
function offenders(sites: readonly CallSite[]): string[] {
  return originatingCallSites(sites)
    .filter((site) => site.args === null || !site.args.includes(POLICY_HELPER))
    .map((site) => site.at);
}

/**
 * FR-R4-F06 (FR-006) -- the `child_process` importer census.
 *
 * WHY THE `.invoke(` SCAN IS NOT ENOUGH
 *
 * It sees a spawn only when it is written `runner.invoke(...)`. Two configured-backend
 * spawns are not: the CLI version probe calls `run(cliPath, ['--version'], ...)` and the
 * capability probe calls `this.spawnFn(cliPath, args, { env, ... })`. The first took no
 * environment at all, so a `--version` child received every credential in the host under
 * every mode; the second was recorded as a known residual in the call-site fixture. A new
 * spawn written in either shape would pass the old gate by omission.
 *
 * The census shape is how this repository makes "a new X" fail rather than pass by
 * omission (`evidence-sink-mode-census.test.ts`, hard rule 69). Every `src/` file that
 * imports `child_process`, in any of its three forms, must be classified in the table
 * below, and a file that is not classified fails by name. A classification that no longer
 * matches the file fails as well, so a row cannot go on excusing a file that changed.
 *
 *  - A STATIC import is `from 'node:child_process'`; a DYNAMIC one is
 *    `await import('child_process')`, which two telemetry files use; a `require(...)` is
 *    the third. Searching for the static form alone found 11 of 15 files at `befeccc8` (16 now: `teardown-ledger.ts` joined, as a type-only importer).
 *  - A CONFIGURED-BACKEND SPAWNER is held to a rule per spawn call: the call's own
 *    arguments must carry the environment, built by `buildSpawnEnv(`, taken from the
 *    request a caller built, or taken from an injected builder whose construction site is
 *    itself checked to hold `buildSpawnEnv(` and `policyRequestFields(`.
 *  - A TYPE-ONLY importer is accepted only while the import stays `import type`.
 *  - An UNRELATED DIAGNOSTIC runs a fixed system tool, never an operator-configured
 *    backend, and each row says which.
 */
type SpawnRule =
  | { readonly marker: string; readonly envFrom: 'buildSpawnEnv' }
  | { readonly marker: string; readonly envFrom: 'caller-input' }
  | { readonly marker: string; readonly envFrom: 'caller-options' }
  | {
      readonly marker: string;
      readonly envFrom: 'injected-builder';
      readonly builderSite: string;
      readonly builderExpects: readonly string[];
    };

type ImporterRow =
  | {
      readonly path: string;
      readonly role: 'spawner';
      readonly reason: string;
      readonly rules: readonly SpawnRule[];
      /** The call site this spawner is in `ENV_POLICY_CALL_SITES`, when it is a probe. */
      readonly probe?: (typeof ENV_POLICY_CALL_SITES)[number];
    }
  | { readonly path: string; readonly role: 'type-only'; readonly reason: string }
  | { readonly path: string; readonly role: 'diagnostic'; readonly reason: string };

const CHILD_PROCESS_IMPORTERS: readonly ImporterRow[] = [
  {
    path: 'src/runner/claude-cli.ts',
    role: 'spawner',
    reason: 'the Claude adapter; `safeSpawn` wraps the spawn and takes its options from the caller',
    rules: [
      { marker: 'safeSpawn(', envFrom: 'buildSpawnEnv' },
      { marker: 'spawnFn(', envFrom: 'caller-options' }
    ]
  },
  {
    path: 'src/runner/process-lifecycle-runner.ts',
    role: 'spawner',
    reason: 'the shared lifecycle for Codex and Agy; its caller builds `env` from the request',
    rules: [{ marker: 'spawnFn(', envFrom: 'caller-input' }]
  },
  {
    path: 'src/services/acp-runtime/stdio-transport.ts',
    role: 'spawner',
    reason: 'the ACP stdio transport; its env comes from the host launch resolver',
    rules: [{ marker: 'spawn(', envFrom: 'caller-input' }]
  },
  {
    path: 'src/runner/cli-version-probe.ts',
    role: 'spawner',
    reason: 'the `--version` probe; its child environment is built from the policy',
    probe: 'cli version probe',
    rules: [{ marker: 'run(', envFrom: 'buildSpawnEnv' }]
  },
  {
    path: 'src/services/backend-capability-service.ts',
    role: 'spawner',
    reason: 'the capability probe; its environment comes from an injected builder',
    probe: 'backend capability probe',
    rules: [
      {
        marker: 'spawnFn(',
        envFrom: 'injected-builder',
        builderSite: 'src/activation/backend-wiring.ts',
        builderExpects: ['buildEnv:', 'buildSpawnEnv(', 'policyRequestFields(']
      }
    ]
  },
  {
    path: 'src/runner/codex-cli.ts',
    role: 'spawner',
    reason: 'imports `spawn` only to inject it into `ProcessLifecycleRunner` as its default `spawnFn`',
    rules: []
  },
  {
    path: 'src/runner/agy-cli.ts',
    role: 'spawner',
    reason: 'imports `spawn` only to inject it into `ProcessLifecycleRunner` as its default `spawnFn`',
    rules: []
  },
  {
    path: 'src/runner/child-completion.ts',
    role: 'type-only',
    reason: 'names the `ChildProcess` type for the completion helper'
  },
  {
    path: 'src/runner/child-stdin.ts',
    role: 'type-only',
    reason: 'names the `ChildProcess` type for the stdin helper'
  },
  {
    path: 'src/runner/teardown-ledger.ts',
    role: 'type-only',
    reason: 'names the `ChildProcess` type to key the ladders a runner has started (FR-R4-F06)'
  },
  {
    path: 'src/lib/git-diff-base.ts',
    role: 'diagnostic',
    reason: 'runs `git` to read a diff base; not an operator-configured backend'
  },
  {
    path: 'src/services/run-checkpoint-service.ts',
    role: 'diagnostic',
    reason: 'runs `git` to take the recovery checkpoint diff; not a configured backend'
  },
  {
    path: 'src/services/workflow-execution/recovery-envelope-builder.ts',
    role: 'diagnostic',
    reason: 'runs `git` to inspect workspace status and diff patches for candidate handover recovery; not a configured backend'
  },
  {
    path: 'src/activation/run-safety-wiring.ts',
    role: 'diagnostic',
    reason: 'runs `git diff` for the run-safety requester; not a configured backend'
  },
  {
    path: 'src/services/execution-lanes/git-runner.ts',
    role: 'diagnostic',
    reason: 'runs `git` for the lane engine with `GIT_DIR`-family variables stripped (FR-R6-F10); not a configured backend'
  },
  {
    path: 'src/services/execution-lanes/verification-runner.ts',
    role: 'diagnostic',
    reason: 'runs the checks an operator declared in a lane verification profile (FR-R6-F10); not a configured backend'
  },
  {
    path: 'src/services/process-liveness.ts',
    role: 'diagnostic',
    reason: 'runs `ps` to read a process start time; a fixed system tool'
  },
  {
    path: 'src/runner/process-tree.ts',
    role: 'diagnostic',
    reason: 'runs `taskkill` on Windows to end a process tree; a fixed system tool'
  },
  {
    path: 'src/telemetry/platform/platform-ps.ts',
    role: 'diagnostic',
    reason: 'dynamic import; runs `ps` for process telemetry'
  },
  {
    path: 'src/telemetry/platform/platform-windows.ts',
    role: 'diagnostic',
    reason: 'dynamic import; runs `powershell.exe` for process telemetry'
  }
];

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** The three ways a module reaches `child_process`, tested on text with comments blanked. */
const CHILD_PROCESS_FORMS: readonly RegExp[] = [
  /\bfrom\s*(['"])(?:node:)?child_process\1/,
  /\bimport\s*\(\s*(['"])(?:node:)?child_process\1\s*\)/,
  /\brequire\s*\(\s*(['"])(?:node:)?child_process\1\s*\)/
];
const TYPE_ONLY_IMPORT = /\bimport\s+type\s+\{[^}]*\}\s+from\s*(['"])(?:node:)?child_process\1\s*;?/g;

function withoutComments(source: string): string {
  return maskCommentsAndLiterals(source, { keepLiterals: true }).text;
}

function importsChildProcess(text: string): boolean {
  return CHILD_PROCESS_FORMS.some((form) => form.test(text));
}

/** Calls whose names are how a process is started in a spawner. */
const SPAWN_CALL = /(?<![A-Za-z0-9_$])(safeSpawn|spawnFn|spawnSync|spawn|execFileSync|execFile|fork|run)\(/g;

interface SpawnCall {
  readonly at: string;
  readonly marker: string;
  /** The call's argument text with comments and literals blanked, or null when unbalanced. */
  readonly args: string | null;
}

function spawnCallsIn(name: string, source: string): SpawnCall[] {
  const masked = maskCommentsAndLiterals(source);
  const src = masked.text;
  const out: SpawnCall[] = [];
  for (const match of src.matchAll(new RegExp(SPAWN_CALL.source, 'g'))) {
    const at = match.index;
    // A declaration is not a call: `function safeSpawn(spawnFn, ...)`.
    if (/function\s+$/.test(src.slice(Math.max(0, at - 16), at))) continue;
    const open = at + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < src.length; end += 1) {
      if (src[end] === '(') depth += 1;
      else if (src[end] === ')' && --depth === 0) break;
    }
    out.push({
      at: `${name}:${src.slice(0, at).split('\n').length}`,
      marker: `${match[1]}(`,
      args: !masked.unterminated && depth === 0 && end < src.length ? src.slice(open + 1, end) : null
    });
  }
  return out;
}

const CARRIES_ENV_PROPERTY = /(^|[\s,{])env\s*[:,}]/;

function ruleFailures(
  call: SpawnCall,
  rule: SpawnRule,
  readSite: (path: string) => string | null
): string[] {
  const args = call.args;
  if (args === null) return [`${call.at}: ${call.marker} call could not be read`];
  if (rule.envFrom === 'buildSpawnEnv') {
    return args.includes('buildSpawnEnv(') && CARRIES_ENV_PROPERTY.test(args)
      ? []
      : [`${call.at}: ${call.marker} carries no \`env\` built by buildSpawnEnv(`];
  }
  if (rule.envFrom === 'caller-input') {
    return args.includes('input.env') && CARRIES_ENV_PROPERTY.test(args)
      ? []
      : [`${call.at}: ${call.marker} carries no \`env\` taken from the caller's input`];
  }
  if (rule.envFrom === 'caller-options') {
    return /\.\.\.options\b/.test(args) ? [] : [`${call.at}: ${call.marker} spreads no caller options`];
  }
  if (!CARRIES_ENV_PROPERTY.test(args)) {
    return [`${call.at}: ${call.marker} carries no \`env\``];
  }
  const site = readSite(rule.builderSite);
  if (site === null) return [`${rule.builderSite}: the injected builder's site cannot be read`];
  return rule.builderExpects
    .filter((needle) => !site.includes(needle))
    .map((needle) => `${rule.builderSite}: the injected builder's site does not hold ${needle}`);
}

function rowFailures(
  row: ImporterRow,
  file: SourceText,
  readSite: (path: string) => string | null
): string[] {
  if (row.role === 'diagnostic') return [];
  if (row.role === 'type-only') {
    const rest = withoutComments(file.text).replace(TYPE_ONLY_IMPORT, '');
    return importsChildProcess(rest)
      ? [`${file.path}: classified type-only but now imports a value from child_process`]
      : [];
  }
  const calls = spawnCallsIn(file.path, file.text);
  const failures: string[] = [];
  for (const call of calls) {
    const rule = row.rules.find((candidate) => candidate.marker === call.marker);
    if (rule === undefined) {
      failures.push(`${call.at}: ${call.marker} is a spawn call this row declares no rule for`);
      continue;
    }
    failures.push(...ruleFailures(call, rule, readSite));
  }
  for (const rule of row.rules) {
    if (!calls.some((call) => call.marker === rule.marker)) {
      failures.push(`${file.path}: the row declares ${rule.marker} but the file has no such call`);
    }
  }
  return failures;
}

/** Every way the table and the tree disagree. Empty means the census holds. */
function censusFailures(
  rows: readonly ImporterRow[],
  files: readonly SourceText[],
  readSite: (path: string) => string | null
): string[] {
  const failures: string[] = [];
  const importers = files.filter((file) => importsChildProcess(withoutComments(file.text)));
  for (const file of importers) {
    const row = rows.find((candidate) => candidate.path === file.path);
    if (row === undefined) {
      failures.push(`${file.path}: imports child_process and is not classified in the table`);
      continue;
    }
    failures.push(...rowFailures(row, file, readSite));
  }
  for (const row of rows) {
    if (!importers.some((file) => file.path === row.path)) {
      failures.push(`${row.path}: classified, but the file no longer imports child_process`);
    }
  }
  return failures;
}

function productionSources(): SourceText[] {
  return filesUnder(SRC_ROOT, { extensions: ['.ts'] }).map((file) => ({
    path: displayPath(file),
    text: readFileSync(file, 'utf8')
  }));
}

function readRepoFile(path: string): string | null {
  try {
    return readFileSync(resolve(REPO_ROOT, path), 'utf8');
  } catch {
    return null;
  }
}

describe('every production invocation forwards the environment policy', () => {
  it('routes every call site through the shared policy helper', () => {
    const sites = productionCallSites();
    expect(
      offenders(sites),
      'these invocations do not route a policy through the shared helper'
    ).toEqual([]);
    // Non-vacuity: a scan that matched nothing must be distinguishable from a scan
    // that verified everything.
    expect(originatingCallSites(sites).length).toBeGreaterThanOrEqual(3);
    // The delegating adapters are exempted by role, so that exemption must also
    // be non-vacuous -- otherwise the role test could silently match everything.
    expect(sites.length).toBeGreaterThan(originatingCallSites(sites).length);
  });

  it('covers the same call sites the parity test models', () => {
    // The two halves of the enumeration cross-check each other. Neither can
    // silently cover fewer sites than the other: the guard proves each site
    // forwards, the parity test proves forwarding produces the right environment,
    // and a drift between the two counts fails here.
    //
    // FR-R4-F06 -- the guard now has two parts. The `.invoke(` scan covers the
    // sites that start a spawn through a runner; the importer census covers the
    // two probes. Their sum is what the parity test models.
    expect(originatingCallSites(productionCallSites()).length).toBe(INVOKE_CALL_SITE_COUNT);
    const probeNames = CHILD_PROCESS_IMPORTERS.flatMap((row) =>
      row.role === 'spawner' && row.probe !== undefined ? [row.probe] : []
    );
    expect(INVOKE_CALL_SITE_COUNT + probeNames.length).toBe(PARITY_CALL_SITE_COUNT);
    expect([...probeNames].sort()).toEqual(
      [...ENV_POLICY_CALL_SITES.slice(INVOKE_CALL_SITE_COUNT)].sort()
    );
  });

  it('fails on a seeded policy-less call site beside a correct one', () => {
    // The failure path is observed through the gate's own functions, not restated
    // over a string. A guard nobody has seen fire is one nobody should trust --
    // and this is the seed the per-file version of this gate passed on.
    const seeded = [
      "await this.runner.invoke({ prompt: '/status', ...policyRequestFields(p) });",
      "await this.runner.invoke({ prompt: '/status' });"
    ].join('\n');
    expect(offenders(callSitesIn(SEEDED_FILE, seeded))).toEqual([`${SEEDED_FILE}:2`]);
  });

  it('passes once the seeded call site forwards a policy', () => {
    const corrected = "await this.runner.invoke({ prompt: '/status', ...policyRequestFields(p) });";
    expect(offenders(callSitesIn(SEEDED_FILE, corrected))).toEqual([]);
  });

  it('does not exempt a request literal the invoker built and spread itself', () => {
    // Hoisting the request into a `const request` and spreading it is the natural
    // refactor of any of the three call sites, and it forwards no policy. Only a
    // request handed in is delegation, so this must be reported.
    const spread = 'await this.runner.invoke({ ...request, iteration: 0 });';
    expect(offenders(callSitesIn(SEEDED_FILE, spread))).toEqual([`${SEEDED_FILE}:1`]);
  });

  it('still exempts an adapter that forwards a request handed to it', () => {
    // The other side of the same line: the two backend adapters receive a request
    // whose policy already travelled with it, and pass it on as a shorthand
    // property. That exemption must survive tightening the spread case.
    const delegating = 'return this.lifecycle.invoke({ request, args, env: buildSpawnEnv(request) });';
    expect(originatingCallSites(callSitesIn(SEEDED_FILE, delegating))).toEqual([]);
  });

  it('reports a call it cannot read rather than assuming it is benign', () => {
    const unreadable = 'await this.runner.invoke({ prompt: policyRequestFields(p) ;';
    expect(offenders(callSitesIn(SEEDED_FILE, unreadable))).toEqual([`${SEEDED_FILE}:1`]);
  });

  it('does not count a commented-out call site, leading or trailing', () => {
    const commented = [
      '// const raw = await this.runner.invoke({ prompt: "x" });',
      'const y = 1; // await this.runner.invoke({ prompt: "x" });',
      '/* await this.runner.invoke({ prompt: "x" }); */'
    ].join('\n');
    expect(callSitesIn(SEEDED_FILE, commented)).toEqual([]);
  });

  it('still counts a call site sharing its line with a quoted `//`', () => {
    // A URL in a log message is not a comment. Before the scan knew about string
    // literals this reported ZERO sites, so the policy-less call below was not an
    // offender -- the gate green with nothing examined, which is the one direction
    // it must never fail. Measured on the previous implementation.
    const quoted = "this.logger.info('see https://x'); await this.runner.invoke({ prompt: 'x' });";
    expect(offenders(callSitesIn(SEEDED_FILE, quoted))).toEqual([`${SEEDED_FILE}:1`]);
  });

  it('still counts a call site after a quoted block-comment marker', () => {
    // A glob is not a comment either. The phantom block comment it used to open
    // ran to the next close marker and swallowed every call in between.
    const globbed = [
      "const pattern = '/*';",
      "await this.runner.invoke({ prompt: 'x' });",
      "const closer = '*/';"
    ].join('\n');
    expect(offenders(callSitesIn(SEEDED_FILE, globbed))).toEqual([`${SEEDED_FILE}:2`]);
  });

  it('reads every production file without losing its place', () => {
    // The scan must not have MISREAD the tree it just passed on. An unterminated
    // literal or comment means the lexer lost its place somewhere in the file, and
    // in a file with no `.invoke(` that would be invisible to every case above --
    // right up to the day somebody adds one there.
    const misread = filesUnder(SRC_ROOT, { extensions: ['.ts'] })
      .filter((file) => maskCommentsAndLiterals(readFileSync(file, 'utf8')).unterminated)
      .map(displayPath);
    expect(misread, 'the scan lost its place in these files').toEqual([]);
  });

  it('does not count a test file', () => {
    // Scoping is by root, so the assertion is that the root excludes tests.
    expect(productionCallSites().every((site) => site.at.startsWith('src/'))).toBe(true);
  });
});

describe('every child_process importer is classified, and a spawner forwards env (FR-006)', () => {
  it('classifies every importer in src/ and holds every spawner to its rule', () => {
    expect(censusFailures(CHILD_PROCESS_IMPORTERS, productionSources(), readRepoFile)).toEqual([]);
  });

  it('is not vacuous: it finds all 20 importers and every role is exercised', () => {
    const found = productionSources().filter((file) =>
      importsChildProcess(withoutComments(file.text))
    );
    expect(found.map((file) => file.path).sort()).toEqual(
      CHILD_PROCESS_IMPORTERS.map((row) => row.path).sort()
    );
    expect(found).toHaveLength(20);
    const roles = new Set(CHILD_PROCESS_IMPORTERS.map((row) => row.role));
    expect([...roles].sort()).toEqual(['diagnostic', 'spawner', 'type-only']);
    // Both probes are spawners with a rule, which is the whole reason for the census.
    const probes = CHILD_PROCESS_IMPORTERS.filter(
      (row) => row.role === 'spawner' && row.probe !== undefined && row.rules.length > 0
    );
    expect(probes).toHaveLength(2);
  });

  it('finds the dynamic imports the static form misses', () => {
    const dynamic = productionSources().filter((file) =>
      /\bimport\s*\(\s*(['"])(?:node:)?child_process\1\s*\)/.test(withoutComments(file.text))
    );
    expect(dynamic.map((file) => file.path).sort()).toEqual([
      'src/telemetry/platform/platform-ps.ts',
      'src/telemetry/platform/platform-windows.ts'
    ]);
  });

  // The four seeded cases. A gate nobody has seen fire is one nobody should trust, and each
  // of these is a way a configured-backend spawn would otherwise slip in.

  it('fails on a fixture importer missing from the table', () => {
    const files: SourceText[] = [
      {
        path: `${SEEDED_SRC}/lib/new-importer.ts`,
        text: "import { execFile } from 'node:child_process';\nexecFile('x');"
      }
    ];
    expect(censusFailures([], files, () => null)).toEqual([
      'src/lib/new-importer.ts: imports child_process and is not classified in the table'
    ]);
  });

  it('fails on a fixture dynamic import missing from the table', () => {
    const files: SourceText[] = [
      {
        path: `${SEEDED_SRC}/lib/lazy-importer.ts`,
        text: "export async function go() {\n  const { spawn } = await import('child_process');\n  spawn('x');\n}"
      }
    ];
    expect(censusFailures([], files, () => null)).toEqual([
      'src/lib/lazy-importer.ts: imports child_process and is not classified in the table'
    ]);
  });

  it('fails on a spawner call text without env', () => {
    const row: ImporterRow = {
      path: `${SEEDED_SRC}/services/probe.ts`,
      role: 'spawner',
      reason: 'seeded',
      rules: [{ marker: 'spawnFn(', envFrom: 'injected-builder', builderSite: `${SEEDED_SRC}/b.ts`, builderExpects: ['buildSpawnEnv('] }]
    };
    const files: SourceText[] = [
      {
        path: `${SEEDED_SRC}/services/probe.ts`,
        text: "import { spawn } from 'node:child_process';\nconst c = this.spawnFn(cliPath, args, { cwd: x, shell: false });"
      }
    ];
    const failures = censusFailures([row], files, () => 'buildEnv: () => buildSpawnEnv(');
    expect(failures).toEqual(['src/services/probe.ts:2: spawnFn( carries no `env`']);
  });

  it('fails on an injected-builder row whose builder site lacks buildSpawnEnv(', () => {
    const row: ImporterRow = {
      path: `${SEEDED_SRC}/services/probe.ts`,
      role: 'spawner',
      reason: 'seeded',
      rules: [
        {
          marker: 'spawnFn(',
          envFrom: 'injected-builder',
          builderSite: 'src/activation/backend-wiring.ts',
          builderExpects: ['buildEnv:', 'buildSpawnEnv(', 'policyRequestFields(']
        }
      ]
    };
    const files: SourceText[] = [
      {
        path: `${SEEDED_SRC}/services/probe.ts`,
        text: "import { spawn } from 'node:child_process';\nconst c = this.spawnFn(cliPath, args, { cwd: x, env, shell: false });"
      }
    ];
    expect(censusFailures([row], files, () => 'buildEnv: () => ({ A: 1 })')).toEqual([
      "src/activation/backend-wiring.ts: the injected builder's site does not hold buildSpawnEnv(",
      "src/activation/backend-wiring.ts: the injected builder's site does not hold policyRequestFields("
    ]);
  });

  it('passes the same fixtures once they are correct', () => {
    const row: ImporterRow = {
      path: `${SEEDED_SRC}/services/probe.ts`,
      role: 'spawner',
      reason: 'seeded',
      rules: [
        {
          marker: 'spawnFn(',
          envFrom: 'injected-builder',
          builderSite: 'src/activation/backend-wiring.ts',
          builderExpects: ['buildEnv:', 'buildSpawnEnv(', 'policyRequestFields(']
        }
      ]
    };
    const files: SourceText[] = [
      {
        path: `${SEEDED_SRC}/services/probe.ts`,
        text: "import { spawn } from 'node:child_process';\nconst c = this.spawnFn(cliPath, args, { cwd: x, env, shell: false });"
      }
    ];
    const builder = 'buildEnv: () => buildSpawnEnv({ ...policyRequestFields(p) })';
    expect(censusFailures([row], files, () => builder)).toEqual([]);
  });

  it('fails when a type-only importer starts importing a value', () => {
    const row: ImporterRow = { path: `${SEEDED_SRC}/runner/helper.ts`, role: 'type-only', reason: 'seeded' };
    const typeOnly: SourceText = {
      path: `${SEEDED_SRC}/runner/helper.ts`,
      text: "import type { ChildProcess } from 'node:child_process';"
    };
    const widened: SourceText = {
      path: `${SEEDED_SRC}/runner/helper.ts`,
      text: "import type { ChildProcess } from 'node:child_process';\nimport { spawn } from 'node:child_process';"
    };
    expect(censusFailures([row], [typeOnly], () => null)).toEqual([]);
    expect(censusFailures([row], [widened], () => null)).toEqual([
      'src/runner/helper.ts: classified type-only but now imports a value from child_process'
    ]);
  });

  it('fails when a classified file no longer imports child_process', () => {
    const row: ImporterRow = { path: `${SEEDED_SRC}/lib/gone.ts`, role: 'diagnostic', reason: 'seeded' };
    const files: SourceText[] = [{ path: `${SEEDED_SRC}/lib/gone.ts`, text: 'export const x = 1;' }];
    expect(censusFailures([row], files, () => null)).toEqual([
      'src/lib/gone.ts: classified, but the file no longer imports child_process'
    ]);
  });

  it('does not read a commented-out import as an importer', () => {
    const files: SourceText[] = [
      {
        path: `${SEEDED_SRC}/lib/commented.ts`,
        text: "// import { spawn } from 'node:child_process';\n/* const x = await import('child_process'); */\nexport const y = 1;"
      }
    ];
    expect(censusFailures([], files, () => null)).toEqual([]);
  });
});
