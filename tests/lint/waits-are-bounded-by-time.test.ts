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
/** The body hands control back to the event loop (bare promise or sleep wrapper). */
const YIELDS = /(?:await new Promise[^;]*(setImmediate|setTimeout)|\bawait\s+(?:waitMs|sleep|sleepMs|delay|delayMs|pauseMs)\s*\()/;
/** The body stops early once something it is watching becomes true. */
const POLLS = /\b(break|return)\b/;
/**
 * FR-R7-18 (N06) — step-sum deadline loops (`for (let waited = 0; waited < 3_000 ...; waited += 25)`
 * or `while (waited < 3_000) { ... waited += 25; }`). Summing fixed sleep steps simulates a wall
 * clock by counting scheduler wakeups: under load each step overruns, so the synthetic budget
 * stretches unpredictably while hiding elapsed wall time and round counts.
 */
const STEP_SUM_FOR = /for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;[^;]*\1\s*<=?[^;]*;\s*\1\s*\+=\s*([^)]+)\)/;
const STEP_SUM_WHILE = /while\s*\(([^)]+)\)/;
const STEP_SUM_TIME_VAR = /^(?:waited|elapsed|elapsedMs|waitedMs|totalWait|timeWaited|waitMs)$/i;
const STEP_SUM_YIELDS = /(?:setTimeout|setImmediate|\bawait\s+(?:waitMs|sleep|sleepMs|delay|delayMs|pauseMs|pause)\s*\([^)]+\))/;
const WALL_CLOCK_BOUND = /\b(?:Date|performance)\.now\s*\(\)/;

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

/**
 * FR-R7-18 (N06) — detect step-sum deadline loops (`for (let waited = 0; ...; waited += 25)` and
 * `while (waited < N) { ... waited += 25; }`) that yield to the event loop instead of checking
 * `Date.now()` / `performance.now()` or delegating to `waitForCondition`.
 */
function stepSumWaitsIn(file: string, lines: readonly string[]): readonly Offender[] {
  const found: Offender[] = [];
  let localWrapperYield: RegExp | null | undefined;
  const yieldsIn = (body: string): boolean => {
    if (STEP_SUM_YIELDS.test(body)) return true;
    if (localWrapperYield === undefined) {
      const names = new Set<string>();
      for (const match of codeOnly(lines.join('\n')).matchAll(LOCAL_SLEEP_WRAPPER_DEF)) {
        const name = match[1] || match[2];
        if (name) names.add(name);
      }
      localWrapperYield =
        names.size > 0 ? new RegExp(`\\bawait\\s+(?:${[...names].join('|')})\\s*\\([^)]+\\)`) : null;
    }
    return localWrapperYield !== null && localWrapperYield.test(body);
  };

  lines.forEach((line, index) => {
    const forQuick = STEP_SUM_FOR.test(line);
    const whileQuick = !forQuick && STEP_SUM_WHILE.test(line);
    if (!forQuick && !whileQuick) return;

    const cleanLine = codeOnly(line);
    const forMatch = STEP_SUM_FOR.exec(cleanLine);
    if (forMatch) {
      const loopVar = forMatch[1] as string;
      const step = (forMatch[2] as string).trim();
      if (step === '1' && !STEP_SUM_TIME_VAR.test(loopVar)) return;
      const body = codeOnly(lines.slice(index, index + BODY_LINES).join('\n'));
      if (yieldsIn(body)) {
        found.push({ file, line: index + 1, cap: `${loopVar} += ${step}` });
      }
      return;
    }

    const whileMatch = STEP_SUM_WHILE.exec(cleanLine);
    if (whileMatch) {
      const condition = whileMatch[1] as string;
      if (WALL_CLOCK_BOUND.test(condition)) return;
      const varMatch = /\b(\w+)\s*<=?/.exec(condition);
      if (!varMatch) return;
      const loopVar = varMatch[1] as string;
      const body = codeOnly(lines.slice(index, index + BODY_LINES).join('\n'));
      if (!yieldsIn(body)) return;
      const incMatch = new RegExp(`\\b${loopVar}\\s*\\+=\\s*([^;\\s)]+)`).exec(body);
      if (!incMatch) return;
      const step = (incMatch[1] as string).trim();
      if (step !== '1' || STEP_SUM_TIME_VAR.test(loopVar)) {
        found.push({ file, line: index + 1, cap: `${loopVar} += ${step}` });
      }
    }
  });
  return found;
}

function stepSumWaits(files: readonly string[]): readonly Offender[] {
  return files.flatMap((file) =>
    stepSumWaitsIn(file, readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n'))
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
 * FR-R3-114 row 3 & FR-R7-18 (N06) — the OTHER shape of a load-sensitive wait: a fixed sleep
 * (bare `await new Promise(...setTimeout...)` OR a sleep wrapper such as `waitMs`, `sleep`,
 * `delay`, or any file-local helper wrapping `new Promise(...setTimeout...)`).
 *
 * `COUNTED_LOOP` above matches a loop. A test that writes `await new Promise((r) =>
 * setTimeout(r, 150))`, `await waitMs(150 + FLUSH_PAD_MS)`, or `await sleep(250)` and then
 * asserts is not a loop, so fixed condition-waits walked past the original gate in both
 * `tests/unit/` and `tests/integration/`.
 *
 * A fixed sleep is wrong in both directions at once: too short on a loaded machine and the test
 * fails for reasons unrelated to the code; long enough to be safe there and every run pays it
 * forever. `state-projector.test.ts` slept 130 ms for a 100 ms debounce — a 30% margin against an
 * unbounded scheduler delay.
 *
 * THE THRESHOLD IS 100 ms, and it is a threshold rather than a ban because short sleeps are how a
 * test yields a turn, which is not a wait for anything.
 *
 * THE COVERAGE IS BOTH `tests/unit/` AND `tests/integration/`. Every Vitest integration suite in
 * `tests/integration/` now sits at zero unexempted `>= 100 ms` sleeps; the only integration
 * entries in `ELAPSED_TIME_SLEEPS` below are real VS Code extension-host pollers and the
 * untrusted-workspace negative-observation grace window.
 *
 * THE EXEMPTIONS ARE BY SITE AND EACH CARRIES A REASON. A sleep that is genuinely about ELAPSED
 * WALL CLOCK — letting a real child process act, measuring durability across a delay, or polling
 * an out-of-band VS Code host inside a deadline loop — has no faster fake-clock substitute. What
 * an exemption may not be is a way to smuggle in a condition-wait: every entry is pinned by file
 * and duration, and `lists no exemption for a sleep that is no longer there` guarantees the
 * allowlist can only shrink.
 */
const BARE_SLEEP = /await\s+new\s+Promise(?:\s*<[^>]+>)?\s*\(\s*\(?[^)]*\)?\s*=>\s*\{?\s*setTimeout\s*\([^,]+,\s*([^)]+)\)/;
const SLEEP_WRAPPER_CALL = /\bawait\s+(?:waitMs|sleep|sleepMs|delay|delayMs|pauseMs)\s*\(\s*([^)]+)\)/;
const LOCAL_SLEEP_WRAPPER_DEF = /(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=)\s*\([^)]*\)(?:\s*:\s*Promise<[^>]+>)?\s*(?:=>|\{)[\s\S]{0,160}?new\s+Promise(?:\s*<[^>]+>)?\s*\(\s*\(?[^)]*\)?\s*=>\s*\{?\s*(?:return\s+)?setTimeout\s*\(/g;
const BARE_SLEEP_THRESHOLD_MS = 100;
const SLEEP_SCAN_TIERS = ['tests/unit/', 'tests/integration/'] as const;

/**
 * Sleeps that are genuinely about elapsed time, real child-process lifetimes, or real VS Code host
 * deadline-bounded polling, by file and resolved duration, each with its reason.
 *
 * Anchored on the file + duration rather than the line number, so an edit above it does not
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
    file: 'tests/unit/runner/child-stdin-line-channel.test.ts',
    ms: 100,
    reason:
      'real child stdin channel test: pauses between consecutive line writes on an open child ' +
      'pipe so multi-turn delivery is exercised across distinct reads before EOF'
  },
  {
    file: 'tests/unit/runner/child-stdin-line-channel.test.ts',
    ms: 250,
    reason:
      'FAULT_SETTLE_MS negative-observation window after a real child destroys stdin and exits, ' +
      'confirming no late uncaught EPIPE fault surfaces on the host process'
  },
  {
    file: 'tests/unit/runner/child-completion-tree.test.ts',
    ms: 200,
    reason: 'a real process tree is allowed to reach the state the test then inspects'
  },
  {
    file: 'tests/unit/runner/process-tree.test.ts',
    ms: 150,
    reason:
      'real POSIX process-tree test: lets the spawned grandchild append to its sentinel file ' +
      'or settle after direct-child SIGKILL before sampling file growth or liveness'
  },
  {
    file: 'tests/unit/runner/process-tree.test.ts',
    ms: 200,
    reason:
      'real POSIX process-tree test: gives the spawned shell + grandchild time to start appending ' +
      'or flush post-SIGKILL state before inspecting the sentinel byte count'
  },
  {
    file: 'tests/unit/runner/process-tree.test.ts',
    ms: 250,
    reason:
      'real POSIX process-tree test: elapsed-time observation window verifying a surviving ' +
      'grandchild keeps writing or a signalled group stays gone'
  },
  {
    file: 'tests/unit/runner/process-tree.test.ts',
    ms: 300,
    reason:
      'real POSIX process-tree negative-observation window confirming zero additional sentinel ' +
      'bytes are written after signalProcessTree terminates the process group'
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
    file: 'tests/unit/setup/descriptor-leak-control.test.ts',
    ms: 100,
    reason:
      'FR-R3-137 — not a wait in this process: the line is inside the source string of a spawned ' +
      'child, and it is that child\'s lifetime. Node emits the descriptor warning on a tick AFTER ' +
      'the collector runs, so a child that exits the instant it drops the handle leaks silently — ' +
      'measured, five runs, zero warnings without it. Nothing here polls a condition; the ' +
      'assertions read the exited child\'s stderr'
  },
  {
    file: 'tests/integration/activation-eager.host.test.ts',
    ms: 100,
    reason:
      'real VS Code host test: POLL_INTERVAL_MS inside a Date.now()-bounded activation poll loop ' +
      'reporting rounds, elapsedMs, and diagnoseWait() starvation classification'
  },
  {
    file: 'tests/integration/multi-root.host.test.ts',
    ms: 100,
    reason:
      'real VS Code host test: POLL_INTERVAL_MS inside a Date.now()-bounded audit-log poll loop ' +
      'reporting rounds, elapsedMs, and diagnoseWait() starvation classification'
  },
  {
    file: 'tests/integration/trust-leg-support.ts',
    ms: 100,
    reason:
      'real VS Code host helper: POLL_INTERVAL_MS inside waitUntilWithStats Date.now()-bounded ' +
      'poll loop reporting rounds, elapsedMs, and diagnoseWait() starvation classification'
  },
  {
    file: 'tests/integration/trust-untrusted-workspace.host.test.ts',
    ms: 3000,
    reason:
      'real VS Code host negative-observation grace window (SPAWN_GRACE_MS): holds after command ' +
      'refusals settle so any delayed background Stage 2 election or CLI probe spawn would surface; ' +
      'there is no completion event for work that must never run'
  }
];

function collectUniqueNumericConsts(cleanSource: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const values = new Map<string, number>();
  const pattern = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*number)?\s*=\s*([0-9][0-9_]*)\s*;/g;
  for (const match of cleanSource.matchAll(pattern)) {
    const name = match[1] as string;
    const value = Number((match[2] as string).replaceAll('_', ''));
    if (!Number.isFinite(value)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    values.set(name, value);
  }
  const unique = new Map<string, number>();
  for (const [name, count] of counts) {
    if (count === 1) unique.set(name, values.get(name)!);
  }
  return unique;
}

function evaluateSleepMs(expr: string, consts: ReadonlyMap<string, number>): number | null {
  const cleaned = expr.trim();
  if (/^[0-9][0-9_]*$/.test(cleaned)) {
    const n = Number(cleaned.replaceAll('_', ''));
    return Number.isFinite(n) ? n : null;
  }
  const resolved = consts.get(cleaned);
  if (resolved !== undefined) return resolved;
  // Purely additive duration expressions (e.g. `150 + FLUSH_PAD_MS`): sum known non-negative terms.
  if (cleaned.includes('+') && !/[-/%?]/.test(cleaned)) {
    let sum = 0;
    let resolvedAny = false;
    for (const part of cleaned.split('+').map((p) => p.trim())) {
      if (/^[0-9][0-9_]*$/.test(part)) {
        sum += Number(part.replaceAll('_', ''));
        resolvedAny = true;
      } else if (consts.has(part)) {
        sum += consts.get(part)!;
        resolvedAny = true;
      }
    }
    return resolvedAny ? sum : null;
  }
  return null;
}

interface DetectedSleep {
  readonly file: string;
  readonly line: number;
  readonly ms: number;
  readonly kind: 'bare' | 'wrapper';
}

function fixedSleepsInSource(file: string, source: string): readonly DetectedSleep[] {
  const cleanWhole = codeOnly(source);
  const consts = collectUniqueNumericConsts(cleanWhole);
  const localWrappers = new Set<string>();
  for (const match of cleanWhole.matchAll(LOCAL_SLEEP_WRAPPER_DEF)) {
    const name = match[1] || match[2];
    if (name) localWrappers.add(name);
  }
  const localWrapperCall =
    localWrappers.size > 0
      ? new RegExp(`\\bawait\\s+(?:${[...localWrappers].join('|')})\\s*\\(\\s*([^)]+)\\)`)
      : null;

  const detected: DetectedSleep[] = [];
  source.split('\n').forEach((line, index) => {
    const cleanLine = codeOnly(line);
    const bareMatch = BARE_SLEEP.exec(cleanLine);
    if (bareMatch) {
      const ms = evaluateSleepMs(bareMatch[1] as string, consts);
      if (ms !== null && ms >= BARE_SLEEP_THRESHOLD_MS) {
        detected.push({ file, line: index + 1, ms, kind: 'bare' });
      }
      return;
    }
    const wrapperMatch =
      SLEEP_WRAPPER_CALL.exec(cleanLine) ?? (localWrapperCall ? localWrapperCall.exec(cleanLine) : null);
    if (wrapperMatch) {
      const ms = evaluateSleepMs(wrapperMatch[1] as string, consts);
      if (ms !== null && ms >= BARE_SLEEP_THRESHOLD_MS) {
        detected.push({ file, line: index + 1, ms, kind: 'wrapper' });
      }
    }
  });
  return detected;
}

function bareSleeps(files: readonly string[]): readonly Offender[] {
  const found: Offender[] = [];
  for (const file of files) {
    if (!SLEEP_SCAN_TIERS.some((tier) => file.startsWith(tier))) continue;
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    for (const sleep of fixedSleepsInSource(file, source)) {
      if (ELAPSED_TIME_SLEEPS.some((entry) => entry.file === file && entry.ms === sleep.ms)) continue;
      found.push({ file, line: sleep.line, cap: `${sleep.ms} ms (${sleep.kind})` });
    }
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

  it('no unexempted fixed sleep or sleep wrapper waits for a condition across unit and integration tiers (FR-R3-114 row 3, FR-R7-18 N06)', () => {
    const offenders = bareSleeps(scanFiles());
    expect(
      offenders.map((o) => `${o.file}:${o.line} (${o.cap})`),
      'These sleep a fixed duration (>= 100 ms) via bare `setTimeout` or a sleep wrapper across ' +
        '`tests/unit/` or `tests/integration/`. Use controllable clocks, deferred barriers, or ' +
        '`waitForCondition` from `tests/wait-for-condition.ts`, which returns the moment the ' +
        'condition holds and fails at a deadline with elapsed time and poll count. If the sleep ' +
        'is genuinely about elapsed wall clock or real host/child lifetimes, add a narrow entry ' +
        'to ELAPSED_TIME_SLEEPS with the reason — a reason, not a line number.'
    ).toEqual([]);
  });

  it('still fires on bare sleeps, named wrappers, local wrappers, and expression/const durations', () => {
    // Mutation-verified (FR-142, FR-R7-18 N06). Without this, a regex that stops matching — or a
    // sleep hidden behind `waitMs`, `sleep`, `delay`, a local arrow helper, or a numeric const —
    // would read identically to compliance.
    expect(bareSleeps.call(null, [])).toEqual([]);

    const sample = [
      'const FLUSH_PAD_MS = 50;',
      'const LADDER_SETTLE_MS = 250;',
      'const customNap = (ms: number) => new Promise((r) => setTimeout(r, ms));',
      'async function run(): Promise<void> {',
      '  await new Promise((r) => setTimeout(r, 250));',
      '  await new Promise<void>((resolve) => setTimeout(resolve, 150));',
      '  await waitMs(150 + FLUSH_PAD_MS);',
      '  await sleep(LADDER_SETTLE_MS);',
      '  await delay(120);',
      '  await customNap(200);',
      '  // Short yields (< 100 ms) are not waits and must stay legal.',
      '  await new Promise((r) => setTimeout(r, 5));',
      '  await waitMs(10);',
      '  await customNap(25);',
      '}'
    ].join('\n');

    expect(
      fixedSleepsInSource('fixture.ts', sample).map((s) => `${s.kind}:${s.ms}`)
    ).toEqual([
      'bare:250',
      'bare:150',
      'wrapper:200',
      'wrapper:250',
      'wrapper:120',
      'wrapper:200'
    ]);
  });

  it('lists no exemption for a sleep that is no longer there', () => {
    // An exemption pointing at nothing is a claim about a line that has moved or gone, and a stale
    // exemption is how a real defect gets silenced later.
    for (const entry of ELAPSED_TIME_SLEEPS) {
      const source = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      const sleeps = fixedSleepsInSource(entry.file, source).map((s) => s.ms);
      expect(
        sleeps,
        `${entry.file} no longer contains a ${entry.ms} ms sleep; remove the exemption`
      ).toContain(entry.ms);
      expect(entry.reason.length, `${entry.file} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it('no loop simulates a deadline by summing sleep steps (FR-R7-18 N06)', () => {
    const offenders = stepSumWaits(scanFiles());
    expect(
      offenders.map((o) => `${o.file}:${o.line} (${o.cap})`),
      `These loops simulate a deadline by adding fixed step increments while yielding:\n  ` +
        offenders.map((o) => `${o.file}:${o.line} (${o.cap})`).join('\n  ') +
        `\n\nUse \`waitForCondition\` or a real wall-clock deadline (\`Date.now() < deadline\`) ` +
        `instead of summing sleep steps. Under load each sleep overruns, turning a step-sum loop ` +
        `into a load-sensitive wait that hides elapsed time and round counts.`
    ).toEqual([]);
  });

  it('catches step-sum deadline loops in both for and while forms, and spares fake-clock or non-yielding loops', () => {
    // Verbatim shape removed from `shutdown-teardown-order.test.ts` by FR-R7-18 (N06).
    const forStepSum = [
      'for (let waited = 0; waited < 3_000 && !existsSync(ready); waited += 25) await sleep(25);'
    ];
    const whileStepSum = [
      'let waited = 0;',
      'while (waited < 3_000 && !ready()) {',
      '  await new Promise((r) => setTimeout(r, 25));',
      '  waited += 25;',
      '}'
    ];
    const localWrapperStepSum = [
      'const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));',
      'for (let waited = 0; waited < 3_000 && !ready(); waited += 25) await nap(25);'
    ];
    expect(stepSumWaitsIn('fixture.ts', forStepSum)).toHaveLength(1);
    expect(stepSumWaitsIn('fixture.ts', whileStepSum)).toHaveLength(1);
    expect(stepSumWaitsIn('fixture.ts', localWrapperStepSum)).toHaveLength(1);

    // Compliant controls: fake-clock stepping (including microtask `settle()`), chunk iteration, and real Date.now() bounds.
    const fakeClockLoop = [
      'for (let elapsed = 0; elapsed < 60_000; elapsed += STEP_MS) {',
      '  clock.advance(STEP_MS);',
      '  await settle();',
      '}'
    ];
    const chunkLoop = [
      'for (let i = 0; i < bytes.length; i += chunk) {',
      '  feed(bytes.subarray(i, i + chunk));',
      '}'
    ];
    const wallClockLoop = [
      'const deadline = Date.now() + 5_000;',
      'let rounds = 0;',
      'while (Date.now() < deadline) {',
      '  rounds += 1;',
      '  if (ready()) break;',
      '  await new Promise((r) => setTimeout(r, 5));',
      '}'
    ];
    expect(stepSumWaitsIn('fixture.ts', fakeClockLoop)).toEqual([]);
    expect(stepSumWaitsIn('fixture.ts', chunkLoop)).toEqual([]);
    expect(stepSumWaitsIn('fixture.ts', wallClockLoop)).toEqual([]);
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
