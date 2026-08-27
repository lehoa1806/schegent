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

/**
 * Comments and string contents removed, because this gate judges CONTROL FLOW and both of
 * those are prose.
 *
 * FR-R3-112 found it the honest way, twice in a row. A chain test whose comment said
 * "…without its cut record is a break" was reported as a counted poll because `POLLS`
 * matched the word `break` inside a sentence; with comments stripped, the very next
 * report came from the `it(...)` TITLE of the same test, which contains the same word. Both
 * loops do N units of work and cannot exit early.
 *
 * A gate that reads prose as control flow gets argued with until someone allowlists a real
 * defect to silence it, so it stops reading prose. String bodies are blanked rather than
 * removed so nothing on either side of them accidentally joins up into a new token.
 */
/**
 * Comments removed, STRING BODIES KEPT.
 *
 * The spawned-fixture check below needs the opposite of `codeOnly`: the loop it hunts lives
 * *inside* a shell command string, so blanking string bodies makes the check vacuous. Found by
 * mutation — reintroducing the exact unbounded loop that leaked for eight hours did not turn the
 * gate red, because `codeOnly` had already erased it.
 */
function withoutComments(body: string): string {
  return body.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

function codeOnly(body: string): string {
  return body
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/\/\/[^\n]*/g, ' ')
    .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replaceAll(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '``');
}

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

/** The detector, over lines already in memory, so a fixture can be judged without a file. */
function countedWaitsIn(file: string, lines: readonly string[]): readonly Offender[] {
  const found: Offender[] = [];
  lines.forEach((line, index) => {
    const match = COUNTED_LOOP.exec(line);
    if (!match) return;
    const body = codeOnly(lines.slice(index, index + BODY_LINES).join('\n'));
    if (YIELDS.test(body) && POLLS.test(body)) {
      found.push({ file, line: index + 1, cap: match[2] });
    }
  });
  return found;
}

function countedWaits(files: readonly string[]): readonly Offender[] {
  return files.flatMap((file) =>
    countedWaitsIn(file, readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n'))
  );
}

/** A real counted poll: bounded by a literal, yields to the scheduler, exits on a condition. */
const OFFENDING_FIXTURE = [
  'async function atGate(): Promise<boolean> {',
  '  for (let round = 0; round < 800; round++) {',
  '    if (reached()) return true;',
  '    await new Promise((r) => setImmediate(r));',
  '  }',
  '  return false;',
  '}'
];

/** The same shape with an elapsed-time bound, which is what the gate asks for. */
const COMPLIANT_FIXTURE = [
  'async function atGate(): Promise<boolean> {',
  '  const deadline = Date.now() + 10_000;',
  '  while (Date.now() < deadline) {',
  '    if (reached()) return true;',
  '    await new Promise((r) => setImmediate(r));',
  '  }',
  '  return false;',
  '}'
];

/**
 * FR-R3-114 row 3 — the OTHER shape of a load-sensitive wait: a bare sleep.
 *
 * `COUNTED_LOOP` above matches a loop. A test that writes `await new Promise((r) =>
 * setTimeout(r, 150))` and then asserts is not a loop, so eleven of them sat in the hermetic unit
 * tier — 130 ms, 150 ms, 250 ms, 500 ms, 750 ms — completely invisible to this gate. That is the
 * exact class `FR-R3-097` removed from the integration harnesses, walking back in through the tier
 * that claims hermeticity.
 *
 * A fixed sleep is wrong in both directions at once: too short on a loaded machine and the test
 * fails for reasons unrelated to the code; long enough to be safe there and every run pays it
 * forever. `state-projector.test.ts` slept 130 ms for a 100 ms debounce — a 30% margin against an
 * unbounded scheduler delay.
 *
 * THE THRESHOLD IS 100 ms, and it is a threshold rather than a ban because short sleeps are how a
 * test yields a turn, which is not a wait for anything.
 *
 * THE EXEMPTIONS ARE BY SITE AND EACH CARRIES A REASON. A sleep that is genuinely about ELAPSED
 * WALL CLOCK — letting a retention age threshold pass, letting a fake process take the time its
 * fixture says it takes — has no condition to poll, and converting it would replace a correct wait
 * with a poll for something that was never the point. What an exemption may not be is a way to add
 * a twelfth condition-wait: it is a claim about a specific line, and `still fires on a new bare
 * sleep` below proves an unlisted one is caught.
 */
const BARE_SLEEP = /await new Promise\([^)]*\)\s*=>\s*setTimeout\([^,]+,\s*([0-9_]+)\s*\)/;
const BARE_SLEEP_THRESHOLD_MS = 100;
const HERMETIC_TIER = 'tests/unit/';

/**
 * Sleeps that are about elapsed time, by file and line-anchoring text, each with its reason.
 *
 * Anchored on the surrounding call rather than the line number, so an edit above it does not
 * silently move an exemption onto a different sleep.
 */
const ELAPSED_TIME_SLEEPS: ReadonlyArray<{ file: string; ms: number; reason: string }> = [
  {
    file: 'tests/unit/metrics/metrics-rollup-durability.test.ts',
    ms: 250,
    reason:
      'measures whether a write SURVIVES a delay, which is the durability question itself; there ' +
      'is no condition that becoming true would end the wait early'
  },
  {
    file: 'tests/unit/runner/child-stdin-delivery.test.ts',
    ms: 250,
    reason:
      'a real child process is given time to consume stdin and exit; the fixture script sleeps, ' +
      'and the test is measuring that the host does not close the pipe first'
  },
  {
    file: 'tests/unit/runner/child-completion-tree.test.ts',
    ms: 200,
    reason: 'a real process tree is allowed to reach the state the test then inspects'
  },
  {
    file: 'tests/unit/platform/windows-sentinel.test.ts',
    ms: 500,
    reason: 'inside a FAKE sentinel script: the sleep is the fixture behaving like a process, not a wait'
  },
  {
    file: 'tests/unit/platform/windows-sentinel.test.ts',
    ms: 750,
    reason:
      'same fixture, the second simulated child: the 750 ms is the child\'s scripted lifetime, ' +
      'which is what the sentinel is being tested against'
  },
  {
    file: 'tests/unit/audit/audit-append-ordering.test.ts',
    ms: 500,
    reason:
      'the ordering barrier is defined in milliseconds; the test asserts what the barrier does ' +
      'when an append stays in flight PAST it, so the elapsed time is the subject'
  },
  {
    file: 'tests/unit/audit/retention.test.ts',
    ms: 120,
    reason:
      'lets a 50 ms retention age threshold actually elapse; an age bound cannot be polled into ' +
      'being reached sooner'
  }
];

function bareSleeps(files: readonly string[]): readonly Offender[] {
  const found: Offender[] = [];
  for (const file of files) {
    if (!file.startsWith(HERMETIC_TIER)) continue;
    const lines = readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = BARE_SLEEP.exec(codeOnly(line));
      if (!match) return;
      const ms = Number((match[1] as string).replaceAll('_', ''));
      if (!Number.isFinite(ms) || ms < BARE_SLEEP_THRESHOLD_MS) return;
      if (ELAPSED_TIME_SLEEPS.some((entry) => entry.file === file && entry.ms === ms)) return;
      found.push({ file, line: index + 1, cap: String(ms) });
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

  it('still fires on a real counted poll, so comment-stripping did not disable it', () => {
    // FR-R3-112 taught this gate to ignore comments and string bodies, after it reported the
    // word `break` inside a sentence and then inside a test title. Narrowing a detector is how
    // a detector gets switched off by accident, so the narrowing is checked from both sides:
    // the offending shape must still be caught, and the compliant shape must still pass.
    expect(countedWaitsIn('fixture.ts', OFFENDING_FIXTURE)).toHaveLength(1);
    expect(countedWaitsIn('fixture.ts', COMPLIANT_FIXTURE)).toEqual([]);
  });

  it('ignores a counted loop whose only `break` is in prose', () => {
    // The false positive itself, pinned. A loop that does N units of work with a sleep in it
    // is not a wait, however often the surrounding words say "break".
    const prose = [
      "  it('a removal with no cut record is a break', async () => {",
      '  for (let i = 0; i < 5; i++) {',
      '    await append(writer, i);',
      '    // the archive stamps must differ, so this is not a break-out condition',
      '    await new Promise((r) => setTimeout(r, 5));',
      '  }'
    ];
    expect(countedWaitsIn('fixture.ts', prose)).toEqual([]);
  });

  it('no bare sleep in the hermetic unit tier waits for a condition (FR-R3-114 row 3)', () => {
    const offenders = bareSleeps(scanFiles());
    expect(
      offenders.map((o) => `${o.file}:${o.line} (${o.cap} ms)`),
      'These sleep a fixed duration and then assert, in the tier that claims hermeticity. Use ' +
        '`waitForCondition` from `tests/wait-for-condition.ts`, which returns the moment the ' +
        'condition holds and fails at a deadline with the elapsed time and poll count. If the ' +
        'sleep is genuinely about elapsed wall clock, add it to ELAPSED_TIME_SLEEPS with the ' +
        'reason — a reason, not a line number.'
    ).toEqual([]);
  });

  it('still fires on a NEW bare sleep, and the exemptions are per-site', () => {
    // Mutation-verified (FR-142). Without this, adding an exemption for a whole file — or a regex
    // that stopped matching — would read exactly like compliance.
    const detected = bareSleeps.call(null, []);
    expect(detected).toEqual([]);
    const line = '    await new Promise((r) => setTimeout(r, 250));';
    expect(BARE_SLEEP.test(line), 'the detector must match the shape it exists for').toBe(true);
    expect(Number(BARE_SLEEP.exec(line)![1])).toBe(250);
    // A short yield is not a wait and must not be reported.
    expect(Number(BARE_SLEEP.exec('await new Promise((r) => setTimeout(r, 5));')![1])).toBeLessThan(
      BARE_SLEEP_THRESHOLD_MS
    );
  });

  it('lists no exemption for a sleep that is no longer there', () => {
    // An exemption pointing at nothing is a claim about a line that has moved or gone, and a stale
    // exemption is how a real defect gets silenced later.
    for (const entry of ELAPSED_TIME_SLEEPS) {
      const source = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      const sleeps = [...source.matchAll(new RegExp(BARE_SLEEP.source, 'g'))].map((m) =>
        Number((m[1] as string).replaceAll('_', ''))
      );
      expect(
        sleeps,
        `${entry.file} no longer contains a ${entry.ms} ms sleep; remove the exemption`
      ).toContain(entry.ms);
      expect(entry.reason.length, `${entry.file} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it('no spawned shell fixture loops without a bound', () => {
    // FR-R3-114 follow-up, and the only case here found by finding the corpses rather than by
    // reading. `process-tree.test.ts` spawned `( while true; do printf 'x' >> file; sleep 0.025;
    // done ) &` to demonstrate that killing a child leaves its grandchild alive — then cleaned up
    // with `process.kill(-child.pid)` on a child deliberately spawned WITHOUT its own process
    // group. The negative pid named a group that does not exist, the `catch` swallowed the
    // `ESRCH`, and every run of the file leaked one shell appending to a file forty times a
    // second, forever. Two were found alive on the development machine aged 8h22m and 3h24m.
    //
    // They are a plausible contributor to the load sensitivity this repository documents and
    // attributes to the machine: the timeouts a handful of runaway loops cause look exactly like
    // a busy laptop, and a day of development leaves a handful.
    //
    // An unbounded loop inside a spawned shell is therefore forbidden. A bounded one is fine —
    // the bound is what makes a missed cleanup survivable instead of permanent.
    const offenders: string[] = [];
    for (const file of scanFiles()) {
      const lines = readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        // `withoutComments`, not `codeOnly`: the loop lives inside a shell string.
        if (!/while\s+(true|:)\b/.test(withoutComments(line))) return;
        offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(
      offenders,
      'A shell fixture spawned with an unbounded loop outlives the test that made it. Bound the ' +
        'loop (`i=0; while [ $i -lt N ]`) AND capture its pid for cleanup — the pid is the ' +
        'mechanism, the bound is what makes a missed cleanup survivable.'
    ).toEqual([]);
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
