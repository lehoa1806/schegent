import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

import {
  assertConfigurationPolicy,
  assertSentinelObservable,
  driveEveryCommand,
  enterTrustLeg,
  ownershipRecords,
  readSyslog,
  refusalLines,
  waitUntil
} from './trust-leg-support';

/**
 * FR-R3-136 (T1527c) — what an activation in an UNTRUSTED workspace does.
 *
 * The claim: the extension activates, serves reads, and performs no act. Every
 * mutating command declines, nothing is elected, nothing is spawned, and no
 * workspace-supplied setting votes on a capability. This is the leg the feature
 * exists for, and the leg that could not be written before `runTest.ts` stopped
 * using `@vscode/test-electron`'s `runTests` — which appends
 * `--disable-workspace-trust` to every launch, so until FR-R3-136 every host-leg
 * assertion this repository ever made was made in a window where Workspace Trust
 * was switched off and `workspace.isTrusted` was unconditionally `true`.
 *
 * Almost everything here is an ABSENCE, and an absence is what a broken harness
 * gives away for free. Three standing controls answer that, and none of them is a
 * one-time demonstration somebody performed and wrote down:
 *
 *   1. `trust-granted-workspace.host.test.ts` runs the SAME fixture with trust
 *      granted, and turns every absence below into a presence.
 *   2. The read-only ids are driven in this same window and must produce NO
 *      refusal, so "the guard refuses everything" fails here.
 *   3. `assertSentinelObservable` runs the sentinel directly, in this process,
 *      before asserting its marker is absent.
 */

/**
 * How long after the last command drive the absences must still hold.
 *
 * Not the primary argument — the granted leg elects and spawns before its own
 * assertions run at this same point in the same sequence, so the acts under test
 * are not slow ones. This is margin, and it is deliberately small: it is paid on
 * every passing run.
 */
const SPAWN_GRACE_MS = 3_000;

/** Budget for the refusal lines to reach disk. `RuntimeLogSink` writes async. */
const SYSLOG_BUDGET_MS = 20_000;

export async function run(): Promise<void> {
  const context = await enterTrustLeg({ trusted: false });

  assertConfigurationPolicy(context, { trusted: false });

  // Before, not after, the marker assertion below: a sentinel that could never
  // write — a lost exec bit, an unwritable directory — would satisfy that
  // assertion for the wrong reason.
  assertSentinelObservable(context);

  const markerBeforeDrive = fs.existsSync(context.sentinelMarker);
  assert.equal(
    markerBeforeDrive,
    false,
    `the sentinel marker at ${context.sentinelMarker} already exists before any command ran. ` +
      `Activation itself spawned a backend probe in an untrusted window, which is the exact ` +
      `failure FR-R3-136 is about — or a previous launch's sentinel directory was reused.`
  );

  const { mutating, readOnly } = await driveEveryCommand();

  // Wait for the refusals to land rather than reading once: `RuntimeLogSink`
  // appends through a per-path promise chain, so `executeCommand` resolving does
  // not mean the line is on disk.
  const landed = await waitUntil(
    () => mutating.every((id) => refusalLines(readSyslog(context.workspaceRoot), id).length > 0),
    SYSLOG_BUDGET_MS
  );
  const syslog = readSyslog(context.workspaceRoot);
  if (!landed) {
    const missing = mutating.filter((id) => refusalLines(syslog, id).length === 0);
    assert.fail(
      `${missing.length} of ${mutating.length} mutating command(s) logged no refusal within ` +
        `${SYSLOG_BUDGET_MS}ms: ${missing.join(', ')}. Either the id is registered unwrapped — ` +
        `which means it RAN in an untrusted workspace — or it is not registered at all and this ` +
        `leg drove a command nothing listens to. The syslog held ${syslog.length} byte(s).`
    );
  }

  // Exactly one, not at least one. A doubled refusal means the id is registered
  // twice, and a second registration is a second code path that has to be
  // guarded — the kind of thing a merge produces and nothing else notices.
  for (const id of mutating) {
    const lines = refusalLines(syslog, id);
    assert.equal(
      lines.length,
      1,
      `${id} logged ${lines.length} refusals, expected exactly 1. More than one means the id is ` +
        `registered more than once; each registration is a separate path that must be guarded.`
    );
  }

  // The other half, and the control for the half above: the guard must not be a
  // blanket refusal. Without this, an activation that declined every command
  // would pass every assertion in this file.
  for (const id of readOnly) {
    const lines = refusalLines(syslog, id);
    assert.equal(
      lines.length,
      0,
      `${id} was REFUSED in an untrusted workspace. It is classified read-only, and the manifest's ` +
        `untrustedWorkspaces.supported = 'limited' promises exactly these reads keep working while ` +
        `the folder is untrusted. Refusal line(s): ${lines.join(' | ')}`
    );
  }

  await new Promise((resolve) => setTimeout(resolve, SPAWN_GRACE_MS));

  // C2 — electing is itself a write, so the election is observable as one. This
  // is the end-to-end form of what `tests/unit/activation/stage2-producers-trust.test.ts`
  // asserts against a fake clock: no generation file means no resource was
  // acquired, in a real window, against a real filesystem.
  const records = ownershipRecords(context.workspaceRoot);
  assert.deepEqual(
    records,
    [],
    `.schegent/ownership/ holds ${records.length} generation file(s) after an untrusted ` +
      `activation: ${records.join(', ')}. Acquiring a resource IS a write to a ` +
      `workspace-influenced path, so an untrusted window must not elect at all — not elect and ` +
      `then decline to act.`
  );

  const spawned = fs.existsSync(context.sentinelMarker)
    ? fs.readFileSync(context.sentinelMarker, 'utf8')
    : null;
  assert.equal(
    spawned,
    null,
    `the sentinel was executed in an untrusted workspace. It is installed at user scope for ` +
      `schegent.cli.path, codex.path and agy.path, so this is the capability probe running ` +
      `'<cli> --help' — a child process, from a window the operator has not trusted. Marker ` +
      `contents: ${JSON.stringify(spawned)}`
  );

  console.log(
    `[trust-untrusted] isTrusted=false; ${mutating.length} mutating command(s) refused exactly ` +
      `once each, ${readOnly.length} read-only command(s) served, no ownership record, no spawn.`
  );
}
