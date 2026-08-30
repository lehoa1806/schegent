import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
 *
 * WHAT THIS GATE MISSED, AND WHY IT NOW SCANS `src/` (2026-08-31). Every assertion here
 * read `run-driver.ts` and nothing else, so "one emitter" was checked inside the file that
 * had held three copies — and was true there while being false of the host. The CONTROLLER
 * owns a second route to a terminal state: `handleUnexpectedStartFailure` fails a Run that
 * threw before or outside the drive, and it emitted nothing at all, because the one emitter
 * was a private method on a collaborator it never reached. A failed run was `failed` in the
 * state store and still open in the durable record, which is how a live host log came to
 * show four `task-execution-started` against one `task-execution-ended`
 * (`docs/audits/syslog-triage-2026-08-30.md`, finding 2b).
 *
 * A uniqueness claim scoped to one file is not a uniqueness claim. So the emitter moved to
 * `services/terminal-outcome-audit.ts`, both routes reach it, and the count below is taken
 * over the whole of `src/` — where a fourth copy would actually appear.
 */
const ROOT = resolve(__dirname, '../../..');
const read = (relPath: string): string => readFileSync(resolve(ROOT, relPath), 'utf8');

const DRIVER = 'src/services/run-driver.ts';
const AUDIT = 'src/services/terminal-outcome-audit.ts';
const AUDITOR = 'src/controller/workflow-lifecycle-auditor.ts';
const CONTROLLER = 'src/controller/workflow-controller.ts';

const SOURCE = read(DRIVER);
const EMITTER = read(AUDIT);

/**
 * FR-R3-128 — the module the shared terminal sequence moved to. Read here because
 * two of the three terminal paths now reach the emitter through it, and a gate that
 * only read the driver would report a property it could no longer see.
 */
const EFFECTS = read('src/services/run-terminal-effects.ts');

/** Every `.ts` file under `src/`, so the uniqueness claim is about the host, not a file. */
function sourceFiles(dir = resolve(ROOT, 'src')): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('FR-R3-107 — the terminal outcome has one emitter', () => {
  it('exactly one place in src/ emits task-execution-ended', () => {
    // The literal appears in several files as a TYPE member — the event union in
    // `contracts/audit-events.ts`, the driver's dep signature, the metrics reader's
    // classification. Those are not emissions. What is counted is the literal in first
    // argument position of an `emitTaskLifecycle*` call, which is what an emission is.
    const sites = sourceFiles()
      .map((file) => ({
        file,
        count: [...readFileSync(file, 'utf8').matchAll(/emitTaskLifecycle\w*\(\s*'task-execution-ended'/g)]
          .length
      }))
      .filter((entry) => entry.count > 0);
    expect(
      sites.map((entry) => `${entry.file.slice(resolve(ROOT).length + 1)} x${entry.count}`),
      'more than one emission body means the drift this item removed can return — and a ' +
        'SECOND file emitting it is how the controller route came to emit nothing instead'
    ).toEqual([`${AUDIT} x1`]);
  });

  it('the emitter derives its statistics rather than hand-writing them', () => {
    const method = /export async function emitTerminalOutcomeAudit\([\s\S]*?\n\}/.exec(EMITTER);
    expect(method, 'the single emitter must exist').not.toBeNull();
    const body = (method as RegExpExecArray)[0];
    expect(body).toContain('...computeRunPhaseStats(run)');
    expect(body).toContain('durationMs');
    // The specific regression: zeros typed in rather than computed.
    expect(body).not.toMatch(/phasesCompleted:\s*0/);
    expect(body).not.toMatch(/phasesSkipped:\s*0/);
  });

  it('the emitter guards the optional dependency once, and warns rather than throwing', () => {
    const method = /export async function emitTerminalOutcomeAudit\([\s\S]*?\n\}/.exec(EMITTER);
    const body = (method as RegExpExecArray)[0];
    // Guarded, so an absent appender is a no-op rather than a thrown TypeError...
    expect(body).toContain('if (!sink) return;');
    // ...and wrapped, so an audit failure never turns a completed Run into a failed one.
    expect(body).toContain('catch');
    expect(body).toContain('logger.warn');
    // The warning names WHICH terminal status failed; before, two of three did.
    expect(body).toContain('${terminalStatus}');
  });

  it('both terminal routes reach the one emitter', () => {
    // The driver's route, through its own private wrapper that `terminalSettler` binds to.
    expect(SOURCE).toContain('emitTerminalOutcomeAudit(sink, this.deps.logger, run, terminalStatus, extra)');
    // The controller's route, through the auditor it hands every other audit event to.
    // Asserted at BOTH ends: a controller that stopped calling it, or an auditor method
    // that started building its own payload, each re-open exactly what this closed.
    expect(read(CONTROLLER)).toContain(
      "this.lifecycleAuditor.emitTaskExecutionEnded(terminalRun, 'failed'"
    );
    const auditor = read(AUDITOR);
    expect(auditor).toContain('public async emitTaskExecutionEnded(');
    expect(auditor).toContain('emitTerminalOutcomeAudit(this, this.logger, run, terminalStatus, extra)');
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
      ...EFFECTS.matchAll(/deps\.emitTerminalOutcome\(([^;]*?)\);/gs),
      ...read(CONTROLLER).matchAll(/emitTaskExecutionEnded\(([^;]*?)\);/gs)
    ];
    expect(
      sites.length,
      'every terminal path must reach the one emitter, in the driver, the effects module ' +
        'or the controller'
    ).toBeGreaterThanOrEqual(4);
    for (const site of sites) {
      const args = site[1] as string;
      expect(args).not.toContain('taskId');
      expect(args).not.toContain('phasesTotal');
      expect(args).not.toContain('computeRunPhaseStats');
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

  it('the controller emits the audit last, after the queue and history copies', () => {
    // The same ordering property as the effects module, on the route that had none. It
    // is asserted here rather than left to the behavioural test because order is what a
    // reader of the audit log reconstructs a run from, and a passing emission in the
    // wrong place still reads as a run that ended before its history was written.
    const controller = read(CONTROLLER);
    const failureAt = controller.indexOf('private async handleUnexpectedStartFailure');
    expect(failureAt, 'the controller route must still exist').toBeGreaterThan(0);
    const region = controller.slice(failureAt);
    const queueAt = region.indexOf('this.queue.finish(');
    const historyAt = region.indexOf('this.historyRecorder.record(');
    const auditAt = region.indexOf('emitTaskExecutionEnded(');
    expect(queueAt).toBeGreaterThanOrEqual(0);
    expect(historyAt).toBeGreaterThan(queueAt);
    expect(auditAt, 'the terminal record is written last').toBeGreaterThan(historyAt);
  });
});
