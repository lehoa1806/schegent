import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR-R3-107 (FR-077, FR-078) — one terminal-outcome emitter, and the CLI-probe path
 * reports DERIVED statistics.
 *
 * WHAT WAS WRONG. `drive()` emitted `task-execution-ended` from three places, and they
 * had already drifted three ways:
 *
 *   | site | statistics | durationMs | optional dep |
 *   |---|---|---|---|
 *   | `:441` CLI-probe failure | hand-written zeros | **omitted** | guarded, silently skipped |
 *   | `:840` failed | derived | present | unguarded |
 *   | `:1035` completed | derived | present | unguarded |
 *
 * So the same event left three shapes, and one terminal path emitted nothing at all when
 * the optional dependency was absent while the others logged a warning. Triplication
 * drifting was not hypothetical here; it was observed.
 *
 * WHY THE ZEROS WERE A BUG AND NOT A SHAPE. They were *correct* — a CLI probe fails before
 * any phase runs — but correct **by position**, and nothing pinned the position. Deriving
 * through `computeRunPhaseStats` preserves the same values (it returns zeros for a Run with
 * no phase records) while making a future reordering visible instead of silently wrong.
 * That is the difference between a number that is right and a number that is right for a
 * reason.
 *
 * The assertions are on the source because what changed is structural — one body, three
 * call sites — and the existing `drive()` suites already cover the behaviour, unmodified,
 * which is FR-080's requirement.
 */
const ROOT = resolve(__dirname, '../../..');
const SOURCE = readFileSync(resolve(ROOT, 'src/services/run-driver.ts'), 'utf8');

/**
 * FR-R3-128 — the module the shared terminal sequence moved to. Read here because
 * two of the three terminal paths now reach the emitter through it, and a gate that
 * only read the driver would report a property it could no longer see.
 */
const EFFECTS = readFileSync(
  resolve(__dirname, '../../../src/services/run-terminal-effects.ts'),
  'utf8'
);

describe('FR-R3-107 — the terminal outcome has one emitter', () => {
  it('exactly one call to emitTaskLifecycleAudit names task-execution-ended', () => {
    const emissions = [
      ...SOURCE.matchAll(/emitTaskLifecycleAudit\(\s*'task-execution-ended'/g)
    ];
    expect(
      emissions.length,
      'more than one emission body means the drift this item removed can return'
    ).toBe(1);
  });

  it('the emitter derives its statistics rather than hand-writing them', () => {
    const method = /private async emitTerminalOutcome\([\s\S]*?\n {2}\}/.exec(SOURCE);
    expect(method, 'the single emitter must exist').not.toBeNull();
    const body = (method as RegExpExecArray)[0];
    expect(body).toContain('...this.computePhaseStats(run)');
    expect(body).toContain('durationMs');
    // The specific regression: zeros typed in rather than computed.
    expect(body).not.toMatch(/phasesCompleted:\s*0/);
    expect(body).not.toMatch(/phasesSkipped:\s*0/);
  });

  it('the emitter guards the optional dependency once, and warns rather than throwing', () => {
    const method = /private async emitTerminalOutcome\([\s\S]*?\n {2}\}/.exec(SOURCE);
    const body = (method as RegExpExecArray)[0];
    // Guarded, so an absent appender is a no-op rather than a thrown TypeError...
    expect(body).toContain('if (!this.deps.emitTaskLifecycleAudit) return;');
    // ...and wrapped, so an audit failure never turns a completed Run into a failed one.
    expect(body).toContain('catch');
    expect(body).toContain('logger.warn');
    // The warning names WHICH terminal status failed; before, two of three did.
    expect(body).toContain('${terminalStatus}');
  });

  it('no call site hand-writes the payload any more', () => {
    // Each terminal path passes only what it alone knows: the status, and an error
    // summary where it has one.
    //
    // FR-R3-128 — this used to assert THREE `this.emitTerminalOutcome(...)` calls in
    // `run-driver.ts`. Two of the three moved into `run-terminal-effects.ts` when the
    // shared terminal sequence was extracted, so `run-driver.ts` now holds the probe
    // path's direct call plus the one delegation, and the effects module holds the
    // call the other two share. The GATE FOLLOWS THE CODE: the property it protects
    // — no hand-written payload at any site — is asserted across both files rather
    // than the code being contorted to keep a source-text count at three.
    const sites = [
      ...SOURCE.matchAll(/this\.emitTerminalOutcome\(([^;]*?)\);/gs),
      ...EFFECTS.matchAll(/deps\.emitTerminalOutcome\(([^;]*?)\);/gs)
    ];
    expect(
      sites.length,
      'every terminal path must reach the one emitter, in the driver or in the effects module'
    ).toBeGreaterThanOrEqual(3);
    for (const site of sites) {
      const args = site[1] as string;
      expect(args).not.toContain('taskId');
      expect(args).not.toContain('phasesTotal');
      expect(args).not.toContain('computePhaseStats');
    }
  });

  it('the CLI-probe path is one of the three, so its zeros are now derived', () => {
    // The specific site that had drifted. Its neighbourhood is distinctive: it follows the
    // probe failure's queue.finish and precedes the run-ended breakpoint audit.
    // Searched FORWARD from the probe marker: `emitRunEndedBreakpointAudit` also appears
    // in the dependency interface far above, so an unbounded indexOf would slice
    // backwards and silently produce an empty region — a check that passes over nothing.
    const probeAt = SOURCE.indexOf('queue.finish (probe failed)');
    expect(probeAt, 'the probe-failure path must still exist').toBeGreaterThan(0);
    const probeRegion = SOURCE.slice(
      probeAt,
      SOURCE.indexOf('emitRunEndedBreakpointAudit', probeAt)
    );
    expect(probeRegion.length, 'the probe region must not be empty').toBeGreaterThan(50);
    expect(probeRegion).toContain("this.emitTerminalOutcome(run, 'failed'");
    expect(probeRegion).not.toMatch(/phasesCompleted:\s*0/);
  });

  it('the persistence chain was not reordered by the extraction (FR-081)', () => {
    // The extraction moved code; it must not have moved an await relative to the
    // serialized commit point. The ordering that matters is: queue finish, then
    // history record, then the audit — the audit LAST, because it is the only one
    // whose failure is not tolerated.
    //
    // FR-R3-128 — the sequence moved to `run-terminal-effects.ts`, so the ordering is
    // asserted there. That module is where the order is now decided, and asserting it
    // anywhere else would be asserting a copy.
    const queueAt = EFFECTS.indexOf('queue.finish(');
    const historyAt = EFFECTS.indexOf('historyRecorder.record(');
    const auditAt = EFFECTS.indexOf('deps.emitTerminalOutcome(');
    expect(queueAt, 'the effects module must call queue.finish').toBeGreaterThanOrEqual(0);
    expect(historyAt, 'then record history').toBeGreaterThan(queueAt);
    expect(auditAt, 'and emit the audit record last').toBeGreaterThan(historyAt);

    // And the swallow/no-swallow split, which is the reason the order matters: the two
    // best-effort records are in `try`/`catch`, the required one is not.
    const auditRegion = EFFECTS.slice(auditAt);
    expect(auditRegion).not.toMatch(/^\s*\}\s*catch/m);
  });
});
