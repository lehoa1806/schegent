// Feature 093 (T028) — the ambient single-Run accessors stay deleted (SC-012).
//
// SC-012 is worded as a property of the *surface*, not of the callers: "the
// criterion is met when the ambient single-Run accessor does not exist, not when
// callers merely avoid it". The T018 deletion turned all 60 call sites into
// compile errors, which is what enumerated the work — but the compiler only
// answers for today. Re-adding `getRun(): WorkflowRun | null` as an overload, or
// a `setRun(run)` convenience wrapper, would compile perfectly and quietly
// restore a path that addresses one Run without naming its queue. In a window
// running several Runs that path does not fail; it acts on whichever entry it
// happened to find, which is the failure mode the whole feature exists to remove.
//
// So the guard is a shape rule on how the two names may be *written* anywhere in
// the host, declaration and call site alike:
//
//   - `getRun` is never written with an empty parameter or argument list.
//   - `setRun` always has at least one top-level comma, so it always names a
//     queue alongside the Run it writes.
//
// One rule covers both forms because a declaration and a call are the same shape
// in source. That matters: the likeliest way the ambient form comes back is not
// an edit to `workspace-state.ts` (which this feature's history makes
// conspicuous) but a hand-rolled store double in a test declaring
// `getRun: () => run`, which is exactly how a converted call site would regress
// without anything failing.
//
// Aggregate reads are deliberately untouched. `getRunMap()` names no single Run
// and is the case SC-012 exempts; the `\b` boundary in the scan keeps it out.
//
// Scope is `src/` and `tests/`: the store is host-side, and the webview receives
// a projection rather than an accessor, so there is nothing there to reintroduce.
//
// Comments are stripped before scanning because the prose in this repo quotes
// `store.getRun()` in its historical, ambient form in a dozen doc comments — the
// record of what was removed must not read as a violation of its own removal.
// Strings are left as they are: no call is written inside one today, and lexing
// them would mean telling a regex literal from a division, whose failure mode is
// over-masking, i.e. a quieter lint.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['src', 'tests'] as const;

/**
 * This file, excluded from its own scan. Its failure messages have to quote the
 * forbidden forms to be worth reading, and they are string literals, which the
 * strip above deliberately leaves alone. The same self-exclusion the other lint
 * guards make for the module they are about.
 */
const SELF = 'tests/lint/no-ambient-run-accessor.test.ts';

/**
 * Files that must contribute at least one site. Without them a path typo would
 * empty the scan and pass every assertion below trivially — the failure mode a
 * reachability guard can least afford.
 */
const ANCHORS = [
  'src/state/workspace-state.ts',
  'src/controller/workflow-controller.ts',
  'src/controller/phase-control-service.ts'
] as const;

/** Well under today's 219 / 189, so ordinary churn does not trip it. */
const MIN_SITES = 100;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly name: 'getRun' | 'setRun';
  readonly text: string;
  readonly args: string;
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
 * ends first. Depth tracks `()`, `[]`, and `{}` only — angle brackets are left
 * alone because telling a generic from a comparison needs a parser, and the two
 * rules below are stated so that mistaking one for the other cannot manufacture
 * a violation: an unclosed generic can only make an argument list look like it
 * has *more* top-level commas, never fewer.
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

function sitesIn(file: string): readonly Site[] {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const lines = raw.split(/\r?\n/);
  const found: Site[] = [];
  for (const match of code.matchAll(/\b(getRun|setRun)\b/g)) {
    const name = match[1] as 'getRun' | 'setRun';
    let cursor = match.index + name.length;
    // `getRun(`, `getRun: (`, and `getRun = (` are the same site; anything else
    // (a bare reference, a field typed `WorkflowRun | null`) opens no list.
    while (cursor < code.length && /[\s?:=]/.test(code[cursor]!)) cursor += 1;
    if (code[cursor] !== '(') continue;
    const args = argumentList(code, cursor);
    if (args === null) continue;
    const line = raw.slice(0, match.index).split('\n').length;
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

const SITES: readonly Site[] = SCAN_ROOTS.flatMap((root) =>
  typescriptFiles(resolve(REPO_ROOT, root))
    .filter((file) => relative(REPO_ROOT, file) !== SELF)
    .flatMap(sitesIn)
);

function describeSite(site: Site): string {
  return `${site.file}:${site.line}  ${site.text}`;
}

describe('Feature 093 — the ambient Run accessors do not come back (SC-012)', () => {
  it('scanned the files the rule is about, so the scan is not vacuous', () => {
    const scanned = new Set(SITES.map((site) => site.file));
    for (const anchor of ANCHORS) {
      expect(scanned, `${anchor} must contribute at least one site`).toContain(anchor);
    }
    for (const name of ['getRun', 'setRun'] as const) {
      const count = SITES.filter((site) => site.name === name).length;
      expect(count, `${name} sites found`).toBeGreaterThanOrEqual(MIN_SITES);
    }
  });

  it('never writes getRun with an empty list — every read names its queue', () => {
    const offenders = SITES.filter(
      (site) => site.name === 'getRun' && site.args.trim() === ''
    ).map(describeSite);
    expect(
      offenders,
      'getRun() addresses one Run without naming its queue; pass the queue id, or use getRunMap() when the caller genuinely wants every Run'
    ).toEqual([]);
  });

  it('never writes setRun without a queue alongside the Run', () => {
    const offenders = SITES.filter(
      (site) => site.name === 'setRun' && topLevelCommas(site.args) === 0
    ).map(describeSite);
    expect(
      offenders,
      'setRun(run) writes a Run to a guessed queue; pass setRun(queueId, run | null)'
    ).toEqual([]);
  });
});
