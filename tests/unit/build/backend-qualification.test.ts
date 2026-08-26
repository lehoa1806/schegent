import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  version: 1,
  qualifiedAt: FRESH,
  commit: 'abc123',
  platform: 'darwin arm64 node 24.19.0',
  versions: { claude: '2.1.246 (Claude Code)', codex: 'codex-cli 0.149.0', agy: '1.1.20' },
  states: { claude: 'ok', codex: 'ok', agy: 'ok' },
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
    expect(verdict.reason).toBe('version-drift');
    expect(verdict.message).toContain('never qualified');
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

    // And the record it produces is one the gate can actually decide on — the two halves driven
    // into each other rather than each against its own fixture.
    const verdict = q.decideQualification({
      record,
      head: 'abc123',
      installedVersions: { claude: '2.1.246', codex: '0.149.0', agy: null },
      changedPaths: [],
      now: NOW
    });
    expect(verdict.ok, verdict.message).toBe(true);
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
