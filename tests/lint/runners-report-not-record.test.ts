import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
/**
 * The WHOLE of `src/`, walked recursively.
 *
 * This gate used to read a non-recursive listing of `src/runner` alone, which is not
 * what it claims to measure: a second `tree-unconfirmed` emitter in `src/services`,
 * `src/controller`, or a new `src/runner/tree/` subdirectory would have left the
 * assertion green while the duplication it was rewritten to catch reappeared.
 */
const SRC_DIR = resolve(__dirname, '..', '..', 'src');
const RUNNER_DIR = resolve(SRC_DIR, 'runner');

/**
 * CONSTRUCTS the event, rather than merely naming it.
 *
 * The trailing comma is what discriminates. An object literal being built writes
 * `kind: 'tree-unconfirmed',` with more fields to follow; the contract's own
 * declaration writes `readonly kind: 'tree-unconfirmed';` and the recorder's
 * parameter type writes `{ kind: 'tree-unconfirmed' }`. A substring match counted
 * all three as emitters the moment this gate started walking `src/` recursively —
 * which would have made it fail on the very layering it exists to pin.
 */
const EMITS_TREE_UNCONFIRMED = /kind:\s*'tree-unconfirmed',/;

/** Modules that would make a runner an audit author rather than a reporter. */
const FORBIDDEN_IMPORT = /from\s+'[^']*(?:audit\/audit-log-writer|audit\/audit-entry|controller\/process-tree-degradation-recorder)'/;

interface Source {
  readonly name: string;
  readonly path: string;
  readonly body: string;
}

function walk(dir: string, out: Source[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push({
        name: entry.name,
        path: relative(SRC_DIR, full).split(/[/\\]/).join('/'),
        body: readFileSync(full, 'utf8')
      });
    }
  }
}

/** Everything under `src/`, so a copy cannot hide in a directory this gate never read. */
function allSources(): readonly Source[] {
  const out: Source[] = [];
  walk(SRC_DIR, out);
  return out;
}

/** The runner modules specifically, for the import assertion. */
function runnerSources(): readonly Source[] {
  const out: Source[] = [];
  walk(RUNNER_DIR, out);
  return out;
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
    const emitters = allSources()
      .filter((s) => EMITS_TREE_UNCONFIRMED.test(s.body))
      .map((s) => s.path)
      .sort();
    expect(emitters).toEqual(['runner/process-tree.ts']);
  });

  it('keeps the runtime-log warning beside the audit emission', () => {
    // Belt and braces on purpose, and asserted so a later cleanup does not treat the
    // log line as redundant. The audit append is BEST-EFFORT: when it cannot land --
    // a writer disposed by `deactivate()`, which is a common shape here -- the log
    // line is the only surviving record.
    for (const source of allSources().filter((s) => EMITS_TREE_UNCONFIRMED.test(s.body))) {
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
