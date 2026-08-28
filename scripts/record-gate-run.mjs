#!/usr/bin/env node
// FR-R3-095, corrected by FR-R3-135 — the CLI entry for the gate recorder.
//
// The mechanism lives in `gate-recorder.mjs`; this file is the shell that binds it to the real
// world and to the process exit code. That split is the correction FR-R3-135 made: the argv this
// spawns used to sit inside a top-level script that ran the real gate on import, so nothing
// could assert it, and it was `['run', 'ci']` under a `npm run gate` label for the ~32 hours
// between FR-R3-100 and this item.
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { ATTESTATION_PATH, readTreeState } from './gate-attestation.mjs';
import { recordGateRun } from './gate-recorder.mjs';

/**
 * FR-R3-111 (FR-110) — an explicit durability barrier on the attestation.
 *
 * WHY HERE AND NOT EVERYWHERE. Measured 2026-08-26: an `fsync` costs **3.9 ms** against 0.014 ms
 * for a plain append — 289x. On the audit log's per-event appends that is a hot-path cost and the
 * decision went the other way (see docs/architecture/durability-decision.md). This file is written
 * **once per gate run**, immediately after a multi-minute gate, and a release is bound to it. 3.9 ms
 * against four minutes is free, and the failure it prevents is specific: a machine that loses power
 * between the gate finishing and the kernel flushing would leave a release bound to an attestation
 * that is absent or truncated — and a truncated JSON record is refused as `unreadable`, which reads
 * as "the gate never ran" for a gate that did.
 *
 * `writeFileSync` + `fsyncSync` rather than a single call, because Node offers no atomic
 * write-and-sync. The window between them is one syscall wide and closes on the same failure this
 * is about.
 *
 * It stays in the CLI rather than moving into the recorder because it is the real-filesystem half:
 * the recorder's tests inject a capture in its place, and a test that had to defeat an `fsync` to
 * observe an argv would be testing the barrier by accident.
 *
 * @param {object} attestation
 */
function writeAttestation(attestation) {
  const handle = openSync(ATTESTATION_PATH, 'w');
  try {
    writeFileSync(handle, `${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

const outcome = recordGateRun({
  spawn: spawnSync,
  platform: process.platform,
  readTreeState,
  writeAttestation,
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  now: () => new Date().toISOString()
});

// The PASS line names the path, so an operator can see where the record landed. It is emitted
// here rather than in the recorder because `ATTESTATION_PATH` is the CLI's concern — the
// recorder is handed a write function and never learns where it writes.
if (outcome.reason === 'passed') {
  console.log(`record-gate-run: recorded a PASS at ${outcome.attestation.head} -> ${ATTESTATION_PATH}`);
}

process.exit(outcome.exitCode);
