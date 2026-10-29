// FR-R4-F15 (feature 243, contract Q4, Q6.3) — the sidebar's "read a row's newest failure record"
// handler.
//
// The request is read-only and addressed by the queue and the task, so the handler takes no primacy
// gate and no trust gate; what it must guarantee is that each true answer reaches the wire unchanged
// and as ACCEPTED (an expired or missing record is an answer, not a refusal), that a row the window
// does not hold is `unknown-row`, and that a failure is logged by code and never by identifier, path
// or message. Modelled on `cmd-resolve-history-description.test.ts`.
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_READ_FAILURE_RECORD } from '../../../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ReadFailureRecordCommand,
  ReadFailureRecordResponse
} from '../../../../../src/contracts/sidebar-ipc';
import type { FailureRecordV1 } from '../../../../../src/contracts/failure-record';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-read-failure-record';
import {
  createFailureRecorder,
  createFailureRecordAnswerer
} from '../../../../../src/services/failure-record/failure-record-service';
import { SanitizedLogger } from '../../../../../src/lib/logger';

const QUEUE = 'default';
const TASK = 'task-1';

const RECORD: FailureRecordV1 = {
  recordVersion: 1,
  queueId: QUEUE,
  taskId: TASK,
  runId: 'run-1',
  failedAt: '2026-10-28T14:30:05.123Z',
  suffix: '0a1b2c3d',
  cause: 'last_phase_issues_remain',
  issueState: 'listed',
  entries: [{ kind: 'issue', summary: 'one case fails', tag: 'regression', source: 'agent' }],
  omittedIssueCount: 0,
  metrics: [],
  omittedMetricCount: 0
};

type Read = (request: { queueId: string; taskId: string }) => Promise<ReadFailureRecordResponse>;

function buildCtx(read?: Read): {
  ctx: Parameters<typeof handler>[0];
  acks: CommandAckMessage[];
  warnings: unknown[][];
} {
  const acks: CommandAckMessage[] = [];
  const warnings: unknown[][] = [];
  const ctx = {
    deps: {
      logger: {
        info: vi.fn(),
        warn: (...args: unknown[]) => warnings.push(args),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      ...(read === undefined ? {} : { readFailureRecord: read })
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-read-failure-record-1'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, warnings };
}

function makeCmd(queueId = QUEUE, taskId = TASK): ReadFailureRecordCommand {
  return {
    type: CMD_READ_FAILURE_RECORD,
    correlationId: 'test-read-failure-record-1',
    payload: { queueId, taskId }
  } as ReadFailureRecordCommand;
}

const resultOf = (acks: CommandAckMessage[]): ReadFailureRecordResponse =>
  (acks[0] as unknown as { result: ReadFailureRecordResponse }).result;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-read-failure-record (Q4.1, Q6.3)', () => {
  const ANSWERS: ReadonlyArray<ReadFailureRecordResponse> = [
    { outcome: 'available', queueId: QUEUE, taskId: TASK, record: RECORD, recordCount: 2 },
    { outcome: 'none', queueId: QUEUE, taskId: TASK },
    { outcome: 'expired', queueId: QUEUE, taskId: TASK },
    { outcome: 'unavailable', queueId: QUEUE, taskId: TASK },
    { outcome: 'malformed', queueId: QUEUE, taskId: TASK, recordCount: 1 }
  ];

  it.each(ANSWERS)('acks the $outcome answer as accepted, with the response unchanged', async (answer) => {
    const { ctx, acks } = buildCtx(async () => answer);
    await handler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0]?.status).toBe('accepted');
    expect(resultOf(acks)).toEqual(answer);
    expect((acks[0] as { reason?: string }).reason).toBeUndefined();
  });

  it('passes the two identifiers to the service and nothing else', async () => {
    const read = vi.fn<Read>(async () => ANSWERS[1] as ReadFailureRecordResponse);
    const { ctx } = buildCtx(read);
    await handler(ctx, makeCmd('q-7', 'task-7'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ queueId: 'q-7', taskId: 'task-7' });
  });

  it('acks an unknown row as rejected with reason unknown-row', async () => {
    const { ctx, acks } = buildCtx(async () => ({ outcome: 'failure', reason: 'unknown-row' }));
    await handler(ctx, makeCmd('default', 'task-that-never-was'));
    expect(acks[0]?.status).toBe('rejected');
    expect((acks[0] as { reason?: string }).reason).toBe('unknown-row');
    expect(resultOf(acks)).toEqual({ outcome: 'failure', reason: 'unknown-row' });
  });

  it('acks a service that reports internal-error as rejected with reason internal-error', async () => {
    const { ctx, acks } = buildCtx(async () => ({ outcome: 'failure', reason: 'internal-error' }));
    await handler(ctx, makeCmd());
    expect(acks[0]?.status).toBe('rejected');
    expect((acks[0] as { reason?: string }).reason).toBe('internal-error');
  });

  it('acks internal-error when no service is wired, rather than throwing', async () => {
    const { ctx, acks } = buildCtx();
    await handler(ctx, makeCmd());
    expect(acks[0]?.status).toBe('rejected');
    expect((acks[0] as { reason?: string }).reason).toBe('internal-error');
    expect(resultOf(acks)).toEqual({ outcome: 'failure', reason: 'internal-error' });
  });

  it('acks internal-error when the service throws, and logs one warning that names no identifier, path or message', async () => {
    const { ctx, acks, warnings } = buildCtx(async () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/Users/someone/work/.schegent/failure-records'"), {
        code: 'EACCES'
      });
    });
    await handler(ctx, makeCmd('q-secret-queue', 'task-secret-task'));
    expect(acks[0]?.status).toBe('rejected');
    expect(resultOf(acks)).toEqual({ outcome: 'failure', reason: 'internal-error' });
    expect(warnings).toHaveLength(1);
    const logged = JSON.stringify(warnings);
    expect(logged).toContain('EACCES');
    for (const fragment of ['/Users/someone', 'permission denied', 'q-secret-queue', 'task-secret-task']) {
      expect(logged).not.toContain(fragment);
    }
  });

  it('logs nothing for an answer, including an unknown row', async () => {
    const { ctx, warnings } = buildCtx(async () => ({ outcome: 'failure', reason: 'unknown-row' }));
    await handler(ctx, makeCmd());
    expect(warnings).toHaveLength(0);
  });
});

describe('a pair from another workspace is an unknown row (Q6.3)', () => {
  // Two workspaces' queue state, as fixtures. The answer is built over the REQUESTING window's state,
  // so a queue id and a task id taken from another workspace's snapshot name no row here.
  const workspaceA = { [QUEUE]: [{ id: 'task-of-a', runId: 'run-a', status: 'failed', completedAt: null }] };
  const workspaceB: Record<string, Array<{ id: string; runId: string | null; status: string; completedAt: number | null }>> = {
    [QUEUE]: [{ id: 'task-of-b', runId: null, status: 'pending', completedAt: null }]
  };

  function answererOver(rowsByQueue: typeof workspaceB) {
    return createFailureRecordAnswerer({
      logger: { warn: vi.fn() },
      workspaceRoot: '/nonexistent/workspace-b',
      state: {
        getQueue: (queueId: string) => ({ requests: rowsByQueue[queueId] ?? [] }),
        getHistoryMap: () => ({})
      } as never,
      maxAgeMs: () => 30 * 86_400_000
    });
  }

  it('acks a queue and task taken from workspace A as unknown-row when asked of workspace B', async () => {
    const { ctx, acks } = buildCtx((request) => answererOver(workspaceB).answer(request));
    await handler(ctx, makeCmd(QUEUE, 'task-of-a'));
    expect(acks[0]?.status).toBe('rejected');
    expect((acks[0] as { reason?: string }).reason).toBe('unknown-row');
  });

  it('acks a queue id that exists only in workspace A as unknown-row', async () => {
    const withExtraQueue = { ...workspaceA, 'q-only-in-a': workspaceA[QUEUE] };
    const { ctx, acks } = buildCtx((request) => answererOver(workspaceB).answer(request));
    await handler(ctx, makeCmd('q-only-in-a', 'task-of-a'));
    expect(withExtraQueue['q-only-in-a']).toHaveLength(1);
    expect(acks[0]?.status).toBe('rejected');
    expect((acks[0] as { reason?: string }).reason).toBe('unknown-row');
  });

  it('control: workspace B\'s own row is found, so the refusals above are not a broken lookup', async () => {
    const { ctx, acks } = buildCtx((request) => answererOver(workspaceB).answer(request));
    await handler(ctx, makeCmd(QUEUE, 'task-of-b'));
    expect(acks[0]?.status).toBe('accepted');
    expect(resultOf(acks)).toEqual({ outcome: 'none', queueId: QUEUE, taskId: 'task-of-b' });
  });
});

// ---------------------------------------------------------------------------
// FR-R4-F15 (contract Q3.1; clarification Q2; User Story 3 scenario 3) — a Run that failed twice and
// was resumed. The records are written by the REAL recorder into a temporary workspace and read back
// through the real answerer and this handler, so the count, the newest record and the two ways the
// answer degrades once the files are gone are the product's own, not a stub's.
// ---------------------------------------------------------------------------
describe('a resumed Run, through the real recorder and answerer (Q3.1, US3)', () => {
  const RUN = 'run-1';
  let workspace: string;
  let clockReads = 0;
  let historyHoldsFailedEntry = false;

  beforeEach(async () => {
    workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmd-read-failure-record-'));
    clockReads = 0;
    historyHoldsFailedEntry = false;
  });

  afterEach(async () => {
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  /** The row as a resumed Run leaves it: the Run is kept, the status is no longer `failed`. */
  const resumedRow = { id: TASK, runId: RUN, status: 'in-flight', completedAt: null };

  function answerer() {
    return createFailureRecordAnswerer({
      logger: { warn: vi.fn() },
      workspaceRoot: workspace,
      state: {
        getQueue: (_queueId: string) => ({ requests: [resumedRow] }),
        getHistoryMap: () => (historyHoldsFailedEntry ? { [QUEUE]: [{ runId: RUN, terminalStatus: 'failed' }] } : {})
      } as never,
      maxAgeMs: () => 30 * 86_400_000
    });
  }

  async function writeTwoFailures(): Promise<void> {
    const recorder = createFailureRecorder({
      logger: new SanitizedLogger(),
      queue: { queueIdForExistingTask: () => QUEUE },
      workspaceRoot: workspace,
      now: () => new Date(Date.parse('2026-10-28T14:30:05.000Z') + clockReads++ * 1000)
    });
    for (const summary of ['first failure: the export test fails', 'second failure: the registry is down']) {
      const wrote = await recorder.record({
        run: { id: RUN, featureId: TASK, currentPhase: 'implement' },
        cause: 'last_phase_issues_remain',
        result: { kind: 'remaining_issues', issues: [{ tag: 'regression', summary }], auditEntry: null },
        iteration: 1,
        iterationCap: 3
      });
      expect(wrote).toBe(true);
    }
  }

  async function ask() {
    const { ctx, acks } = buildCtx((request) => answerer().answer(request));
    await handler(ctx, makeCmd());
    return { status: acks[0]?.status, result: resultOf(acks) };
  }

  it('answers available with the newer record and a count of two while the row is in flight', async () => {
    await writeTwoFailures();
    const { status, result } = await ask();
    expect(status).toBe('accepted');
    if (result.outcome !== 'available') throw new Error(`expected available, got ${result.outcome}`);
    expect(result.recordCount).toBe(2);
    expect(result.record.entries[0]?.summary).toBe('second failure: the registry is down');
    expect(Date.parse(result.record.failedAt)).toBeGreaterThan(Date.parse('2026-10-28T14:30:05.000Z'));
  });

  it('with both files gone, answers unavailable while history still holds the Run\'s failed entry', async () => {
    await writeTwoFailures();
    await fsp.rm(path.join(workspace, '.schegent', 'failure-records'), { recursive: true });
    historyHoldsFailedEntry = true;
    const { status, result } = await ask();
    expect(status).toBe('accepted');
    expect(result).toEqual({ outcome: 'unavailable', queueId: QUEUE, taskId: TASK });
  });

  it('with both files gone and no failed history entry, answers none: the host has no evidence it ever failed', async () => {
    await writeTwoFailures();
    await fsp.rm(path.join(workspace, '.schegent', 'failure-records'), { recursive: true });
    historyHoldsFailedEntry = false;
    const { status, result } = await ask();
    expect(status).toBe('accepted');
    expect(result).toEqual({ outcome: 'none', queueId: QUEUE, taskId: TASK });
  });

  it('control: the same row with its files present is available whatever history says', async () => {
    await writeTwoFailures();
    for (const held of [true, false]) {
      historyHoldsFailedEntry = held;
      expect((await ask()).result.outcome).toBe('available');
    }
  });
});

// ---------------------------------------------------------------------------
// FR-R4-F15 (TA6; FR-024, SC-004; User Story 5 scenarios 1 to 3 and 7) — "the response" is hostile-safe
// end to end. A real recorder writes a record from an output that plants two secrets, POSIX and Windows
// absolute paths, the workspace root, 500 issues and a 10,000-character metric key; the handler reads
// it back through the real answerer; and the whole serialized ack is searched for every planted value.
// ---------------------------------------------------------------------------
describe('a hostile output never reaches the response (TA6, FR-024, SC-004)', () => {
  const SECRET_ONE = ['sk', 'ant', 'a'.repeat(24)].join('-');
  const SECRET_TWO = ['ghp', 'b'.repeat(32)].join('_');
  const POSIX_PATH = '/etc/hostile/passwd';
  const WINDOWS_PATH = 'C:\\Users\\hostile\\secret.txt';
  const UNC_PATH = '\\\\hostile-host\\share\\x';
  const LONG_KEY = 'k'.repeat(10_000);
  let workspace: string;

  beforeEach(async () => {
    workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmd-read-failure-record-hostile-'));
  });

  afterEach(async () => {
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  function hostileResult(root: string) {
    const planted = [
      `first leaked ${SECRET_ONE} and ${SECRET_TWO}`,
      `second read ${root}/src/secret.ts and ${POSIX_PATH}`,
      `third opened ${WINDOWS_PATH} and ${UNC_PATH}`
    ];
    const plain = Array.from({ length: 497 }, (_, index) => `plain issue ${index}`);
    return {
      kind: 'remaining_issues' as const,
      issues: [...planted, ...plain].map((summary) => ({ tag: 'regression', summary })),
      auditEntry: { metrics: { [LONG_KEY]: 1, short_key: 2 } } as never
    };
  }

  async function writeAndRead() {
    const result = hostileResult(workspace);
    const recorder = createFailureRecorder({
      logger: new SanitizedLogger(),
      queue: { queueIdForExistingTask: () => QUEUE },
      workspaceRoot: workspace
    });
    const wrote = await recorder.record({
      run: { id: 'run-1', featureId: TASK, currentPhase: 'implement' },
      cause: 'last_phase_issues_remain',
      result,
      iteration: 1,
      iterationCap: 3
    });
    expect(wrote).toBe(true);
    const answerer = createFailureRecordAnswerer({
      logger: { warn: vi.fn() },
      workspaceRoot: workspace,
      state: {
        getQueue: (_queueId: string) => ({ requests: [{ id: TASK, runId: 'run-1', status: 'failed', completedAt: Date.now() }] }),
        getHistoryMap: () => ({})
      } as never,
      maxAgeMs: () => 30 * 86_400_000
    });
    const { ctx, acks } = buildCtx((request) => answerer.answer(request));
    await handler(ctx, makeCmd());
    return { acks, input: result };
  }

  /** The form a value takes inside a JSON document, which is what both searches below read. */
  const asJson = (value: string): string => JSON.stringify(value).slice(1, -1);

  it('control: every planted value is in the input the recorder was given', () => {
    const input = JSON.stringify(hostileResult(workspace));
    for (const planted of [SECRET_ONE, SECRET_TWO, workspace, POSIX_PATH, WINDOWS_PATH, UNC_PATH, LONG_KEY]) {
      expect(input, planted.slice(0, 40)).toContain(asJson(planted));
    }
  });

  it('keeps every planted value out of the serialized ack', async () => {
    const { acks } = await writeAndRead();
    expect(acks[0]?.status).toBe('accepted');
    const wire = JSON.stringify(acks);
    for (const planted of [SECRET_ONE, SECRET_TWO, workspace, POSIX_PATH, WINDOWS_PATH, UNC_PATH, 'hostile-host', 'k'.repeat(100)]) {
      expect(wire, planted.slice(0, 40)).not.toContain(planted);
      expect(wire, planted.slice(0, 40)).not.toContain(asJson(planted));
    }
  });

  it('bounds it: 20 entries, 480 counted as omitted, and a record under 32,768 bytes', async () => {
    const { acks } = await writeAndRead();
    const response = resultOf(acks);
    if (response.outcome !== 'available') throw new Error(`expected available, got ${response.outcome}`);
    expect(response.record.entries).toHaveLength(20);
    expect(response.record.omittedIssueCount).toBe(480);
    expect(Buffer.byteLength(JSON.stringify(response.record, null, 2) + '\n')).toBeLessThan(32_768);
    expect(response.record.metrics).toEqual([{ key: 'short_key', value: 2 }]);
    expect(response.record.omittedMetricCount).toBe(1);
  });

  it('keeps the redacted and relative remainder of the planted summaries, which is what an operator reads', async () => {
    const { acks } = await writeAndRead();
    const response = resultOf(acks);
    if (response.outcome !== 'available') throw new Error(`expected available, got ${response.outcome}`);
    expect(response.record.entries[0]?.summary).toBe('first leaked [REDACTED] and [REDACTED]');
    expect(response.record.entries[1]?.summary).toBe('second read src/secret.ts and [path]');
    expect(response.record.entries[2]?.summary).toBe('third opened [path] and [path]');
  });
});
