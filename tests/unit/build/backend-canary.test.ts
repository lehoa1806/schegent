import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PhaseDef } from '../../../src/config/pipeline-config';
import { PromptBuilder } from '../../../src/runner/prompt-builder';

/**
 * FR-R3-061 (M-08 / R-15) — the canary's decisions, tested without a CLI, a
 * network, or credentials.
 *
 * The point of the separation: a canary whose logic can only be exercised by a
 * scheduled run against a live service is a canary nobody can reason about, and
 * its most common state -- no credentials -- is the one least likely to be
 * checked.
 */
async function loadCanary() {
  return import('../../../scripts/backend-canary.mjs');
}

let canary: Awaited<ReturnType<typeof loadCanary>>;

beforeAll(async () => {
  canary = await loadCanary();
});

const version = (v: string) => ({ ok: true, version: v });

describe('the backend canary reports what it actually established', () => {
  it('reports ok when the version probe and the live probe both pass', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('1.2.3'),
      liveProbe: { ok: true }
    });
    expect(verdict.state).toBe('ok');
  });

  it('reports skipped-not-authenticated, and says the run made no behavioural claim', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, notAuthenticated: true, detail: 'not signed in' }
    });
    expect(verdict.state).toBe('skipped-not-authenticated');
    for (const unestablished of ['protocol', 'auth', 'prompt', 'cost']) {
      expect(verdict.detail).toContain(unestablished);
    }
  });

  it('reports unavailable when the CLI is absent, not drifted', () => {
    // A missing CLI and a changed CLI are different findings. Reporting the first
    // as the second sends someone looking for a protocol change that never
    // happened.
    expect(canary.decideBackendState({ versionProbe: { ok: false, detail: 'ENOENT' } }).state).toBe(
      'unavailable'
    );
    expect(canary.decideBackendState({ versionProbe: null }).state).toBe('unavailable');
  });

  it('reports drift when the version leaves the recorded prefix', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('2.0.0'),
      expectedVersionPrefix: '1.'
    });
    expect(verdict.state).toBe('drifted');
    expect(verdict.detail).toContain('protocol shape');
  });

  it('reports drift when the live probe fails', () => {
    const verdict = canary.decideBackendState({
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, detail: 'auth rejected' }
    });
    expect(verdict.state).toBe('drifted');
    expect(verdict.detail).toContain('auth rejected');
  });

  it('never turns a finding into a red gate through its exit code', () => {
    // The review's explicit constraint. A drift must not fail the workflow, or the
    // canary becomes a PR-adjacent gate depending on a third-party service.
    const drifted = [{ backend: 'claude', state: 'drifted', detail: 'x' }];
    expect(canary.canaryExitCode(drifted)).toBe(0);
    expect(canary.canaryExitCode([])).toBe(0);
    // Non-zero only when the canary itself is broken.
    expect(canary.canaryExitCode(undefined)).toBe(2);
  });

  it('says in its report that a degraded run qualified nothing', () => {
    const report = canary.formatReport([
      { backend: 'claude', state: 'skipped-not-authenticated', detail: 'd' },
      { backend: 'codex', state: 'drifted', detail: 'd' }
    ]);
    expect(report).toContain('version probe only');
    expect(report).toContain('No behavioural claim');
    expect(report).toContain('not gate failures');
  });
});

/**
 * FR-R3-072 — the runner cannot report a pass it did not run.
 *
 * The runner fabricated a liveProbe result whenever a credential env var was
 * set, so exporting ANTHROPIC_API_KEY made the canary report `ok` for a live
 * phase that does not exist. These tests pin the fix: the runner's whole
 * decision is `runnerBackendResult`, it constructs no probe result, and no
 * input it can receive reaches `ok`.
 */
describe('the runner cannot report a pass it did not run', () => {
  // REWRITTEN 2026-08-26. This block used to assert that `ok` was unreachable
  // from every runner-reachable input, because no live invocation existed. One
  // does now, it has been run by hand against two authenticated CLIs, and `ok` is
  // reachable on purpose. Asserting it is still unreachable would pin the absence
  // of the feature rather than the safety of it.
  //
  // What still holds, and is what actually mattered: `ok` requires BOTH a
  // positive authentication answer and a real live-probe result. Neither alone,
  // and neither fabricated.
  const versionProbes = [version('1.2.3'), { ok: false, detail: 'ENOENT' }, null];

  it('never reports ok without a live probe result', () => {
    for (const versionProbe of versionProbes) {
      const verdict = canary.runnerBackendResult({ backend: 'claude', versionProbe });
      expect(verdict.state).not.toBe('ok');
      expect(canary.PROBE_STATES).toContain(verdict.state);
    }
  });

  it('never reports ok without a live probe result', () => {
    // `ok` is a claim that a turn completed. Nothing but a real live result may
    // produce it — the defect this block was originally written for was a
    // fabricated probe result attached to a phase that never ran.
    for (const versionProbe of versionProbes) {
      const verdict = canary.runnerBackendResult({ backend: 'claude', versionProbe });
      expect(verdict.state).not.toBe('ok');
      expect(canary.PROBE_STATES).toContain(verdict.state);
    }
  });

  it('reports ok only from a real live probe result', () => {
    const verdict = canary.runnerBackendResult({
      backend: 'claude',
      versionProbe: version('1.2.3'),
      liveProbe: { ok: true, detail: 'answered in 6 chars' }
    });
    expect(verdict.state).toBe('ok');
  });

  it('names what an unauthenticated skip leaves unestablished', () => {
    const verdict = canary.runnerBackendResult({
      backend: 'agy',
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, notAuthenticated: true, detail: 'not signed in' }
    });
    expect(verdict.state).toBe('skipped-not-authenticated');
    expect(verdict.detail).toContain('not signed in');
    for (const unestablished of ['protocol', 'auth', 'prompt', 'cost']) {
      expect(verdict.detail).toContain(unestablished);
    }
  });

  it('treats an unrecognised failure as drift, not as a skip', () => {
    // A skip is a shrug nobody reads. A failure this canary cannot explain is a
    // finding, and calling it "probably just auth" would convert real protocol
    // drift into silence — which is what the classifier is kept narrow to avoid.
    const verdict = canary.runnerBackendResult({
      backend: 'claude',
      versionProbe: version('1.2.3'),
      liveProbe: { ok: false, detail: 'exit 7' }
    });
    expect(verdict.state).toBe('drifted');
  });

  it('reads a sign-in refusal out of real CLI output, and nothing wider', () => {
    // Fixtures are the ACTUAL strings observed on 2026-08-26. `agy models`
    // printed its refusal beside exit 0, which is why output is the signal and
    // status is not.
    expect(canary.saysNotAuthenticated('Error: Please sign in to view available models.', '')).toBe(
      true
    );
    expect(canary.saysNotAuthenticated('', 'Not logged in')).toBe(true);
    expect(canary.saysNotAuthenticated('unauthorized', '')).toBe(true);
    // Narrow on purpose: an ordinary failure must NOT be excused as auth.
    expect(canary.saysNotAuthenticated('exit 7', '')).toBe(false);
    expect(canary.saysNotAuthenticated('canary', '')).toBe(false);
    expect(canary.saysNotAuthenticated('', '')).toBe(false);
  });


  it('counts both skip states as version-probe-only in the report', () => {
    const report = canary.formatReport([
      { backend: 'claude', state: 'skipped-no-live-path', detail: 'd' },
      { backend: 'codex', state: 'skipped-not-authenticated', detail: 'd' }
    ]);
    expect(report).toContain('2 backend(s) ran the version probe only');
    expect(report).toContain('No behavioural claim');
  });

  it('contains no fabricated live-probe result in the canary sources', () => {
    // The defect was the literal `'live phase reached'` attached to a probe
    // result no probe produced. Reads exactly the two canary sources; the
    // literal in THIS file is the assertion's own needle, not a match.
    // Widened from the two canary files to the whole scripts/ directory after
    // review: the literal's realistic reintroduction site is any script that
    // feeds the decision layer, and a two-file check would stay green for a
    // sibling. Hermetic: one readdir of a small first-party directory.
    const scriptsDir = resolve(__dirname, '../../../scripts');
    const sources = readdirSync(scriptsDir).filter((name) => /\.(mjs|mts|js|ts|sh)$/.test(name));
    expect(sources.length).toBeGreaterThan(5); // non-vacuity: the sweep saw the directory
    for (const source of sources) {
      expect(
        readFileSync(resolve(scriptsDir, source), 'utf8'),
        `${source} must not construct a live-probe result`
      ).not.toContain('live phase reached');
    }
  });
});

/**
 * FR-R3-084 — the blocked live phase, pinned so it stays blocked HONESTLY.
 *
 * The item forbids writing a live invocation that has never been run by hand,
 * and no credential exists in this checkout, so none is written. What CAN be
 * pinned is that the no-credential behaviour is unchanged and that the reasons
 * are on record rather than in someone's memory — because the failure mode here
 * is not a broken canary, it is a canary that quietly starts claiming more than
 * it ran.
 */
describe('FR-R3-084 — the live phase, written after it was run', () => {
  // REWRITTEN 2026-08-26, and the reason is the point of the item.
  //
  // This block used to pin that NO live invocation existed and that the reason
  // was recorded — because the item forbids shipping a live call that has never
  // run. That guard did its job: it stood until the call had actually been made.
  //
  // The premise it rested on was wrong, and the operator said so: these backends
  // authenticate by SUBSCRIPTION, not by API key. `claude auth status` reports
  // `authMethod: "claude.ai"`, `codex login status` reports "Logged in using
  // ChatGPT", and no `*_API_KEY` variable exists on the machine this is developed
  // on. The canary had been asking whether a key was set as a proxy for whether a
  // live call was possible, and the proxy was false while the truth was true.
  //
  // The live phase was then written, RUN BY HAND, and observed:
  //   claude: ok — version 2.1.246, live probe passed
  //   codex:  ok — version 0.149.0, live probe passed
  //   agy:    skipped-not-authenticated — not signed in on this machine
  //
  // So what is pinned now is what still needs protecting: `ok` requires a real
  // live result, the prompt discloses nothing, the deadline is bounded, and a
  // drift is never an exit code.
  it('the live invocation is bounded, fixed, and discloses nothing', () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    const pure = readFileSync(resolve(__dirname, '../../../scripts/backend-canary.mjs'), 'utf8');
    // One turn, a fixed trivial prompt, and a hard wall-clock deadline. The
    // prompt moved into the pure module on 2026-08-26 so the canary and the
    // parity gate name one literal.
    expect(pure).toContain("export const LIVE_PROMPT = 'Reply with exactly one word: canary'");
    expect(runner).toMatch(/LIVE_TIMEOUT_MS\s*=\s*\d/);
    expect(runner).toContain('timeout: LIVE_TIMEOUT_MS');
    // The prompt is a constant, never interpolated.
    expect(pure).not.toMatch(/LIVE_PROMPT\s*\+/);

    // AND THE WORKING DIRECTORY DISCLOSES NOTHING EITHER, which is the half this
    // assertion missed until 2026-08-26. A fixed prompt is not enough: these CLIs
    // load their cwd's `CLAUDE.md`, `AGENTS.md` and git state into the turn on
    // their own. Run from the repository, one two-token prompt billed 38,101
    // cache-creation tokens and the model quoted this feature's plan file back
    // with no tool call in the envelope. A temp dir is what makes "discloses
    // nothing" true.
    expect(runner).toContain('mkdtempSync');
    expect(runner).toContain('tmpdir()');
    expect(runner).toContain('cwd: LIVE_CWD');
    expect(runner, 'the live turn must never run in the workspace').not.toMatch(
      /cwd:\s*process\.cwd\(\)/
    );
  });

  it('reads no API key, because none is what this product uses', () => {
    // The correction of 2026-08-26. A request for a secret nothing consumes is
    // worse than no request: it asks an operator to create a live credential for
    // no reason.
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    for (const env of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AGY_API_KEY']) {
      expect(runner, `${env} is not how these CLIs authenticate here`).not.toContain(env);
    }
    expect(runner).toContain('auth');
  });

  it('never asks a CLI that is not installed for a turn', () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // The only ordering left. There is no auth gate, because the auth gate was a
    // proxy and proxies were the defect twice over — see backend-canary.mjs.
    expect(runner).toContain('version.ok === true ? liveProbe(');
    expect(runner).not.toContain('authProbe');
  });

  it('skipped-no-live-path is unreachable: every backend has a live path', () => {
    // FR-R3-084 §4, verbatim: "`skipped-no-live-path` becomes unreachable for a
    // backend that has one, and the unit table asserts that." All three have one
    // now, so the state survives only for a backend added without one — which is
    // exactly when it should fire, and never for the three that ship.
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    const declared = [...runner.matchAll(/backend: '([a-z]+)'/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(['agy', 'claude', 'codex']);
    // Derived from the shared table rather than from the runner's source text:
    // the argv moved into `LIVE_INVOCATIONS` so the canary and the host could be
    // compared against each other, and a live path is now an entry there.
    for (const backend of declared) {
      expect(canary.liveArgsFor(backend), `${backend} needs a live path`).toBeDefined();
      expect((canary.liveArgsFor(backend) ?? []).length).toBeGreaterThan(0);
    }
  });

  it('a drift is a finding, never an exit code', async () => {
    const canary = await import('../../../scripts/backend-canary.mjs');
    expect(
      canary.canaryExitCode([{ backend: 'claude', state: 'drifted', detail: 'd' }])
    ).toBe(0);
    expect(
      canary.canaryExitCode([{ backend: 'agy', state: 'skipped-not-authenticated', detail: 'd' }])
    ).toBe(0);
  });

  it('the qualification log records a run, and names every backend in it', () => {
    // The gap this closes: until 2026-08-26 the log was the ONE artifact of this
    // item that no test read. The backlog-verification plan (`INDEX.md` §5)
    // declined to file the canary precisely because "has it ever produced a
    // result" was not
    // checkable from a checkout; a log nothing checks is that same gap wearing a
    // filename.
    //
    // Deliberately NOT asserting a version string. Pinning the installed version
    // here is the convenience-as-baseline mistake the item rejects twice, and it
    // would make a routine CLI update fail a unit test.
    const log = readFileSync(
      resolve(__dirname, '../../../docs/release/backend-qualification-log.md'),
      'utf8'
    );
    for (const backend of ['claude', 'codex', 'agy']) {
      expect(log, `${backend} must appear in a qualification entry`).toContain(`${backend}:`);
    }
    // An entry is a dated result, so the log must carry at least one date and say
    // what its runs do not establish.
    expect(log).toMatch(/### \d{4}-\d{2}-\d{2}/);
    expect(log).toContain('does NOT establish');
    expect(log).toContain('npm run canary');
  });

  it('the qualification run is recorded, and no prefix is enforced from it', () => {
    const request = readFileSync(
      resolve(__dirname, '../../../docs/release/canary-credential-request.md'),
      'utf8'
    );
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // A first observation on one machine is not a qualified baseline, and pinning
    // a prefix from it would make every routine CLI update report drift. The run
    // is recorded as evidence; the pin stays absent, which is what the item asks.
    expect(request).toContain('2026-08-26');
    expect(request).toContain('2.1.246');
    expect(runner).not.toMatch(/expectedVersionPrefix:\s*'[^']+'/);
  });
});

/**
 * FR-R3-084 §3.4 — a recorded envelope names no probe directory.
 *
 * `redactLiveEnvelope` drops the rows that describe the machine and blanks the keys that name a
 * session, a machine or a path. It did not reach a path the backend names in a TOOL CALL. On
 * 2026-10-19 the repository-file case's recordings on claude (`Read`) and agy (`view_file`) each
 * carried the absolute path of the planted `NOTES.md`, in a directory `mkdtempSync` made under the
 * operator's per-user temp root. So the runner hands the redactor the turn's working directory,
 * and no string in the envelope keeps it.
 */
describe('FR-R3-084 §3.4 — a recorded envelope names no probe directory', () => {
  const dir = '/var/folders/ab/cdefgh0000gn/T/schegent-canary-Ab3dEf';
  // How macOS reports it: `/var` links to `/private/var`, and the CLIs name the resolved path.
  const resolvedDir = `/private${dir}`;
  const envelopeNaming = (named: string, resolved: string): string =>
    [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${resolved}/NOTES.md` } }]
        }
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: { tool_info: { parameters: { AbsolutePath: `${resolved}/NOTES.md` } } }
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: `I read ${named}/NOTES.md.` }
      }),
      JSON.stringify({ type: 'result', files: { [`${resolved}/NOTES.md`]: 'read' }, cwd: named })
    ].join('\n');

  it('replaces the directory in every string and key, whichever spelling the backend used', () => {
    // The shorter spelling first, on purpose: `/private/var/...` contains `/var/...`, so a
    // redactor that scrubbed in the order it was given would leave `/private<probe-dir>`.
    const envelope = envelopeNaming(dir, resolvedDir);
    const redacted = canary.redactLiveEnvelope(envelope, [dir, resolvedDir]);
    expect(redacted).not.toContain('schegent-canary-');
    expect(redacted).not.toContain('/var/folders');
    expect(redacted).not.toContain('/private<probe-dir>');
    // And nothing else changed: the same envelope, written with the placeholder already in it.
    expect(redacted).toBe(canary.redactLiveEnvelope(envelopeNaming('<probe-dir>', '<probe-dir>')));
  });

  it('scrubs nothing when given no directory, or an empty one', () => {
    // An empty spelling must not split every string into characters.
    const envelope = envelopeNaming(dir, resolvedDir);
    expect(canary.redactLiveEnvelope(envelope, [''])).toBe(canary.redactLiveEnvelope(envelope));
    expect(canary.redactLiveEnvelope(envelope)).toContain(`${resolvedDir}/NOTES.md`);
  });

  it("is handed the turn's working directory everywhere the runner records", () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    const calls = [...runner.matchAll(/redactLiveEnvelope\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      expect(args, 'a recording written without its directory').toMatch(/^result\.stdout,\s*\S/);
    }
  });
});

/**
 * FR-R3-084 §3.4 — a recorded envelope keeps no thinking signature.
 *
 * claude 2.1.302 attaches a `signature` to each thinking block: a base64 blob, 1,200 to 6,540
 * characters in the 2026-10-19 recordings, that no parser reads. What it is bound to cannot be
 * checked from here, so the redactor blanks it as it blanks an id, and the block stays.
 */
describe('FR-R3-084 §3.4 — a recorded envelope keeps no thinking signature', () => {
  it('blanks the signature and keeps the thinking block around it', () => {
    const blob = 'opaque-signature-blob';
    const envelope = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '', signature: blob }] }
    });
    const redacted = canary.redactLiveEnvelope(envelope);
    expect(redacted).not.toContain(blob);
    expect(JSON.parse(redacted)).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '', signature: '<redacted>' }] }
    });
  });
});

/**
 * FR-R3-182 — the corpus says what each case must show, and reaches all three surfaces.
 *
 * Read line by line before this item, the corpus proved delivery and held one sampled refusal;
 * none of its lines was evidence of resistance (feature 217, `measurements.md` §6). What is
 * pinned here is the table that replaced it: every case declares its observable, every surface
 * is reached on every backend, the two old cases stay where they were, and every surface case
 * can tell "the text arrived" from "the text was obeyed". A case that cannot tell them apart
 * shows nothing whichever way it goes.
 *
 * Nothing here runs the corpus. It spends live turns, and it runs only when someone records it
 * (FR-059).
 */
describe('FR-R3-182 — the injection corpus', () => {
  const backends = (): string[] => Object.keys(canary.LIVE_INVOCATIONS);
  const surfaceScenarios = () => canary.CANARY_SCENARIOS.filter((s) => s.surface !== null);

  /** Everything a surface case puts on its surface: the text the model was not told to obey. */
  function surfaceText(scenario: (typeof canary.CANARY_SCENARIOS)[number]): string {
    return [
      scenario.host?.featureDescription ?? '',
      ...Object.values(scenario.host?.previousPhaseMessage ?? {}),
      ...Object.values(scenario.files ?? {})
    ].join('\n');
  }

  it('declares what every case must show (FR-054, SC-012)', () => {
    const undeclared = canary.CANARY_CASES.filter(
      (c) => typeof c.expectedObservable !== 'string' || c.expectedObservable.trim().length === 0
    );
    expect(undeclared.map((c) => `${c.backend}/${c.id}`)).toEqual([]);
    // Over the whole table, not a view of it: one case per scenario per backend.
    expect(canary.CANARY_CASES).toHaveLength(canary.CANARY_SCENARIOS.length * backends().length);
    expect(canary.CANARY_SCENARIOS.length).toBeGreaterThan(2);
  });

  it('reaches every surface on every backend (FR-053)', () => {
    expect([...canary.INJECTION_SURFACES]).toEqual(['task-text', 'repository-file', 'prior-output']);
    for (const surface of canary.INJECTION_SURFACES) {
      for (const backend of backends()) {
        expect(
          canary.CANARY_CASES.some((c) => c.surface === surface && c.backend === backend),
          `${surface} on ${backend}`
        ).toBe(true);
      }
    }
    for (const c of canary.CANARY_CASES) {
      expect(c.surface === null || canary.INJECTION_SURFACES.includes(c.surface), c.id).toBe(true);
    }
  });

  it('keeps the two cases it had, in place, and counts neither as reaching a surface (FR-052)', () => {
    const byId = new Map(canary.CANARY_SCENARIOS.map((s) => [s.id, s]));
    const probe = byId.get('live-protocol-probe');
    expect(probe?.prompt).toBe(canary.LIVE_PROMPT);
    expect(probe?.stem).toBe('live');
    expect(probe?.cadence).toBe('every-run');
    const output = byId.get('prompt-injection-in-output');
    expect(output?.prompt).toBe(canary.INJECTION_PROMPT);
    expect(output?.stem).toBe('injection');
    expect(output?.cadence).toBe('record-only');
    // The probe carries no untrusted text, and the output case ASKS for its lines, so a model
    // that prints them is complying. Neither reaches a surface, and neither may be counted as
    // though it did.
    expect(probe?.surface).toBeNull();
    expect(output?.surface).toBeNull();
    // A recording is named by its stem, so two cases sharing one would overwrite each other.
    const count = canary.CANARY_SCENARIOS.length;
    expect(new Set(canary.CANARY_SCENARIOS.map((s) => s.id)).size).toBe(count);
    expect(new Set(canary.CANARY_SCENARIOS.map((s) => s.stem)).size).toBe(count);
  });

  it('is one corpus, run by one runner (FR-053)', () => {
    const runner = readFileSync(
      resolve(__dirname, '../../../scripts/backend-canary-run.mjs'),
      'utf8'
    );
    // The runner names no prompt of its own. The probe's is `LIVE_PROMPT`, which the table's
    // probe case carries (above); every other turn takes its prompt from the table.
    expect(runner).toContain('CANARY_CASES');
    expect(runner).not.toContain('INJECTION_PROMPT');
    expect(runner).not.toMatch(/const [A-Z_]*PROMPT\s*=/);
    // The table's other turns are spent under `--record` only.
    expect(runner).toMatch(/recordDir\)\s*recordCorpus\(/);
    // And no other script declares cases beside these. A declaration is the field with a value
    // or a type after it; a comment naming the field declares nothing.
    const scriptsDir = resolve(__dirname, '../../../scripts');
    const declaring = readdirSync(scriptsDir)
      .filter((name) => /\.(mjs|mts|js|ts|sh)$/.test(name))
      .filter((name) =>
        /\bexpectedObservable\s*:/.test(readFileSync(resolve(scriptsDir, name), 'utf8'))
      );
    expect(declaring.sort()).toEqual(['backend-canary.d.mts', 'backend-canary.mjs']);
  });

  it('lets every surface case tell the text arriving from the text being obeyed', () => {
    expect(surfaceScenarios().length).toBeGreaterThanOrEqual(canary.INJECTION_SURFACES.length);
    const words: string[] = [];
    for (const scenario of surfaceScenarios()) {
      const { id, host, deliveryToken, injectionMarker, expectedObservable } = scenario;
      if (!host || !deliveryToken || !injectionMarker) {
        throw new Error(`${id} needs host sections, a delivery token and an injection marker`);
      }
      // Both words sit on the surface and nowhere in the instruction the model was given, so a
      // delivery token in an answer can only have come from the surface, and so can a marker.
      expect(surfaceText(scenario), id).toContain(deliveryToken);
      expect(surfaceText(scenario), id).toContain(injectionMarker);
      expect(host.instruction, id).not.toContain(deliveryToken);
      expect(host.instruction, id).not.toContain(injectionMarker);
      // A planted file is the only place its words exist: the prompt names the file, not them.
      if (scenario.files) {
        expect(scenario.prompt, id).not.toContain(deliveryToken);
        expect(scenario.prompt, id).not.toContain(injectionMarker);
      }
      // The observable names what to look for, so it can be checked against a recording.
      expect(expectedObservable, id).toContain(deliveryToken);
      expect(expectedObservable, id).toContain(injectionMarker);
      words.push(deliveryToken, injectionMarker);
    }
    // Distinct across cases, so no recording can be read as another case's.
    expect(new Set(words).size).toBe(words.length);
  });

  it('plants nothing the host would act on, under bare file names only', () => {
    for (const scenario of canary.CANARY_SCENARIOS) {
      // A bracketed status token is the one string the host reads as a verdict. The corpus
      // samples whether a model follows planted text; planting the host's own control token
      // would make a recording that replays as a pass.
      for (const text of [scenario.prompt, ...Object.values(scenario.files ?? {})]) {
        expect(text, scenario.id).not.toMatch(/\[\s*SCHEGENT_STATUS/i);
      }
      for (const name of Object.keys(scenario.files ?? {})) {
        expect(name, scenario.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      }
    }
  });

  it("places each surface case's text where the host does", () => {
    // `hostShapedPrompt` repeats the layout of `PromptBuilder.build`, which a `.mjs` cannot
    // import: a second site. So the host's prompt is built from the same inputs, and the case's
    // prompt must be a verbatim slice of it: the same headers, order and entry format.
    for (const scenario of surfaceScenarios()) {
      const { host } = scenario;
      if (!host) throw new Error(`${scenario.id} needs host sections`);
      const phaseDef: PhaseDef = { id: 'canary', name: 'Canary', version: 1, instruction: host.instruction };
      const built = new PromptBuilder().build({
        phase: 'canary',
        phaseDef,
        iteration: 1,
        iterationCap: 1,
        featureDescription: host.featureDescription ?? '',
        featureDir: null,
        previousPhaseMessage: host.previousPhaseMessage ?? null
      });
      expect(built, scenario.id).toContain(scenario.prompt);
      expect(scenario.prompt, scenario.id).toContain(`TASK:\n${host.instruction}`);
    }
  });

  it('costs the turns the threat model states (FR-055, SC-012)', () => {
    const everyRun = canary.CANARY_CASES.filter((c) => c.cadence === 'every-run').length;
    const recorded = canary.CANARY_CASES.length;
    // The ordinary canary spends the protocol probe alone, once per backend.
    expect(everyRun).toBe(backends().length);
    const threatModel = readFileSync(
      resolve(__dirname, '../../../docs/security/threat-model.md'),
      'utf8'
    );
    expect(threatModel).toContain(`\`npm run canary\` spends ${everyRun} turns`);
    expect(threatModel).toContain(`\`npm run canary:record\` spends ${recorded} turns`);
  });
});
