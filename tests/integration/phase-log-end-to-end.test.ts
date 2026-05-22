// Feature 020 T057 — End-to-end integration test for the phase-log
// host service + IPC contract + tail registry.
//
// Drives the full host-side path that a webview message router would
// trigger via CMD_READ_PHASE_LOG and CMD_START_PHASE_LOG_TAIL, using
// real fs operations against a temporary workspace seeded from
// `tests/integration/fixtures/phase-log/`.
//
// Validates:
//   1. Manifest projection through `createPhaseLogService.read()`
//      (kinds, sanitization, truncation, skippedLines).
//   2. Tail push lifecycle via `PhaseLogTailRegistry`:
//      a. Initial bytes emit one push per projected entry.
//      b. Appending bytes to the stream.jsonl triggers another push.
//      c. `task-leaves-in-flight` signal emits a synthetic
//         `tail-ended` push and drops the registry to 0 sessions.
//
// The MessageRouter is *not* mounted directly; the contracts under
// test (CMD_READ_PHASE_LOG, MSG_PHASE_LOG_ENTRY) are the IPC seams,
// and we exercise them through the service + registry that the router
// dispatches to. The router itself is a thin adapter — exercising it
// would re-test wiring already covered by unit tests in
// `tests/unit/ui/sidebar/`. See `specs/020-phase-level-logs/tasks.md`
// T057.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SanitizedLogger } from '../../src/lib/logger';
import { createPhaseLogService } from '../../src/services/phase-log/phase-log-service';
import {
  PhaseLogTailRegistry,
  type PhaseLogTailEnvelope,
  type PhaseLogTailRegistryAuditEvent
} from '../../src/services/phase-log/phase-log-tail-registry';
import {
  CMD_READ_PHASE_LOG,
  MSG_PHASE_LOG_ENTRY,
  type ReadPhaseLogRequest,
  type ReadPhaseLogResponse
} from '../../src/contracts/sidebar-ipc';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/phase-log');

const RUN_ID = 'run-test-1';
const TASK_ID = 'task-id-different-from-run';
const QUEUE_ID = 'default';
const PIPELINE_ID = 'standard';
const PHASE_ID = 'speckit-plan';

interface Harness {
  readonly workspaceRoot: string;
  readonly logger: SanitizedLogger;
  readonly cleanup: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'phase-log-e2e-')
  );
  const phaseDir = path.join(
    workspaceRoot,
    '.schegent',
    'sessions',
    RUN_ID,
    'diagnostics',
    PIPELINE_ID,
    PHASE_ID
  );
  for (const n of [1, 2, 3]) {
    const iterDir = path.join(phaseDir, `iter-${n}`);
    await fs.mkdir(iterDir, { recursive: true });
    const src = path.join(FIXTURES_DIR, `iter-${n}.jsonl`);
    const dst = path.join(iterDir, 'stream.jsonl');
    await fs.copyFile(src, dst);
  }
  const logger = new SanitizedLogger();
  return {
    workspaceRoot,
    logger,
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

function makeService(h: Harness, isInFlight: boolean) {
  return createPhaseLogService({
    workspaceRoot: h.workspaceRoot,
    sanitize: (s) => h.logger.sanitize(s),
    readVerboseSetting: () => true,
    getSnapshot: () => ({
      queue: {
        inFlight: isInFlight ? { id: RUN_ID } : null,
        pending: [],
        recent: isInFlight ? [] : [{ id: RUN_ID }],
        queues: [{ id: QUEUE_ID }]
      },
      history: [],
      availablePipelines: [{ id: PIPELINE_ID }],
      availablePhases: [{ id: PHASE_ID }]
    }),
    // In these tests RUN_ID is used as both the snapshot id and the
    // directory name, so the resolver simply returns the same value.
    resolveRunId: (taskId) => (taskId === RUN_ID ? RUN_ID : null),
    caps: { perFieldBytes: 4096 }
  });
}

/**
 * Variant of makeService that uses a DIFFERENT taskId from the runId.
 * The snapshot carries `TASK_ID` as the queue item id, while the
 * session directory on disk is named `RUN_ID`. The `resolveRunId`
 * callback maps TASK_ID → RUN_ID, proving the service correctly
 * translates the webview's taskId into the on-disk runId.
 */
function makeServiceWithSplitIds(h: Harness, isInFlight: boolean) {
  return createPhaseLogService({
    workspaceRoot: h.workspaceRoot,
    sanitize: (s) => h.logger.sanitize(s),
    readVerboseSetting: () => true,
    getSnapshot: () => ({
      queue: {
        inFlight: isInFlight ? { id: TASK_ID } : null,
        pending: [],
        recent: isInFlight ? [] : [{ id: TASK_ID }],
        queues: [{ id: QUEUE_ID }]
      },
      history: [],
      availablePipelines: [{ id: PIPELINE_ID }],
      availablePhases: [{ id: PHASE_ID }]
    }),
    resolveRunId: (taskId) => (taskId === TASK_ID ? RUN_ID : null),
    caps: { perFieldBytes: 4096 }
  });
}

function buildReq(iterationN: number | null): ReadPhaseLogRequest {
  return {
    selection: {
      queueId: QUEUE_ID,
      taskId: RUN_ID,
      pipelineId: PIPELINE_ID,
      phaseId: PHASE_ID,
      iterationN
    }
  };
}

function asSuccess(
  res: ReadPhaseLogResponse
): Extract<ReadPhaseLogResponse, { outcome: 'success' }> {
  if (res.outcome !== 'success') {
    throw new Error(
      `expected success response, got failure: ${(res as { reason?: string }).reason ?? '<unknown>'}`
    );
  }
  return res;
}

async function pollUntil(
  cond: () => boolean,
  timeoutMs: number,
  stepMs = 25
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

let harness: Harness;
beforeEach(async () => {
  harness = await buildHarness();
});
afterEach(async () => {
  await harness.cleanup();
});

describe('Feature 020 T057 — phase-log end-to-end', () => {
  it('CMD_READ_PHASE_LOG returns projected manifest for the happy-path iteration', async () => {
    const service = makeService(harness, /* isInFlight */ false);
    const res = await service.read(buildReq(1));
    const success = asSuccess(res);
    // discoverIterations returns most-recent-first (descending).
    expect(success.manifest.iterations).toEqual([3, 2, 1]);
    expect(success.manifest.selectedIteration).toBe(1);
    // iter-1 has 5 displayable entries + 2 framing lines that the
    // projector drops (message_start, content_block_delta).
    const kinds = success.manifest.entries.map((e) => e.kind);
    expect(kinds).toEqual([
      'system',
      'assistant-text',
      'tool-use',
      'tool-result',
      'result'
    ]);
    expect(success.manifest.skippedLines).toBe(0);
    expect(success.manifest.truncatedCount).toBe(0);
    expect(success.manifest.verboseDiagnosticsState.kind).toBe(
      'enabled-with-sessions'
    );
    expect(success.manifest.isInFlight).toBe(false);
  });

  it('CMD_READ_PHASE_LOG sanitizes secret patterns and truncates long body fields', async () => {
    const service = makeService(harness, /* isInFlight */ false);
    const res = await service.read(buildReq(2));
    const success = asSuccess(res);
    expect(success.manifest.entries.length).toBe(3);
    // Sanitization: the assistant-text contains an Anthropic-style key
    // that must be redacted by SanitizedLogger before crossing the IPC
    // boundary.
    const text = success.manifest.entries[0].body.text;
    expect(typeof text).toBe('string');
    expect(text).not.toMatch(/sk-ant-api03-[A-Za-z0-9]+/);
    expect(text).toContain('[REDACTED]');
    // Truncation: the tool_result body string exceeds the 4096-byte
    // default cap and must be reported via bodyTruncated.
    const toolResultEntry = success.manifest.entries[1];
    expect(toolResultEntry.kind).toBe('tool-result');
    const truncated = toolResultEntry.bodyTruncated;
    expect(truncated).not.toBeNull();
    expect(truncated?.toolResult?.originalLength).toBe(5000);
    expect((toolResultEntry.body.toolResult as string).length).toBeLessThanOrEqual(
      4096
    );
    expect(success.manifest.truncatedCount).toBe(1);
  });

  it('CMD_READ_PHASE_LOG reports skippedLines for malformed JSONL', async () => {
    const service = makeService(harness, /* isInFlight */ false);
    const res = await service.read(buildReq(3));
    const success = asSuccess(res);
    // iter-3 has 3 valid entries (text, system, text) and 2 malformed
    // lines.
    const kinds = success.manifest.entries.map((e) => e.kind);
    expect(kinds).toEqual(['assistant-text', 'system', 'assistant-text']);
    expect(success.manifest.skippedLines).toBe(2);
  });

  it('CMD_READ_PHASE_LOG resolves runId from taskId when they differ (BUG-001 regression)', async () => {
    // This is the core regression test for the taskId/runId mismatch
    // bug. The webview sends TASK_ID (FeatureRequest.id) as the
    // selection.taskId, but the session directory on disk is named
    // RUN_ID (WorkflowRun.id). Without the resolveRunId translation,
    // the service would look for a non-existent directory and return
    // an empty manifest.
    const service = makeServiceWithSplitIds(harness, /* isInFlight */ false);
    const req: ReadPhaseLogRequest = {
      selection: {
        queueId: QUEUE_ID,
        taskId: TASK_ID,
        pipelineId: PIPELINE_ID,
        phaseId: PHASE_ID,
        iterationN: 1
      }
    };
    const res = await service.read(req);
    const success = asSuccess(res);
    // The service should have resolved TASK_ID → RUN_ID and found the
    // on-disk iterations successfully.
    expect(success.manifest.iterations).toEqual([3, 2, 1]);
    expect(success.manifest.selectedIteration).toBe(1);
    expect(success.manifest.entries.length).toBeGreaterThan(0);
  });

  it('PhaseLogTailRegistry emits MSG_PHASE_LOG_ENTRY pushes for existing bytes, new appends, and synthetic tail-ended', async () => {
    const envelopes: PhaseLogTailEnvelope[] = [];
    const auditEvents: PhaseLogTailRegistryAuditEvent[] = [];
    let leaveCb: ((runId: string) => void) | null = null;
    const registry = new PhaseLogTailRegistry({
      pushToWebview: (env) => envelopes.push(env),
      sanitize: (s) => harness.logger.sanitize(s),
      appendAudit: (e) => {
        auditEvents.push(e);
      },
      onTaskNoLongerInFlight: (cb) => {
        leaveCb = cb;
        return { dispose: () => { leaveCb = null; } };
      },
      caps: { perFieldBytes: 4096 }
    });

    // Step 1 — start a tail on the malformed-lines iteration. The
    // selection mirrors the IPC contract's StartPhaseLogTailRequest.
    const start = await registry.start({
      workspaceRoot: harness.workspaceRoot,
      selection: {
        queueId: QUEUE_ID,
        taskId: RUN_ID,
        pipelineId: PIPELINE_ID,
        phaseId: PHASE_ID,
        iterationN: 3
      }
    });
    if (start.outcome !== 'success') {
      throw new Error(`tail start failed: ${start.reason}`);
    }
    expect(registry.activeSessionCount).toBe(1);
    expect(['fs.watch', 'polling']).toContain(start.mechanism);

    // Step 2 — wait for the 3 valid entries to push from the initial
    // tick. Skipped lines are counted but don't push.
    await pollUntil(() => envelopes.length >= 3, 2000);
    expect(envelopes.length).toBeGreaterThanOrEqual(3);
    for (const env of envelopes) {
      expect(env.type).toBe(MSG_PHASE_LOG_ENTRY);
      expect(env.payload.tailSessionId).toBe(start.sessionId);
    }
    const initialKinds = envelopes.map((e) => e.payload.entry.kind);
    expect(initialKinds.slice(0, 3)).toEqual([
      'assistant-text',
      'system',
      'assistant-text'
    ]);

    // Step 3 — append a new entry to the on-disk stream.jsonl. The
    // watcher (fs.watch or polling) MUST detect the append within 2s
    // and emit one additional push.
    const streamPath = path.join(
      harness.workspaceRoot,
      '.schegent',
      'sessions',
      RUN_ID,
      'diagnostics',
      PIPELINE_ID,
      PHASE_ID,
      'iter-3',
      'stream.jsonl'
    );
    const newLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'appended live' }] }
    });
    await fs.appendFile(streamPath, newLine + '\n', 'utf8');

    const expectedAfterAppend = envelopes.length + 1;
    const arrived = await pollUntil(
      () => envelopes.length >= expectedAfterAppend,
      2000
    );
    expect(arrived).toBe(true);
    const latest = envelopes[envelopes.length - 1].payload.entry;
    expect(latest.kind).toBe('assistant-text');
    expect(latest.body.text).toBe('appended live');

    // Step 4 — simulate the task leaving in-flight. The registry MUST
    // dispose the active session, push a synthetic tail-ended entry,
    // and drop the activeSessionCount to 0.
    const beforeLeave = envelopes.length;
    if (leaveCb === null) {
      throw new Error('onTaskNoLongerInFlight callback was never registered');
    }
    // TypeScript can't narrow `leaveCb` through the closure, so cast.
    (leaveCb as (runId: string) => void)(RUN_ID);

    await pollUntil(() => envelopes.length > beforeLeave, 2000);
    const tailEnded = envelopes[envelopes.length - 1].payload.entry;
    expect(tailEnded.kind).toBe('tail-ended');
    expect(tailEnded.body.reason).toBe('phase-complete');
    expect(registry.activeSessionCount).toBe(0);

    // Audit-log expectations: one started + one stopped event with the
    // matching session id, with the stopped event carrying the
    // 'phase-complete' reason. The stopped event lands AFTER
    // disposeCurrent inside an async handler; poll until it arrives.
    await pollUntil(
      () => auditEvents.some((e) => e.type === 'phase-log-tail-stopped'),
      2000
    );
    const started = auditEvents.find((e) => e.type === 'phase-log-tail-started');
    const stopped = auditEvents.find((e) => e.type === 'phase-log-tail-stopped');
    expect(started?.payload.sessionId).toBe(start.sessionId);
    expect(started?.payload.outcome).toBe('success');
    expect(stopped?.payload.sessionId).toBe(start.sessionId);
    expect(stopped?.payload.reason).toBe('phase-complete');
    // The audit payload MUST be paths-free — the selection tuple +
    // counts/outcome are the only fields that cross the audit boundary.
    expect(stopped?.payload).not.toHaveProperty('path');
    expect(stopped?.payload).not.toHaveProperty('filePath');
    expect(stopped?.payload).not.toHaveProperty('workspaceRoot');

    await registry.disposeAll('webview-dispose');
  });

  it('CMD_READ_PHASE_LOG (sentinel commandName) matches the wire contract', () => {
    // Cheap regression: drift between the contract module and this
    // test would surface as a typo here, not just at runtime in the
    // router. The literal MUST match the export.
    expect(CMD_READ_PHASE_LOG).toBe('CMD_READ_PHASE_LOG');
    expect(MSG_PHASE_LOG_ENTRY).toBe('MSG_PHASE_LOG_ENTRY');
  });
});
