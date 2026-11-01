// FR-R4-F09 (FR-030, FR-031; contract GR2; research R15, R16) -- what the gate ran on, written down
// before it runs.
//
// A gate record used to say where and when the gate ran and nothing about what it ran on. It could
// not say that the repository declares Node 24.19.0 while the gate ran on 24.21.0, that the planning
// envelope above the checkout was absent (so the gates that read it skipped), or which lockfile and
// which installed tree each of the two dependency trees was gated on. This observation is taken
// once, before the gate is spawned, and the recorder writes it into the record.
//
// IT DESCRIBES AND NEVER DECIDES. A Node mismatch, a standalone clone and an install that differs
// from its lockfile are recorded and carried, and none of them refuses anything here or at release
// (research R17): refusing on a Node mismatch would block every release from a shell whose Node
// differs by a patch for a fact the record now shows. It also never says more than it saw: it names
// no platform, Node or tree that did not run, and every path in it is repository-relative.
//
// The filesystem and the envelope predicate are injected, so the module reads nothing by itself and
// every case of it is a map of paths to bytes.
import { join } from 'node:path';
import { sha256Hex } from './release-digest.mjs';

/** The most bytes an `.nvmrc` may have and still be believed. A larger file is not a version. */
const NVMRC_MAX_BYTES = 64;

/** The two trees, in the order the record lists them, with the files the observation reads. */
const TREES = Object.freeze([
  Object.freeze({
    tree: 'root',
    lockfile: 'package-lock.json',
    hidden: 'node_modules/.package-lock.json'
  }),
  Object.freeze({
    tree: 'webview-ui',
    lockfile: 'webview-ui/package-lock.json',
    hidden: 'webview-ui/node_modules/.package-lock.json'
  })
]);

/** A file's bytes, or why there are none: `absent` (it does not exist) or `unreadable` (anything else). */
function readOptional(readFile, path) {
  try {
    return { state: 'read', bytes: readFile(path) };
  } catch (cause) {
    return { state: cause?.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * How many entries differ between a lockfile and npm's hidden lockfile for the same install.
 * The hidden lockfile omits the platform packages that do not apply to this machine, so an entry
 * the lock marks `optional` and the install lacks is not a difference. Anything else is: an entry
 * missing without `optional`, an entry only the install has, or a shared entry at another version.
 */
function countInstallDifferences(lockPackages, hiddenPackages) {
  let differences = 0;
  for (const [key, entry] of Object.entries(lockPackages)) {
    if (key === '') continue;
    if (!Object.hasOwn(hiddenPackages, key)) {
      if (entry?.optional !== true) differences += 1;
    } else if (entry?.version !== hiddenPackages[key]?.version) {
      differences += 1;
    }
  }
  for (const key of Object.keys(hiddenPackages)) {
    if (key !== '' && !Object.hasOwn(lockPackages, key)) differences += 1;
  }
  return differences;
}

/** One tree's entry: its lockfile, the digest of the lockfile's bytes, and what is installed. */
function observeTree({ tree, lockfile, hidden }, root, readFile) {
  const lock = readOptional(readFile, join(root, lockfile));
  if (lock.state !== 'read') {
    return { tree, lockfile, lockfileSha256: null, install: 'unreadable' };
  }
  const lockfileSha256 = sha256Hex(lock.bytes);
  const lockJson = parseJson(lock.bytes);
  if (lockJson === undefined) return { tree, lockfile, lockfileSha256, install: 'unreadable' };

  const installed = readOptional(readFile, join(root, hidden));
  if (installed.state === 'absent') return { tree, lockfile, lockfileSha256, install: 'absent' };
  const hiddenJson = installed.state === 'read' ? parseJson(installed.bytes) : undefined;
  if (hiddenJson === undefined) return { tree, lockfile, lockfileSha256, install: 'unreadable' };

  const installDifferences = countInstallDifferences(lockJson.packages ?? {}, hiddenJson.packages ?? {});
  return installDifferences === 0
    ? { tree, lockfile, lockfileSha256, install: 'matches' }
    : { tree, lockfile, lockfileSha256, install: 'differs', installDifferences };
}

/**
 * Observe the environment the gate is about to run in.
 *
 * `nodeDeclared` is `.nvmrc` trimmed, or `null` when the file is absent, empty or over 64 bytes.
 * `nodeMatchesDeclared` is false whenever `nodeDeclared` is `null`. `envelope.present` is the
 * injected predicate's answer, asked once. `trees` is exactly `root` then `webview-ui`.
 *
 * @param {{ root: string, readFile: (path: string) => Buffer, envelopePresent: () => boolean,
 *   nodeVersion: string }} input
 */
export function observeGateEnvironment({ root, readFile, envelopePresent, nodeVersion }) {
  const nvmrc = readOptional(readFile, join(root, '.nvmrc'));
  const declared =
    nvmrc.state === 'read' && nvmrc.bytes.length <= NVMRC_MAX_BYTES ? nvmrc.bytes.toString('utf8').trim() : '';
  const nodeDeclared = declared === '' ? null : declared;

  return {
    nodeDeclared,
    nodeMatchesDeclared: nodeDeclared !== null && nodeVersion === `v${nodeDeclared}`,
    envelope: { present: envelopePresent() === true },
    trees: TREES.map((entry) => observeTree(entry, root, readFile))
  };
}
