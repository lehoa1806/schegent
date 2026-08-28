// FR-R3-095 (S14), amended by FR-R3-099 and FR-R3-100 — the release binding. As of
// 2026-08-26 it is the ONLY one this project has.
//
// This module was written beside `require-full-gate.mjs`, which bound a release to a
// verified GitHub Actions run for the exact commit. The note here used to say that
// binding had no data source because "this project does not run GitHub Actions".
// **That was false**: the remote had 185 runs, including runs at the then-current
// HEAD, none of which any record ever read. The operator has since retired Actions
// entirely, for budget, and both `require-full-gate.mjs` and `release.yml` are
// deleted — see `docs/release/withdrawn-ci-controls.md` for what they were and
// `docs/release/actions-terminal-record.md` for what they produced.
//
// So this is no longer "the same shape over evidence that does exist" as a second
// binding beside a first. It is the whole release gate: a local record that the
// attested command was observed to pass, at a named commit, on a named platform,
// over a clean tree. The release path refuses unless such a record names `HEAD`.
//
// FR-R3-100 widened what that command covers. `GATE_COMMAND` was `npm run ci`,
// which omitted the secret scan, the workflow-pin check, the license check, the docs
// check and `contracts:check` — so a release could be attested past a failing secret
// scan. It is now `npm run gate`, which runs all five and then `ci`. Changing the
// NAME as well as the perimeter is deliberate: the refusal below is an exact string
// match, so every attestation recorded under the narrower command is now refused
// rather than silently honoured.
//
// FR-R3-135 — **it moved the name and not the argv.** `record-gate-run.mjs` printed this
// label, spawned `['run', 'ci']`, and serialized this label into the record. The five checks
// FR-R3-100 added were never observed by any attestation, and the refusal above — an exact
// match against a string the recorder writes unconditionally — could not see it.
// `check-gate-coverage-parity.mjs` was affected the same way from the other side: it derived
// `RELEASE.md`'s coverage block from the script name `gate`, describing the closure of a
// command no record had ever watched.
//
// THE WINDOW, MEASURED RATHER THAN ESTIMATED. The report that filed this said the divergence
// stood "for two months". It did not, and the correction is worth keeping because the true
// shape is sharper than the estimate:
//
//   - `37c054ae` (2026-08-26 19:46 +0700) created the recorder with label `npm run ci` and
//     argv `['run', 'ci']` — consistent, no defect.
//   - `d0b7f2cc` (2026-08-27 00:15 +0700) is FR-R3-100. It changed the label to
//     `npm run gate` and left the argv at `['run', 'ci']`. The divergence opens here.
//   - This item closes it, ~32 hours later.
//
// One attestation was written inside that window — the 2026-08-27 run recorded in
// `docs/architecture/release-posture-engineering-preview.md`, corrected there by this item.
//
// So the label is no longer a constant sitting beside a spawn vector. `GATE_COMMAND_SPEC`
// below owns the executable, the argument vector, the cwd and the script name, and
// `GATE_COMMAND` is *rendered from* its argv. There is one editable authority, and a label
// that does not describe what runs is now unwritable rather than merely unlikely.
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
 * The gate's spawn identity — executable, arguments, working directory, script name.
 *
 * FR-R3-135. This is the single construction site for what the gate IS. Nothing else may
 * assemble an argument vector for it, and nothing else may state its name: the label below
 * is rendered from `args`, so the two cannot disagree. The previous shape — a display
 * constant here and a literal `['run', 'ci']` in the recorder — is exactly the split this
 * replaces, and it is worth naming why a split is the dangerous shape rather than the typo
 * being the dangerous thing: correcting `'ci'` to `'gate'` in the spawn call would have
 * fixed the instance and left two independently editable sites for the next one.
 *
 * Frozen, including `args`, because a mutable authority is not an authority. `executableFor`
 * is a function rather than a resolved string so that a test can ask for the Windows answer
 * on a POSIX machine — the platform resolution is a property worth asserting, and the
 * previous code decided it inline at the spawn site where nothing could reach it.
 *
 * @type {Readonly<{
 *   script: string,
 *   args: readonly string[],
 *   cwd: string,
 *   executableFor: (platform: string) => string
 * }>}
 */
export const GATE_COMMAND_SPEC = Object.freeze({
  script: 'gate',
  args: Object.freeze(['run', 'gate']),
  cwd: REPO_ROOT,
  // `npm.cmd` on Windows, where `npm` is a shell script `spawnSync` cannot execute
  // directly. `shell: true` would be the shorter fix and is refused on principle: every
  // other spawn in this tree passes `shell: false`, and a release-path script is the last
  // place to introduce a shell that parses its arguments.
  executableFor: (platform) => (platform === 'win32' ? 'npm.cmd' : 'npm')
});

/**
 * Render an argument vector as the command an operator would type.
 *
 * Platform-NEUTRAL on purpose: this renders `npm`, never `npm.cmd`. The label goes into the
 * record and into refusal messages, and a record whose command field differed by platform
 * would make two machines' attestations incomparable for a difference that says nothing
 * about what ran. The executable actually spawned is recorded separately, as
 * `commandExecutable`.
 *
 * @param {readonly string[]} args
 * @returns {string}
 */
export function renderGateCommandLabel(args) {
  return ['npm', ...args].join(' ');
}

/**
 * The command whose observed exit code is the evidence.
 *
 * Derived, not stated. Keeping the name and the value means every existing reader — the
 * refusals below, the recorder's announcement, the tests — is untouched, while the string
 * itself is now a projection of the argv that runs. A record written by running something
 * cheaper is not a record of this gate, and the mismatch is now impossible to write rather
 * than merely reported.
 */
export const GATE_COMMAND = renderGateCommandLabel(GATE_COMMAND_SPEC.args);

/**
 * FR-R3-135 — version 2, and every version-1 record is refused.
 *
 * The reason is stronger than "we cannot tell the good ones from the bad ones", which is what
 * this comment said before the window above was measured. **Among version-1 records that the
 * label check would otherwise accept, there are no honest ones.** The label `npm run gate` and
 * the wrong argv were introduced by the same commit (`d0b7f2cc`) and never coexisted with a
 * correct one, so a version-1 record naming `npm run gate` is necessarily a record of a `ci`
 * run. Version-1 records naming `npm run ci` are honest records of `ci`, and those the
 * `wrong-command` refusal below already rejects by name.
 *
 * So refusing the whole version is not a precaution against an indistinguishable minority; it
 * is the exact set. The remedy is one gate run.
 */
export const ATTESTATION_VERSION = 2;

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
 * Every refusal names the specific reason AND the remedy it implies. A gate that says only
 * "refused" sends someone to read the gate instead of fixing the cause. The eight refusals
 * below fall into three remedies, and the reason exists to say which one applies:
 *
 *   - **Re-record** (`no-attestation`, `stale-version`, `wrong-commit`, `gate-failed`) — the
 *     record is absent, superseded, about another commit, or about a red run.
 *   - **Change the tree** (`dirty-tree`) — commit or stash, then record.
 *   - **Inspect the file** (`unreadable`, `wrong-command`, `command-identity-mismatch`,
 *     `recorded-dirty`) — what is on disk is not something the recorder would have written.
 *
 * The count in this comment is maintained by hand and was wrong for one revision (it said
 * "three causes" while there were six). `gate-attestation.test.ts` asserts the refusals are
 * mutually distinct and that each is reachable, which is the part that matters; this prose is
 * a reader's map, not the authority.
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
  // FR-R3-135 — two refusals where there was one, because a superseded record and a corrupt
  // one send the operator to different places. A numeric version this checker does not read is
  // a record from another schema: it may be perfectly intact, and the remedy is one gate run.
  // A version that is absent or not a number means the file is not a record at all —
  // `require-local-gate.mjs` maps a parse failure to `{ version: 'unparseable' }` and lands
  // here — and the remedy is to look at the file.
  if (typeof attestation.version === 'number' && attestation.version !== ATTESTATION_VERSION) {
    return {
      ok: false,
      reason: 'stale-version',
      message:
        `the attestation declares version ${String(attestation.version)} and this checker reads ` +
        `version ${ATTESTATION_VERSION}. Records at earlier versions are refused by version rather ` +
        `than by name: until FR-R3-135 the recorder wrote the label \`${GATE_COMMAND}\` while ` +
        `spawning \`npm run ci\`, so a version-1 record's command field cannot be trusted to say ` +
        `what ran. Re-run \`npm run gate:record\` on this commit — migration is a deliberate ` +
        `re-run, not an upgrade of the old record.`
    };
  }
  if (attestation.version !== ATTESTATION_VERSION) {
    return {
      ok: false,
      reason: 'unreadable',
      message:
        `the attestation's \`version\` is ${JSON.stringify(attestation.version)}, which is not a ` +
        `version number, so this file is not a gate record at all. This is what a truncated or ` +
        `hand-edited file looks like (\`require-local-gate.mjs\` reports a parse failure the same ` +
        `way). Look at ${ATTESTATION_PATH} — re-recording over a file that is corrupt for some ` +
        `other reason will not tell you why.`
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
  // FR-R3-135 — the record carries the argv it spawned, and the label must be that argv's
  // rendering. This is what gives the comparison above a witness: a label alone is a claim,
  // while a label that must equal the rendering of a recorded argv is a claim with evidence
  // behind it. The case it catches is the one the label comparison structurally cannot see —
  // a record whose label says `npm run gate` over a vector that ran something weaker, which
  // is precisely what the recorder itself wrote until this item.
  //
  // ORDERED HERE, and the position is load-bearing at both ends. After the version check,
  // because a version-1 record legitimately has no `commandArgv` and an identity refusal would
  // send an operator to inspect a field that did not exist at that version. After the label
  // comparison, because an internally-consistent record of a *different* command — argv and
  // label both saying `ci` — should report `wrong-command`, which names the remedy, rather than
  // an identity mismatch, which would be true but unhelpful. What is left for this check is
  // exactly the laundering case: a strong label over a weak vector.
  const argv = attestation.commandArgv;
  if (!Array.isArray(argv) || !argv.every((word) => typeof word === 'string')) {
    return {
      ok: false,
      reason: 'command-identity-mismatch',
      message:
        `the attestation carries no usable \`commandArgv\`, so its \`command\` label ` +
        `(${String(attestation.command)}) has nothing to witness it. A version-${ATTESTATION_VERSION} ` +
        `record written by the recorder always carries an array of strings. Re-run ` +
        `\`npm run gate:record\`.`
    };
  }
  if (renderGateCommandLabel(argv) !== attestation.command) {
    return {
      ok: false,
      reason: 'command-identity-mismatch',
      message:
        `the attestation's label says \`${String(attestation.command)}\` while its recorded ` +
        `arguments render as \`${renderGateCommandLabel(argv)}\`. A record whose label does not ` +
        `describe its own argument vector did not come from the recorder.`
    };
  }
  // The rendering comparison above is necessary and NOT sufficient, which is worth stating
  // because the first version of this check stopped there. `join(' ')` is not injective: the
  // single-element vector `['run gate']` renders to `npm run gate` exactly, so a label-versus-
  // rendering test accepts it — while what it actually witnesses is one argument containing a
  // space, which `npm` would not treat as `run gate` and `spawnSync` with `shell: false` would
  // pass through as a single opaque word. A record can therefore satisfy the comparison above
  // while its vector attests to nothing. So the vector is also compared element-wise against
  // the one authority, which is the property the record is supposed to carry.
  const argvMatchesSpec =
    argv.length === GATE_COMMAND_SPEC.args.length &&
    argv.every((word, index) => word === GATE_COMMAND_SPEC.args[index]);
  if (!argvMatchesSpec) {
    return {
      ok: false,
      reason: 'command-identity-mismatch',
      message:
        `the attestation's arguments are ${JSON.stringify(argv)}, and this gate is ` +
        `${JSON.stringify([...GATE_COMMAND_SPEC.args])}. The two render to the same text, so the ` +
        `label looks right, but the recorded vector is not the one that runs — which is a shape ` +
        `the recorder cannot produce. Re-run \`npm run gate:record\`.`
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
