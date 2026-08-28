import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * FR-R3-135 — the recorder spawns the gate it attests.
 *
 * WHAT WAS MISSING AND WHY IT WAS MISSING. `gate-attestation.test.ts` pinned the attested label
 * and every branch of the pure release decision, and passed throughout the window in which
 * `record-gate-run.mjs` printed `npm run gate`, spawned `npm run ci`, and serialized `npm run gate`
 * into the record. It could not have caught it: the argv sat at module top level in a script that
 * ran the real four-minute gate on import, so the only way to observe it was to run one. Nothing
 * about the old coverage was weak except its reach.
 *
 * So the argv is the subject here, and the child process is injected. These tests never spawn
 * anything: a unit test that ran the real gate would be a suite inside a suite, and the property
 * under test is which arguments the recorder passes, not whether the gate passes.
 *
 * Loaded dynamically for the same TS1479 reason its siblings record.
 */
async function loadRecorder() {
  return import('../../../scripts/gate-recorder.mjs');
}
async function loadGate() {
  return import('../../../scripts/gate-attestation.mjs');
}
async function loadParity() {
  return import('../../../scripts/check-gate-coverage-parity.mjs');
}

let recorder: Awaited<ReturnType<typeof loadRecorder>>;
let gate: Awaited<ReturnType<typeof loadGate>>;
let parity: Awaited<ReturnType<typeof loadParity>>;

const HEAD = 'c'.repeat(40);

/** The repository root as the scripts themselves resolve it, not as this file guesses it. */
const repoRoot = () => gate.REPO_ROOT;
const scriptsDir = () => resolve(repoRoot(), 'scripts');

beforeAll(async () => {
  [recorder, gate, parity] = await Promise.all([loadRecorder(), loadGate(), loadParity()]);
});

type SpawnCall = { executable: string; args: readonly string[]; options: Record<string, unknown> };

/**
 * A source file with its comments removed, so a scan for a literal can be about executable text.
 *
 * Not a JavaScript parser and not trying to be: it tracks block-comment nesting across lines and
 * cuts a line comment at the first `//` that is not preceded by `:` — the guard exists because
 * `check-gate-coverage-parity.mjs` compares against a `file://` URL and cutting there would
 * silently discard live code. The pair of controls in the non-vacuity case below is what keeps
 * this honest; a stripper nobody probes is a scan over an empty string.
 */
function stripComments(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const rawLine of source.split('\n')) {
    let line = rawLine;
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      line = line.slice(close + 2);
      inBlock = false;
    }
    line = line.replaceAll(/\/\*.*?\*\//g, '');
    const opener = line.indexOf('/*');
    if (opener !== -1) {
      inBlock = true;
      line = line.slice(0, opener);
    }
    const nearComment = line.search(/(^|[^:])\/\//);
    if (nearComment !== -1) line = line.slice(0, line.indexOf('//', nearComment));
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * A value something was supposed to supply, or a failure saying what was missing.
 *
 * FR-R3-136 — WHY THE PARAMETER CARRIES THE `| undefined` AND THE CALL SITES DO NOT. Two
 * programs read this file and they disagree about the type of an index read:
 * `noUncheckedIndexedAccess` is off in the lint program and on in the one the `FR-R3-110`
 * ratchet measures. Annotating the read at the call site does not settle it — an annotated
 * `const` is narrowed by its initializer, so the guard would read as dead code to the linter
 * while still being the thing that keeps this file out of the ratchet's baseline. A parameter's
 * declared type is not narrowed that way, so one check here is live in both programs and there
 * are no `=== undefined` comparisons left in the body of the file at all.
 */
function present<T>(value: T | undefined, missing: string): T {
  if (value === undefined) throw new Error(missing);
  return value;
}

/**
 * The first recorded call, or a failure naming what was missing.
 *
 * FR-R3-136 — WHY THIS EXISTS AND NOT `spawns[0]`. This file was added with fourteen raw
 * indexed reads, each of which `noUncheckedIndexedAccess` types as `| undefined`. The
 * `FR-R3-110` ratchet pins that flag's diagnostic count at 1,277 and refuses growth, and these
 * fourteen sites were exactly the eighteen diagnostics that pushed it to 1,295 — a new baseline
 * entry per assertion, in a file written the same week the ratchet was being cited elsewhere.
 * Nobody noticed because the ratchet is not in the fast tier.
 *
 * A `!` on each read would have satisfied the compiler and told the reader nothing. This fails
 * with the name of the thing that was not there — so a harness that silently stopped recording
 * reads as "recorded no spawn" rather than "Object is possibly undefined".
 */
function first<T>(items: readonly T[], what: string): T {
  const [head] = items;
  return present(head, `the harness recorded no ${what}`);
}

/**
 * A recorder harness over injected seams.
 *
 * Every dependency the recorder touches is captured, so a case can assert not only what came
 * back but what was *not* done — no spawn on a dirty tree, no write on a refusal. "Wrote
 * nothing" is half of what the refusal paths guarantee and it is unobservable without this.
 */
function harness(
  over: {
    status?: number | null;
    signal?: string | null;
    error?: Error;
    platform?: string;
    treeStates?: Array<{ head: string; treeClean: boolean }>;
  } = {}
) {
  const spawns: SpawnCall[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const treeStates = over.treeStates ?? [
    { head: HEAD, treeClean: true },
    { head: HEAD, treeClean: true }
  ];
  let treeReads = 0;
  let clock = 0;

  const result = recorder.recordGateRun({
    spawn: (executable: string, args: readonly string[], options: Record<string, unknown>) => {
      spawns.push({ executable, args, options });
      if (over.error) return { status: null, signal: null, error: over.error };
      // `??` would be wrong here: a deliberate `status: null` is the signal-termination case,
      // and coalescing it to 0 would turn that test into a silent duplicate of the pass case.
      return {
        status: over.status === undefined ? 0 : over.status,
        signal: over.signal ?? null
      };
    },
    platform: over.platform ?? 'darwin',
    readTreeState: () => {
      // The last state repeats: the recorder reads the tree twice (before and after the gate)
      // and most cases care about only one answer.
      return present(
        treeStates[Math.min(treeReads++, treeStates.length - 1)],
        'the harness was given no tree states'
      );
    },
    writeAttestation: (attestation: Record<string, unknown>) => void writes.push(attestation),
    log: (message: string) => void logs.push(message),
    error: (message: string) => void errors.push(message),
    now: () => `2026-08-28T00:0${clock++}:00.000Z`
  });

  return { result, spawns, writes, logs, errors };
}

describe('FR-R3-135 — the recorder spawns the specification, not a literal', () => {
  it('spawns `npm run gate` on a POSIX platform', () => {
    const { spawns } = harness({ platform: 'darwin' });
    expect(spawns).toHaveLength(1);
    expect(first(spawns, 'spawn').executable).toBe('npm');
    // The whole argument vector, not a `toContain`. The defect was a vector that was wrong in
    // its second element while the first was right, so an assertion that only looked for
    // `'run'` would have passed against `['run', 'ci']`.
    expect(first(spawns, 'spawn').args).toEqual(['run', 'gate']);
  });

  it('resolves `npm.cmd` on win32 with an identical argument vector', () => {
    // Asserted on a POSIX machine because `executableFor` is a function on the specification
    // rather than a `process.platform` branch at the spawn site. The old code decided this
    // inline, where no test could reach the Windows answer without a Windows runner — and a
    // release-path portability failure surfaces at the worst possible moment.
    const { spawns } = harness({ platform: 'win32' });
    expect(first(spawns, 'spawn').executable).toBe('npm.cmd');
    expect(first(spawns, 'spawn').args).toEqual(['run', 'gate']);
  });

  it('never passes `shell: true`, and runs in the repository root', () => {
    const { spawns } = harness();
    expect(first(spawns, 'spawn').options.shell).toBe(false);
    expect(first(spawns, 'spawn').options.stdio).toBe('inherit');
    expect(first(spawns, 'spawn').options.cwd).toBe(gate.GATE_COMMAND_SPEC.cwd);
  });

  it('POSITIVE CONTROL — the argv assertion fails when the spec says `ci` (FR-010)', () => {
    // The mutation this feature exists to catch, executed rather than described. Mutating the
    // real frozen spec would leak into every sibling case, so this reproduces the recorder's
    // own resolution against a `ci` specification and asserts the expectation above rejects it.
    // If this ever passes, the assertion in the first case has stopped discriminating.
    const mutated = Object.freeze({
      script: 'ci',
      args: Object.freeze(['run', 'ci']),
      cwd: gate.GATE_COMMAND_SPEC.cwd,
      executableFor: gate.GATE_COMMAND_SPEC.executableFor
    });
    expect(() => expect(mutated.args).toEqual(['run', 'gate'])).toThrow();
    expect(gate.renderGateCommandLabel(mutated.args)).not.toBe(gate.GATE_COMMAND);
  });

  it('keeps the frozen specification unmutable at runtime', () => {
    // A mutable authority is not an authority. Frozen in both directions: the object and its
    // argument array.
    expect(Object.isFrozen(gate.GATE_COMMAND_SPEC)).toBe(true);
    expect(Object.isFrozen(gate.GATE_COMMAND_SPEC.args)).toBe(true);
  });

  it('derives the label from the argv rather than stating it alongside', () => {
    expect(gate.GATE_COMMAND).toBe(gate.renderGateCommandLabel(gate.GATE_COMMAND_SPEC.args));
    expect(gate.GATE_COMMAND).toBe('npm run gate');
  });

  it('renders the label platform-neutrally, so two machines produce comparable records', () => {
    // `commandExecutable` carries `npm.cmd`; the label does not. A record whose command field
    // differed by platform would make two operators' attestations incomparable for a difference
    // that says nothing about what ran.
    const { writes } = harness({ platform: 'win32' });
    expect(first(writes, 'attestation').commandExecutable).toBe('npm.cmd');
    expect(first(writes, 'attestation').command).toBe('npm run gate');
  });
});

describe('FR-R3-135 — the record states what was executed', () => {
  it('writes the argv and executable beside the derived label', () => {
    const { writes, result } = harness();
    expect(writes).toHaveLength(1);
    const record = first(writes, 'attestation');
    expect(record.version).toBe(gate.ATTESTATION_VERSION);
    expect(record.commandArgv).toEqual(['run', 'gate']);
    expect(record.commandExecutable).toBe('npm');
    expect(record.command).toBe(gate.renderGateCommandLabel(record.commandArgv as string[]));
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe('passed');
  });

  it('produces a record the release decision accepts', () => {
    // End to end across the two halves, without a gate run or a release: what the recorder
    // writes is what the verifier reads. The pair drifted precisely because no test crossed the
    // seam between them: each half was well covered on its own side of it.
    const { writes } = harness();
    const verdict = gate.decideRelease({
      attestation: first(writes, 'attestation'),
      head: HEAD,
      treeClean: true
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('verified');
  });

  it('records a red gate as anti-evidence, and the release decision refuses it (FR-012)', () => {
    // A failing added gate stage cannot yield a pass record. This is the recorder-level half of
    // non-vacuity: the exit code comes from the child, so a stage that `ci` never ran and `gate`
    // does now propagates all the way to a refusal.
    const { writes, result } = harness({ status: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe('gate-failed');
    expect(first(writes, 'attestation').exitCode).toBe(1);
    const verdict = gate.decideRelease({ attestation: first(writes, 'attestation'), head: HEAD, treeClean: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('gate-failed');
  });

  it('records a signal termination distinguishably from an exit code', () => {
    const { writes } = harness({ status: null, signal: 'SIGKILL' });
    expect(first(writes, 'attestation').exitCode).toBe('signal:SIGKILL');
  });
});

describe('FR-R3-135 — every refusal writes nothing', () => {
  it('refuses a dirty tree before spending the gate wall-clock, without spawning', () => {
    const { result, spawns, writes, errors } = harness({
      treeStates: [{ head: HEAD, treeClean: false }]
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('dirty-tree-before');
    expect(spawns).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(errors[0]).toContain('uncommitted changes');
  });

  it('refuses a spawn failure with exit 2, distinct from a red gate', () => {
    // A gate that could not be spawned is not a gate that failed. Recording it as exit 1 would
    // be indistinguishable from a genuine failure, and the two have different remedies.
    const { result, writes, errors } = harness({ error: new Error('ENOENT npm') });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('spawn-failed');
    expect(writes).toHaveLength(0);
    expect(errors[0]).toContain('could not spawn');
  });

  it('refuses when HEAD moved underneath the run', () => {
    const { result, writes } = harness({
      treeStates: [
        { head: HEAD, treeClean: true },
        { head: 'd'.repeat(40), treeClean: true }
      ]
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('tree-moved');
    expect(writes).toHaveLength(0);
  });

  it('refuses when the gate dirtied the tree it was measuring', () => {
    const { result, writes, errors } = harness({
      treeStates: [
        { head: HEAD, treeClean: true },
        { head: HEAD, treeClean: false }
      ]
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('tree-moved');
    expect(writes).toHaveLength(0);
    expect(errors[0]).toContain('moved underneath it');
  });

  it('never calls process.exit — the caller owns the process', () => {
    // The reason the mechanism is testable at all. Asserted by the fact that every case above
    // returns; a `process.exit` inside `recordGateRun` would tear down the test runner.
    expect(harness().result).toHaveProperty('exitCode');
  });
});

describe('FR-R3-135 — the attested command reaches all five release-only stages', () => {
  /** The five stages `npm run gate` adds over `npm run ci`. */
  const RELEASE_ONLY = [
    'contracts:check',
    'docs:check',
    'security:secrets',
    'security:actions',
    'license:check'
  ] as const;

  const liveScripts = (): Record<string, string> =>
    JSON.parse(readFileSync(resolve(repoRoot(), 'package.json'), 'utf8')).scripts;

  /** The named script, or a failure saying the manifest has no such entry. */
  const liveScript = (name: string): string => {
    const scripts = liveScripts();
    return present(scripts[name], `package.json declares no '${name}' script`);
  };

  it('static parity: every one of the five is in the specification command closure (FR-011)', () => {
    // Derived from `GATE_COMMAND_SPEC.script`, through the closure walker that already exists in
    // `check-gate-coverage-parity.mjs`. A second walker here would be a second authority on what
    // the gate reaches, which is the class of defect this whole item is about.
    const reachable = parity.reachableScripts(liveScripts(), gate.GATE_COMMAND_SPEC.script);
    for (const stage of RELEASE_ONLY) expect(reachable).toContain(stage);
    // And the omission that started all this: `ci` reaches none of them.
    const ciReachable = parity.reachableScripts(liveScripts(), 'ci');
    for (const stage of RELEASE_ONLY) expect(ciReachable).not.toContain(stage);
  });

  it('NON-VACUITY: the same closure reports the omission when a stage is removed (FR-012)', () => {
    // Proof that the assertion above can fail. A parity check over an empty or mis-keyed script
    // map would satisfy "all five present" vacuously, and the way to know it would not is to
    // remove one and watch it notice.
    const scripts = liveScripts();
    const gateBody = liveScript(gate.GATE_COMMAND_SPEC.script);
    const withoutSecrets = {
      ...scripts,
      [gate.GATE_COMMAND_SPEC.script]: gateBody.replace('npm run security:secrets && ', '')
    };
    expect(withoutSecrets[gate.GATE_COMMAND_SPEC.script]).not.toBe(gateBody);
    const reachable = parity.reachableScripts(withoutSecrets, gate.GATE_COMMAND_SPEC.script);
    expect(reachable).not.toContain('security:secrets');
    // The other four are untouched, so the control is specific rather than a blanket failure.
    for (const stage of RELEASE_ONLY.filter((s) => s !== 'security:secrets')) {
      expect(reachable).toContain(stage);
    }
  });

  it('the coverage parity check still passes after its entry was repointed at the spec', () => {
    // T1521l. The repoint is behaviour-neutral by construction — `GATE_COMMAND_SPEC.script` is
    // `'gate'` — but "by construction" is what the label was, so it is asserted rather than
    // assumed.
    expect(parity.GATE_SCRIPT).toBe(gate.GATE_COMMAND_SPEC.script);
    const verdict = parity.decideParity(
      readFileSync(resolve(repoRoot(), 'RELEASE.md'), 'utf8'),
      liveScripts()
    );
    expect(verdict.ok).toBe(true);
  });

  it('no script carries a literal `run, ci` argument vector in executable text (SC-001)', () => {
    // The corrected argv must not be reintroduced beside the specification. A grep written into
    // a success criterion is a criterion nothing executes; this is the control that runs.
    //
    // COMMENTS ARE EXCLUDED DELIBERATELY, and not as a convenience. Three comments in
    // `gate-attestation.mjs` and `record-gate-run.mjs` quote the defective vector verbatim
    // because that is the record of what went wrong and why the seam exists. Deleting the
    // account of a two-month defect to satisfy a text search would be the wrong repair, and it
    // would leave the next reader with a mechanism whose shape has no stated reason.
    const offenders: string[] = [];
    const dir = scriptsDir();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue;
      const code = stripComments(readFileSync(resolve(dir, name), 'utf8'));
      if (/\[\s*['"]run['"]\s*,\s*['"]ci['"]\s*\]/.test(code)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('NON-VACUITY: the same scan finds the vector when it is in executable text', () => {
    // Proof the exclusion above did not neuter the scan. A comment stripper that ate the whole
    // file would report zero offenders forever, which is the failure mode of every
    // grep-shaped control, so the discriminating pair is asserted directly.
    expect(stripComments("const argv = ['run', 'ci'];")).toContain("'ci'");
    expect(stripComments("// it used to be ['run', 'ci'] here")).not.toContain("'ci'");
    expect(stripComments("/*\n * spawned ['run', 'ci']\n */\nconst x = 1;")).not.toContain("'ci'");
    // And the real recorder's live spawn site survives stripping, so the scan above ran over
    // code rather than over an empty string.
    const recorderSource = stripComments(
      readFileSync(resolve(scriptsDir(), 'gate-recorder.mjs'), 'utf8')
    );
    expect(recorderSource).toContain('GATE_COMMAND_SPEC.args');
  });
});
