// FR-R3-104 (FR-054, FR-055) — what version of the CLI is this run actually driving?
//
// THE GAP. The qualification record names the CLI versions a canary observed. Nothing on the
// host observed the version it drives, so an operator upgrading `claude` mid-feature
// crossed the protocol boundary the record vouches for and no evidence said so. When a parse then
// failed, the record showed a qualified version and the machine had another one installed — a
// diagnosis nobody could reach from the evidence.
//
// A VERSION, NEVER A PATH. `cliPath` is deliberately absent from every audit payload
// (`InvocationRequest.command` carries it and is documented as never routed to the log). The
// probe answers with the version STRING the CLI printed and the digest of nothing else; the path
// it was probed at stays where it already lives. A version is a fact about the world; a path is a
// fact about this machine's filesystem, and only one of those belongs in an evidence record.
//
// CACHED WITH A TTL, not once per activation and not once per phase. Once per activation would
// miss the upgrade that happens during a long session, which is precisely the drift this exists
// to notice. Once per phase would spawn a process per phase for a value that changes on the order
// of days. A short TTL gets both: a mid-session upgrade is noticed within one window, and a
// pipeline of twenty phases pays for at most a handful of probes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  QUALIFIED_AT,
  QUALIFIED_BACKEND_VERSIONS
} from '../contracts/qualified-backend-versions';

const run = promisify(execFile);

/** How long an observed version stands before it is probed again. */
export const CLI_VERSION_TTL_MS = 10 * 60 * 1000;

/** How long the probe may take. A CLI that cannot answer this in five seconds is answering `null`. */
export const CLI_VERSION_TIMEOUT_MS = 5_000;

/** Bound on what is recorded, so a chatty `--version` cannot inflate an audit payload. */
export const CLI_VERSION_MAX_LEN = 64;

export interface CliVersionProbe {
  /** The observed version, or `null` when it could not be observed. Never throws. */
  observe: (cliPath: string) => Promise<string | null>;
}

export interface CliVersionProbeDeps {
  /** Injected so tests never spawn. Resolves the first line of `<cliPath> --version`. */
  readonly probe?: (cliPath: string) => Promise<string>;
  readonly monotonicNow?: () => number;
}

/**
 * Reduce a `--version` line to the token worth recording.
 *
 * The three CLIs answer differently (`2.1.246 (Claude Code)`, `codex-cli 0.149.0`, `1.1.20`), and
 * the comparison that matters is on the dotted-numeric token — the same reduction
 * `scripts/backend-qualification.mjs` applies, for the same reason: a vendor changing its banner
 * text is not a version change, and an operator who learns that drift warnings usually mean
 * nothing will ignore the one that does not.
 *
 * The whole line is kept when no token is found, bounded, rather than discarded: an unparsed
 * answer is still more than no answer.
 */
export function normalizeCliVersion(line: string): string | null {
  const first = line.split('\n')[0]?.trim() ?? '';
  if (first.length === 0) return null;
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(first);
  return (match?.[1] ?? first).slice(0, CLI_VERSION_MAX_LEN);
}

export function createCliVersionProbe(deps: CliVersionProbeDeps = {}): CliVersionProbe {
  const now = deps.monotonicNow ?? (() => Date.now());
  const probe =
    deps.probe ??
    (async (cliPath: string): Promise<string> => {
      // `shell: false` is the default for `execFile` and is the point: `cliPath` is operator
      // configuration, and a shell between here and the binary would make it a command line.
      const { stdout } = await run(cliPath, ['--version'], {
        timeout: CLI_VERSION_TIMEOUT_MS,
        windowsHide: true
      });
      return stdout;
    });

  const cache = new Map<string, { version: string | null; observedAtMs: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const observe = async (cliPath: string): Promise<string | null> => {
    const cached = cache.get(cliPath);
    if (cached !== undefined && now() - cached.observedAtMs < CLI_VERSION_TTL_MS) {
      return cached.version;
    }
    // One probe per path at a time. Twenty phases starting together must not spawn twenty
    // processes for one answer.
    const existing = inFlight.get(cliPath);
    if (existing !== undefined) return existing;

    // `Promise.resolve().then(...)` rather than `probe(cliPath).then(...)`: a probe that throws
    // SYNCHRONOUSLY never returns a promise for `.catch` to attach to, so the exception escapes
    // into whatever awaited `observe` — a phase, in production. Found by the test that throws
    // synchronously on purpose; the async-rejection path had been covered and this one had not.
    const pending = Promise.resolve()
      .then(() => probe(cliPath))
      .then((stdout) => normalizeCliVersion(stdout))
      .catch(() => null)
      .then((version) => {
        // A failed probe is cached too, for the same window. Otherwise a CLI that is missing or
        // slow would be probed again at every phase, turning one unanswerable question into a
        // per-phase cost.
        cache.set(cliPath, { version, observedAtMs: now() });
        inFlight.delete(cliPath);
        return version;
      });
    inFlight.set(cliPath, pending);
    return pending;
  };

  return { observe };
}

/**
 * FR-R3-104 (FR-054) — the version for one invocation, resolved safely.
 *
 * HERE RATHER THAN IN THE PHASE RUNNER, and the reason is that file's own budget discipline: the
 * shell forwards decisions, it does not make them. The null-registry case, the swallowed failure
 * and the reason for swallowing it are all properties of "how do we observe a version", which is
 * this module's job.
 *
 * NEVER THROWS AND NEVER BLOCKS A PHASE. A version is metadata on an evidence record; a phase
 * that failed to run because `--version` did not answer would trade a working product for a
 * complete record. An unobserved version is recorded as absent, which is honest — the payload
 * simply omits the key rather than carrying a guess.
 */
export async function observedVersionOf(
  registry: { observedCliVersion: (cliPath: string) => Promise<string | null> } | null,
  cliPath: string
): Promise<string | null> {
  if (registry === null) return null;
  try {
    return await registry.observedCliVersion(cliPath);
  } catch {
    return null;
  }
}

type DriftDirection = 'newer than' | 'older than' | 'not comparable to';

/**
 * FR-R3-147 — what each direction means for the operator, which is not the same thing.
 *
 * `===` gave both the same sentence. Four patches ahead and a major version behind are not one
 * condition, and the more dangerous of the two is the one the old wording did not describe.
 */
const DRIFT_ADVICE: Readonly<Record<DriftDirection, string>> = Object.freeze({
  'newer than':
    'A newer CLI usually speaks the same protocol; treat this as context if a phase fails in a way you cannot explain.',
  'older than':
    'An older CLI may not have protocol features this build relies on; upgrading the backend CLI is the fix.',
  'not comparable to':
    'The installed version did not parse as a version, so which way it drifted is unknown.'
});

/**
 * FR-R3-147 — drift compared on `major.minor`, and which side of it we are on.
 *
 * `null` means "not drift, say nothing". That is the patch-only case, and it is the whole point:
 * the backend CLI auto-updates itself while the pin moves only when a human runs the canary and
 * commits, so exact-string equality made this warning permanently on for every installed workspace.
 * A warning that can never be cleared is furniture, and it teaches operators to skip the line where
 * a real incompatibility would one day appear. The qualification table's own header already says
 * "a newer CLI is usually fine; vendors do not break protocols weekly" — this compares the way that
 * sentence reasons.
 *
 * UNPARSEABLE IS DRIFT, deliberately, and says so as `not comparable to` rather than guessing a
 * side. An unreadable version string is not evidence the binary is fine — a lenient fallback would
 * be a way to silence the warning by reporting a shape the comparison cannot read — but it is not
 * evidence of a direction either, and a message that named one would be asserting what this
 * function does not know.
 *
 * THE RELEASE GATE IS NOT THIS. `FR-R3-104` §4 requires a release attempt with a version-mismatched
 * qualification record to be refused, and that stays exact: a release is cut from a checkout by
 * someone who can run the canary, which is precisely the audience this runtime warning does not
 * have. Two surfaces, two audiences; they stopped sharing one comparison here.
 */
function driftDirection(qualified: string, observed: string): DriftDirection | null {
  const q = /^(\d+)\.(\d+)/.exec(qualified);
  const o = /^(\d+)\.(\d+)/.exec(observed);
  if (!q || !o) return 'not comparable to';
  const qMajor = Number(q[1]);
  const oMajor = Number(o[1]);
  if (qMajor !== oMajor) return oMajor > qMajor ? 'newer than' : 'older than';
  const qMinor = Number(q[2]);
  const oMinor = Number(o[2]);
  if (qMinor !== oMinor) return oMinor > qMinor ? 'newer than' : 'older than';
  return null;
}

/**
 * FR-R3-104 (FR-054, FR-055) — the version fields for one phase's records, and the drift warning.
 *
 * ONE PLACE, TWO OUTPUTS, on purpose. The record and the warning are the same observation: a
 * payload field that said `cliVersionDrift: true` while nothing told the operator would be
 * evidence for a reader who already has the failure, and a warning with no field would leave the
 * record unable to explain it later. Splitting them is how the two come to disagree.
 *
 * THE HELPER LOGS, which is unusual here and deliberate: the alternative was a second call site in
 * `phase-runner.ts`, and that file's budget exists precisely to keep decisions like "is this
 * drift" out of the shell. What the shell does is forward the observation.
 *
 * Absent qualification for a backend is NOT drift. A build that never qualified `agy` says nothing
 * about `agy`, and warning about it would teach an operator to ignore this warning.
 */
export function cliVersionFields(
  observed: string | null,
  backend: string,
  logger?: { warn: (message: string) => void }
): Record<string, unknown> {
  if (observed === null) return {};
  // Read through a lookup that admits absence: the table is a `Record<string, string>`, so an
  // index read is TYPED as present while a backend this build never qualified is genuinely
  // missing. `undefined` here is "not qualified", not "qualified as nothing".
  const qualified: string | undefined = Object.prototype.hasOwnProperty.call(
    QUALIFIED_BACKEND_VERSIONS,
    backend
  )
    ? QUALIFIED_BACKEND_VERSIONS[backend]
    : undefined;
  if (qualified === undefined || qualified === observed) return { cliVersion: observed };
  const direction = driftDirection(qualified, observed);
  if (direction === null) return { cliVersion: observed };
  logger?.warn(
    `${backend} CLI ${observed} is ${direction} the version this build was qualified against ` +
      `(${qualified}, ${QUALIFIED_AT}). Protocol handling for this backend has not been checked ` +
      `against this binary. ${DRIFT_ADVICE[direction]} ` +
      'From a checkout, `npm run canary` re-qualifies.'
  );
  return { cliVersion: observed, cliVersionDrift: true, qualifiedCliVersion: qualified };
}
