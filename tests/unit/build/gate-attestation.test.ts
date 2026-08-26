import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * FR-R3-095 — the release binding for the release path this project has.
 *
 * `require-full-gate.mjs` binds a release to a verified gate result at the exact
 * commit, and that shape is right; what it reads is GitHub Actions run records,
 * and this project does not run them, so its data source is empty regardless of
 * who calls it. `S14` recorded that; this is the same binding over evidence that
 * exists.
 *
 * The decision is pure over a parsed record, so every refusal below is exercised
 * without git, without a gate run and without cutting a release. A release gate
 * that can only be exercised by releasing is a gate nobody exercises.
 *
 * FR-R3-099 withdrew the sibling this note used to cite (`require-full-gate.mjs`
 * and its test) along with the Actions it read; `docs/release/
 * withdrawn-ci-controls.md` records what it was. This attestation is no longer one
 * of two release bindings — it is the only one.
 *
 * Loaded dynamically for the same TS1479 reason its sibling records.
 */
async function loadGate() {
  return import('../../../scripts/gate-attestation.mjs');
}

let gate: Awaited<ReturnType<typeof loadGate>>;

beforeAll(async () => {
  gate = await loadGate();
});

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A record of the shape `record-gate-run.mjs` writes on a green run. */
const passing = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  command: gate.GATE_COMMAND,
  head: HEAD,
  treeClean: true,
  exitCode: 0,
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v22.0.0',
  startedAt: '2026-08-26T10:00:00.000Z',
  recordedAt: '2026-08-26T10:30:00.000Z',
  ...over
});

const decide = (over: Record<string, unknown> = {}): ReturnType<typeof gate.decideRelease> =>
  gate.decideRelease({ attestation: passing(), head: HEAD, treeClean: true, ...over });

describe('FR-R3-095 — a release is bound to a verified gate result for THIS commit', () => {
  it('allows a release when a green record names HEAD over a clean tree', () => {
    const verdict = decide();
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain(HEAD);
  });

  it('names the platform it ran on, and says the record is local rather than independent', () => {
    // The item asks for the platform to be recorded. Saying it out loud in the
    // success message is what makes `VER-1` visible at the moment someone
    // releases: a green gate on one platform is evidence about one platform.
    const verdict = decide();
    expect(verdict.message).toContain('darwin');
    expect(verdict.message).toContain('LOCAL record');
  });

  it('refuses when no gate has ever been recorded, and says how to record one', () => {
    const verdict = decide({ attestation: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('no-attestation');
    expect(verdict.message).toContain('npm run gate:record');
  });

  it('refuses a green record that names a DIFFERENT commit, naming both', () => {
    // The confusion the whole binding exists to remove: a gate that passed, on
    // some other tree, is not evidence for this one.
    const verdict = decide({ attestation: passing({ head: OTHER }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('wrong-commit');
    expect(verdict.message).toContain(OTHER);
    expect(verdict.message).toContain(HEAD);
  });

  it('refuses when the tree is dirty, however green the record is', () => {
    // "An attestation that outlives its commit is worse than none." A clean
    // record plus a modified tree is exactly that: the record describes bytes
    // that are no longer the ones being packaged.
    const verdict = decide({ treeClean: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('dirty-tree');
  });

  it('refuses a record of a FAILING gate rather than ignoring it', () => {
    // A red run is recorded on purpose, so a failure leaves anti-evidence
    // instead of leaving the previous commit's pass as the newest record found.
    const verdict = decide({ attestation: passing({ exitCode: 1 }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('gate-failed');
    expect(verdict.message).toContain('exit code 1');
  });

  it('refuses a record of a different command', () => {
    // A pass of something cheaper is not a pass of the gate. Without this, the
    // binding is satisfied by whatever the writer happened to run.
    const verdict = decide({ attestation: passing({ command: 'npm run lint' }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('wrong-command');
  });

  it('refuses a record it may not understand rather than guessing', () => {
    const verdict = decide({ attestation: passing({ version: 99 }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('unreadable');
  });

  it('refuses a record that says the tree was dirty when the gate ran', () => {
    // Defence in depth. `record-gate-run.mjs` refuses to write this, so a record
    // carrying it did not come from the recorder — and the refusal says so.
    const verdict = decide({ attestation: passing({ treeClean: false }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('recorded-dirty');
    expect(verdict.message).toContain('did not come from it');
  });

  it('every refusal names a distinct cause, because they have distinct remedies', () => {
    // A gate that says only "refused" sends someone to read the gate instead of
    // fixing the cause. Six causes, six reasons, all different.
    const reasons = [
      decide({ attestation: null }),
      decide({ attestation: passing({ head: OTHER }) }),
      decide({ treeClean: false }),
      decide({ attestation: passing({ exitCode: 1 }) }),
      decide({ attestation: passing({ command: 'npm run lint' }) }),
      decide({ attestation: passing({ version: 99 }) })
    ].map((v) => v.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason).not.toBe('verified');
  });

  it('the dirty-tree refusal outranks every record-level one', () => {
    // Deliberate order: with a modified tree, no record can be right about it,
    // so reporting a stale commit id would send someone to re-record over a tree
    // that would refuse again for the same reason.
    const verdict = gate.decideRelease({
      attestation: passing({ head: OTHER, exitCode: 1 }),
      head: HEAD,
      treeClean: false
    });
    expect(verdict.reason).toBe('dirty-tree');
  });
});

describe('FR-R3-095 — the recorder observes the gate rather than vouching for itself', () => {
  it('names the gate command in one place, and the release check compares it', () => {
    // One authority. A second copy of the command string in the checker is the
    // duplicate-authority shape `FR-082` and `FR-R3-066` both exist to remove —
    // and here it would drift into a binding that passes on the wrong evidence.
    // FR-R3-100 (FR-014) — the attested command is `gate`, not `ci`. `ci` omitted
    // the secret scan, the workflow-pin check, the license check, the docs check and
    // contracts:check, so a release could be attested past a failing secret scan.
    // Widening `ci` in place would have left this string unchanged and every stale
    // attestation still matching by name, so the perimeter moved AND the name did.
    expect(gate.GATE_COMMAND).toBe('npm run gate');
    expect(decide({ attestation: passing({ command: gate.GATE_COMMAND }) }).ok).toBe(true);
  });

  it('refuses an attestation produced by the OLD, narrower command (FR-R3-100 ratchet)', () => {
    // This is the ratchet working as designed, not an edge case to special-case.
    // Every attestation recorded before FR-R3-100 names `npm run ci`, a command whose
    // perimeter omitted five checks -- including the secret scan. Those records
    // describe a weaker gate than the one a release is now bound to, so they are
    // refused by name. The remedy is to re-record, which costs one gate run.
    const verdict = decide({ attestation: passing({ command: 'npm run ci' }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('wrong-command');
    // The refusal must name BOTH commands: "wrong command" with only one of them
    // sends the reader to guess which end moved.
    expect(verdict.message).toContain('npm run ci');
    expect(verdict.message).toContain('npm run gate');
  });

  it('keeps the record out of the repository, and PROVES git agrees', () => {
    // A committed attestation would travel to a clone that never earned it.
    //
    // The `git check-ignore` half is not belt-and-braces, it is the load-bearing
    // one, and an observation on 2026-08-26 is why it exists. The record is
    // written INTO the tree it vouches for, so if git does not ignore it the act
    // of recording makes the tree dirty -- and the release check, which refuses a
    // dirty tree, then refuses every release forever with a message about
    // uncommitted changes that names no file. Observed exactly that way in a
    // worktree whose `.gitignore` predated the entry. Asserting the constant's
    // filename alone would not have caught it: the constant was right and the
    // ignore rule was missing.
    expect(gate.ATTESTATION_PATH.endsWith('.gate-attestation.json')).toBe(true);
    const status = spawnSync('git', ['check-ignore', '-q', gate.ATTESTATION_PATH], {
      cwd: gate.REPO_ROOT
    });
    expect(
      status.status,
      `git does not ignore ${gate.ATTESTATION_PATH}. Recording a gate result would ` +
        'dirty the tree, and the release check refuses a dirty tree -- so every release ' +
        'would be refused with a message that names no cause. Restore the .gitignore entry.'
    ).toBe(0);
  });
});
