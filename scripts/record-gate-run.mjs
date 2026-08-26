#!/usr/bin/env node
// FR-R3-095 — run the gate and record what was observed.
//
// This spawns the gate as a child and writes down the exit code it watched. The
// direction matters and is the whole point: the writer is OUTSIDE the thing the
// record vouches for, so it cannot record a pass it did not see. A step appended
// to the gate chain that wrote its own attestation would prove only that the step
// ran, which is the shape `FR-R3-072` deleted when it removed a fabricated live
// probe.
//
// It refuses to write over a dirty tree BEFORE spending the gate's wall-clock,
// because the result would describe a tree nobody can reconstruct.
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import {
  ATTESTATION_PATH,
  ATTESTATION_VERSION,
  GATE_COMMAND,
  REPO_ROOT,
  readTreeState
} from './gate-attestation.mjs';

const { head, treeClean } = readTreeState();

if (!treeClean) {
  console.error(
    'record-gate-run: the working tree has uncommitted changes.\n' +
      '  A gate result recorded here would name a commit it did not actually test.\n' +
      '  Commit or stash first, then re-run.'
  );
  process.exit(2);
}

console.log(`record-gate-run: observing \`${GATE_COMMAND}\` at ${head} — this takes a while.`);
const startedAt = new Date().toISOString();

// Inherited stdio: the operator watches the real gate, not a summary of it. The
// exit code is the only thing read back, and it comes from the child.
//
// `npm.cmd` on Windows, where `npm` is a shell script `spawnSync` cannot execute
// directly. `shell: true` would be the shorter fix and is refused on principle:
// every other spawn in this tree passes `shell: false`, and a release-path script
// is the last place to introduce a shell that parses its arguments.
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'ci'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: false,
  encoding: 'utf8'
});

// A gate that could not be spawned is not a gate that failed, and recording it as
// exit code 1 would be indistinguishable from a red run. Refuse to write.
if (result.error) {
  console.error(`record-gate-run: could not spawn the gate: ${result.error.message}`);
  process.exit(2);
}

const exitCode = result.status === null ? `signal:${result.signal}` : result.status;

// Re-read the tree AFTER the run. A gate that writes into its own checkout —
// coverage output, a build directory, a lockfile touch — produced a result about
// a tree that no longer exists by the time it finished.
const after = readTreeState();
if (after.head !== head || !after.treeClean) {
  console.error(
    'record-gate-run: the tree changed while the gate ran ' +
      `(head ${head} -> ${after.head}, clean ${String(treeClean)} -> ${String(after.treeClean)}).\n` +
      '  Refusing to record a result whose subject moved underneath it.'
  );
  process.exit(2);
}

const attestation = {
  version: ATTESTATION_VERSION,
  command: GATE_COMMAND,
  head,
  treeClean: true,
  exitCode,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  startedAt,
  recordedAt: new Date().toISOString()
};

// FR-R3-111 (FR-110) — an explicit durability barrier on the attestation.
//
// WHY HERE AND NOT EVERYWHERE. Measured 2026-08-26: an `fsync` costs **3.9 ms** against 0.014 ms
// for a plain append — 289x. On the audit log's per-event appends that is a hot-path cost and the
// decision went the other way (see docs/architecture/durability-decision.md). This file is written
// **once per gate run**, immediately after a multi-minute gate, and a release is bound to it. 3.9 ms
// against four minutes is free, and the failure it prevents is specific: a machine that loses power
// between the gate finishing and the kernel flushing would leave a release bound to an attestation
// that is absent or truncated — and a truncated JSON record is refused as `unreadable`, which reads
// as "the gate never ran" for a gate that did.
//
// `writeFileSync` + `fsyncSync` rather than a single call, because Node offers no atomic
// write-and-sync. The window between them is one syscall wide and closes on the same failure this
// is about.
const handle = openSync(ATTESTATION_PATH, 'w');
try {
  writeFileSync(handle, `${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
  fsyncSync(handle);
} finally {
  closeSync(handle);
}

if (exitCode === 0) {
  console.log(`record-gate-run: recorded a PASS at ${head} -> ${ATTESTATION_PATH}`);
  process.exit(0);
}
// A red run is recorded too, and deliberately: the release check reads the exit
// code and refuses on a non-zero one, so a failing gate leaves anti-evidence
// rather than leaving the previous commit's pass standing as the most recent
// record anyone finds.
console.error(`record-gate-run: recorded a FAILURE (exit ${String(exitCode)}) at ${head}`);
process.exit(1);
