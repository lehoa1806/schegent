// FR-R3-002 (T286) — the implicit Default queue does not grow back.
//
// FUNC-02 found four production seams that substituted Default for a queue the
// caller either supplied or should have been required to supply. Three of them
// shared one mechanism: `DEFAULT_QUEUE_ID` as a *default parameter value*. A
// default parameter turns "the caller forgot" into "the caller meant Default",
// silently and at the wrong layer, and the resulting write is not a missing
// write — it is a *sibling's* write. A schedule armed on queue B cleared queue
// A's lifecycle fields for exactly this reason, and a connected child in flight
// on a non-Default queue read as settled for exactly this reason.
//
// T280/T281 removed the defaults from `getQueue()` and `updateQueue()`, which
// made `npm run typecheck` the exhaustive call-site worklist — the same
// mechanism feature 093 used when it deleted the ambient `getRun()`. But the
// compiler only answers for today. Re-adding `= DEFAULT_QUEUE_ID` to either
// signature, or hand-rolling a store double that declares `getQueue: () =>
// state`, compiles perfectly and quietly restores the fallback. So the guard is
// a shape rule on how these names may be *written*, declaration and call site
// alike:
//
//   - `getQueue` is never written with an empty parameter or argument list.
//   - `updateQueue` always carries at least one top-level comma, so the
//     mutation it applies always names the queue it applies to.
//   - No `src/` module introduces a new `= DEFAULT_QUEUE_ID` parameter default.
//
// The third rule is general rather than scoped to the two accessors, because
// the acceptance criterion is about the *mechanism*, not about two functions.
// The nine sites that predate this requirement are allowlisted by name below
// and are expected to shrink; an allowlist entry for a parameter that no longer
// has the default is itself a failure, so the list cannot go stale in the
// direction that matters.
//
// `?? DEFAULT_QUEUE_ID` is deliberately NOT matched. That is a value fallback at
// a site that already tried to name its queue and found nothing — `runAuto` and
// `cmd-start` use it on purpose, at the boundary whose own contract says an
// unscoped submit means Default. The defect is a callee hiding the absence from
// its caller, not a caller resolving one it can see.
//
// Scope is `src/` and `tests/` for the call-shape rules and `src/` alone for the
// default-parameter rule: a test may legitimately declare a helper with a
// Default-queue default, but a test that calls `getQueue()` bare is the regressed
// call site the rule exists to catch.
//
// Comments are stripped before scanning because this repo's prose quotes
// `store.getQueue()` in its historical, ambient form in several doc comments —
// the record of what was removed must not read as a violation of its own
// removal. Strings are left alone, matching `no-ambient-run-accessor`.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['src', 'tests'] as const;

/**
 * This file, excluded from its own scan. Its prose and failure messages have to
 * quote the forbidden forms to be worth reading, and the message strings are
 * string literals, which the strip above deliberately leaves alone.
 */
const SELF = 'tests/lint/no-implicit-default-queue.test.ts';

/**
 * Files that must contribute at least one site. Without them a path typo would
 * empty the scan and pass every assertion below trivially.
 */
const ANCHORS = [
  'src/state/workspace-state.ts',
  'src/ui/sidebar/snapshot-composer.ts',
  'src/commands/enqueue.ts'
] as const;

/** Well under today's counts, so ordinary churn does not trip it. */
const MIN_GET_SITES = 150;
const MIN_UPDATE_SITES = 20;

/**
 * Parameter defaults that predate FR-R3-002, keyed `file` → owning function.
 *
 * Each is a queue-addressed method whose callers this requirement did not
 * enumerate. They are recorded rather than silently unscanned so the next
 * person to tighten one has the list; T280/T281 named only `getQueue` and
 * `updateQueue`, and widening beyond them would have been scope this
 * requirement did not carry.
 *
 * An entry that no longer corresponds to a real default fails the vacuity test
 * below, so removing a default means removing its entry in the same change.
 */
const DEFAULT_PARAM_ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'src/queue/queue-manager.ts',
    ['list', 'peekNextPending', 'hasQueueCapacity', 'clearCompleted', 'clearFailed', 'clearByStatus']
  ],
  // `setQueue` is the `@internal` full-replacement seam for migrations and test
  // setup. Its production callers are the migrator, which addresses every entry
  // explicitly, and no operator-facing path at all.
  ['src/state/workspace-state.ts', ['setQueue']],
  // The drain pair. Every production call site names its queue as of T279/T282/
  // T285; the defaults remain only for the test call sites this requirement did
  // not rewrite.
  ['src/services/auto-drain-coordinator.ts', ['drainIfIdle']],
  ['src/controller/workflow-controller.ts', ['drainQueuedWork']]
]);

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly name: 'getQueue' | 'updateQueue';
  readonly text: string;
  readonly args: string;
}

interface DefaultParamSite {
  readonly file: string;
  readonly line: number;
  readonly owner: string;
  readonly text: string;
}

function typescriptFiles(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(absolute);
  }
  return found;
}

/** Blank out comments, preserving offsets and newlines so lines still line up. */
function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const pair = text.slice(cursor, cursor + 2);
    if (pair === '//') {
      const newline = text.indexOf('\n', cursor);
      const stop = newline === -1 ? text.length : newline;
      blank(cursor, stop);
      cursor = stop;
    } else if (pair === '/*') {
      const close = text.indexOf('*/', cursor + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(cursor, stop);
      cursor = stop;
    } else {
      cursor += 1;
    }
  }
  return out.join('');
}

/**
 * The argument (or parameter) list that opens at `open`, or null when the source
 * ends first. Depth tracks `()`, `[]`, and `{}` only — telling a generic from a
 * comparison needs a parser, and an unclosed generic can only make a list look
 * like it has *more* top-level commas, never fewer.
 */
function argumentList(text: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return null;
}

function topLevelCommas(args: string): number {
  let depth = 0;
  let count = 0;
  for (const char of args) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) count += 1;
  }
  return count;
}

function lineOf(raw: string, index: number): number {
  return raw.slice(0, index).split('\n').length;
}

function callSitesIn(file: string): readonly CallSite[] {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const lines = raw.split(/\r?\n/);
  const found: CallSite[] = [];
  for (const match of code.matchAll(/\b(getQueue|updateQueue)\b/g)) {
    const name = match[1] as 'getQueue' | 'updateQueue';
    let cursor = match.index + name.length;
    // `getQueue(`, `getQueue: (`, `getQueue = (` and `updateQueue: async (` are
    // the same site. Skipping `async` matters here where it does not for
    // `getRun`: the likeliest regressed `updateQueue` is a store double written
    // `updateQueue: async (mutate) => …`, which is precisely the ambient form.
    // Anything else (a bare reference, a `getQueue<T>` generic) opens no list.
    while (cursor < code.length && /[\s?:=]/.test(code[cursor]!)) cursor += 1;
    if (code.startsWith('async', cursor)) {
      cursor += 'async'.length;
      while (cursor < code.length && /\s/.test(code[cursor]!)) cursor += 1;
    }
    if (code[cursor] !== '(') continue;
    const args = argumentList(code, cursor);
    if (args === null) continue;
    const line = lineOf(raw, match.index);
    found.push({
      file: relative(REPO_ROOT, file),
      line,
      name,
      text: (lines[line - 1] ?? '').trim(),
      args
    });
  }
  return found;
}

/**
 * Every `= DEFAULT_QUEUE_ID` that sits inside a parameter list, with the name of
 * the function that owns it.
 *
 * `===` and `!==` are excluded by the lookbehind: those are comparisons, and
 * comparing an id against the reserved one is how a caller *distinguishes* the
 * Default queue rather than how it hides a missing argument. The walk left finds
 * the enclosing `(`; a `;`, `{` or `}` reached first means the assignment is a
 * statement, not a parameter default.
 */
function defaultParamsIn(file: string): readonly DefaultParamSite[] {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const lines = raw.split(/\r?\n/);
  const found: DefaultParamSite[] = [];
  for (const match of code.matchAll(/(?<![=!<>])=\s*DEFAULT_QUEUE_ID\b/g)) {
    let depth = 0;
    let open = -1;
    for (let index = match.index - 1; index >= 0; index -= 1) {
      const char = code[index]!;
      if (char === ')' || char === ']' || char === '}') depth += 1;
      else if (char === '(' || char === '[' || char === '{') {
        if (depth === 0) {
          if (char === '(') open = index;
          break;
        }
        depth -= 1;
      } else if (char === ';' && depth === 0) break;
    }
    if (open === -1) continue;
    let nameEnd = open;
    while (nameEnd > 0 && /\s/.test(code[nameEnd - 1]!)) nameEnd -= 1;
    let nameStart = nameEnd;
    while (nameStart > 0 && /[A-Za-z0-9_$]/.test(code[nameStart - 1]!)) nameStart -= 1;
    const line = lineOf(raw, match.index);
    found.push({
      file: relative(REPO_ROOT, file),
      line,
      owner: code.slice(nameStart, nameEnd) || '<anonymous>',
      text: (lines[line - 1] ?? '').trim()
    });
  }
  return found;
}

const CALL_SITES: readonly CallSite[] = SCAN_ROOTS.flatMap((root) =>
  typescriptFiles(resolve(REPO_ROOT, root))
    .filter((file) => relative(REPO_ROOT, file) !== SELF)
    .flatMap(callSitesIn)
);

const DEFAULT_PARAMS: readonly DefaultParamSite[] = typescriptFiles(
  resolve(REPO_ROOT, 'src')
).flatMap(defaultParamsIn);

function describeCall(site: CallSite): string {
  return `${site.file}:${site.line}  ${site.text}`;
}

describe('FR-R3-002 — the implicit Default queue does not grow back', () => {
  it('scanned the files the rule is about, so the scan is not vacuous', () => {
    const scanned = new Set(CALL_SITES.map((site) => site.file));
    for (const anchor of ANCHORS) {
      expect(scanned, `${anchor} must contribute at least one site`).toContain(anchor);
    }
    expect(
      CALL_SITES.filter((site) => site.name === 'getQueue').length,
      'getQueue sites found'
    ).toBeGreaterThanOrEqual(MIN_GET_SITES);
    expect(
      CALL_SITES.filter((site) => site.name === 'updateQueue').length,
      'updateQueue sites found'
    ).toBeGreaterThanOrEqual(MIN_UPDATE_SITES);
    expect(DEFAULT_PARAMS.length, 'DEFAULT_QUEUE_ID parameter defaults found').toBeGreaterThan(0);
  });

  it('never writes getQueue with an empty list — every read names its queue', () => {
    const offenders = CALL_SITES.filter(
      (site) => site.name === 'getQueue' && site.args.trim() === ''
    ).map(describeCall);
    expect(
      offenders,
      'getQueue() reads whichever queue the default parameter picks; pass the queue id, or use getQueueStates() when the caller genuinely wants every queue'
    ).toEqual([]);
  });

  it('never writes updateQueue without a queue alongside the mutation', () => {
    const offenders = CALL_SITES.filter(
      (site) => site.name === 'updateQueue' && topLevelCommas(site.args) === 0
    ).map(describeCall);
    expect(
      offenders,
      'updateQueue(mutate) writes to a guessed queue and reads as a sibling queue s write; pass updateQueue(mutate, queueId)'
    ).toEqual([]);
  });

  it('introduces no new DEFAULT_QUEUE_ID parameter default in src/', () => {
    const offenders = DEFAULT_PARAMS.filter(
      (site) => !(DEFAULT_PARAM_ALLOWLIST.get(site.file) ?? []).includes(site.owner)
    ).map((site) => `${site.file}:${site.line}  ${site.owner}  ${site.text}`);
    expect(
      offenders,
      'a DEFAULT_QUEUE_ID parameter default turns "the caller forgot" into "the caller meant Default"; require the argument, and let the caller that genuinely means Default say so'
    ).toEqual([]);
  });

  it('carries no stale allowlist entry', () => {
    const live = new Set(DEFAULT_PARAMS.map((site) => `${site.file}::${site.owner}`));
    const stale: string[] = [];
    for (const [file, owners] of DEFAULT_PARAM_ALLOWLIST) {
      for (const owner of owners) {
        if (!live.has(`${file}::${owner}`)) stale.push(`${file}::${owner}`);
      }
    }
    expect(
      stale,
      'this allowlist is expected to shrink; an entry for a parameter that no longer has the default should be deleted with it'
    ).toEqual([]);
  });
});
