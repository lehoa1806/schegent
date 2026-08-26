// FR-R3-095 (S14) — the release binding, for the release path this project
// actually has.
//
// `require-full-gate.mjs` binds a release to a VERIFIED gate result for the exact
// commit, and that shape is right. What it reads is workflow run records, and
// this project does not run GitHub Actions, so its data source is empty
// regardless of who calls it. The binding was sound and the evidence did not
// exist.
//
// This is the same shape over evidence that does exist: a local record that
// `npm run ci` was observed to pass, at a named commit, on a named platform, over
// a clean tree. The release path refuses unless such a record names `HEAD`.
//
// WHAT THIS IS NOT. A local attestation is not tamper-evident against the
// operator whose machine wrote it — anyone who can run the release can also edit
// the file it reads. It is a risk reduction against the two failures that
// actually happen: releasing a commit whose gate never ran, and releasing a
// commit whose gate ran on a DIFFERENT tree. It is not a defence against
// forgery, and nothing here should be read as one.
//
// TWO PROPERTIES ARE DESIGNED IN, both named by the item:
//
//   1. **The record is observed, not self-issued.** `record-gate-run.mjs` SPAWNS
//      the gate and records the exit code it watched, so the writer sits outside
//      the thing the record vouches for. A gate step that wrote its own pass
//      would prove only that the step ran — the shape `FR-R3-072` removed when
//      it deleted a fabricated live probe.
//   2. **The record cannot outlive its tree.** It names the commit and refuses to
//      be written over a dirty one, and the check refuses again if the tree is
//      dirty at release time. A pass over a tree nobody can reconstruct is worse
//      than no record, because it reads as evidence.
//
// The decision is a pure function over a parsed record so it can be exercised
// without git, without a gate run and without cutting a release — the same
// reasoning `require-full-gate.mjs` states for `decideFullGate`. A release gate
// that can only be exercised by releasing is a gate nobody exercises.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root, from this file rather than the caller's cwd.
 *
 * Via `fileURLToPath`, not `new URL().pathname`: on Windows the latter yields a
 * leading-slash `/C:/...` that no filesystem call accepts, and this script is
 * reached from a release path, where a portability failure surfaces at the worst
 * possible moment. `check-doc-links.mjs` resolves its root the same way.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the record lives.
 *
 * Untracked on purpose. It describes one machine's observation of one tree at
 * one time, so committing it would publish a claim about a checkout nobody else
 * has — and the next clone would inherit an attestation it never earned.
 */
export const ATTESTATION_PATH = resolve(REPO_ROOT, '.gate-attestation.json');

/**
 * The command whose observed exit code is the evidence.
 *
 * Stated once and compared, never re-derived: a record written by running
 * something cheaper is not a record of this gate, and the refusal names the
 * mismatch rather than accepting it.
 */
export const GATE_COMMAND = 'npm run ci';

export const ATTESTATION_VERSION = 1;

/** `git` output for one repository, trimmed. Throws when git cannot answer. */
function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/**
 * The tree this attestation is about.
 *
 * `repo/` is its own repository and the VSIX is built entirely from it, so its
 * HEAD is what a release is a release OF. The planning envelope above it can move
 * without changing a byte of the artifact, and binding to it would refuse
 * releases for documentation edits.
 *
 * `--porcelain` over `diff --quiet` because untracked files count: a new source
 * file that the gate never compiled is exactly the drift this is here to catch.
 */
export function readTreeState() {
  return {
    head: git(['rev-parse', 'HEAD']),
    treeClean: git(['status', '--porcelain']).length === 0
  };
}

/**
 * Decide whether a release may proceed. Pure over its inputs.
 *
 * Every refusal names the specific reason. A gate that says only "refused" sends
 * someone to read the gate instead of fixing the cause, and the three causes here
 * — never ran, ran on another commit, ran on a tree that has since changed —
 * have three different remedies.
 */
export function decideRelease({ attestation, head, treeClean, now }) {
  if (!treeClean) {
    return {
      ok: false,
      reason: 'dirty-tree',
      message:
        `the working tree has uncommitted changes, so no gate result can describe it. ` +
        `Commit or stash, then run \`${GATE_COMMAND}\` through \`npm run gate:record\`.`
    };
  }
  if (attestation === null || attestation === undefined) {
    return {
      ok: false,
      reason: 'no-attestation',
      message:
        `no gate attestation exists at ${ATTESTATION_PATH}. ` +
        `Run \`npm run gate:record\` on this commit before releasing.`
    };
  }
  if (attestation.version !== ATTESTATION_VERSION) {
    return {
      ok: false,
      reason: 'unreadable',
      message:
        `the attestation declares version ${String(attestation.version)}, and this checker ` +
        `reads version ${ATTESTATION_VERSION}. Refusing to interpret a record it may not understand.`
    };
  }
  if (attestation.command !== GATE_COMMAND) {
    return {
      ok: false,
      reason: 'wrong-command',
      message:
        `the attestation records \`${String(attestation.command)}\`, not \`${GATE_COMMAND}\`. ` +
        `A pass of a different command is not evidence for this one.`
    };
  }
  if (attestation.head !== head) {
    return {
      ok: false,
      reason: 'wrong-commit',
      message:
        `the attestation names commit ${String(attestation.head)} and HEAD is ${head}. ` +
        `A green gate on another commit is not evidence for this one — re-run \`npm run gate:record\`.`
    };
  }
  if (attestation.treeClean !== true) {
    // Defence in depth: the recorder refuses to write this, so reaching it means
    // the file was edited or produced by something other than the recorder.
    return {
      ok: false,
      reason: 'recorded-dirty',
      message:
        'the attestation records that the tree was dirty when the gate ran, so it does not ' +
        'describe this commit. The recorder does not write such a record; this one did not come from it.'
    };
  }
  if (attestation.exitCode !== 0) {
    return {
      ok: false,
      reason: 'gate-failed',
      message:
        `the attestation records exit code ${String(attestation.exitCode)} — the gate was observed FAILING ` +
        `at this commit. Fix it and re-run \`npm run gate:record\`.`
    };
  }
  return {
    ok: true,
    reason: 'verified',
    message:
      `gate verified at ${head}: \`${GATE_COMMAND}\` observed passing on ` +
      `${String(attestation.platform)}/${String(attestation.arch)}, node ${String(attestation.nodeVersion)}, ` +
      `recorded ${String(attestation.recordedAt)}` +
      (typeof now === 'string' ? ` (checked ${now})` : '') +
      `.\nThis is a LOCAL record on this machine, not independent verification. ` +
      `The platform above is the only one the gate ran on.`
  };
}
