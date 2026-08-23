import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-047 (H-04) — a prompt may only reach a child's stdin through the shared
 * attach-then-write helper.
 *
 * Why a gate and not just a fix: the defect was never "one runner forgot". No
 * `stdin` `'error'` listener existed anywhere in `src` (verified count: zero),
 * because the pattern had never been established. The review's own modernization
 * table freezes new backends until the containment work lands — which is exactly
 * when a fourth runner gets written, against whatever the code then models.
 *
 * The unit is the WRITE SITE, not the runner class. Measured: two write sites
 * (`claude-cli.ts`, `process-lifecycle-runner.ts`) serve four backends, because
 * `agy-cli.ts` and `codex-cli.ts` delegate to the generic runner and correctly
 * contain no write of their own. A gate enumerating runner classes would demand a
 * handler in two files that must not have one.
 */

const RUNNER_DIR = join(__dirname, '..', '..', 'src', 'runner');
const HELPER = 'writePromptToStdin';
/** The helper itself is where the raw write legitimately lives. */
const HELPER_FILE = 'child-stdin.ts';

/** A raw write or close on a child's stdin, with or without optional chaining. */
const RAW_STDIN_WRITE = /\bstdin\s*\??\.\s*(?:write|end)\s*\(/;

function runnerFiles(): string[] {
  return readdirSync(RUNNER_DIR).filter((f) => f.endsWith('.ts'));
}

describe('stdin writes route through the shared helper', () => {
  it('no runner writes to child stdin outside the helper', () => {
    const offenders: string[] = [];
    let writeSites = 0;

    for (const file of runnerFiles()) {
      if (file === HELPER_FILE) continue;
      const source = readFileSync(join(RUNNER_DIR, file), 'utf8');
      const writesRaw = RAW_STDIN_WRITE.test(source);
      const usesHelper = source.includes(HELPER);
      if (usesHelper) writeSites += 1;
      if (writesRaw) offenders.push(file);
    }

    expect(offenders).toEqual([]);
    // Non-vacuity: a gate that matched nothing must be distinguishable from a gate
    // that verified everything. Two write sites exist today; if this ever reads
    // zero, the gate has stopped looking rather than started passing.
    expect(writeSites).toBeGreaterThanOrEqual(2);
  });

  it('fails on a seeded fixture of its own defect class', () => {
    // The failure path is observed, not assumed. An allowlist or a gate nobody has
    // seen fire is one nobody should trust.
    const seeded = 'child.stdin?.write(request.prompt); child.stdin?.end();';
    expect(RAW_STDIN_WRITE.test(seeded)).toBe(true);
    const corrected = 'const delivery = await writePromptToStdin(child, request.prompt);';
    expect(RAW_STDIN_WRITE.test(corrected)).toBe(false);
  });

  it('no production call site selects the completion boundary (M-01)', () => {
    // FR-R3-047 (M-01) — `waitForChildCompletion(child, outputSink !== undefined)`
    // let a privacy setting decide whether the runner settled on `exit` or waited
    // for `close`. The parameter still exists because this helper's own tests pass
    // it; what makes the regression unrepresentable is this rule.
    const offenders: string[] = [];
    for (const file of runnerFiles()) {
      const source = readFileSync(join(RUNNER_DIR, file), 'utf8');
      for (const line of source.split('\n')) {
        if (!line.includes('waitForChildCompletion(')) continue;
        // Declaration and default live in the helper; a call with a second
        // argument anywhere in src/runner does not.
        if (file === 'child-completion.ts') continue;
        if (/waitForChildCompletion\(\s*child\s*\)/.test(line)) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
