import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

import {
  assertConfigurationPolicy,
  enterTrustLeg,
  ownershipRecords,
  waitUntil
} from './trust-leg-support';

/**
 * FR-R3-136 (T1527d) — the same fixture, trusted. The control leg.
 *
 * `trust-untrusted-workspace.host.test.ts` is almost entirely absences: no
 * election, no spawn, no workspace-supplied capability. A harness that failed to
 * launch the extension, a fixture quietly reduced to a bare directory, a sentinel
 * that lost its exec bit — each satisfies every one of those assertions. This leg
 * is what makes them mean something: one copy of the same tracked fixture, one
 * variable changed, and every absence there becomes a presence here.
 *
 * It deliberately does NOT drive the mutating commands. In a trusted window they
 * do not decline, they RUN — `schegent.auto` with no argument opens a modal input
 * box, and a modal in a headless launch has nobody to answer it. What is under
 * test here is what the gate lets through on its own at activation, and that is
 * observable without invoking anything.
 */

/** Budget for the election and the capability probe to reach disk. */
const EVIDENCE_BUDGET_MS = 20_000;

export async function run(): Promise<void> {
  const context = await enterTrustLeg({ trusted: true });

  assertConfigurationPolicy(context, { trusted: true });

  // C2's other half. The untrusted leg asserts this directory holds nothing;
  // unless the election really does write here when permitted, that assertion is
  // about a code path that never writes at all.
  //
  // A count, not a set: how many resources Stage 2 elects for is not what this
  // leg is about, and pinning the number here would make adding one fail a trust
  // test for no reason.
  const elected = await waitUntil(
    () => ownershipRecords(context.workspaceRoot).length > 0,
    EVIDENCE_BUDGET_MS
  );
  const records = ownershipRecords(context.workspaceRoot);
  assert.ok(
    elected,
    `no ownership generation file appeared under .schegent/ownership/ within ` +
      `${EVIDENCE_BUDGET_MS}ms of a TRUSTED activation. Stage 2 calls lock.tryAcquire() as its ` +
      `first statement, so this window elected nothing — which also means the untrusted leg's ` +
      `"no generation file" assertion is passing for the wrong reason.`
  );

  // The spawn, in the window that is allowed one. `backendCapabilities.scan()`
  // runs '<resolved path> --help' per backend kind, and all three resolved paths
  // are the user-scope sentinel, so a line lands per kind and the probe reports
  // every backend unavailable. Nothing cascades into a real run.
  const spawned = await waitUntil(
    () => fs.existsSync(context.sentinelMarker),
    EVIDENCE_BUDGET_MS
  );
  assert.ok(
    spawned,
    `the sentinel at ${context.sentinelPath} was never executed in a TRUSTED window (no marker at ` +
      `${context.sentinelMarker} within ${EVIDENCE_BUDGET_MS}ms). The capability probe is what ` +
      `spawns it; if it does not spawn here, the untrusted leg's "no spawn" assertion is not ` +
      `evidence of a refusal.`
  );
  const marker = fs.readFileSync(context.sentinelMarker, 'utf8');
  const lines = marker.split(/\r?\n/).filter((line) => line.length > 0);
  assert.ok(lines.length > 0, `sentinel marker at ${context.sentinelMarker} is empty`);
  for (const line of lines) {
    assert.equal(
      line,
      'spawned --help',
      `the sentinel was invoked as ${JSON.stringify(line)} rather than with '--help'. Only the ` +
        `capability probe is expected to spawn a backend at activation; anything else means a ` +
        `Run started in a fixture that queued none.`
    );
  }

  console.log(
    `[trust-granted] isTrusted=true; ${records.length} ownership generation file(s), ` +
      `${lines.length} probe spawn(s).`
  );
}
