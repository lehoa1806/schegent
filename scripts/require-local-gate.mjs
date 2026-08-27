#!/usr/bin/env node
// FR-R3-095 — the release-side refusal.
//
// `require-full-gate.mjs` is the same binding over GitHub Actions run records and
// stays in place for the day this project runs them; see RELEASE.md. This is the
// binding for the release path that exists today, and it fails closed for the
// same reason: an unanswerable check is a refusal, not a pass.
import { readFileSync } from 'node:fs';
import { ATTESTATION_PATH, decideRelease, readTreeState } from './gate-attestation.mjs';
import { checkManifestVersions } from './check-manifest-versions.mjs';
import {
  DRIFT_OVERRIDE_ENV,
  changedQualificationPaths,
  decideQualification,
  probeInstalledVersions,
  readQualification
} from './backend-qualification.mjs';

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

// FR-R3-104 (FR-051, FR-053, FR-055, FR-058) — the second binding: the gate attestation says the
// verification suite passed on this tree, and it says nothing about whether the three third-party
// CLIs this product drives still speak the protocol the adapters parse. Every fixture in the eval
// corpus is a recording of the OLD protocol, so protocol drift is invisible to the whole suite.
//
// HERE AND NOT IN `npm run gate`, because qualification costs live turns on the operator's own
// subscription. A release is a deliberate act with a person present; `ci` is not.
//
// REFUSES, WITH AN OVERRIDE, and the reason for that shape rather than a warning: a warning at
// release time is read by the same person who is about to type `npm publish` and has already
// decided to. The override exists because "the CLI moved and I still need to ship" is a real
// position an operator may take; what it must not be is silent, so taking it prints
// RELEASING UNQUALIFIED and points at the log entry FR-057 requires.
const qualification = readQualification();
const qualificationVerdict = decideQualification({
  record: qualification,
  head,
  installedVersions: probeInstalledVersions(),
  changedPaths: changedQualificationPaths(qualification?.commit, head),
  now: new Date().toISOString(),
  overrideRequested: process.env[DRIFT_OVERRIDE_ENV] === '1'
});

if (!qualificationVerdict.ok) {
  console.error(
    `require-local-gate: REFUSED (${qualificationVerdict.reason})\n  ${qualificationVerdict.message}\n` +
      `  To release anyway, set ${DRIFT_OVERRIDE_ENV}=1 and record the unqualified release in ` +
      'docs/release/backend-qualification-log.md.'
  );
  process.exit(1);
}
console.log(`require-local-gate: ${qualificationVerdict.message}`);


// FR-R3-120 (FR-014) — the third binding: the tree agrees with itself about what
// version it is, and any `v*` tag on HEAD agrees with it too.
//
// `RELEASE.md` §1 said the gap plainly — "Nothing mechanically checks the tag
// against the manifest any more" — because that check lived in the tag job
// `FR-R3-099` retired with the rest of Actions. This restores it where every
// release now happens.
//
// HERE, AND NOT AS A SECOND COMMAND CHAINED IN package.json, so a release refuses
// for one reason at a time, in one shape, from one script. The two bindings above
// fail closed; a third that only warned would be the odd one out and would teach
// the wrong thing about what a preflight is for.
const manifestVerdict = checkManifestVersions();
if (!manifestVerdict.ok) {
  console.error(
    `require-local-gate: REFUSED (${manifestVerdict.reason})\n  ${manifestVerdict.detail}`
  );
  for (const problem of manifestVerdict.problems) console.error(`    ${problem}`);
  process.exit(1);
}
console.log(
  `require-local-gate: manifests agree at ${manifestVerdict.version}` +
    `${manifestVerdict.tagged ? `, matching tag ${manifestVerdict.tagged}` : ' (no v* tag on HEAD)'}.`
);
