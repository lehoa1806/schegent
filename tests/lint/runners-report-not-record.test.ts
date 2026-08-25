import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * FR-R3-083 (T1154) — a runner reports a lifecycle fact; something else decides
 * what to record.
 *
 * `FR-R3-083` put the degraded-tree finding into the audit record, and the obvious
 * way to do that is to hand the audit writer to the runner. It is the wrong way,
 * for two reasons that are easy to lose once the code compiles:
 *
 *   1. The append-only audit writer is the single sink, and the standing rule is
 *      that built-in and custom-phase invocations do not bypass it. A runner
 *      holding a writer is a second place that decides what an audit entry is.
 *   2. The degraded-tree probe fires on a delayed, `unref`'d timer AFTER the phase
 *      has ended. A runner writing there would be writing outside any phase's
 *      lifetime, into a sink that may already have been disposed by
 *      `deactivate()` — which is exactly when the tree gets killed.
 *
 * So the runners emit through `MonitorSidecarHook`, and `extension.ts` — where that
 * hook already meets the writer — translates it.
 *
 * Hermetic (FR-R3-033): `readdirSync`, never a spawned binary.
 */
const RUNNER_DIR = resolve(__dirname, '..', '..', 'src', 'runner');

/** Modules that would make a runner an audit author rather than a reporter. */
const FORBIDDEN_IMPORT = /from\s+'[^']*(?:audit\/audit-log-writer|audit\/audit-entry|controller\/process-tree-degradation-recorder)'/;

function runnerSources(): readonly { readonly name: string; readonly body: string }[] {
  return readdirSync(RUNNER_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, body: readFileSync(join(RUNNER_DIR, name), 'utf8') }));
}

describe('runners report, they do not record (FR-R3-083)', () => {
  const sources = runnerSources();

  it('finds runner sources at all', () => {
    // Non-vacuity: a directory rename would otherwise make every assertion below
    // pass by checking nothing.
    expect(sources.length).toBeGreaterThan(5);
  });

  it('has no runner importing the audit writer or the recorder', () => {
    const offenders = sources.filter((s) => FORBIDDEN_IMPORT.test(s.body)).map((s) => s.name);
    // If this fails: emit a `MonitorSidecarEvent` and translate it where the hook is
    // wired, in `extension.ts`. Do not reach for the writer from here.
    expect(offenders).toEqual([]);
  });

  it('emits the degraded-tree fact from exactly ONE place', () => {
    // Originally this asserted the two runner files by name -- which PINNED the
    // duplication instead of flagging it. `claude-cli.ts` does not delegate to
    // `ProcessLifecycleRunner` (a pre-existing shape), so FR-R3-083's additions to
    // the ladder had landed twice, byte for byte.
    //
    // The ladder now lives in `process-tree.ts` and both runners call it. A second
    // emitter appearing here means the ladder has been copied again, and the next
    // change to what is recorded will land in one copy.
    const emitters = sources
      .filter((s) => s.body.includes("kind: 'tree-unconfirmed'"))
      .map((s) => s.name)
      .sort();
    expect(emitters).toEqual(['process-tree.ts']);
  });

  it('keeps the runtime-log warning beside the audit emission', () => {
    // Belt and braces on purpose, and asserted so a later cleanup does not treat the
    // log line as redundant. The audit append is BEST-EFFORT: when it cannot land --
    // a writer disposed by `deactivate()`, which is a common shape here -- the log
    // line is the only surviving record.
    for (const source of sources.filter((s) => s.body.includes("kind: 'tree-unconfirmed'"))) {
      expect(source.body).toContain('not confirmed gone after SIGKILL');
    }
  });

  it('has both runners reach that one place', () => {
    // The other half: one emitter is only correct if both ladders still run. A
    // runner that stopped calling it would go silent about a surviving group, and
    // the assertion above would still pass.
    const callers = sources
      .filter((s) => s.body.includes('escalateAndReportTree({'))
      .map((s) => s.name)
      .sort();
    expect(callers).toEqual(['claude-cli.ts', 'process-lifecycle-runner.ts']);
  });
});
