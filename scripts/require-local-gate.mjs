#!/usr/bin/env node
// FR-R3-095 — the release-side refusal.
//
// `require-full-gate.mjs` is the same binding over GitHub Actions run records and
// stays in place for the day this project runs them; see RELEASE.md. This is the
// binding for the release path that exists today, and it fails closed for the
// same reason: an unanswerable check is a refusal, not a pass.
import { readFileSync } from 'node:fs';
import { ATTESTATION_PATH, decideRelease, readTreeState } from './gate-attestation.mjs';

function readAttestation() {
  let raw;
  try {
    raw = readFileSync(ATTESTATION_PATH, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Distinct from absence: a file that exists and does not parse is a
    // corrupted record, and `decideRelease` reports it as unreadable rather than
    // as "never ran", which sends someone to a different remedy.
    return { version: 'unparseable' };
  }
}

const { head, treeClean } = readTreeState();
const verdict = decideRelease({
  attestation: readAttestation(),
  head,
  treeClean,
  now: new Date().toISOString()
});

if (!verdict.ok) {
  console.error(`require-local-gate: REFUSED (${verdict.reason})\n  ${verdict.message}`);
  process.exit(1);
}
console.log(`require-local-gate: ${verdict.message}`);
