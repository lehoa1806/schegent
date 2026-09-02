import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runExecFile = promisify(execFile);

/**
 * The empty tree, per hash algorithm. These are not arbitrary constants: a tree
 * object's id is the hash of its (here, empty) content, so both values are fixed
 * by the object format and cannot drift. They are spelled out rather than
 * derived from `git hash-object -t tree <devNull>` because that needs a readable
 * `/dev/null` — `os.devNull` is `\\.\nul` on Windows and Git for Windows is not
 * reliably willing to open it — and this resolution runs on the path that blocks
 * a Git-capable phase when it fails.
 */
export const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const EMPTY_TREE_SHA256 =
  '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

/** What a diff is taken against, and whether git had a commit to offer. */
export interface DiffBase {
  /** A ref `git diff` accepts: the resolved HEAD, or the empty tree. */
  readonly ref: string;
  /** True when the branch has no commits, so `ref` is the empty tree. */
  readonly unborn: boolean;
}

/**
 * Resolve what `git diff` should be given as the left-hand side in `cwd`.
 *
 * A freshly `git init`-ed workspace has an **unborn HEAD** — a symbolic ref to a
 * branch that does not exist yet — and every `HEAD`-relative command against it
 * fails with `ambiguous argument 'HEAD'`. Callers used to route that into the
 * same handler as an unreadable tree, which blocked the first Git-capable phase
 * in any workspace whose first commit had not been made. The tree is readable;
 * there is only no commit to diff against, and git's own answer for that is the
 * empty tree, against which every tracked path reads as an addition.
 *
 * Rejects when `cwd` is not a repository, and — deliberately — when HEAD names a
 * branch whose ref exists but will not resolve. That second case is a damaged
 * repository, not an empty one, and treating it as unborn would diff the whole
 * tree against nothing and write the result as a checkpoint. A patch that large
 * presenting as a restore point is worse than the failure it would be hiding, so
 * only a genuinely absent ref takes the empty-tree path.
 */
export async function resolveDiffBase(cwd: string): Promise<DiffBase> {
  try {
    const { stdout } = await runExecFile('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      maxBuffer: 1024
    });
    return { ref: stdout.trim(), unborn: false };
  } catch (error) {
    if (!(await hasUnbornHead(cwd))) throw error;
    return { ref: await emptyTree(cwd), unborn: true };
  }
}

/**
 * Whether HEAD is unborn: it names a branch, and that branch has no ref yet.
 *
 * Both halves are load-bearing. Outside a repository — and in one damaged badly
 * enough that git no longer recognises it — `symbolic-ref` fails, so the caller
 * rethrows. On a detached HEAD it also fails, but `rev-parse --verify` would
 * have succeeded there and this is never reached.
 */
async function hasUnbornHead(cwd: string): Promise<boolean> {
  let ref: string;
  try {
    const { stdout } = await runExecFile('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd,
      maxBuffer: 1024
    });
    ref = stdout.trim();
  } catch {
    return false;
  }
  if (ref === '') return false;
  try {
    await runExecFile('git', ['show-ref', '--verify', '--quiet', ref], { cwd, maxBuffer: 1024 });
    // The branch exists, so HEAD should have resolved. It did not: damaged, not
    // empty.
    return false;
  } catch {
    return true;
  }
}

/**
 * The empty tree for this repository's hash algorithm.
 *
 * A sha256 repository's empty tree is a different object, and handing `git diff`
 * the sha1 id there names nothing. `--show-object-format` arrived in git 2.29,
 * the same release that introduced sha256 repositories at all — so a git old
 * enough to reject the flag is a git that cannot be reading a sha256 repository,
 * which makes the fallback exact rather than a guess.
 */
async function emptyTree(cwd: string): Promise<string> {
  try {
    const { stdout } = await runExecFile('git', ['rev-parse', '--show-object-format'], {
      cwd,
      maxBuffer: 1024
    });
    return stdout.trim() === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
  } catch {
    return EMPTY_TREE_SHA1;
  }
}
