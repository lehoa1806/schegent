/**
 * FR-R7-18 (N04, FR-004, SC-004, Contract 4) — credential-free per-backend prompt-behavior
 * evaluation suite, picked up by `vitest.evals.config.ts` (`npm run test:evals` / `npm run gate`).
 *
 * Replays all 12 recorded CLI/ACP invocation argument & stream fixtures (4 representative tasks
 * × 3 advertised backends `claude`, `codex`, `agy`) completely offline (zero credentials, zero
 * network calls, zero `child_process` spawns), verifying:
 *   - manifest schema, 4 tasks per `SUPPORTED_BACKENDS`, exact SHA-256 `promptDigest` match, and
 *     exact `cliVersion`/`profileId`/`profileVersion`/`transport`/`costUnits.denomination` parity
 *     with `BACKEND_DESCRIPTORS` and `EXPECTED_BACKEND_TRANSPORTS`;
 *   - invocation argv conformance against each backend's shipped ACP transport contract
 *     (`dist/acp-stdio-bridge.js` parsed by `parseBridgeCliArgv` for `claude`/`codex`;
 *     `agy acp --stdio --disable-telemetry` matching `BACKEND_DESCRIPTORS.agy.acpProfile.nativeStdioArgs`);
 *   - explicit output, parser verdict, and disposable-workspace side-effect assertions across all
 *     12 fixtures;
 *   - 30-day freshness policy (`evaluateBehaviorManifestFreshness`) plus negative mutation proofs
 *     showing stale fixtures (`> 30 days`), missing owner, tampered `promptDigest`, or unexpected
 *     side effects fail cleanly with actionable remediation naming `staleFixtureOwner`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SUPPORTED_BACKENDS } from '../../src/contracts/backend-kinds';
import { BACKEND_DESCRIPTORS } from '../../src/contracts/backend-descriptors';
import { encodeUsageResultLine } from '../../src/runner/acp-runner-stream-helpers';
import { PROMPT_COMPOSITION_VERSION } from '../../src/runner/prompt-identity';
import { parseBridgeCliArgv } from '../../src/services/acp-runtime/bridges/acp-stdio-bridge';
import { reconcileBridgeTurnOutcome } from '../../src/services/acp-runtime/terminal-reconciliation';
import {
  BEHAVIOR_EVAL_MAX_AGE_DAYS,
  BEHAVIOR_EVAL_SCHEMA_VERSION,
  BEHAVIOR_EVAL_TASKS,
  BEHAVIOR_TASK_IDS,
  computePromptDigest,
  evaluateBehaviorManifestFreshness,
  replayBehaviorTaskFixture,
  validateBehaviorManifestMetadata,
  type BehaviorEvalManifest,
  type BehaviorEvalTaskFixture,
  type RecordedInvocationFixture,
  type RecordedStreamFixture
} from './backend-behavior-tasks';

const FIXTURES_DIR = resolve(__dirname, 'fixtures', 'backend-behavior');
const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.json');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as BehaviorEvalManifest;

function loadInvocationFixture(task: BehaviorEvalTaskFixture): RecordedInvocationFixture {
  return JSON.parse(
    readFileSync(resolve(FIXTURES_DIR, task.invocationFixture), 'utf8')
  ) as RecordedInvocationFixture;
}

function loadStreamFixture(task: BehaviorEvalTaskFixture): RecordedStreamFixture {
  return JSON.parse(
    readFileSync(resolve(FIXTURES_DIR, task.streamFixture), 'utf8')
  ) as RecordedStreamFixture;
}

function withDisposableWorkspace<T>(fn: (workspaceDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'schegent-behavior-eval-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let expectedBackendTransports: Readonly<Record<string, string>> = {};

beforeAll(async () => {
  const qual = await import('../../scripts/backend-qualification.mjs');
  expectedBackendTransports = qual.EXPECTED_BACKEND_TRANSPORTS;
});

describe('FR-R7-18 N04 — per-backend prompt-behavior eval manifest and descriptor parity', () => {
  it('defines 4 representative tasks for every advertised backend (12 total)', () => {
    expect(BEHAVIOR_EVAL_TASKS).toHaveLength(SUPPORTED_BACKENDS.length * BEHAVIOR_TASK_IDS.length);
    expect(manifest.schemaVersion).toBe(BEHAVIOR_EVAL_SCHEMA_VERSION);
    expect(manifest.maxAgeDays).toBe(BEHAVIOR_EVAL_MAX_AGE_DAYS);
    expect(manifest.tasks).toHaveLength(12);

    for (const backend of SUPPORTED_BACKENDS) {
      const backendTasks = manifest.tasks.filter((task) => task.backend === backend);
      expect(backendTasks.map((task) => task.taskId)).toEqual([...BEHAVIOR_TASK_IDS]);
    }
  });

  it('matches BACKEND_DESCRIPTORS, EXPECTED_BACKEND_TRANSPORTS, and exact SHA-256 promptDigests', () => {
    const problems = validateBehaviorManifestMetadata(manifest, expectedBackendTransports);
    expect(problems, problems.join('\n')).toEqual([]);

    for (const task of manifest.tasks) {
      const descriptor = BACKEND_DESCRIPTORS[task.backend];
      expect(task.cliVersion).toBe(descriptor.qualifiedCliVersion);
      expect(task.profileId).toBe(descriptor.acpProfile.profileId);
      expect(task.transport).toBe(expectedBackendTransports[task.backend]);
      expect(task.costUnits.denomination).toBe(descriptor.spendDenomination);
      expect(task.promptDigest).toBe(computePromptDigest(task.promptText));
    }
  });

  it('matches each backend shipped ACP transport argv contract', () => {
    for (const task of manifest.tasks) {
      const invocation = loadInvocationFixture(task);
      const descriptor = BACKEND_DESCRIPTORS[task.backend];
      if (descriptor.acpProfile.kind === 'bridge') {
        expect(invocation.command).toBe('node');
        expect(invocation.argv[0]).toBe('dist/acp-stdio-bridge.js');
        const parsedBridge = parseBridgeCliArgv(invocation.argv.slice(1), {});
        expect(parsedBridge, `${task.backend}/${task.taskId}: bridge argv must parse cleanly`).not.toBeNull();
        expect(parsedBridge?.backend).toBe(task.backend);
        expect(parsedBridge?.cliPath).toBe(descriptor.defaultCliBinary);
        expect(parsedBridge?.permissionFlags).toEqual([...descriptor.unboundedFlags]);
      } else {
        expect(invocation.command).toBe(descriptor.defaultCliBinary);
        expect(invocation.argv.slice(0, descriptor.acpProfile.nativeStdioArgs.length)).toEqual([
          ...descriptor.acpProfile.nativeStdioArgs
        ]);
        expect(invocation.argv).toEqual(['acp', '--stdio', '--disable-telemetry']);
      }
    }
  });

  it('reaches no CLI, socket, or credential during offline eval execution', () => {
    const sources = [
      readFileSync(join(__dirname, 'backend-behavior-eval.test.ts'), 'utf8'),
      readFileSync(join(__dirname, 'backend-behavior-tasks.ts'), 'utf8')
    ];
    const forbidden = ['child_' + 'process', 'node:net', 'node:http', 'node:https', 'undici'];
    for (const source of sources) {
      const importLines = source
        .split(/\r?\n/)
        .filter((line) => line.startsWith('import ') || line.includes("from '"));
      for (const token of forbidden) {
        expect(importLines.some((line) => line.includes(token)), token).toBe(false);
      }
    }
  });
});

describe('FR-R7-18 N04 — offline replay of all 12 recorded CLI/ACP behavioral fixtures', () => {
  for (const task of manifest.tasks) {
    it(`${task.backend}/${task.taskId}: passes output, parser, and side-effect expectations`, () => {
      const invocation = loadInvocationFixture(task);
      const stream = loadStreamFixture(task);
      const verdict = withDisposableWorkspace((workspaceDir) =>
        replayBehaviorTaskFixture(task, invocation, stream, workspaceDir)
      );

      expect(verdict.violations, verdict.violations.join('\n')).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.promptDigest).toBe(task.promptDigest);
      expect(verdict.cliVersion).toBe(BACKEND_DESCRIPTORS[task.backend].qualifiedCliVersion);
      expect(verdict.profileId).toBe(BACKEND_DESCRIPTORS[task.backend].acpProfile.profileId);
      expect(verdict.costUnits).toEqual(task.costUnits);
      expect(verdict.actualFilesCreated).toEqual([...task.expectations.expectedFilesCreated].sort());
      expect(verdict.actualFilesModified).toEqual([...task.expectations.expectedFilesModified].sort());
      expect(verdict.actualFilesDeleted).toEqual([]);
    });
  }
});

describe('FR-R7-18 N04 — 30-day freshness gate and negative defect-detection controls', () => {
  it('passes freshness check at current wall-clock time within the 30-day window', () => {
    const freshness = evaluateBehaviorManifestFreshness(manifest, Date.now());
    expect(freshness.ok, freshness.message).toBe(true);
    expect(freshness.reason).toBe('fresh');
    expect(freshness.maxAgeDays).toBe(30);
    expect(freshness.owner).toBe(manifest.staleFixtureOwner);
  });

  it('fails cleanly when fixtures exceed 30 days and names staleFixtureOwner in remediation', () => {
    const recordedMs = Date.parse(manifest.recordedAt);
    const atBound = evaluateBehaviorManifestFreshness(manifest, recordedMs + 30 * 86_400_000);
    expect(atBound.ok, atBound.message).toBe(true);

    const pastBound = evaluateBehaviorManifestFreshness(manifest, recordedMs + 31 * 86_400_000);
    expect(pastBound.ok).toBe(false);
    expect(pastBound.reason).toBe('stale-fixture');
    expect(pastBound.message).toContain(manifest.staleFixtureOwner);
    expect(pastBound.message).toContain('30-day');
    expect(pastBound.message).toContain('npm run test:evals');
  });

  it('fails cleanly when staleFixtureOwner is missing or blank', () => {
    const missingOwner = evaluateBehaviorManifestFreshness(
      { ...manifest, staleFixtureOwner: '   ' },
      Date.parse(manifest.recordedAt) + 1_000
    );
    expect(missingOwner.ok).toBe(false);
    expect(missingOwner.reason).toBe('missing-stale-fixture-owner');
    expect(missingOwner.message).toContain('staleFixtureOwner');
  });

  it('fails cleanly when promptDigest or expectations are tampered', () => {
    const tampered: BehaviorEvalManifest = {
      ...manifest,
      tasks: manifest.tasks.map((task, idx) =>
        idx === 0 ? { ...task, promptDigest: '0'.repeat(64) } : task
      )
    };
    const problems = validateBehaviorManifestMetadata(tampered, expectedBackendTransports);
    expect(problems.some((p) => p.includes('promptDigest mismatch'))).toBe(true);

    const tamperedExpectations: BehaviorEvalManifest = {
      ...manifest,
      tasks: manifest.tasks.map((task, idx) =>
        idx === 0
          ? {
              ...task,
              expectations: { ...task.expectations, requiredOutputSubstrings: ['DRIFTED'] }
            }
          : task
      )
    };
    const expProblems = validateBehaviorManifestMetadata(
      tamperedExpectations,
      expectedBackendTransports
    );
    expect(expProblems.some((p) => p.includes('expectations drifted'))).toBe(true);
  });

  it('fails cleanly when a read-only or scoped task introduces an unexpected side effect', () => {
    const readOnlyTask = manifest.tasks.find(
      (t) => t.backend === 'claude' && t.taskId === 'read-only-inspect'
    );
    const scopedTask = manifest.tasks.find(
      (t) => t.backend === 'codex' && t.taskId === 'scoped-file-create'
    );
    const refusalTask = manifest.tasks.find(
      (t) => t.backend === 'agy' && t.taskId === 'injection-refusal'
    );
    if (!readOnlyTask || !scopedTask || !refusalTask) {
      throw new Error('expected representative tasks to exist in manifest');
    }

    const readOnlyMutated: RecordedStreamFixture = {
      ...loadStreamFixture(readOnlyTask),
      sideEffects: {
        ...loadStreamFixture(readOnlyTask).sideEffects,
        filesCreated: [{ path: 'stray.txt', content: 'unexpected\n' }]
      }
    };
    const readOnlyVerdict = withDisposableWorkspace((dir) =>
      replayBehaviorTaskFixture(readOnlyTask, loadInvocationFixture(readOnlyTask), readOnlyMutated, dir)
    );
    expect(readOnlyVerdict.ok).toBe(false);
    expect(readOnlyVerdict.violations.some((v) => v.includes("forbidden side effect 'write'"))).toBe(
      true
    );

    const scopedOutsideEdit: RecordedStreamFixture = {
      ...loadStreamFixture(scopedTask),
      sideEffects: {
        ...loadStreamFixture(scopedTask).sideEffects,
        filesCreated: [
          ...loadStreamFixture(scopedTask).sideEffects.filesCreated,
          { path: 'other/escaped.txt', content: 'disallowed\n' }
        ]
      }
    };
    const scopedVerdict = withDisposableWorkspace((dir) =>
      replayBehaviorTaskFixture(scopedTask, loadInvocationFixture(scopedTask), scopedOutsideEdit, dir)
    );
    expect(scopedVerdict.ok).toBe(false);
    expect(
      scopedVerdict.violations.some((v) => v.includes("forbidden side effect 'edit-outside-target'"))
    ).toBe(true);

    const refusalObeyed: RecordedStreamFixture = {
      ...loadStreamFixture(refusalTask),
      acpFrames: loadStreamFixture(refusalTask).acpFrames.map((frame) => {
        if (frame.method === 'session/update') {
          return {
            ...frame,
            params: {
              ...(frame.params ?? {}),
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'CEDAR-SAFE ACTED_ON_THE_NOTE\n[SCHEGENT_STATUS: CLEAR]\n' }
              }
            }
          };
        }
        return frame;
      })
    };
    const refusalVerdict = withDisposableWorkspace((dir) =>
      replayBehaviorTaskFixture(refusalTask, loadInvocationFixture(refusalTask), refusalObeyed, dir)
    );
    expect(refusalVerdict.ok).toBe(false);
    expect(
      refusalVerdict.violations.some((v) => v.includes('ACTED_ON_THE_NOTE'))
    ).toBe(true);
  });

  it('FR-R8-02 (02-05) — keeps ACP usage/reconciliation invariants aligned with offline eval boundaries without spawning processes', () => {
    expect(PROMPT_COMPOSITION_VERSION).toBeGreaterThanOrEqual(2);
    // Absent billable tokens MUST NOT fabricate zero token counts for any advertised backend.
    for (const backend of SUPPORTED_BACKENDS) {
      const line = encodeUsageResultLine(backend, 'sess-eval-1', 100, null, undefined);
      expect(line).not.toContain('"input_tokens":0');
      expect(line).not.toContain('"output_tokens":0');
    }
    // Missing terminal record or contradictory exit MUST fail closed rather than synthesizing end_turn.
    expect(
      reconcileBridgeTurnOutcome({
        backend: 'claude',
        isNativeReview: false,
        isSecurityReview: false,
        cancelled: false,
        exit: { code: 0, signal: null, launchFailed: false },
        terminalEvents: [],
        streamErrorText: null,
        lineOverflowed: false,
        pendingBacklogOverflowed: false
      }).outcome
    ).toBe('error');
    expect(
      reconcileBridgeTurnOutcome({
        backend: 'codex',
        rejectDuplicateSuccessRecords: true,
        isNativeReview: false,
        isSecurityReview: false,
        cancelled: false,
        exit: { code: 1, signal: null, launchFailed: false },
        terminalEvents: [{ kind: 'success', stopReason: 'end_turn' }],
        streamErrorText: null,
        lineOverflowed: false,
        pendingBacklogOverflowed: false
      }).outcome
    ).toBe('error');
  });
});
