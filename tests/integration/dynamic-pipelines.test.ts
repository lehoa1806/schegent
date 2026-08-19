import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../src/config/pipeline-config';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const cleanStdout = (phase: string): string =>
  [
    '[SCHEGENT_STATUS: CLEAR]',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'open_issues: 0',
    'notes: ok',
    '=== END AUDIT LOG ==='
  ].join('\n');

const issuesStdout = (phase: string): string =>
  [
    'Remaining issues:',
    '- one outstanding item',
    '=== SCHEGENT AUDIT LOG ===',
    `phase: ${phase}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: ["mock"]',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'open_issues: 1',
    'notes: looping',
    '=== END AUDIT LOG ==='
  ].join('\n');

interface CapturedInvocation {
  readonly phase: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
}

function makeCliRunner(
  loopOnceFor: ReadonlySet<string>
): { runner: ClaudeCliRunner; invocations: CapturedInvocation[] } {
  const counts = new Map<string, number>();
  const invocations: CapturedInvocation[] = [];
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    invocations.push({
      phase: req.phase,
      model: req.model,
      effort: req.effort,
      timeoutMs: req.timeoutMs
    });
    const prev = counts.get(req.phase) ?? 0;
    counts.set(req.phase, prev + 1);
    const shouldLoop = loopOnceFor.has(req.phase) && prev === 0;
    return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(shouldLoop ? issuesStdout(req.phase) : cleanStdout(req.phase)); b.finalize(); return b; })(),
        stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 1
    };
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return { runner, invocations };
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-dynamic-pipelines-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Feature 098 (T080) — the two framing Phases and the Pipeline they belong to,
// declared here instead of read off `BUILT_IN_PHASES` / `BUILT_IN_PIPELINE`.
//
// They keep their ids and their fields, because this file is about a *custom*
// Pipeline: the custom Phase is the subject, and the two around it are the
// control — the assertion that `speckit-specify` runs on `claude-opus-5` with no
// effort and no timeout is what makes the `security-audit` overrides mean
// something rather than being the only values in the run. Substituting fixture
// ids would keep that structure, and the ids are kept only so the diff shows the
// definitions moving rather than the test changing.
const SPECIFY_PHASE: PhaseDef = {
  id: 'speckit-specify',
  name: 'Spec-kit Specify',
  instruction: 'Run /speckit-specify',
  model: 'claude-opus-5',
  runner: 'claude'
};

const FINALIZE_PHASE: PhaseDef = {
  id: 'finalize',
  name: 'Finalize',
  instruction: 'Finalize the feature.',
  model: 'claude-opus-5',
  runner: 'claude'
};

const FRAMING_PHASES: readonly PhaseDef[] = [SPECIFY_PHASE, FINALIZE_PHASE];

const FRAMING_PIPELINE: PipelineDef = {
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: [SPECIFY_PHASE.id, FINALIZE_PHASE.id]
};

describe('Dynamic pipelines end-to-end (T034, US2)', () => {
  it('runs a custom 3-phase pipeline with model/effort/timeout overrides and loop semantics', async () => {
    const securityPhase: PhaseDef = {
      id: 'security-audit',
      name: 'Security Audit',
      instruction: 'Audit the staged diff for security regressions.',
      model: 'claude-opus-4-7',
      effort: 'high',
      timeoutSeconds: 90,
      retryCondition: 'open_issues > 0'
    };
    const securityPipeline: PipelineDef = {
      id: 'security',
      name: 'Security Audit Pipeline',
      // Feature 098 (T025, FR-022) — no trailing `'done'`. No Phase declares
      // that id, so the resolver used to drop the entry silently; it refuses the
      // whole Pipeline now. Every assertion below is unchanged, because the
      // sequence that actually ran never included it.
      phases: ['speckit-specify', 'security-audit', 'finalize']
    };

    const customPhases: readonly PhaseDef[] = [...FRAMING_PHASES, securityPhase];
    const customPipelines: readonly PipelineDef[] = [FRAMING_PIPELINE, securityPipeline];
    const catalog = buildCatalog(customPhases, customPipelines, { claude: [], codex: [], agy: [] }, 'security');

    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
    const { runner, invocations } = makeCliRunner(new Set(['security-audit']));
    const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);

    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      makeLock(),
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 },
      { catalog }
    );

    const feature = await queue.enqueue('Audit auth flow', { pipelineId: 'security' });
    expect(feature.pipelineId).toBe('security');
    await controller.startNew(feature, null);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('completed');
    expect(run.pipeline?.id).toBe('security');
    expect(run.pipeline?.name).toBe('Security Audit Pipeline');

    const phaseSequence = invocations.map((i) => i.phase);
    expect(phaseSequence).toEqual([
      'speckit-specify',
      'security-audit',
      'security-audit',
      'finalize'
    ]);

    const securityCall = invocations.find((i) => i.phase === 'security-audit')!;
    expect(securityCall.model).toBe('claude-opus-4-7');
    expect(securityCall.effort).toBe('high');
    expect(securityCall.timeoutMs).toBe(90_000);

    const specifyCall = invocations.find((i) => i.phase === 'speckit-specify')!;
    expect(specifyCall.model).toBe('claude-opus-5');
    expect(specifyCall.effort).toBeUndefined();

    const log = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    const securityStarts = lines.filter(
      (l) => l.eventType === 'phase-start' && l.payload.phaseId === 'security-audit'
    );
    expect(securityStarts.length).toBeGreaterThan(0);
    for (const entry of securityStarts) {
      expect(entry.payload.pipelineId).toBe('security');
      expect(entry.payload.model).toBe('claude-opus-4-7');
      expect(entry.payload.effort).toBe('high');
      expect(entry.payload.timeoutMs).toBe(90_000);
    }

    const specifyStart = lines.find(
      (l) => l.eventType === 'phase-start' && l.payload.phaseId === 'speckit-specify'
    )!;
    expect(specifyStart.payload.pipelineId).toBe('security');
    expect(specifyStart.payload).toHaveProperty('model', 'claude-opus-5');
    expect(specifyStart.payload).not.toHaveProperty('effort');
    expect(specifyStart.payload).not.toHaveProperty('timeoutMs');
  });

  it('refuses a start when feature.pipelineId is unknown to the catalog (T026, FR-023)', async () => {
    const catalog = buildCatalog(FRAMING_PHASES, [FRAMING_PIPELINE], { claude: [], codex: [], agy: [] }, FRAMING_PIPELINE.id);

    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
    const { runner, invocations } = makeCliRunner(new Set());
    const phaseRunner = new PhaseRunner(runner, new PromptBuilder(), audit, logger);
    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;

    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      makeLock(),
      { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 },
      { catalog }
    );

    const warnings: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
      warnings.push(message);
    });

    const feature = await queue.enqueue('Some feature', { pipelineId: 'nonexistent' });
    await controller.startNew(feature, null);

    // Feature 098 (T026, US3, FR-023) — this used to fall through to
    // `catalog.defaultPipelineId` and run the built-in Pipeline. The Task named a
    // Pipeline; running a different one is not a recovery from that, it is a
    // silent substitution of the process, so the start is refused: no Run record,
    // no CLI invocation, and the id that failed to resolve is named.
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
    expect(invocations).toEqual([]);
    expect(
      warnings.some(
        (message) =>
          message.includes('nonexistent') && message.includes('not in the effective catalog')
      )
    ).toBe(true);
  });
});
