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

/**
 * A record of the shape `record-gate-run.mjs` writes on a green run.
 *
 * FR-R3-135 — version is read from the module rather than pinned to a literal, so a future
 * schema bump does not silently turn every case here into a `stale-version` refusal and hide
 * whatever it was actually asserting. `commandArgv` is the label's witness and is part of the
 * shape now; a record without one is refused.
 */
/**
 * FR-R4-F09 (GR1, GR2) -- the version-3 observation a recorder writes, in the order it writes it.
 * The values describe a run that matched everything it was asked about, so a case that wants a
 * difference changes one field and the others keep it from being a second reason.
 */
const observation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nodeDeclared: '22.0.0',
  nodeMatchesDeclared: true,
  envelope: { present: true },
  trees: [
    { tree: 'root', lockfile: 'package-lock.json', lockfileSha256: 'a'.repeat(64), install: 'matches' },
    { tree: 'webview-ui', lockfile: 'webview-ui/package-lock.json', lockfileSha256: 'b'.repeat(64), install: 'matches' }
  ],
  ...over
});

const passing = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: gate.ATTESTATION_VERSION,
  command: gate.GATE_COMMAND,
  commandExecutable: 'npm',
  commandArgv: ['run', 'gate'],
  head: HEAD,
  treeClean: true,
  exitCode: 0,
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v22.0.0',
  ...observation(),
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
    // FR-R3-135 split this refusal in two. `unreadable` is now the shape that is not a record
    // at all — a version that is absent or not a number, which is what
    // `require-local-gate.mjs` synthesises (`{ version: 'unparseable' }`) for a file that did
    // not parse. The remedy is to look at the file.
    const verdict = decide({ attestation: passing({ version: 'unparseable' }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('unreadable');
  });

  it('refuses a numerically superseded record by VERSION, not by name (FR-R3-135)', () => {
    // The case this exists for is the one the label ratchet cannot see. Until FR-R3-135 the
    // recorder printed and serialized `npm run gate` while spawning `npm run ci`, so a
    // version-1 record with a correct-looking command field may describe a run that never
    // observed the secret scan, the workflow-pin check, the license check, the docs check or
    // contracts:check. An honest version-1 record and a misstated one are byte-identical —
    // there is nothing in the record to tell them apart — so the version is what separates
    // them, and every version-1 record is refused regardless of what its label says.
    const verdict = decide({
      attestation: passing({ version: 1, command: 'npm run gate', exitCode: 0 })
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale-version');
    // Both versions, or the reader is left guessing which end moved.
    expect(verdict.message).toContain('version 1');
    expect(verdict.message).toContain(`version ${gate.ATTESTATION_VERSION}`);
    // And the remedy, which is one gate run rather than an edit to the old record.
    expect(verdict.message).toContain('gate:record');
  });

  it('accepts the current version and refuses a label its own argv does not witness', () => {
    // The identity check is what gives the `wrong-command` comparison a witness. A label is a
    // claim; a label that must equal the rendering of a recorded argv is a claim with evidence
    // behind it, and a hand-edited record cannot present a strong label over a weak vector.
    expect(decide().ok).toBe(true);

    const mismatched = decide({
      attestation: passing({ command: 'npm run gate', commandArgv: ['run', 'ci'] })
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.reason).toBe('command-identity-mismatch');
    expect(mismatched.message).toContain('npm run ci');
    expect(mismatched.message).toContain('npm run gate');
  });

  it('refuses a current-version record that carries no argv to witness its label', () => {
    const verdict = decide({ attestation: passing({ commandArgv: undefined }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('command-identity-mismatch');
  });

  it('refuses a re-split argv that renders correctly but witnesses nothing (FR-R3-135 review)', () => {
    // `join(' ')` is not injective, and the first version of the identity check did not account
    // for it: `['run gate']` renders to `npm run gate` exactly, so a label-versus-rendering
    // comparison accepts it. What it attests to is one argument containing a space — which
    // `spawnSync` with `shell: false` passes to `npm` as a single opaque word, and `npm` does
    // not read as `run gate`. So the vector must also equal this gate's vector element-wise.
    const verdict = decide({ attestation: passing({ commandArgv: ['run gate'] }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('command-identity-mismatch');
    // The message must not claim the label and rendering disagree, because they do not.
    expect(verdict.message).toContain('render to the same text');
    expect(verdict.message).toContain('["run gate"]');
  });

  it('refuses an argv whose elements are not strings, before rendering it', () => {
    // `join(' ')` coerces anything. A record with `commandArgv: [1, 2]` would render `npm 1 2`
    // — harmless here, but the guard is what lets `renderGateCommandLabel` keep its
    // `readonly string[]` contract while reading a file an operator can edit.
    for (const argv of [[1, 2], ['run', null], 'run gate', {}]) {
      const verdict = decide({ attestation: passing({ commandArgv: argv }) });
      expect(verdict.reason, `argv ${JSON.stringify(argv)}`).toBe('command-identity-mismatch');
    }
  });

  it('the unreadable refusal names the file, not a re-record', () => {
    // The two version refusals must not converge on the same advice. A superseded record needs
    // a gate run; a file whose `version` is not a number is not a record, and re-recording over
    // it would destroy the evidence of why it was corrupt without explaining anything.
    const verdict = decide({ attestation: passing({ version: 'unparseable' }) });
    expect(verdict.reason).toBe('unreadable');
    expect(verdict.message).toContain(gate.ATTESTATION_PATH);
    expect(verdict.message).toContain('not a version number');
    expect(verdict.message).not.toContain('npm run gate:record');
  });

  it('checks the version BEFORE command identity, so a v1 record is not sent to the wrong field', () => {
    // Ordering is deliberate: a version-1 record legitimately has no `commandArgv`, and
    // reporting an identity mismatch for it would send an operator to inspect a field that did
    // not exist at that version. The remedy it needs is "re-record", not "your argv is wrong".
    const verdict = decide({
      attestation: passing({ version: 1, commandArgv: undefined })
    });
    expect(verdict.reason).toBe('stale-version');
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
    // fixing the cause. FR-R3-135 took this from six causes to eight: `stale-version` split
    // from `unreadable`, and `command-identity-mismatch` is new.
    const reasons = [
      decide({ attestation: null }),
      decide({ attestation: passing({ head: OTHER }) }),
      decide({ treeClean: false }),
      decide({ attestation: passing({ exitCode: 1 }) }),
      decide({ attestation: passing({ command: 'npm run lint' }) }),
      decide({ attestation: passing({ version: 'unparseable' }) }),
      decide({ attestation: passing({ version: 1 }) }),
      decide({ attestation: passing({ commandArgv: ['run', 'ci'] }) }),
      decide({ attestation: passing({ envelope: undefined }) })
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

describe('FR-R4-F09 — version 3 says what the gate observed (T10, GR1, GR4)', () => {
  it('reads version 3', () => {
    expect(gate.ATTESTATION_VERSION).toBe(3);
  });

  it('refuses a version-2 record by version, with the re-record instruction', () => {
    const verdict = decide({ attestation: passing({ version: 2 }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale-version');
    expect(verdict.message).toContain('version 2');
    expect(verdict.message).toContain('version 3');
    expect(verdict.message).toContain('npm run gate:record');
  });

  it('says why version 2 cannot be read: it holds no declared-Node, envelope or tree observation', () => {
    const { message } = decide({ attestation: passing({ version: 2 }) });
    expect(message).toMatch(/declared Node/i);
    expect(message).toMatch(/envelope/i);
    expect(message).toMatch(/tree/i);
    expect(message).toMatch(/re-?run/i);
  });

  it.each(['nodeDeclared', 'nodeMatchesDeclared', 'envelope', 'trees'])(
    'refuses a version-3 record missing %s as observation-missing, naming it',
    (field) => {
      const without = { ...passing() };
      delete without[field];
      const verdict = decide({ attestation: without });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('observation-missing');
      expect(verdict.message).toContain(field);
    }
  );

  it.each([
    ['nodeDeclared that is a number', { nodeDeclared: 24 }, 'nodeDeclared'],
    ['nodeMatchesDeclared that is a string', { nodeMatchesDeclared: 'yes' }, 'nodeMatchesDeclared'],
    ['an envelope that is null', { envelope: null }, 'envelope'],
    ['an envelope.present that is not a boolean', { envelope: { present: 'yes' } }, 'envelope.present'],
    ['no trees', { trees: [] }, 'trees'],
    ['trees that are not a list', { trees: 'root' }, 'trees'],
    [
      'the trees in the wrong order',
      { trees: [...(observation().trees as object[])].reverse() },
      'trees'
    ],
    [
      'a third tree',
      { trees: [...(observation().trees as object[]), { tree: 'extra', lockfile: 'x', lockfileSha256: null, install: 'matches' }] },
      'trees'
    ],
    [
      'a tree with no lockfile path',
      { trees: [{ tree: 'root', lockfileSha256: null, install: 'matches' }, (observation().trees as object[])[1]] },
      'lockfile'
    ],
    [
      'a lockfile digest that is not 64 hex or null',
      {
        trees: [
          { tree: 'root', lockfile: 'package-lock.json', lockfileSha256: 'abc', install: 'matches' },
          (observation().trees as object[])[1]
        ]
      },
      'lockfileSha256'
    ],
    [
      'an install state outside the closed set',
      {
        trees: [
          { tree: 'root', lockfile: 'package-lock.json', lockfileSha256: null, install: 'perfect' },
          (observation().trees as object[])[1]
        ]
      },
      'install'
    ]
  ])('refuses %s as observation-missing, naming the field', (_label, over, field) => {
    const verdict = decide({ attestation: passing(over) });
    expect(verdict.reason).toBe('observation-missing');
    expect(verdict.message).toContain(field);
  });

  it('checks the observation AFTER the existing checks, so a red or wrong-commit record keeps its own reason', () => {
    const bare = { ...passing({ exitCode: 1 }) };
    delete bare['envelope'];
    expect(decide({ attestation: bare }).reason).toBe('gate-failed');
    const elsewhere = { ...passing({ head: OTHER }) };
    delete elsewhere['trees'];
    expect(decide({ attestation: elsewhere }).reason).toBe('wrong-commit');
  });

  it('accepts a complete version-3 record', () => {
    expect(decide().reason).toBe('verified');
  });
});

describe('FR-R4-F09 — the verified message prints the observation and refuses on none of it (GR4, research R17)', () => {
  it('prints the Node that ran beside the declared one, marking a difference', () => {
    const differs = decide({
      attestation: passing({ nodeVersion: 'v24.21.0', nodeDeclared: '24.19.0', nodeMatchesDeclared: false })
    });
    expect(differs.ok).toBe(true);
    expect(differs.message).toContain('v24.21.0');
    expect(differs.message).toContain('24.19.0');
    expect(differs.message).toContain('(differs)');

    const same = decide({
      attestation: passing({ nodeVersion: 'v24.19.0', nodeDeclared: '24.19.0', nodeMatchesDeclared: true })
    });
    expect(same.ok).toBe(true);
    expect(same.message).toContain('24.19.0');
    expect(same.message).not.toContain('(differs)');
  });

  it('says so, without calling it a difference, when no Node was declared', () => {
    const verdict = decide({ attestation: passing({ nodeDeclared: null, nodeMatchesDeclared: false }) });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toMatch(/declares none|not declared|no declared/i);
    expect(verdict.message).not.toContain('(differs)');
  });

  it('prints the envelope as present, or as absent in a standalone clone', () => {
    expect(decide().message).toContain('workspace envelope: present');
    const standalone = decide({ attestation: passing({ envelope: { present: false } }) });
    expect(standalone.ok).toBe(true);
    expect(standalone.message).toContain('absent (standalone clone)');
    expect(standalone.message).toMatch(/skipped/i);
  });

  it('prints each tree\'s install state, and an install that is not a match does not refuse', () => {
    const trees = [
      { tree: 'root', lockfile: 'package-lock.json', lockfileSha256: 'a'.repeat(64), install: 'differs', installDifferences: 3 },
      { tree: 'webview-ui', lockfile: 'webview-ui/package-lock.json', lockfileSha256: null, install: 'unreadable' }
    ];
    const verdict = decide({ attestation: passing({ trees }) });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('root install: differs');
    expect(verdict.message).toContain('3');
    expect(verdict.message).toContain('webview-ui install: unreadable');

    const matching = decide().message;
    expect(matching).toContain('root install: matches');
    expect(matching).toContain('webview-ui install: matches');

    const absent = decide({
      attestation: passing({
        trees: [
          { tree: 'root', lockfile: 'package-lock.json', lockfileSha256: 'a'.repeat(64), install: 'absent' },
          (observation().trees as object[])[1]
        ]
      })
    });
    expect(absent.ok).toBe(true);
    expect(absent.message).toContain('root install: absent');
  });

  it('keeps the sentence that the record is local and not independent verification', () => {
    expect(decide().message).toContain('This is a LOCAL record on this machine, not independent verification');
  });

  it('prints a record\'s free text only as data: a path or label it carries never reaches the message', () => {
    const verdict = decide({
      attestation: passing({
        trees: [
          { tree: 'root', lockfile: '/Users/someone/package-lock.json', lockfileSha256: null, install: 'matches' },
          (observation().trees as object[])[1]
        ]
      })
    });
    expect(verdict.message).not.toContain('/Users/someone');
  });
});
