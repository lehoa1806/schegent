import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

/**
 * FR-R3-104 (FR-051..FR-058) — the qualification gate, exercised without a live turn.
 *
 * WHY EVERY ARM IS HERE. The gate refuses a release for five distinct reasons with five
 * different remedies, and the only way to exercise them by releasing would be to spend a live
 * turn per case on the operator's own subscription. The decision is pure over its inputs for
 * exactly that reason — the same argument `gate-attestation.test.ts` records for `decideRelease`.
 *
 * THE LOAD-BEARING CASE is `refuses when a runner-area file changed`. The eval corpus cannot see
 * protocol drift: every fixture is a recording of the old protocol, so it keeps passing across a
 * change that breaks the real thing. That is the hole this gate covers, and a test suite that
 * only checked staleness would leave it open.
 *
 * Loaded dynamically for the same TS1479 reason its siblings record.
 */
async function loadQualification() {
  return import('../../../scripts/backend-qualification.mjs');
}

let q: Awaited<ReturnType<typeof loadQualification>>;

beforeAll(async () => {
  q = await loadQualification();
});

const NOW = '2026-08-27T12:00:00.000Z';
const FRESH = '2026-08-26T12:00:00.000Z';
const STALE = '2026-07-01T12:00:00.000Z';

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 2,
  mode: 'live',
  qualifiedAt: FRESH,
  commit: 'abc123',
  platform: 'darwin arm64 node 24.19.0',
  versions: { claude: '2.1.246 (Claude Code)', codex: 'codex-cli 0.149.0', agy: '1.1.20' },
  states: { claude: 'ok', codex: 'ok', agy: 'ok' },
  transports: { claude: 'acp-stdio-bridge', codex: 'acp-stdio-bridge', agy: 'acp-native' },
  profiles: {
    claude: 'claude-acp-bridge',
    codex: 'codex-acp-bridge',
    agy: 'agy-acp-native'
  },
  ...overrides
});

const installed = {
  claude: '2.1.246 (Claude Code)',
  codex: 'codex-cli 0.149.0',
  agy: '1.1.20'
};

const decide = (overrides: Record<string, unknown> = {}) =>
  q.decideQualification({
    record: record(),
    head: 'abc123',
    installedVersions: installed,
    changedPaths: [],
    now: NOW,
    ...overrides
  });

describe('FR-051 — the release path refuses on an absent, stale or unreadable record', () => {
  it('passes on a fresh record at HEAD with the installed versions', () => {
    const verdict = decide();
    expect(verdict.ok, verdict.message).toBe(true);
    expect(verdict.reason).toBe('qualified');
    // Non-vacuity: the pass names the versions, so a record with none cannot read as qualified.
    expect(verdict.message).toContain('claude 2.1.246');
  });

  it('refuses when no record exists, and names the command that writes one', () => {
    const verdict = decide({ record: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('no-qualification');
    expect(verdict.message).toContain('npm run canary');
  });

  it('distinguishes an unreadable record from an absent one', () => {
    // Different remedies: one is "run the canary", the other is "the file is corrupt".
    expect(decide({ record: { malformed: true } }).reason).toBe('unreadable-qualification');
  });

  it('refuses an undated record rather than treating it as fresh', () => {
    expect(decide({ record: record({ qualifiedAt: undefined }) }).reason).toBe(
      'undated-qualification'
    );
  });

  it('refuses a record older than the declared bound, naming both ages', () => {
    const verdict = decide({ record: record({ qualifiedAt: STALE }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale-qualification');
    expect(verdict.message).toContain('57 days old');
    expect(verdict.message).toContain('14 days');
    expect(verdict.message).toContain('QUALIFICATION_MAX_AGE_MS');
  });

  it('is fresh right up to the bound and stale one millisecond past it', () => {
    // The boundary, because an off-by-one in a freshness bound is invisible until the day it
    // refuses a release it should have allowed.
    const atBound = new Date(Date.parse(NOW) - q.QUALIFICATION_MAX_AGE_MS).toISOString();
    const pastBound = new Date(Date.parse(NOW) - q.QUALIFICATION_MAX_AGE_MS - 1).toISOString();
    expect(decide({ record: record({ qualifiedAt: atBound }) }).ok).toBe(true);
    expect(decide({ record: record({ qualifiedAt: pastBound }) }).reason).toBe(
      'stale-qualification'
    );
  });
});

describe('FR-051 / FR-054 — the record must describe the installed CLI surface', () => {
  it('refuses when an installed CLI has moved past the qualified version', () => {
    const verdict = decide({
      installedVersions: { ...installed, claude: '2.2.0 (Claude Code)' }
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('version-drift');
    expect(verdict.message).toContain('qualified 2.1.246, installed 2.2.0');
  });

  it('refuses when an installed CLI was never qualified at all', () => {
    const verdict = decide({ record: record({ versions: { claude: '2.1.246' } }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('incomplete-qualification');
    expect(verdict.message).toContain('missing observed version');
  });

  it('ignores a backend that is not installed on this machine', () => {
    // A machine without `agy` is not a machine whose `agy` qualification is stale.
    expect(decide({ installedVersions: { ...installed, agy: null } }).ok).toBe(true);
  });

  it('compares version TOKENS, so a vendor banner change is not drift', () => {
    // An operator who learns that drift warnings usually mean nothing will ignore the one that
    // does not.
    expect(q.versionToken('2.1.246 (Claude Code)')).toBe('2.1.246');
    expect(q.versionToken('codex-cli 0.149.0')).toBe('0.149.0');
    expect(q.versionToken('1.1.20')).toBe('1.1.20');
    expect(q.versionToken(undefined)).toBeNull();
    expect(
      decide({ installedVersions: { ...installed, claude: '2.1.246 (Claude Code, build 9)' } }).ok
    ).toBe(true);
  });
});

describe('FR-053 — a runner-area change requires a fresh record', () => {
  it('refuses when a qualification-relevant file changed since the record', () => {
    const verdict = decide({ changedPaths: ['src/runner/claude-cli.ts'] });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('runner-changed-since-qualification');
    expect(verdict.message).toContain('src/runner/claude-cli.ts');
    // The message says WHY a passing suite is not enough, because that is the objection the
    // person reading it will have.
    expect(verdict.message).toContain('eval corpus cannot see protocol drift');
  });

  it('refuses when the path question cannot be answered at all', () => {
    // An unanswerable check is a refusal, never a pass — the same rule the audit-chain verifier
    // and the gate attestation both hold to.
    expect(decide({ changedPaths: null }).reason).toBe('unanswerable-path-check');
  });

  it('accepts a record from another commit when nothing relevant changed', () => {
    // Requiring the same SHA would demand a live turn for every documentation commit.
    const verdict = decide({ head: 'def456', changedPaths: [] });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('qualified-at-equivalent-tree');
  });

  it('watches the parser as well as the runner, and says why', () => {
    // `FR-R3-098` found a marker pair that had never matched `codex` — a parse-side defect no
    // fixture could see. The path list is asserted so a future edit cannot quietly narrow it.
    expect(q.QUALIFICATION_PATHS).toContain('src/runner/');
    expect(q.QUALIFICATION_PATHS).toContain('src/parser/');
    for (const prefix of q.QUALIFICATION_PATHS) {
      expect(
        decide({ changedPaths: [`${prefix}whatever.ts`] }).ok,
        `${prefix} must invalidate an older qualification`
      ).toBe(false);
    }
  });
});

describe('the commit the record names is bounded before it reaches git (FR-R3-105 applied here)', () => {
  it('refuses a flag-shaped commit rather than handing it to git', () => {
    // `execFileSync` uses no shell, so this is FLAG injection rather than shell injection — the
    // same distinction FR-R3-105 drew about `model`. A "commit" of `--output=/tmp/x` would be
    // read by `git` as an option. The record is a JSON file on disk: untrusted input by the same
    // argument that makes an operator-imported pipeline document untrusted.
    for (const hostile of [
      '--output=/tmp/x',
      '-n',
      'abc123 --exec=touch /tmp/pwned',
      'HEAD; rm -rf /',
      ''
    ]) {
      expect(
        q.changedQualificationPaths(hostile),
        `${hostile} must not reach git`
      ).toBeNull();
    }
  });

  it('accepts what a commit id actually looks like', () => {
    // Non-vacuity: a bound that refused everything would make the path gate permanently
    // unanswerable, which the decision reads as a refusal — a gate that always refuses is a gate
    // that gets switched off.
    expect(q.changedQualificationPaths('0123456789abcdef', 'HEAD')).not.toBeUndefined();
  });
});

describe('FR-055 — the override is loud, and it is the only way past a refusal', () => {
  it('turns every refusal into a recorded unqualified release', () => {
    for (const args of [
      { record: null },
      { record: record({ qualifiedAt: STALE }) },
      { installedVersions: { ...installed, claude: '9.9.9' } },
      { changedPaths: ['src/runner/agy-cli.ts'] },
      { changedPaths: null }
    ]) {
      const refused = decide(args);
      expect(refused.ok, JSON.stringify(args)).toBe(false);
      const overridden = decide({ ...args, overrideRequested: true });
      expect(overridden.ok).toBe(true);
      expect(overridden.reason).toBe(`overridden:${refused.reason}`);
      expect(overridden.message).toContain('RELEASING UNQUALIFIED');
      // It names the log the operator must write to, because an override nobody records is an
      // override nobody can audit.
      expect(overridden.message).toContain('backend-qualification-log.md');
    }
  });

  it('does not fabricate a pass when nothing was wrong', () => {
    // The override must not change the reason on a clean release, or the log would fill with
    // unqualified entries for qualified releases and stop meaning anything.
    expect(decide({ overrideRequested: true }).reason).toBe('qualified');
  });
});

describe('FR-052 — the freshness bound reaches the operator disclosure, derived', () => {
  const doc = (): string =>
    readFileSync(
      resolve(__dirname, '..', '..', '..', 'docs', 'release', 'backend-qualification-log.md'),
      'utf8'
    );

  it('states the bound the constant actually holds', () => {
    // Derived, not restated: the document says fourteen days because the constant does, and this
    // fails if either moves. A bound stated only in prose is the shape this round keeps finding —
    // a number several records claim and nothing enforces.
    const days = Math.round(q.QUALIFICATION_MAX_AGE_MS / 86_400_000);
    expect(doc()).toContain(`stands for ${days} days`);
    expect(doc()).toContain('QUALIFICATION_MAX_AGE_MS');
  });

  it('records the version-drift decision and its reason, not only its behaviour', () => {
    const text = doc();
    expect(text).toContain('SCHEGENT_RELEASE_UNQUALIFIED');
    expect(text).toMatch(/Phase start \|/);
    expect(text).toContain('Refuses');
    expect(text).toContain('deliberate act with a person present');
  });

  it('names every path whose change invalidates a record', () => {
    // The gate names the paths and the document must name the same ones, or an operator learns
    // the rule from prose that has drifted from the gate.
    const text = doc();
    for (const prefix of q.QUALIFICATION_PATHS) {
      expect(text, `${prefix} is gated but undisclosed`).toContain(prefix);
    }
  });
});

describe('FR-058 / FR-059 — the cadence gates the release path only', () => {
  it('is read by the release preflight and by nothing in the gate chain', () => {
    const root = resolve(__dirname, '..', '..', '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const preflight = readFileSync(resolve(root, 'scripts', 'require-local-gate.mjs'), 'utf8');
    expect(preflight).toContain('decideQualification');
    // A live turn inside `npm run gate` would charge an operator a subscription turn per gate
    // run, and a gate people cannot afford is a gate people disable.
    expect(pkg.scripts.gate).not.toContain('canary');
    expect(pkg.scripts.ci).not.toContain('canary');
    expect(pkg.scripts['release:preflight']).toContain('require-local-gate');
  });

  it('projects the canary\'s own results into the record, degraded backends included', () => {
    // The half the qualification log recorded as an unqualified hole when this landed: every arm
    // of the DECISION was exercised, and the projection that produces the record the decision
    // reads was covered by nothing. A wrong field name here would leave the gate deciding about
    // `undefined` while all 23 decision cases stayed green.
    const record = q.recordFromCanaryResults(
      [
        { backend: 'claude', state: 'ok', observedVersion: '2.1.246' },
        { backend: 'codex', state: 'degraded', observedVersion: '0.149.0' },
        { backend: 'agy', state: 'unavailable', observedVersion: null }
      ],
      { commit: 'abc123', platform: 'darwin arm64 node 24.19.0', now: NOW }
    );
    expect(record.versions).toEqual({
      claude: '2.1.246',
      codex: '0.149.0',
      agy: null
    });
    // A partially-degraded run must not leave a record that reads as three qualified backends.
    expect(record.states).toEqual({ claude: 'ok', codex: 'degraded', agy: 'unavailable' });
    expect(record.commit).toBe('abc123');
    expect(record.qualifiedAt).toBe(NOW);

    // FR-R7-14 (14-10): a partially degraded or unavailable record MUST be refused by the gate.
    const refused = q.decideQualification({
      record,
      head: 'abc123',
      installedVersions: { claude: '2.1.246', codex: '0.149.0', agy: null },
      changedPaths: [],
      now: NOW
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('incomplete-qualification');
    expect(refused.message).toContain('codex: state=degraded');
    expect(refused.message).toContain('agy: state=unavailable');
  });

  it('records what the canary observed rather than inferring it', () => {
    const built = q.buildQualificationRecord({
      versions: { claude: '2.1.246', codex: null, agy: '1.1.20' },
      states: { claude: 'ok', codex: 'degraded', agy: 'ok' },
      commit: 'abc123',
      platform: 'darwin',
      now: NOW
    });
    // The per-backend verdict travels with the versions, so a record written while one backend
    // was degraded cannot read as three qualified backends.
    expect(built.states.codex).toBe('degraded');
    expect(built.versions.codex).toBeNull();
    expect(built.qualifiedAt).toBe(NOW);
  });
});

describe('FR-R7-14 (14-10) — shipped-transport v2 qualification, fingerprinting, and fixture mode', () => {
  it.each([
    'skipped-not-authenticated',
    'skipped-no-live-path',
    'unavailable',
    'drifted',
    'degraded'
  ])('refuses when any advertised backend has state %s', (badState) => {
    const verdict = decide({
      record: record({ states: { claude: 'ok', codex: badState, agy: 'ok' } })
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('incomplete-qualification');
    expect(verdict.message).toContain(`codex: state=${badState}`);
  });

  it('refuses transport mismatch, missing transports, wrong profiles, v1 records, and missing mode', () => {
    const wrongTransport = decide({
      record: record({
        transports: { claude: 'direct-cli', codex: 'acp-stdio-bridge', agy: 'acp-native' }
      })
    });
    expect(wrongTransport.ok).toBe(false);
    expect(wrongTransport.reason).toBe('transport-mismatch');
    expect(wrongTransport.message).toContain('claude');

    const missingTransports = decide({
      record: record({ transports: undefined })
    });
    expect(missingTransports.ok).toBe(false);
    expect(missingTransports.reason).toBe('transport-mismatch');

    const wrongProfiles = decide({
      record: record({
        profiles: { claude: 'legacy-cli', codex: 'codex-acp-bridge', agy: 'agy-acp-native' }
      })
    });
    expect(wrongProfiles.ok).toBe(false);
    expect(wrongProfiles.reason).toBe('transport-mismatch');

    const legacyV1 = decide({ record: record({ version: 1 }) });
    expect(legacyV1.ok).toBe(false);
    expect(legacyV1.reason).toBe('unsupported-qualification-version');

    const missingMode = decide({ record: record({ mode: undefined }) });
    expect(missingMode.ok).toBe(false);
    expect(missingMode.reason).toBe('invalid-qualification-mode');
  });

  it('refuses fixture-mode records for live releases and accepts them when requireLive is false', () => {
    const fixtureRec = record({ mode: 'fixture', sourceFingerprint: 'a'.repeat(64) });
    const liveVerdict = decide({
      record: fixtureRec,
      expectedFingerprint: 'a'.repeat(64),
      requireLive: true
    });
    expect(liveVerdict.ok).toBe(false);
    expect(liveVerdict.reason).toBe('fixture-only-qualification');

    const fixtureVerdict = decide({
      record: fixtureRec,
      expectedFingerprint: 'a'.repeat(64),
      requireLive: false
    });
    expect(fixtureVerdict.ok, fixtureVerdict.message).toBe(true);
  });

  it('invalidates qualification when bridge, descriptor, or profile source fingerprint changes', () => {
    expect(q.QUALIFICATION_PATHS).toContain('src/contracts/backend-descriptors.ts');
    expect(q.QUALIFICATION_PATHS).toContain('src/contracts/acp-runtime.ts');
    expect(q.QUALIFICATION_PATHS).toContain('src/services/acp-runtime/');
    expect(q.QUALIFICATION_PATHS).toContain('esbuild.config.mjs');

    const liveFp = q.computeQualificationSourceFingerprint();
    expect(liveFp).toMatch(/^[0-9a-f]{64}$/);

    const matched = decide({
      record: record({ sourceFingerprint: liveFp }),
      expectedFingerprint: liveFp
    });
    expect(matched.ok, matched.message).toBe(true);

    const drifted = decide({
      record: record({ sourceFingerprint: '0'.repeat(64) }),
      expectedFingerprint: liveFp
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.reason).toBe('fingerprint-mismatch');
  });

  it('qualifies all three advertised backends end-to-end through shipped transport in fixture mode', async () => {
    const evalNow = '2026-11-24T12:00:00.000Z';
    const { runFixtureQualification } = (await import(
      '../../../scripts/backend-canary-run.mjs' as string
    )) as {
      runFixtureQualification: (opts?: { now?: string }) => Promise<{
        results: Array<{ backend: string; state: string; transport: string }>;
        record: Record<string, unknown>;
      }>;
    };
    const { results, record: fixtureRecord } = await runFixtureQualification({ now: evalNow });
    expect(results.map((r) => [r.backend, r.state, r.transport])).toEqual([
      ['claude', 'ok', 'acp-stdio-bridge'],
      ['codex', 'ok', 'acp-stdio-bridge'],
      ['agy', 'ok', 'acp-native']
    ]);
    expect(fixtureRecord.version).toBe(2);
    expect(fixtureRecord.mode).toBe('fixture');
    expect(fixtureRecord.behaviorEvals).toBeDefined();
    const fp = q.computeQualificationSourceFingerprint();
    expect(fixtureRecord.sourceFingerprint).toBe(fp);

    const verdict = q.decideQualification({
      record: fixtureRecord,
      head: String(fixtureRecord.commit ?? 'abc123'),
      installedVersions: {
        claude: '2.1.302 (Claude Code fixture)',
        codex: 'codex-cli 0.159.2',
        agy: '1.4.2'
      },
      changedPaths: [],
      expectedFingerprint: fp,
      requireLive: false,
      now: evalNow
    });
    expect(verdict.ok, verdict.message).toBe(true);
  });
});

describe('FR-R7-17 (R7-17-05) — authority-gate/wiring fingerprint sensitivity, locality, and qualification checks', () => {
  it('includes acp-authority-gate.ts and acp-execution-wiring.ts in QUALIFICATION_PATHS and sourceFingerprint', () => {
    expect(q.QUALIFICATION_PATHS).toContain(
      'src/services/containment-qualification/acp-authority-gate.ts'
    );
    expect(q.QUALIFICATION_PATHS).toContain('src/activation/acp-execution-wiring.ts');

    const sandbox = mkdtempSync(resolve(tmpdir(), 'schegent-qual-fp-'));
    try {
      const write = (relPath: string, content: string): void => {
        const target = resolve(sandbox, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
      };
      write(['src', 'runner', 'dummy.ts'].join('/'), 'export const r = 1;\n');
      write(['src', 'parser', 'dummy.ts'].join('/'), 'export const p = 1;\n');
      write('src/contracts/backend-kinds.ts', 'export const k = 1;\n');
      write('src/contracts/backend-descriptors.ts', 'export const d = 1;\n');
      write('src/contracts/acp-runtime.ts', 'export const c = 1;\n');
      write(['src', 'services', 'acp-runtime', 'dummy.ts'].join('/'), 'export const s = 1;\n');
      write('src/services/containment-qualification/acp-authority-gate.ts', 'export const g = 1;\n');
      write('src/activation/acp-execution-wiring.ts', 'export const w = 1;\n');
      write('esbuild.config.mjs', 'export default {};\n');
      write('dist/acp-stdio-bridge.js', '// bridge bundle\n');

      const baseline = q.computeQualificationSourceFingerprint(sandbox);
      expect(baseline).toMatch(/^[0-9a-f]{64}$/);

      write('src/services/containment-qualification/acp-authority-gate.ts', 'export const g = 2;\n');
      const afterGateEdit = q.computeQualificationSourceFingerprint(sandbox);
      expect(afterGateEdit).not.toBe(baseline);

      write('src/services/containment-qualification/acp-authority-gate.ts', 'export const g = 1;\n');
      expect(q.computeQualificationSourceFingerprint(sandbox)).toBe(baseline);

      write('src/activation/acp-execution-wiring.ts', 'export const w = 2;\n');
      const afterWiringEdit = q.computeQualificationSourceFingerprint(sandbox);
      expect(afterWiringEdit).not.toBe(baseline);
      expect(afterWiringEdit).not.toBe(afterGateEdit);

      // FR-R7-14 (14-10): mutating a descriptor, profile, or built bridge individually invalidates
      // a previously qualified live record via decideQualification (`fingerprint-mismatch`).
      write('src/activation/acp-execution-wiring.ts', 'export const w = 1;\n');
      write('src/services/acp-runtime/profiles.ts', 'export const profiles = 1;\n');
      const fullBaseline = q.computeQualificationSourceFingerprint(sandbox);
      const baselineRecord = q.buildQualificationRecord({
        versions: installed,
        states: { claude: 'ok', codex: 'ok', agy: 'ok' },
        commit: 'abc123',
        platform: 'darwin arm64 node 24.19.0',
        now: FRESH,
        sourceFingerprint: fullBaseline
      });
      expect(
        q.decideQualification({
          record: baselineRecord,
          head: 'abc123',
          installedVersions: installed,
          changedPaths: [],
          expectedFingerprint: fullBaseline,
          now: NOW
        }).ok
      ).toBe(true);

      const mutations: ReadonlyArray<readonly [string, string, string]> = [
        ['src/contracts/backend-descriptors.ts', 'export const d = 1;\n', 'export const d = 2;\n'],
        ['src/services/acp-runtime/profiles.ts', 'export const profiles = 1;\n', 'export const profiles = 2;\n'],
        ['dist/acp-stdio-bridge.js', '// bridge bundle\n', '// mutated bridge bundle\n']
      ];
      for (const [relPath, original, mutated] of mutations) {
        write(relPath, mutated);
        const mutatedFp = q.computeQualificationSourceFingerprint(sandbox);
        expect(mutatedFp, relPath).not.toBe(fullBaseline);
        const rejected = q.decideQualification({
          record: baselineRecord,
          head: 'abc123',
          installedVersions: installed,
          changedPaths: [],
          expectedFingerprint: mutatedFp,
          now: NOW
        });
        expect(rejected.ok, relPath).toBe(false);
        expect(rejected.reason, relPath).toBe('fingerprint-mismatch');
        write(relPath, original);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('validates optional locality and live qualification checks without breaking existing v2 records', () => {
    // Existing v2 records omitting `locality` and `checks` remain valid.
    expect(decide().ok).toBe(true);

    // Local live record with all checks true passes both default and strict enforcement.
    const fullRecord = q.buildQualificationRecord({
      versions: installed,
      states: { claude: 'ok', codex: 'ok', agy: 'ok' },
      commit: 'abc123',
      platform: 'darwin arm64 node 24.19.0',
      now: FRESH,
      locality: 'local',
      checks: {
        resume: true,
        policyDenial: true,
        permissionTitleSanitized: true
      }
    });
    expect(fullRecord.locality).toBe('local');
    expect(fullRecord.checks).toEqual({
      resume: true,
      policyDenial: true,
      permissionTitleSanitized: true
    });
    expect(
      decide({ record: fullRecord, expectedLocality: 'local', requireChecks: true }).ok
    ).toBe(true);

    // Remote locality is refused for live qualification.
    const remoteVerdict = decide({
      record: record({ locality: 'remote' })
    });
    expect(remoteVerdict.ok).toBe(false);
    expect(remoteVerdict.reason).toBe('unqualified-locality');

    // Invalid locality token is refused.
    expect(decide({ record: record({ locality: 'cloud' }) }).reason).toBe(
      'invalid-qualification-locality'
    );

    // Explicitly false check flag is refused even when requireChecks is false.
    const failedCheck = decide({
      record: record({
        locality: 'local',
        checks: { resume: true, policyDenial: false, permissionTitleSanitized: true }
      })
    });
    expect(failedCheck.ok).toBe(false);
    expect(failedCheck.reason).toBe('incomplete-qualification-checks');
    expect(failedCheck.message).toContain('policyDenial=false');

    // Missing checks are refused when requireChecks is true.
    expect(decide({ requireChecks: true }).reason).toBe('incomplete-qualification-checks');
  });
});

interface BehaviorEvalsBackendSummary {
  taskCount: number;
  passedCount: number;
  promptDigests: string[];
  costDenomination: 'usd' | 'tokens';
  totalCostUnits: number;
}

interface BehaviorEvalsSummary {
  recordedAt: string;
  maxAgeDays: number;
  staleFixtureOwner: string;
  perBackend: Record<'claude' | 'codex' | 'agy', BehaviorEvalsBackendSummary>;
}

interface QualificationBehaviorExtensions {
  BEHAVIOR_EVAL_MANIFEST_PATH: string;
  BEHAVIOR_EVAL_MAX_AGE_DAYS: number;
  summarizeBehaviorEvalManifest: (
    manifestOrPath?: unknown
  ) => BehaviorEvalsSummary | null;
  validateBehaviorEvalsSummary: (
    summary: unknown,
    opts: { now: string; requiredBackends?: readonly string[] }
  ) => { ok: boolean; reason?: string; message?: string };
}

describe('FR-R7-18 (N04) — optional additive behaviorEvals metadata validation and backwards compatibility', () => {
  it('keeps existing v2 records omitting behaviorEvals 100% valid', () => {
    const legacyV2 = record();
    expect('behaviorEvals' in legacyV2).toBe(false);
    const verdict = decide({ record: legacyV2 });
    expect(verdict.ok, verdict.message).toBe(true);
    expect(verdict.reason).toBe('qualified');
  });

  it('summarizes the committed behavior-eval manifest and accepts fresh summaries in v2 records', () => {
    const ext = q as unknown as QualificationBehaviorExtensions;
    const summary = ext.summarizeBehaviorEvalManifest(ext.BEHAVIOR_EVAL_MANIFEST_PATH);
    expect(summary).not.toBeNull();
    if (summary === null) return;
    expect(summary.maxAgeDays).toBe(30);
    expect(summary.staleFixtureOwner.length).toBeGreaterThan(0);
    for (const backend of ['claude', 'codex', 'agy'] as const) {
      expect(summary.perBackend[backend].taskCount).toBe(4);
      expect(summary.perBackend[backend].passedCount).toBe(4);
      expect(summary.perBackend[backend].promptDigests).toHaveLength(4);
    }
    expect(summary.perBackend.claude.costDenomination).toBe('usd');
    expect(summary.perBackend.codex.costDenomination).toBe('tokens');
    expect(summary.perBackend.agy.costDenomination).toBe('tokens');

    const evalNow = '2026-11-24T12:00:00.000Z';
    const withEvals = record({
      qualifiedAt: '2026-11-24T11:00:00.000Z',
      behaviorEvals: summary
    });
    const verdict = decide({ record: withEvals, now: evalNow });
    expect(verdict.ok, verdict.message).toBe(true);
  });

  it('refuses stale, missing-owner, future, malformed, or incomplete behaviorEvals summaries', () => {
    const ext = q as unknown as QualificationBehaviorExtensions;
    const summary = ext.summarizeBehaviorEvalManifest(ext.BEHAVIOR_EVAL_MANIFEST_PATH);
    if (summary === null) throw new Error('expected committed behavior-eval manifest summary');

    // Stale (> 30 days) refuses and names staleFixtureOwner.
    const staleNow = '2026-12-26T12:00:00.000Z';
    const staleVerdict = decide({
      record: record({ qualifiedAt: '2026-12-25T12:00:00.000Z', behaviorEvals: summary }),
      now: staleNow
    });
    expect(staleVerdict.ok).toBe(false);
    expect(staleVerdict.reason).toBe('stale-behavior-evals');
    expect(staleVerdict.message).toContain(summary.staleFixtureOwner);

    // Future behaviorEvals timestamp is refused.
    const futureVerdict = decide({
      record: record({ qualifiedAt: '2026-11-20T12:00:00.000Z', behaviorEvals: summary }),
      now: '2026-11-21T12:00:00.000Z'
    });
    expect(futureVerdict.ok).toBe(false);
    expect(futureVerdict.reason).toBe('future-behavior-evals');

    // Missing staleFixtureOwner is refused.
    const noOwner = decide({
      record: record({
        qualifiedAt: '2026-11-24T11:00:00.000Z',
        behaviorEvals: { ...summary, staleFixtureOwner: '' }
      }),
      now: '2026-11-24T12:00:00.000Z'
    });
    expect(noOwner.ok).toBe(false);
    expect(noOwner.reason).toBe('invalid-behavior-evals');

    // Degraded per-backend pass count is refused.
    const degraded = decide({
      record: record({
        qualifiedAt: '2026-11-24T11:00:00.000Z',
        behaviorEvals: {
          ...summary,
          perBackend: {
            ...summary.perBackend,
            codex: { ...summary.perBackend.codex, passedCount: 3 }
          }
        }
      }),
      now: '2026-11-24T12:00:00.000Z'
    });
    expect(degraded.ok).toBe(false);
    expect(degraded.reason).toBe('incomplete-behavior-evals');
    expect(degraded.message).toContain('codex: passedCount=3/4');

    // Non-object or null summary is refused (including fail-closed null from malformed on-disk manifest).
    for (const bad of ['invalid', null] as const) {
      const malformed = decide({
        record: record({
          qualifiedAt: '2026-11-24T11:00:00.000Z',
          behaviorEvals: bad
        }),
        now: '2026-11-24T12:00:00.000Z'
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.reason).toBe('invalid-behavior-evals');
    }

    // Invalid `now`, duplicate promptDigests, and wrong per-backend costDenomination are refused.
    expect(ext.validateBehaviorEvalsSummary(summary, { now: 'not-a-date' })).toMatchObject({
      ok: false,
      reason: 'invalid-behavior-evals'
    });
    const dupDigest = decide({
      record: record({
        qualifiedAt: '2026-11-24T11:00:00.000Z',
        behaviorEvals: {
          ...summary,
          perBackend: {
            ...summary.perBackend,
            claude: {
              ...summary.perBackend.claude,
              promptDigests: Array(4).fill(summary.perBackend.claude.promptDigests[0])
            }
          }
        }
      }),
      now: '2026-11-24T12:00:00.000Z'
    });
    expect(dupDigest.ok).toBe(false);
    expect(dupDigest.reason).toBe('incomplete-behavior-evals');

    const wrongDenom = decide({
      record: record({
        qualifiedAt: '2026-11-24T11:00:00.000Z',
        behaviorEvals: {
          ...summary,
          perBackend: {
            ...summary.perBackend,
            claude: { ...summary.perBackend.claude, costDenomination: 'tokens' }
          }
        }
      }),
      now: '2026-11-24T12:00:00.000Z'
    });
    expect(wrongDenom.ok).toBe(false);
    expect(wrongDenom.reason).toBe('incomplete-behavior-evals');

    // Stale or future per-task timestamps, wrong profileId, or mixed cost denominations cannot hide behind header.
    const rawManifest = JSON.parse(readFileSync(ext.BEHAVIOR_EVAL_MANIFEST_PATH, 'utf8'));
    const withStaleTask = ext.summarizeBehaviorEvalManifest({
      ...rawManifest,
      tasks: rawManifest.tasks.map((t: Record<string, unknown>, idx: number) =>
        idx === 0 ? { ...t, recordedAt: '2026-09-01T00:00:00.000Z' } : t
      )
    });
    expect(withStaleTask?.recordedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(
      decide({
        record: record({ qualifiedAt: '2026-11-24T11:00:00.000Z', behaviorEvals: withStaleTask }),
        now: '2026-11-24T12:00:00.000Z'
      })
    ).toMatchObject({ ok: false, reason: 'stale-behavior-evals' });

    const withFutureTask = ext.summarizeBehaviorEvalManifest({
      ...rawManifest,
      tasks: rawManifest.tasks.map((t: Record<string, unknown>, idx: number) =>
        idx === 0 ? { ...t, recordedAt: '2026-12-10T00:00:00.000Z' } : t
      )
    });
    expect(
      decide({
        record: record({ qualifiedAt: '2026-11-24T11:00:00.000Z', behaviorEvals: withFutureTask }),
        now: '2026-11-24T12:00:00.000Z'
      })
    ).toMatchObject({ ok: false, reason: 'future-behavior-evals' });

    const withBadProfile = ext.summarizeBehaviorEvalManifest({
      ...rawManifest,
      tasks: rawManifest.tasks.map((t: Record<string, unknown>, idx: number) =>
        idx === 0 ? { ...t, profileId: 'wrong-profile' } : t
      )
    });
    expect(withBadProfile?.perBackend.claude.passedCount).toBe(3);

    const withMixedDenom = ext.summarizeBehaviorEvalManifest({
      ...rawManifest,
      tasks: rawManifest.tasks.map((t: Record<string, unknown>, idx: number) =>
        idx === 0 ? { ...t, costUnits: { denomination: 'tokens', value: 999 } } : t
      )
    });
    expect(withMixedDenom?.perBackend.claude.passedCount).toBe(3);
    expect(withMixedDenom?.perBackend.claude.totalCostUnits).toBeLessThan(1);

    expect(
      ext.summarizeBehaviorEvalManifest({ ...rawManifest, maxAgeDays: 999 })
    ).toBeNull();
  });
});
