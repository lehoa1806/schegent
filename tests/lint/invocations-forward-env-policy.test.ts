import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';
import { PARITY_CALL_SITE_COUNT } from '../fixtures/env-policy-call-sites';

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
function maskCommentsAndLiterals(source: string): MaskedSource {
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
      for (let at = body; at < Math.min(cursor, source.length); at += 1) blank(at);
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
    expect(originatingCallSites(productionCallSites()).length).toBe(PARITY_CALL_SITE_COUNT);
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
