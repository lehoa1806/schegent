// A wait must be bounded by elapsed time, not by a count of event-loop turns.
//
// THE DEFECT, TWICE. FR-R3-033 fixed `drainUntil` in
// `tests/integration/concurrent-run-harness.ts`, which gave up after a fixed
// number of rounds rather than after a duration. On 2026-08-23 the identical
// defect was found in `tests/integration/checkpoints/driver-harness.ts` —
// `atGate()`, `for (let round = 0; round < 800; round++)` with no sleep in the
// body. It had survived the first fix because nothing linked the two files.
//
// WHY IT IS A DEFECT AND NOT A STYLE PREFERENCE. A loop that yields with
// `setImmediate` and counts iterations measures how many times this process got
// scheduled. That is a property of what else the CPU is doing, so the loop is an
// instrument pointed at the machine rather than at the code. Under an unrelated
// ten-worker build on a ten-core box, `atGate()` failed while the run it was
// waiting for was perfectly healthy; on an idle machine the same code passed.
//
// Its own error message said so and nobody read it that way: "gave up after
// 10000ms and 7644 round(s)".
//
// FR-R3-097 CORRECTED THIS PARAGRAPH, and the correction is the more useful
// half. It used to end: "7,644 event-loop rounds is not a stalled run, it is a
// starved one — and keeping the round count alongside an elapsed-time bound is
// what lets a reader tell those apart." The second clause is true and the first
// is **backwards**. A round yields with `setImmediate` and then `setTimeout(…, 0)`,
// which Node clamps to one millisecond, so a round cannot cost less than ~1 ms —
// measured at 1.24 ms idle on a 10-core darwin box, and 2.23-2.34 ms with forty
// CPU workers running. 7,644 rounds in 10,000 ms is **1.31 ms per round**: that
// poller was running at full speed, not starving.
//
// So the round count discriminates only against a stated floor, and no file
// stated one — which is how the tree's single worked example came out inverted in
// three places at once. The floor and the verdict now live in
// `tests/integration/wait-diagnosis.ts`, and both harnesses report the
// classification instead of leaving the division to a reader with no baseline.
// This gate is unchanged: keeping the count is still right, and it is now worth
// something.
//
// WHAT IS ALLOWED. Loops that do N units of work (build 30 fixtures, feed 64
// chunks, drain 5 microtasks) are untouched — they are not waits, they cannot
// give up early, and their duration does not vary with load. What this forbids
// is specifically: bounded by a count, yields to the scheduler, and exits early
// on a polled condition. All three, together.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = [resolve(REPO_ROOT, 'src'), resolve(REPO_ROOT, 'tests')] as const;
const SELF = 'tests/lint/waits-are-bounded-by-time.test.ts';

const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll('\\', '/');

/** `for (let i = 0; i < 800; i++)` — a loop bounded by a literal count. */
const COUNTED_LOOP = /for \(let (\w+) = 0; \1 < (\d+); \1\+\+\)/;
/** The body hands control back to the event loop. */
const YIELDS = /await new Promise[^;]*(setImmediate|setTimeout)/;
/** The body stops early once something it is watching becomes true. */
const POLLS = /\b(break|return)\b/;

/** How far past the `for` line to read when judging the body. */
const BODY_LINES = 16;

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly cap: string;
}

function scanFiles(): readonly string[] {
  return SCAN_ROOTS.flatMap((root) => filesUnder(root, { extensions: ['.ts'] }))
    .map(rel)
    .filter((file) => file !== SELF)
    .sort();
}

function countedWaits(files: readonly string[]): readonly Offender[] {
  const found: Offender[] = [];
  for (const file of files) {
    const lines = readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = COUNTED_LOOP.exec(line);
      if (!match) return;
      const body = lines.slice(index, index + BODY_LINES).join('\n');
      if (YIELDS.test(body) && POLLS.test(body)) {
        found.push({ file, line: index + 1, cap: match[2] });
      }
    });
  }
  return found;
}

describe('a wait is bounded by elapsed time', () => {
  it('scans both source trees, so a broken scan cannot read as compliance', () => {
    const files = scanFiles();
    expect(
      files.length,
      `No .ts files found under ${SCAN_ROOTS.join(' or ')}. The assertion below is ` +
        `passing over an empty file list.`
    ).toBeGreaterThan(800);
  });

  it('no loop waits by counting event-loop turns', () => {
    const offenders = countedWaits(scanFiles());
    expect(
      offenders.map((o) => `${o.file}:${o.line} (cap ${o.cap})`),
      `These wait for a condition but give up after a fixed number of iterations ` +
        `rather than after a duration:\n  ` +
        offenders.map((o) => `${o.file}:${o.line} (cap ${o.cap})`).join('\n  ') +
        `\n\nUse a deadline: \`const deadline = Date.now() + MS; while (Date.now() < ` +
        `deadline) { ... }\`, and keep a round counter in the failure message. A ` +
        `count of iterations measures how often this process was scheduled, which ` +
        `is a property of machine load rather than of the code under test.`
    ).toEqual([]);
  });

  it('recognises the two real instances, and spares loops that are not waits', () => {
    // Both offenders below are the code as it actually stood, verbatim. Without
    // this, a detector that stops matching is indistinguishable from a tree with
    // no offenders — and this gate currently has zero in-tree offenders, so it
    // has nothing else to prove itself against.
    const atGate = [
      '      for (let round = 0; round < 800; round++) {',
      '        if (parked.some((e) => e.runId === runId)) {',
      '          return;',
      '        }',
      '        await new Promise((r) => setImmediate(r));',
      '      }'
    ].join('\n');
    const drainUntil = [
      '  for (let i = 0; i < 800; i++) {',
      '    if (settled()) break;',
      '    await new Promise((r) => setTimeout(r, 0));',
      '  }'
    ].join('\n');
    for (const source of [atGate, drainUntil]) {
      expect(COUNTED_LOOP.test(source)).toBe(true);
      expect(YIELDS.test(source)).toBe(true);
      expect(POLLS.test(source)).toBe(true);
    }

    // Not waits. A counted loop that builds fixtures, feeds chunks, or drains a
    // known number of microtasks is deterministic under load and stays legal —
    // a rule that flagged these would be noise, and noise gets suppressed.
    const buildsFixtures = [
      '    for (let index = 0; index < 30; index++) {',
      "      manyBadFields[`unknownField${index}`] = 'x';",
      '    }'
    ].join('\n');
    const drainsMicrotasks = '    for (let i = 0; i < 5; i++) await Promise.resolve();';
    for (const source of [buildsFixtures, drainsMicrotasks]) {
      expect(COUNTED_LOOP.test(source)).toBe(true);
      expect(YIELDS.test(source) && POLLS.test(source)).toBe(false);
    }
  });
});
