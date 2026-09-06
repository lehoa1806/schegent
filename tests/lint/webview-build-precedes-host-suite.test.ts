// FR-R3-169 / FR-019 — every chain that runs the host suite builds the webview first.
//
// WHY THIS EXISTS AND NOT JUST THE THREE EDITS IT ENFORCES. Two files in
// `tests/unit/ui/sidebar/` read `dist/webview` and, as of FR-R3-169, fail rather
// than excuse themselves when it is absent. That is only safe if every supported
// way of reaching the host suite builds the bundle first. Measured on 2026-09-06,
// three did not: `verify:all`, `verify:edit`, and `test`. Repairing those three by
// hand and stopping would reproduce, inside this feature, the exact defect the
// feature was filed about — a policy written down, enforced by nobody, correct on
// the day it was adopted and quietly wrong four months later when someone adds a
// fourth script. The three edits are the fix; this file is the reason the fix
// stays true.
//
// The rule, stated so it cannot be satisfied by adding a name to a list:
//
//   Resolve every script's command sequence, expanding `npm run <name>` into that
//   script's own sequence, in order. If the sequence reaches the whole host suite,
//   it must reach `build:webview` strictly earlier.
//
// EXEMPTION, AND WHY IT IS STRUCTURAL RATHER THAN A LIST. `test:host` (`vitest
// run`) and `test:coverage` (`vitest run --coverage`) are the primitive runners
// every other script composes. Prefixing them with a build would rebuild the
// webview on every invocation, including inside `ci`, where it has already been
// built. So a script is exempt when its ENTIRE body is one command that is itself
// the host-suite invocation — a property of the script's shape, derived here, not
// a name anyone can add. `test` was two commands, so it was never exempt, and this
// gate is what caught it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');

/** The script whose body IS the webview build. Reaching it satisfies the rule. */
const BUILD_SCRIPT = 'build:webview';

type Marker = 'build' | 'host-suite';

function loadScripts(): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const scripts = (parsed as { scripts?: Record<string, string> }).scripts;
  if (scripts === undefined) throw new Error('package.json has no "scripts" object');
  return scripts;
}

/** A script body split into the commands the shell would run in order. */
function commandsOf(body: string): string[] {
  return body
    .split(/&&|;/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * The local script `command` delegates to, or `undefined`.
 *
 * `npm --prefix webview-ui run build` is deliberately NOT local: it runs the
 * webview package's own scripts, which this file does not model and which cannot
 * reach this package's host suite.
 */
function localRunTarget(command: string): string | undefined {
  return /^npm\s+run\s+(\S+)/.exec(command)?.[1];
}

/**
 * True when `command` runs the WHOLE default vitest project — the host suite.
 *
 * Excluded, because neither is the host suite: an explicit `--config` (a different
 * project, e.g. `test:perf`, `test:e2e`, `test:evals`) and a positional path
 * argument (a single-file run, e.g. `test:soak`). Flags such as `--coverage` and
 * `--reporter=verbose` do not narrow the project and so do not exclude.
 */
function runsHostSuite(command: string): boolean {
  const tokens = command.split(/\s+/);
  const vitest = tokens.indexOf('vitest');
  if (vitest === -1 || tokens[vitest + 1] !== 'run') return false;
  const rest = tokens.slice(vitest + 2);
  if (rest.includes('--config')) return false;
  return !rest.some((token) => !token.startsWith('-'));
}

/**
 * `scripts[name]`, typed so the miss it can be stays visible.
 *
 * `Record<string, string>` types the lookup as `string`, which is a claim about
 * `package.json` that nothing checks — a script body may `npm run` a target that is
 * not defined, and resolving exactly those names is what this file does. Under that
 * type the guard below is dead code and the linter says so correctly; read through a
 * signature that admits `undefined` it is the real branch it has always been.
 */
function bodyOf(
  scripts: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  return scripts[name];
}

/**
 * The ordered markers a script produces once every local `npm run` is expanded.
 *
 * `seen` breaks a cycle rather than overflowing the stack: a script chain that
 * refers to itself is a defect this gate should report as such, not crash on.
 */
function markersOf(
  name: string,
  scripts: Readonly<Record<string, string>>,
  seen: readonly string[] = []
): Marker[] {
  if (name === BUILD_SCRIPT) return ['build'];
  const body = bodyOf(scripts, name);
  if (body === undefined || seen.includes(name)) return [];
  const out: Marker[] = [];
  for (const command of commandsOf(body)) {
    const target = localRunTarget(command);
    if (target !== undefined) {
      out.push(...markersOf(target, scripts, [...seen, name]));
      continue;
    }
    if (runsHostSuite(command)) out.push('host-suite');
  }
  return out;
}

/** A script whose entire body is one command that is itself the host-suite run. */
function isPrimitiveRunner(body: string): boolean {
  const commands = commandsOf(body);
  // Quantified rather than indexed. After the length check `commands[0]` is there,
  // so the guard TypeScript would want for the read is genuinely dead — unlike the
  // one in `bodyOf`, which is a lookup that can miss. `every` over a one-element
  // array says the same thing without the dead branch.
  return commands.length === 1 && commands.every((command) => runsHostSuite(command));
}

interface Offender {
  readonly script: string;
  readonly reason: string;
}

function offenders(scripts: Readonly<Record<string, string>>): Offender[] {
  const found: Offender[] = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (isPrimitiveRunner(body)) continue;
    const markers = markersOf(name, scripts);
    const suite = markers.indexOf('host-suite');
    if (suite === -1) continue;
    const build = markers.indexOf('build');
    if (build !== -1 && build < suite) continue;
    found.push({
      script: name,
      reason: build === -1 ? 'never runs build:webview' : 'runs build:webview only afterwards'
    });
  }
  return found;
}

describe('every npm chain that runs the host suite builds the webview first (FR-019)', () => {
  const scripts = loadScripts();

  it('has no script that reaches the host suite without an earlier build:webview', () => {
    const bad = offenders(scripts);
    expect(
      bad.map((offender) => `${offender.script}: ${offender.reason}`),
      `These scripts run the whole host suite without building the webview first, so ` +
        `tests/unit/ui/sidebar/no-remote-refs.test.ts and bundle-content.test.ts would fail ` +
        `for want of a bundle rather than for a real defect. Prefix each with ` +
        `\`npm run ${BUILD_SCRIPT} && \`. Do not re-guard those tests instead — see FR-R3-169 §3.`
    ).toEqual([]);
  });

  // Without these, the gate above passes just as happily when the resolver has
  // stopped resolving anything. Each asserts a fact measured on 2026-09-06.
  it('resolves the chains it claims to resolve', () => {
    expect(markersOf('ci', scripts)).toContain('host-suite');
    expect(markersOf('ci:fast', scripts)).toContain('host-suite');
    expect(markersOf('verify:all', scripts)).toContain('host-suite');
    expect(markersOf('verify:release', scripts)).toContain('host-suite');
    expect(markersOf(BUILD_SCRIPT, scripts)).toEqual(['build']);
  });

  it('recognises the host suite without mistaking narrower vitest runs for it', () => {
    expect(runsHostSuite('vitest run')).toBe(true);
    expect(runsHostSuite('vitest run --coverage')).toBe(true);
    expect(runsHostSuite('vitest run --config vitest.perf.config.ts')).toBe(false);
    expect(runsHostSuite('vitest run tests/perf/x.test.ts --reporter=verbose')).toBe(false);
    expect(runsHostSuite('tsc --noEmit')).toBe(false);
  });

  it('exempts only the primitive runners, and by shape rather than by name', () => {
    const exempt = Object.entries(scripts)
      .filter(([, body]) => isPrimitiveRunner(body))
      .map(([name]) => name)
      .sort();
    expect(exempt).toEqual(['test:coverage', 'test:host']);
  });

  it('would catch a script that runs the host suite with no build', () => {
    const planted = { ...scripts, 'probe:unbuilt': 'npm run test:host' };
    expect(offenders(planted).map((offender) => offender.script)).toContain('probe:unbuilt');
  });

  it('would catch a script that builds only after the suite has run', () => {
    const planted = { ...scripts, 'probe:late': `npm run test:host && npm run ${BUILD_SCRIPT}` };
    expect(offenders(planted).map((offender) => offender.script)).toContain('probe:late');
  });
});
