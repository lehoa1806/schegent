// FR-R3-095, corrected by FR-R3-135 — run the gate and record what was observed.
//
// This spawns the gate as a child and writes down the exit code it watched. The direction
// matters and is the whole point: the writer is OUTSIDE the thing the record vouches for, so
// it cannot record a pass it did not see. A step appended to the gate chain that wrote its own
// attestation would prove only that the step ran, which is the shape `FR-R3-072` deleted when
// it removed a fabricated live probe.
//
// WHY THIS IS A FUNCTION AND NOT A SCRIPT. It used to be a script, and that is how it came to
// spawn `npm run ci` while announcing and recording `npm run gate`: the argv sat at module top
// level in a file that ran the real four-minute gate on import, so no test could observe it
// without running one. The defect stood ~32 hours (the window is measured in
// `gate-attestation.mjs`) and was found by audit rather than by the suite, which is the part
// worth fixing structurally: a shorter window is luck, not a control.
// `record-gate-run.mjs` is now a thin CLI shell around this function, and the argv is an
// assertion in `tests/unit/build/gate-recorder.test.ts`.
//
// Injected here is every dependency whose behaviour a test needs to VARY — `spawn`, `platform`,
// `readTreeState`, `writeAttestation`, `now`, and `log`/`error` for the operator's console —
// for that reason and no other; there is no second production caller and none is wanted.
// `process.arch` and `process.version` are read directly below: they are inert facts about the
// running interpreter, not seams, and injecting them would add two parameters no test varies.
import { ATTESTATION_VERSION, GATE_COMMAND, GATE_COMMAND_SPEC } from './gate-attestation.mjs';

/**
 * @typedef {object} RecordGateRunDeps
 * @property {(executable: string, args: readonly string[], options: object) => {
 *   status: number | null, signal: string | null, error?: Error
 * }} spawn Synchronous child-process spawn. `spawnSync`'s shape.
 * @property {string} platform `process.platform`, injected so the Windows executable
 *   resolution is assertable from a POSIX test.
 * @property {() => { head: string, treeClean: boolean }} readTreeState
 * @property {(attestation: object) => void} writeAttestation Durable write. The `fsync`
 *   barrier lives in the caller's implementation, not here.
 * @property {(message: string) => void} log
 * @property {(message: string) => void} error
 * @property {() => string} now ISO-8601 timestamp source.
 */

/**
 * @typedef {object} RecordGateRunResult
 * @property {number} exitCode 0 pass, 1 recorded failure, 2 refused without recording.
 * @property {object | null} attestation The record written, or null when refused.
 * @property {'passed' | 'gate-failed' | 'dirty-tree-before' | 'spawn-failed' | 'tree-moved'} reason
 *   Recorder-internal. Read by tests and by nothing in production: the CLI exits on `exitCode`
 *   and the operator-facing text has already gone through `error`. It exists so a test can tell
 *   `spawn-failed` from `tree-moved` — both exit 2 — without matching on message prose. It
 *   deliberately shares no namespace with `decideRelease`'s release-side reasons.
 */

/**
 * Observe the gate and produce the record.
 *
 * Never calls `process.exit` and never throws for an expected refusal; the caller owns the
 * process. A refusal returns exit code 2 and writes nothing, which is distinct from a red gate:
 * a gate that could not be spawned is not a gate that failed, and recording it as exit 1 would
 * be indistinguishable from a genuine failure.
 *
 * @param {RecordGateRunDeps} deps
 * @returns {RecordGateRunResult}
 */
export function recordGateRun(deps) {
  const { spawn, platform, readTreeState, writeAttestation, log, error, now } = deps;

  // Refuse a dirty tree BEFORE spending the gate's wall-clock, because the result would
  // describe a tree nobody can reconstruct.
  const { head, treeClean } = readTreeState();
  if (!treeClean) {
    error(
      'record-gate-run: the working tree has uncommitted changes.\n' +
        '  A gate result recorded here would name a commit it did not actually test.\n' +
        '  Commit or stash first, then re-run.'
    );
    return { exitCode: 2, attestation: null, reason: 'dirty-tree-before' };
  }

  const executable = GATE_COMMAND_SPEC.executableFor(platform);
  log(`record-gate-run: observing \`${GATE_COMMAND}\` at ${head} — this takes a while.`);
  const startedAt = now();

  // Inherited stdio: the operator watches the real gate, not a summary of it. The exit code is
  // the only thing read back, and it comes from the child.
  const result = spawn(executable, GATE_COMMAND_SPEC.args, {
    cwd: GATE_COMMAND_SPEC.cwd,
    stdio: 'inherit',
    shell: false,
    encoding: 'utf8'
  });

  if (result.error) {
    error(`record-gate-run: could not spawn the gate: ${result.error.message}`);
    return { exitCode: 2, attestation: null, reason: 'spawn-failed' };
  }

  const exitCode = result.status === null ? `signal:${result.signal}` : result.status;

  // Re-read the tree AFTER the run. A gate that writes into its own checkout — coverage output,
  // a build directory, a lockfile touch — produced a result about a tree that no longer exists
  // by the time it finished.
  const after = readTreeState();
  if (after.head !== head || !after.treeClean) {
    error(
      'record-gate-run: the tree changed while the gate ran ' +
        `(head ${head} -> ${after.head}, clean ${String(treeClean)} -> ${String(after.treeClean)}).\n` +
        '  Refusing to record a result whose subject moved underneath it.'
    );
    return { exitCode: 2, attestation: null, reason: 'tree-moved' };
  }

  // FR-R3-135 — the record carries what was spawned, not only what it is called. `command` is
  // the derived label and `commandArgv` is its witness; `decideRelease` refuses a record where
  // the two disagree, which is the check that was missing while the label was a free constant.
  const attestation = {
    version: ATTESTATION_VERSION,
    command: GATE_COMMAND,
    commandExecutable: executable,
    commandArgv: [...GATE_COMMAND_SPEC.args],
    head,
    treeClean: true,
    exitCode,
    platform,
    arch: process.arch,
    nodeVersion: process.version,
    startedAt,
    recordedAt: now()
  };

  writeAttestation(attestation);

  if (exitCode === 0) {
    return { exitCode: 0, attestation, reason: 'passed' };
  }
  // A red run is recorded too, and deliberately: the release check reads the exit code and
  // refuses on a non-zero one, so a failing gate leaves anti-evidence rather than leaving the
  // previous commit's pass standing as the most recent record anyone finds.
  error(`record-gate-run: recorded a FAILURE (exit ${String(exitCode)}) at ${head}`);
  return { exitCode: 1, attestation, reason: 'gate-failed' };
}
