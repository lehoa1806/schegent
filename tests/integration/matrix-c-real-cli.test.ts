/**
 * Matrix C — real-CLI evidence for the FR-029 completion-marker boundary.
 *
 * Why this file exists. The dev-host evidence runbook filed Matrix C under
 * "cannot be automated in the current architecture", but that justification is
 * about webview DOM isolation and applies to Matrices A and B. Matrix C is a
 * runner/CLI interaction observed through log output: `ClaudeCliRunner` imports
 * no `vscode` module, so it is instantiable headlessly and a real CLI can be
 * driven against it without a VS Code host. What a dev host would add is the
 * extension wrapper, which is not what C asserts.
 *
 * What this closes that the fake-timer unit tests cannot. Those tests assert
 * FR-029 against hand-written stream-json fixtures. If the real CLI's init
 * envelope has a shape the guard's predicate does not match, the marker would
 * never arm from it, the fallback bound would silently carry every invocation,
 * and every unit test would still pass. That fixture-versus-reality gap is the
 * load-bearing premise of the whole fix and is only closable against a real
 * process.
 *
 * The test owns both of its turns. It spawns a fresh session, reads that
 * session's own id off its `system`/`init` envelope, and resumes exactly that
 * id — it never resumes a session it did not create. An earlier draft took a
 * session id from the operator's transcript directory, which would have
 * appended a turn to a history file that might have been live; naming a
 * pre-existing session is not supported for that reason. The cost is that the
 * resumed history is small, so this does not exercise the large-history clause
 * of C1 — that clause is characterised separately by the T075 raw probe
 * (117.4 MB of history producing 34 KB of stdout and no replay), and on a CLI
 * that does not replay at all, what C2/C4 assert is not history-size dependent.
 *
 * C3 is the one row that cannot be read off a live turn. Its settle window
 * elapses only while a process is alive and silent 15 s after its terminal
 * result, and the real CLI exits within milliseconds of emitting one, so no
 * window ever expires. That is the CLI's exit timing, not the runner's window
 * bookkeeping, which is what C3 asserts. It is therefore exercised by replaying
 * turn B's own captured bytes out of a stub that lingers — real envelopes
 * through the real predicate, with only the exit timing synthetic.
 *
 * Opt-in by design. It spawns a real authenticated CLI, costs tokens, and is
 * nondeterministic in timing, so it must never run in the default suite:
 *
 *   SCHEGENT_MATRIX_C=1 npx vitest run tests/integration/matrix-c-real-cli.test.ts
 *
 * `SCHEGENT_MATRIX_C_CLI` overrides the binary (default `claude`).
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeCliRunner } from '../../src/runner/claude-cli';
import { SanitizedLogger } from '../../src/lib/logger';
import type { InvocationOutputSink } from '../../src/runner/invocation-result';

const ENABLED = process.env.SCHEGENT_MATRIX_C === '1';
const CLI_PATH = process.env.SCHEGENT_MATRIX_C_CLI ?? 'claude';

/** Generous: a resumed turn can take minutes to reach its terminal result. */
const INVOCATION_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 900_000;

/** Inert single-turn prompt — no tools, no writes, minimal output. */
const PROMPT = 'Reply with the single word: ack. Do not use any tools.';

/**
 * Mirrors the runner's module-private `COMPLETION_SETTLE_MS`. Asserted against
 * the emitted `windowMs=` field, so a drift in the runner fails C3 loudly
 * rather than silently weakening it.
 */
const COMPLETION_SETTLE_MS = 15_000;

/** Must exceed the settle period so the window can elapse before the stub exits. */
const LINGER_SECONDS = 25;

interface Captured {
  readonly logLines: readonly string[];
  readonly lines: readonly string[];
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly elapsedMs: number;
}

function parseOrNull(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function invokeOnce(
  resumeSessionId: string | null,
  cliPathOverride?: string
): Promise<Captured> {
  const logLines: string[] = [];
  const logger = new SanitizedLogger([{ appendLine: (line: string) => logLines.push(line) }]);
  const runner = new ClaudeCliRunner(undefined, null, {}, logger);

  const chunks: string[] = [];
  const sink: InvocationOutputSink = {
    write: (stream, chunk) => {
      if (stream === 'stdout') chunks.push(chunk);
      return true;
    },
    onceDrain: (_stream, callback) => callback()
  };

  const startedAt = Date.now();
  const result = await runner.invoke(
    {
      phase: 'analyze',
      iteration: 1,
      prompt: PROMPT,
      timeoutMs: INVOCATION_TIMEOUT_MS,
      cliPath: cliPathOverride ?? CLI_PATH,
      cwd: process.cwd(),
      ...(resumeSessionId === null
        ? {}
        : { sessionReuse: true, resumeSessionId })
    },
    sink
  );

  const stdout = chunks.join('');
  return {
    logLines,
    stdout,
    lines: stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    stdoutBytes: stdout.length,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    elapsedMs: Date.now() - startedAt
  };
}

function report(label: string, captured: Captured): void {
  // A runbook row is evidence only with its inputs on record.
  console.log(
    `[matrix-c] ${label} elapsedMs=${captured.elapsedMs} ` +
      `stdoutLines=${captured.lines.length} stdoutBytes=${captured.stdoutBytes} ` +
      `exitCode=${String(captured.exitCode)} timedOut=${String(captured.timedOut)}`
  );
}

describe.skipIf(!ENABLED)('Matrix C — real CLI, resumed invocation', () => {
  it(
    'C1/C2/C3/C4 — init is first, the genuine result arms the marker, nothing is suppressed',
    async () => {
      // ---- Turn A: a fresh session this test owns, solely to obtain an id.
      const fresh = await invokeOnce(null);
      report('fresh', fresh);
      expect(fresh.lines.length, 'the fresh invocation produced no stdout').toBeGreaterThan(0);

      const freshInit = parseOrNull(fresh.lines[0]);
      expect(freshInit?.type, 'fresh: first line was not a system envelope').toBe('system');
      expect(freshInit?.subtype).toBe('init');

      const sessionId = freshInit?.session_id;
      expect(typeof sessionId, 'no session_id on the init envelope').toBe('string');

      // ---- Turn B: resume exactly the session turn A created.
      const resumed = await invokeOnce(sessionId as string);
      report('resumed', resumed);

      // ---- C1: the FR-029 premise, re-measured through the runner itself.
      // T075 measured this with a raw probe; this asserts it against the real
      // stream the guard actually reads. Zero lines may precede the envelope.
      expect(resumed.lines.length, 'the resumed invocation produced no stdout').toBeGreaterThan(0);
      const resumedInit = parseOrNull(resumed.lines[0]);
      expect(
        resumedInit,
        `resumed: first stdout line was not JSON: ${resumed.lines[0]?.slice(0, 120)}`
      ).not.toBeNull();
      expect(resumedInit?.type).toBe('system');
      expect(resumedInit?.subtype).toBe('init');

      // ---- C2: a terminal result follows the boundary, and the invocation
      // completes without a premature termination.
      const resultIndex = resumed.lines.findIndex((line) => parseOrNull(line)?.type === 'result');
      expect(resultIndex, 'no terminal result event on stdout').toBeGreaterThan(0);
      expect(resumed.timedOut, 'resumed invocation hit the idle window').toBe(false);

      // ---- C4: the FR-029 suppression branch is unreachable on this CLI.
      // Its expected result is an absence: one appearance means the CLI has
      // begun replaying history and BUG-003's defect is live again.
      const suppressed = resumed.logLines.filter((line) =>
        line.includes('suppressed terminal result')
      );
      expect(
        suppressed,
        `FR-029 suppressed a result on a real CLI — the CLI may now replay:\n${suppressed.join('\n')}`
      ).toEqual([]);

      // ---- C3: an expiring window reports the settle window, not the idle
      // window.
      //
      // Turn B alone cannot exercise this. The settle window elapses only
      // while the process is still alive and silent 15 s after its terminal
      // result, and the real CLI exits within milliseconds of emitting one, so
      // nothing expires and there is nothing to observe. That is a property of
      // the CLI's exit timing, not of the runner, and C3 is an assertion about
      // the runner's window bookkeeping.
      //
      // So the invocation is replayed out of a stub that lingers instead of
      // exiting. The bytes are the ones the real CLI produced seconds earlier
      // in turn B — the same init envelope and the same terminal result,
      // verbatim — so the marker still has to arm from a real envelope through
      // the real predicate. Only the exit timing is synthetic, and it is
      // synthetic precisely because the real CLI structurally will not produce
      // it. A hand-written fixture would have re-opened the gap this file
      // exists to close; a captured one does not.
      expect(resumed.stdout.length, 'nothing captured to replay').toBeGreaterThan(0);

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-matrix-c-'));
      const capturePath = path.join(dir, 'turn-b.jsonl');
      const stubPath = path.join(dir, 'lingering-cli.sh');
      await fs.writeFile(capturePath, resumed.stdout, 'utf8');
      // Ignores argv: the runner's real flags are irrelevant to replaying bytes.
      await fs.writeFile(
        stubPath,
        `#!/bin/sh\ncat ${JSON.stringify(capturePath)}\nsleep ${LINGER_SECONDS}\n`,
        'utf8'
      );
      await fs.chmod(stubPath, 0o755);

      const lingering = await invokeOnce(sessionId as string, stubPath);
      report('lingering', lingering);

      const windowLines = lingering.logLines.filter((line) =>
        line.includes('invocation window expired')
      );
      expect(
        windowLines.length,
        'no window expired against a stub that outlives the settle period'
      ).toBeGreaterThan(0);

      // The whole of C3: `settle` means the runner believed the turn was over,
      // `idle` means it saw no output at all. Reading `idle` here would mean
      // the marker never armed from the real envelope.
      expect(windowLines.every((line) => line.includes('window=settle'))).toBe(true);
      expect(windowLines.every((line) => line.includes(`windowMs=${COMPLETION_SETTLE_MS}`))).toBe(
        true
      );
      expect(windowLines.every((line) => line.includes('resumed=true'))).toBe(true);

      // A settle expiry is a completion awaiting exit, not a timeout — the
      // BUG-004 defect reported exactly this case as a timed-out invocation.
      expect(lingering.timedOut, 'settle expiry was reported as a timeout').toBe(false);

      // The replay must not re-trip suppression: turn B's own init envelope
      // precedes its result in the captured bytes.
      expect(
        lingering.logLines.filter((line) => line.includes('suppressed terminal result')),
        'the replayed capture tripped FR-029 suppression'
      ).toEqual([]);

      await fs.rm(dir, { recursive: true, force: true });
    },
    TEST_TIMEOUT_MS
  );
});
