// FR-R6-F10 T025 — running a request's verification profile in its lane (research R9).
//
// WHAT THIS PINS:
//   - every check passing moves the request to `awaiting-review`; a non-zero exit, a timeout or a
//     signal moves it to `blocked/verification-failed`, and the first failure stops the run;
//   - each stored result carries the byte count and SHA-256 of the check's output, never the
//     output itself;
//   - a lane whose HEAD moved or whose tracked files changed, before or during the run, gives
//     `blocked/verification-workspace-changed`;
//   - the argv reaches the process unchanged, with no shell, in the lane root, with the R5
//     environment (an inherited `GIT_DIR` is stripped);
//   - a check settles once it exits, even when a descendant that left its process group keeps
//     its output open (review S1).

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  IntegrationRequestView,
  VerificationCheck,
  VerificationProfile
} from '../../../src/contracts/execution-lanes';
import { createSpawnCheck } from '../../../src/services/execution-lanes/verification-runner';
import { createLaneHarness, disposeLaneHarnesses, type LaneHarness, type LaneHarnessOptions } from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const TARGET = 'main';
const SHORT_TIMEOUT_MS = 1_000;
const CHECK_TIMEOUT_MS = 30_000;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function nodeCheck(name: string, script: string, extra: readonly string[] = [], timeoutMs = CHECK_TIMEOUT_MS): VerificationCheck {
  return { name, argv: [process.execPath, '-e', script, ...extra], timeoutMs };
}

function profileOf(...checks: VerificationCheck[]): VerificationProfile {
  return { profileId: 'unit', revision: 1, checks };
}

interface Queued {
  readonly h: LaneHarness;
  readonly root: string;
  readonly request: IntegrationRequestView;
}

async function queued(profile: VerificationProfile, options: LaneHarnessOptions = {}): Promise<Queued> {
  const h = createLaneHarness({ label: 'verify', ...options });
  const lane = await h.provision();
  const root = await h.laneRoot(lane.laneId);
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha, verified\n');
  const frozen = await h.service.freezeCandidate({ laneId: lane.laneId });
  if (!frozen.ok) throw new Error(`freeze refused: ${frozen.refusal.reason}`);
  const request = await h.service.requestIntegration({ laneId: lane.laneId, targetBranch: TARGET, profile });
  if (!request.ok) throw new Error(`request refused: ${request.refusal.reason}`);
  return { h, root, request: request.value };
}

async function verified(q: Queued): Promise<IntegrationRequestView> {
  const result = await q.h.service.verifyRequest({ requestId: q.request.requestId });
  if (!result.ok) throw new Error(`verify refused: ${result.refusal.reason}`);
  return result.value;
}

function checksOf(q: Queued) {
  const result = q.h.service.getVerification({ requestId: q.request.requestId });
  if (!result.ok) throw new Error(`getVerification refused: ${result.refusal.reason}`);
  return result.value;
}

describe('FR-R6-F10 verification runner: outcomes', () => {
  it('moves a request whose checks all pass to awaiting-review', async () => {
    const q = await queued(
      profileOf(nodeCheck('first', 'process.stdout.write("ok")'), nodeCheck('second', 'process.exitCode = 0'))
    );
    expect(q.request.state).toBe('queued');

    const request = await verified(q);

    expect(request.state).toBe('awaiting-review');
    expect(request.reason).toBeNull();
    expect(request.verificationAttempt).toBe(1);
    const checks = checksOf(q);
    expect(checks.map((check) => [check.checkIndex, check.name, check.exitCode, check.passed])).toEqual([
      [0, 'first', 0, true],
      [1, 'second', 0, true]
    ]);
  });

  it.each([
    ['a non-zero exit', nodeCheck('fails', 'process.exit(3)'), { exitCode: 3, signal: null, timedOut: false }],
    [
      'a timeout',
      nodeCheck('stalls', 'setTimeout(() => {}, 60000)', [], SHORT_TIMEOUT_MS),
      { exitCode: null, timedOut: true }
    ],
    [
      'a signal',
      nodeCheck('killed', 'process.kill(process.pid, "SIGTERM")'),
      { exitCode: null, signal: 'SIGTERM', timedOut: false }
    ]
  ])('blocks with verification-failed on %s and stops the run', async (_label, failing, expected) => {
    const q = await queued(profileOf(failing, nodeCheck('never', 'process.stdout.write("unreached")')));

    const request = await verified(q);

    expect(request.state).toBe('blocked');
    expect(request.reason).toBe('verification-failed');
    const checks = checksOf(q);
    expect(checks).toHaveLength(1);
    expect(checks.at(0)).toMatchObject({ ...expected, passed: false });
  });

  it('stores the byte count and digest of the output, never the text', async () => {
    const marker = 'lane-output-marker-7f3a';
    const q = await queued(
      profileOf(nodeCheck('stdout', `process.stdout.write("${marker}")`), nodeCheck('stderr', 'process.stderr.write("oops")'))
    );

    await verified(q);

    const checks = checksOf(q);
    expect(checks.map((check) => [check.outputBytes, check.outputSha256])).toEqual([
      [marker.length, sha256(marker)],
      [4, sha256('oops')]
    ]);
    const stored = JSON.stringify(q.h.integrations.listVerificationResults(q.request.requestId, 1));
    expect(stored).not.toContain(marker);
  });
});

describe('FR-R6-F10 verification runner: the lane must hold the candidate', () => {
  it('blocks with verification-workspace-changed when the lane HEAD moved, running no check', async () => {
    const q = await queued(profileOf(nodeCheck('ok', 'process.exitCode = 0')));
    q.h.fixture.git(['commit', '-q', '--allow-empty', '-m', 'moved'], q.root);

    const request = await verified(q);

    expect(request.state).toBe('blocked');
    expect(request.reason).toBe('verification-workspace-changed');
    expect(checksOf(q)).toEqual([]);
  });

  it('blocks with verification-workspace-changed when a tracked file is dirty, running no check', async () => {
    const q = await queued(profileOf(nodeCheck('ok', 'process.exitCode = 0')));
    fs.writeFileSync(path.join(q.root, 'src', 'b.txt'), 'bravo, dirtied\n');

    const request = await verified(q);

    expect(request.reason).toBe('verification-workspace-changed');
    expect(checksOf(q)).toEqual([]);
  });

  it('blocks with verification-workspace-changed when an untracked file appeared after the freeze, running no check (review S3)', async () => {
    const q = await queued(profileOf(nodeCheck('ok', 'process.exitCode = 0')));
    fs.writeFileSync(path.join(q.root, 'src', 'helper.txt'), 'not in the candidate\n');

    const request = await verified(q);

    expect(request.reason).toBe('verification-workspace-changed');
    expect(checksOf(q)).toEqual([]);
  });

  it('passes when a check only writes an untracked file, as build output does (review S3)', async () => {
    const q = await queued(profileOf(nodeCheck('builds', 'require("node:fs").writeFileSync("src/out.txt", "built\\n")')));

    const request = await verified(q);

    expect(request.state).toBe('awaiting-review');
  });

  it('blocks with verification-workspace-changed when a check dirties a tracked file', async () => {
    const q = await queued(
      profileOf(nodeCheck('rewrites', 'require("node:fs").writeFileSync("src/b.txt", "rewritten\\n")'))
    );

    const request = await verified(q);

    expect(request.state).toBe('blocked');
    expect(request.reason).toBe('verification-workspace-changed');
    expect(checksOf(q).map((check) => check.passed)).toEqual([true]);
  });
});

describe('FR-R6-F10 verification runner: the process', () => {
  it('passes the argv literally, with no shell', async () => {
    const hostile = 'a; touch pwned && $(touch pwned2) `touch pwned3` | cat > pwned4';
    const q = await queued(profileOf(nodeCheck('literal', 'process.stdout.write(process.argv[1])', [hostile])));

    await verified(q);

    expect(checksOf(q).at(0)?.outputSha256).toBe(sha256(hostile));
    for (const name of ['pwned', 'pwned2', 'pwned3', 'pwned4']) {
      expect(fs.existsSync(path.join(q.root, name))).toBe(false);
    }
  });

  it('runs in the lane root with an inherited GIT_DIR stripped', async () => {
    const script = 'process.stdout.write(require("node:fs").realpathSync(process.cwd()) + "|" + (process.env.GIT_DIR ?? "unset"))';
    const q = await queued(profileOf(nodeCheck('where', script)), {
      overrides: { spawnCheck: createSpawnCheck({ baseEnv: { ...process.env, GIT_DIR: '/nonexistent/.git' } }) }
    });

    await verified(q);

    expect(checksOf(q).at(0)?.outputSha256).toBe(sha256(`${q.root}|unset`));
  });
});

describe('FR-R6-F10 verification runner: a descendant that leaves the process group (review S1)', () => {
  const ESCAPE_TEST_TIMEOUT_MS = 15_000;
  const PARENT_OUTPUT = 'parent done';

  it(
    'settles once the check exits, while a detached descendant still holds its output open',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-escape-'));
      const pidFile = path.join(dir, 'pid');
      const script = [
        "const cp = require('node:child_process');",
        "const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'inherit' });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        'c.unref();',
        `process.stdout.write(${JSON.stringify(PARENT_OUTPUT)});`
      ].join(' ');
      try {
        const run = await createSpawnCheck()([process.execPath, '-e', script], { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS });

        expect(run).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
        expect(run.outputBytes).toBe(PARENT_OUTPUT.length);
      } finally {
        killPidIn(pidFile);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    ESCAPE_TEST_TIMEOUT_MS
  );
});

function killPidIn(pidFile: string): void {
  if (!fs.existsSync(pidFile)) return;
  try {
    process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
  } catch {
    // Already gone.
  }
}

describe('FR-R6-F10 verification runner: refusals', () => {
  it('refuses request-not-found for an unknown request', async () => {
    const h = createLaneHarness({ label: 'verify-missing' });
    expect(await h.service.verifyRequest({ requestId: 'e'.repeat(32) })).toEqual({
      ok: false,
      refusal: { reason: 'request-not-found' }
    });
    expect(h.service.getVerification({ requestId: 'e'.repeat(32) })).toEqual({
      ok: false,
      refusal: { reason: 'request-not-found' }
    });
  });

  it('refuses request-state-invalid for a request no longer queued', async () => {
    const q = await queued(profileOf(nodeCheck('ok', 'process.exitCode = 0')));
    await verified(q);

    expect(await q.h.service.verifyRequest({ requestId: q.request.requestId })).toEqual({
      ok: false,
      refusal: { reason: 'request-state-invalid' }
    });
  });
});
