// Feature 107 (T618, FR-021, FR-022, SC-005) — nothing the model prints may
// arm a SIGTERM.
//
// `claude-cli.ts` can grace-terminate a live CLI process. Feature 030 BUG-002
// armed that on a substring scan of accumulated stdout for the audit-log close
// marker, so a model quoting a prior phase's block mid-turn could arm a kill
// against itself. `e2bf9ad` (2026-08-01) replaced the scan with a check on the
// stream-json `{"type":"result"}` envelope, which content cannot forge because
// the CLI harness — not the model — emits it. That fix was never pinned, and
// the field, comments, and 14 test arguments went on describing the substring
// as live for five months.
//
// So the gate forbids the *mechanism*, not the identifier (plan D6). Renaming
// `completionMarker` to `phaseDoneSentinel` and scanning for that would pass a
// grep for the old name and fail here:
//
//   1. No substring/regex search over accumulated stdout anywhere in the file.
//      The whole-buffer scans that legitimately exist run in the *parser*, over
//      a finished string, where a wrong answer is a misclassification rather
//      than a signal to a live process.
//   2. Every assignment of `sawCompletionMarker = true` is guarded by
//      `isTerminalResultLine`, and that predicate reads a parsed envelope's
//      `type` field rather than testing the raw line for a substring.
//   3. `InvocationRequest` carries no marker/sentinel field for a caller to
//      supply, so the coupling cannot be rebuilt from the phase layer.
//
// Each matcher is proved against known-bad text below, per the precedent in
// `no-vsix-allowlist-update-mode.test.ts`: a pattern that silently stops
// matching must fail here rather than ship as a comment.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'runner', 'claude-cli.ts');
const REQUEST_PATH = join(REPO_ROOT, 'src', 'runner', 'invocation-result.ts');

/**
 * A substring or pattern search applied to something that reads like an
 * accumulated buffer rather than a single parsed line.
 */
const BUFFER_SEARCH =
  /\b\w*(stdout|stderr|buffer|accumulated|output|transcript|chunks?|text)\w*\s*\.\s*(includes|indexOf|search|match|lastIndexOf|endsWith|startsWith)\s*\(/i;

/** A field a caller could use to inject a control sentinel. */
const SENTINEL_FIELD = /^\s*(completionMarker|\w*(marker|sentinel|terminator|doneToken)\w*)\??\s*:/i;

function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));
}

const cliSource = readFileSync(CLI_PATH, 'utf8');
const cliLines = codeLines(cliSource);

describe('the runner never searches accumulated output (FR-021)', () => {
  it('claude-cli.ts applies no substring search to a stdout buffer', () => {
    expect(cliLines.filter((line) => BUFFER_SEARCH.test(line))).toEqual([]);
  });

  it('the buffer-search matcher matches an offending line', () => {
    // The mechanism as it stood before e2bf9ad, and three ways to rebuild it.
    expect(BUFFER_SEARCH.test('if (stdoutAccumulated.includes(request.completionMarker)) {')).toBe(true);
    expect(BUFFER_SEARCH.test('const at = accumulatedOutput.indexOf(sentinel);')).toBe(true);
    expect(BUFFER_SEARCH.test('if (transcriptText.match(DONE_RE)) arm();')).toBe(true);
    expect(BUFFER_SEARCH.test('return stdoutBuffer.endsWith(marker);')).toBe(true);
    // And does not fire on the per-line envelope reads that are the fix.
    expect(BUFFER_SEARCH.test("return record.type === 'result';")).toBe(false);
    expect(BUFFER_SEARCH.test('if (isTerminalResultLine(stdoutLineBuffer)) {')).toBe(false);
    expect(BUFFER_SEARCH.test('const parsed = JSON.parse(line) as unknown;')).toBe(false);
  });
});

describe('arming is reachable only from a parsed result envelope (FR-022)', () => {
  const armingLines = cliLines.filter((line) => /sawCompletionMarker\s*=\s*true/.test(line));

  it('the arming assignment exists exactly once', () => {
    // A count, so a second arming site added elsewhere fails here rather than
    // inheriting this test's guarantee about the first.
    expect(armingLines).toHaveLength(1);
  });

  it('the sole arming assignment sits inside the isTerminalResultLine branch', () => {
    const lines = cliSource.split('\n');
    const armIndex = lines.findIndex((line) => /sawCompletionMarker\s*=\s*true/.test(line));
    expect(armIndex).toBeGreaterThan(-1);

    // Walk back to the nearest enclosing predicate. `isTerminalResultLine` must
    // be the one that opens the block the assignment is in.
    const preceding = lines.slice(0, armIndex).reverse();
    const guard = preceding.find((line) => /^\s*(\}\s*else\s*)?if\s*\(/.test(line));
    expect(guard).toMatch(/isTerminalResultLine\(|replayingHistory/);
  });

  it('isTerminalResultLine decides on a parsed field, not on a raw substring', () => {
    const body = cliSource.slice(
      cliSource.indexOf('function isTerminalResultLine'),
      cliSource.indexOf('function isSessionInitLine')
    );
    expect(body).toContain('JSON.parse(line)');
    expect(body).toContain("record.type === 'result'");
    // The property that makes the envelope unforgeable: the decision is made on
    // a structural field of a harness-emitted line, so nothing inside a
    // message's content can produce it.
    expect(codeLines(body).filter((line) => BUFFER_SEARCH.test(line))).toEqual([]);
  });
});

describe('no caller can supply a control sentinel (FR-020)', () => {
  const requestBlock = (() => {
    const source = readFileSync(REQUEST_PATH, 'utf8');
    const start = source.indexOf('export interface InvocationRequest');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('export interface RawInvocationOutput'));
  })();

  it('InvocationRequest declares no marker or sentinel field', () => {
    expect(codeLines(requestBlock).filter((line) => SENTINEL_FIELD.test(line))).toEqual([]);
  });

  it('the sentinel-field matcher matches an offending declaration', () => {
    expect(SENTINEL_FIELD.test('  completionMarker?: string;')).toBe(true);
    expect(SENTINEL_FIELD.test('  phaseDoneSentinel: string;')).toBe(true);
    expect(SENTINEL_FIELD.test('  stopMarker?: string;')).toBe(true);
    // Fields the request legitimately carries.
    expect(SENTINEL_FIELD.test('  timeoutMs: number;')).toBe(false);
    expect(SENTINEL_FIELD.test('  resumeSessionId?: string;')).toBe(false);
    expect(SENTINEL_FIELD.test('  effectiveFatalSignatures?: ReadonlyArray<EffectiveSignature>;')).toBe(
      false
    );
  });

  it('nothing in the tree still passes a completion marker to the runner', () => {
    // The dead argument at phase-runner.ts:444 read as a live coupling for five
    // months and is what sent FR-R3-023's author looking for a reader.
    const runner = readFileSync(join(REPO_ROOT, 'src', 'controller', 'phase-runner.ts'), 'utf8');
    expect(codeLines(runner).filter((line) => /completionMarker\s*:/.test(line))).toEqual([]);
  });
});
