import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';
import { waitForChildCompletion } from '../../../src/runner/child-completion';
import type { InvocationOutputSink, InvocationRequest } from '../../../src/runner/invocation-result';
import { ProcessLifecycleRunner, type ProcessSpawnFn } from '../../../src/runner/process-lifecycle-runner';

/**
 * FR-R3-047 (M-01) — a privacy setting must not select the completion semantics.
 *
 * Both runners passed `outputSink !== undefined` as `waitForStdioClose`, so
 * whether a transcript sink existed decided whether the runner settled on `exit`
 * or waited for `close`. Output buffered between those two events — which can
 * include the terminal `{"type":"result"}` line and the session id — was simply
 * lost whenever an operator turned capture off. The helper's own doc comment
 * already said that waiting only for `exit` "loses buffered output".
 *
 * The three "transcript modes" are represented by what actually differed at the
 * call site: whether an output sink was supplied. That is the whole mechanism the
 * defect ran through.
 */

/**
 * Emits its terminal result AFTER exit is observable but before the pipes close,
 * by writing and then exiting without flushing a close of its own.
 */
const CHILD_LATE_RESULT =
  'process.stdout.write(JSON.stringify({ type: "result", session_id: "sess-late" }) + "\\n");' +
  'setTimeout(() => process.exit(0), 50);';

function requestFor(prompt: string): InvocationRequest {
  return {
    phase: 'implement' as InvocationRequest['phase'],
    iteration: 1,
    prompt,
    timeoutMs: 20_000,
    cliPath: process.execPath,
    cwd: process.cwd()
  };
}

/** A sink that accepts everything, standing in for capture being ON. */
function acceptingSink(): InvocationOutputSink {
  return { write: () => true, onceDrain: () => undefined };
}

describe('completion no longer depends on transcript capture', () => {
  it('captures the terminal result identically with and without an output sink', async () => {
    const runs: Array<{ label: string; sink?: InvocationOutputSink }> = [
      { label: 'always (sink present)', sink: acceptingSink() },
      { label: 'errors-only (sink present)', sink: acceptingSink() },
      { label: 'off (no sink)', sink: undefined }
    ];

    const observed: Array<{ label: string; exitCode: number | null; sawResult: boolean; sawSession: boolean }> = [];
    for (const { label, sink } of runs) {
      const runner = new ProcessLifecycleRunner(
        spawn as unknown as ProcessSpawnFn, null, new SanitizedLogger([]), 'codex-cli'
      );
      const raw = await runner.invoke({
        request: requestFor(''),
        args: ['-e', CHILD_LATE_RESULT],
        env: process.env,
        commandDisplay: 'node -e <fixture>',
        ...(sink ? { outputSink: sink } : {})
      });
      const text = raw.stdoutBuffer.getTrailingLines(50);
      observed.push({
        label,
        exitCode: raw.exitCode,
        sawResult: text.includes('"type":"result"'),
        sawSession: text.includes('sess-late')
      });
    }

    // The point of the assertion is sameness across the three, not any one value:
    // before the fix, the `off` run was the odd one out.
    expect(observed.every((o) => o.sawResult)).toBe(true);
    expect(observed.every((o) => o.sawSession)).toBe(true);
    expect(new Set(observed.map((o) => o.exitCode)).size).toBe(1);
  }, 60_000);

  it('defaults to waiting for stdio close, so an omitted argument cannot lose output', async () => {
    // The default is the mechanism: every production call site now omits the
    // argument, and the lint gate forbids passing the non-waiting value.
    const child = spawn(process.execPath, ['-e', CHILD_LATE_RESULT], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const chunks: string[] = [];
    const out = child.stdout as NodeJS.ReadableStream;
    out.setEncoding('utf8');
    out.on('data', (c: string) => chunks.push(c));
    const completion = await waitForChildCompletion(child);
    expect(completion.exitCode).toBe(0);
    // Arrived because the helper waited for close rather than settling on exit.
    expect(chunks.join('')).toContain('sess-late');
  }, 30_000);

  it('keeps the bounded grace and still destroys the local readers', async () => {
    // FR-020 — the grace MECHANISM is unchanged. Per-invocation behaviour for an
    // `off`-mode run deliberately does change (it now waits), which is the M-01
    // fix rather than a regression; what must not change is what happens when a
    // descendant holds an inherited pipe open past the window.
    const child = spawn(
      process.execPath,
      ['-e', 'const cp=require("node:child_process");cp.spawn(process.execPath,["-e","setTimeout(()=>{},5000)"],{stdio:["ignore",1,2]});setTimeout(()=>process.exit(0),50);'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const started = Date.now();
    const completion = await waitForChildCompletion(child, true, 300);
    const elapsed = Date.now() - started;

    expect(completion.stdioCloseTimedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect((child.stdout as { destroyed: boolean }).destroyed).toBe(true);
    expect((child.stderr as { destroyed: boolean }).destroyed).toBe(true);
  }, 30_000);
});
