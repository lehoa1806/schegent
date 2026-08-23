import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARITY_CALL_SITE_COUNT } from '../unit/runner/spawn-env-parity.test';

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
 * WHY A SOURCE SCAN AND NOT A REGISTRY
 *
 * A runtime registry is exact, but it needs every invoker to enrol -- and a
 * forgotten enrolment is the *same defect class* as a forgotten policy. It would
 * reproduce this finding one level up. A scan catches a new call site with nobody
 * remembering anything; its weakness is matching a comment or a test file, which
 * stripping comments and scoping to `src/` closes.
 */

const SRC_ROOT = join(__dirname, '..', '..', 'src');

/** The single helper every call site must route its policy through. */
const POLICY_HELPER = 'policyRequestFields';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Files that call `.invoke(` on a runner, comments stripped. */
function invocationFiles(): Array<{ file: string; src: string }> {
  const found: Array<{ file: string; src: string }> = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    // The runner package defines `invoke`; it does not call one.
    if (file.includes(join('src', 'runner'))) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    if (/\.invoke\(/.test(src)) found.push({ file, src });
  }
  return found;
}

describe('every production invocation forwards the environment policy', () => {
  it('routes every call site through the shared policy helper', () => {
    const offenders: string[] = [];
    const sites = invocationFiles();
    for (const { file, src } of sites) {
      if (!src.includes(POLICY_HELPER)) offenders.push(file.slice(file.indexOf('src/')));
    }
    expect(
      offenders,
      'these files invoke a runner without routing a policy through the shared helper'
    ).toEqual([]);
    // Non-vacuity: a scan that matched nothing must be distinguishable from a scan
    // that verified everything.
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('covers the same call sites the parity test models', () => {
    // The two halves of the enumeration cross-check each other. Neither can
    // silently cover fewer sites than the other: the guard proves each site
    // forwards, the parity test proves forwarding produces the right environment,
    // and a drift between the two counts fails here.
    expect(invocationFiles().length).toBe(PARITY_CALL_SITE_COUNT);
  });

  it('fails on a seeded call site that forwards nothing', () => {
    // The failure path is observed, not assumed. A guard nobody has seen fire is
    // one nobody should trust.
    const seeded = 'const raw = await this.runner.invoke({ prompt: "/status" });';
    expect(/\.invoke\(/.test(stripComments(seeded))).toBe(true);
    expect(stripComments(seeded).includes(POLICY_HELPER)).toBe(false);
  });

  it('does not count a commented-out call site', () => {
    const commented = '// const raw = await this.runner.invoke({ prompt: "x" });';
    expect(/\.invoke\(/.test(stripComments(commented))).toBe(false);
  });
});
