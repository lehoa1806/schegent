import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
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

const SRC_DIR = join(__dirname, '..', '..', 'src');
const HELPER = 'writePromptToStdin';
/** The helper itself is where the raw write legitimately lives. */
const HELPER_FILE = join('runner', 'child-stdin.ts');

/**
 * A raw write or close on a child's stdin, through any of the three accessor
 * forms TypeScript allows: plain, optional-chained, and non-null-asserted.
 *
 * `!` is not hypothetical here: `child.stdout!` and `child.stderr!` are the
 * idiom both runners already use for the sibling pipes, so `child.stdin!.write(
 * request.prompt)` is the shape a fourth backend is most likely to be written
 * in — and a gate that missed it would pass the exact uncaught-EPIPE host crash
 * it exists to forbid.
 */
const RAW_STDIN_WRITE = /\bstdin\s*[!?]?\.\s*(?:write|end)\s*\(/;

/**
 * Every `.ts` file under `src`, as a path relative to `src`.
 *
 * The whole tree, not `src/runner` alone: the gate's premise is that no stdin
 * write exists anywhere in `src`, and a fifth backend is as likely to be filed
 * under a new subdirectory as beside the existing four. A gate that only reads
 * one flat directory passes a runner written one level down, which is the same
 * uncaught-EPIPE host crash with a different path.
 */
function sourceFiles(dir: string = SRC_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(relative(SRC_DIR, full));
  }
  return found;
}

describe('stdin writes route through the shared helper', () => {
  it('no runner writes to child stdin outside the helper', () => {
    const offenders: string[] = [];
    let writeSites = 0;

    for (const file of sourceFiles()) {
      if (file === HELPER_FILE) continue;
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
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
    // Every accessor form, because a gate that only knows one of them is a gate
    // the next author walks past without noticing.
    expect(RAW_STDIN_WRITE.test('child.stdin.write(request.prompt);')).toBe(true);
    expect(RAW_STDIN_WRITE.test('child.stdin!.write(request.prompt); child.stdin!.end();')).toBe(true);
    const corrected = 'const delivery = await writePromptToStdin(child, request.prompt);';
    expect(RAW_STDIN_WRITE.test(corrected)).toBe(false);
  });

  it('no production call site selects the completion boundary (M-01)', () => {
    // FR-R3-047 (M-01) — `waitForChildCompletion(child, outputSink !== undefined)`
    // let a privacy setting decide whether the runner settled on `exit` or waited
    // for `close`. The parameter still exists because this helper's own tests pass
    // it; what makes the regression unrepresentable is this rule.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
      for (const line of source.split('\n')) {
        if (!line.includes('waitForChildCompletion(')) continue;
        // Declaration and default live in the helper; a call with a second
        // argument anywhere else in src does not.
        if (file === join('runner', 'child-completion.ts')) continue;
        if (/waitForChildCompletion\(\s*child\s*\)/.test(line)) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
