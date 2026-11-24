/**
 * FR-R7-18 (`N05`, `FR-005`, `SC-005`) — Repeatable perf-tier characterization harness for:
 *   1. Actual Stage 2 activation sub-stages (`lock.tryAcquire`, `replayTerminalTransitions` +
 *      `sqliteCutover.activatePrimary`, `replayEvidenceBacklog`, `refreshCatalog`,
 *      `runArchiveMaintenance`, `installRecoveryProducers`) while `SidebarViewProvider.resolveWebviewView`
 *      opens from `PlaceholderProjector` to the first live `STATE_SNAPSHOT`.
 *   2. On-demand whole-file audit chain verification (`verifyAuditChainAt` sync baseline and
 *      `runVerifyAuditChain` command entry point) at the 5 MiB (`5,242,880 B`) rotation boundary
 *      (single 5 MiB file and 4-file / ~20 MiB multi-archive retained chain).
 *
 * Runs strictly in `npm run test:perf` (`vitest.perf.config.ts`, single-threaded) and is
 * excluded from hermetic `npm run test:host`.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { wireBackendExecution } from '../../src/activation/backend-execution-wiring';
import { createRuntimeEvidenceWiring } from '../../src/activation/backend-wiring';
import { nodeDigest, systemClock } from '../../src/activation/catalog-store-wiring';
import { wireEvidence } from '../../src/activation/evidence-wiring';
import { wireLivePicture } from '../../src/activation/live-picture-wiring';
import { wirePhaseExecution } from '../../src/activation/phase-execution-wiring';
import { pauseQueuesAtLifecycleBoundary } from '../../src/activation/queue-lifecycle-boundary';
import { wireScheduledWork } from '../../src/activation/scheduled-work-wiring';
import {
  deriveWorkspaceScopeId,
  disposeCutoverStore,
  getOperationalMementoForStore,
  registerOperationalMementoForStore
} from '../../src/activation/sqlite-cutover-wiring';
import { createStage2Producers } from '../../src/activation/stage2-producers';
import { openWorkspaceSession } from '../../src/activation/workspace-session';
import { resolveWorkspaceSettings } from '../../src/activation/workspace-settings';
import {
  AUDIT_CHAIN_GENESIS,
  AUDIT_DIGEST_ALG,
  digestOf,
  verifyAuditChainAt
} from '../../src/audit/audit-chain';
import type { CheckpointRead } from '../../src/audit/audit-checkpoint';
import { createCatalogStore, createQueueRunProvenance } from '../../src/catalog';
import { runVerifyAuditChain } from '../../src/commands/verify-audit-chain';
import { resolveCliPath } from '../../src/config/cli-path-accessor';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { createCatalogFsAdapter } from '../../src/host-services/catalog-fs-adapter';
import { SanitizedLogger } from '../../src/lib/logger';
import type { FeatureRequest, QueueState } from '../../src/queue/feature-request';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import {
  createSwitchableCatalogFsAdapter,
  SqliteApplicationStore
} from '../../src/services/sqlite-store';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import { unfencedCommit } from '../../src/state/ownership-claim';
import type { TerminalTransitionIntent, WorkflowRun } from '../../src/state/workflow-run';
import { disposeWorkspaceFolderPicker } from '../../src/state/workspace-folder-picker';
import {
  WorkspaceStateStore,
  type Memento,
  type PersistedHistoryEntry
} from '../../src/state/workspace-state';
import type { Notifier } from '../../src/ui/notifications';
import { STATE_SNAPSHOT } from '../../src/ui/sidebar/messages';
import { PlaceholderProjector } from '../../src/ui/sidebar/placeholder-projector';
import { SidebarViewProvider } from '../../src/ui/sidebar/sidebar-view-provider';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { removeTempRoot } from '../temp-root-cleanup';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIVE_MIB = 5 * 1024 * 1024; // 5,242,880 B rotation boundary
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;
const BASE_EPOCH_MS = 1_760_000_000_000;
/** Clarified FR-005 / SC-005 decision-gate ceilings enforced as perf regression guards. */
const STAGE2_LIVE_SNAPSHOT_P95_CEILING_MS = 500;
const AUDIT_CMD_EVENT_LOOP_STALL_P95_CEILING_MS = 50;

interface DistStats {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

interface EventLoopSample {
  readonly eldP50Ms: number;
  readonly eldP95Ms: number;
  readonly eldMaxMs: number;
  readonly eldMeanMs: number;
  readonly immediateTicks: number;
  readonly immediateP50GapMs: number;
  readonly immediateP95GapMs: number;
  readonly immediateMaxGapMs: number;
}

interface Stage2IterationMetrics {
  readonly wiringMs: number;
  readonly lockElectionMs: number;
  readonly operatorAttributionMs: number;
  readonly replayTerminalTransitionsMs: number;
  readonly replayEvidenceBacklogMs: number;
  readonly refreshCatalogMs: number;
  readonly archiveMaintenanceMs: number;
  readonly recoveryReArmMs: number;
  readonly recoveryWatchdogMs: number;
  readonly recoveryResumeMs: number;
  readonly recoveryProducersMs: number;
  readonly producersTotalMs: number;
  readonly sidebarHandoffMs: number;
  readonly stage2TotalToLiveSnapshotMs: number;
  readonly eventLoop: EventLoopSample;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, rank));
  return sortedAsc[idx]!;
}

function statsOf(values: readonly number[]): DistStats {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: round3(sorted[0]!),
    p50: round3(percentile(sorted, 50)),
    p95: round3(percentile(sorted, 95)),
    max: round3(sorted[sorted.length - 1]!),
    mean: round3(sum / sorted.length)
  };
}

function captureHostMetadata() {
  const cpus = os.cpus();
  const [load1m, load5m, load15m] = os.loadavg();
  return {
    dateUtc: new Date().toISOString().slice(0, 10),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCores: cpus.length,
    totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    nodeVersion: process.version,
    loadAvg1m: Number(load1m.toFixed(2)),
    loadAvg5m: Number(load5m.toFixed(2)),
    loadAvg15m: Number(load15m.toFixed(2))
  };
}

/**
 * Measures both `perf_hooks.monitorEventLoopDelay({ resolution: 1 })` and a concurrent
 * `setImmediate` tick-gap monitor across an async or synchronous workload.
 * Performs one final `setImmediate` handoff before stopping so a synchronous stall
 * spanning the entire call is captured by both instruments.
 */
async function withEventLoopProbe<T>(
  work: () => Promise<T>
): Promise<{ readonly result: T; readonly eventLoop: EventLoopSample }> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  const gaps: number[] = [];
  let active = true;
  let lastTick = performance.now();
  let handle: NodeJS.Immediate | undefined;

  const tick = (): void => {
    const now = performance.now();
    gaps.push(now - lastTick);
    lastTick = now;
    if (active) {
      handle = setImmediate(tick);
    }
  };

  histogram.enable();
  // Let libuv enter one timer phase so EventLoopDelayMonitor initializes its baseline clock,
  // then reset and advance into `check` (`setImmediate`) so any synchronous blocking inside
  // `work()` is faithfully captured on the very next `uv_timer` sample.
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  histogram.reset();
  await new Promise<void>((resolve) => setImmediate(resolve));
  lastTick = performance.now();
  handle = setImmediate(tick);

  try {
    const result = await work();
    // Flush one final `setImmediate` so a synchronous call records its single spanning gap,
    // then stop the `setImmediate` probe BEFORE the trailing timer settle so `immediateTicks`
    // reflects ticks strictly during `work()`.
    await new Promise<void>((resolve) => setImmediate(resolve));
    active = false;
    clearImmediate(handle);
    // Let libuv complete its timer phase so `monitorEventLoopDelay` records the stall sample.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    histogram.disable();

    const gapStats = statsOf(gaps);
    return {
      result,
      eventLoop: {
        eldP50Ms: round3(histogram.percentile(50) / 1e6),
        eldP95Ms: round3(histogram.percentile(95) / 1e6),
        eldMaxMs: round3(histogram.max / 1e6),
        eldMeanMs: round3(histogram.mean / 1e6),
        immediateTicks: gaps.length,
        immediateP50GapMs: gapStats.p50,
        immediateP95GapMs: gapStats.p95,
        immediateMaxGapMs: gapStats.max
      }
    };
  } catch (err) {
    active = false;
    clearImmediate(handle);
    histogram.disable();
    throw err;
  }
}

function createMemoryMemento(): Memento & { keys(): readonly string[] } {
  const map = new Map<string, unknown>();
  return {
    keys: () => [...map.keys()],
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
      return Promise.resolve();
    }
  };
}

function makeQueueId(index: number): string {
  if (index === 0) return DEFAULT_QUEUE_ID;
  return `0000${index.toString(16).padStart(4, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function buildSamplePipelineSnapshot(): NonNullable<WorkflowRun['pipeline']> {
  return {
    id: 'wf-n05-sdd',
    name: 'N05 SDD Benchmark Workflow',
    version: 1,
    description: 'Frozen pipeline snapshot for Stage 2 characterization.',
    phases: [
      { id: 'phase-01', name: 'Phase 01', instruction: 'Specify requirements.', loopable: false },
      { id: 'phase-02', name: 'Phase 02', instruction: 'Plan design.', loopable: false },
      { id: 'phase-03', name: 'Phase 03', instruction: 'Implement solution.', loopable: true }
    ]
  };
}

function buildSampleRun(overrides: Partial<WorkflowRun> & { id: string; featureId: string }): WorkflowRun {
  return {
    featureDir: 'specs/332-n05',
    status: 'paused',
    currentPhase: 'phase-02',
    currentIteration: 1,
    startedAt: BASE_EPOCH_MS,
    lastTransitionAt: BASE_EPOCH_MS + 1000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    pipeline: buildSamplePipelineSnapshot(),
    ...overrides
  };
}

interface SyntheticAuditSpec {
  readonly fileName: string;
  readonly minBytes: number;
}

interface SyntheticAuditResult {
  readonly auditDir: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly totalEntries: number;
  readonly perFile: readonly { readonly name: string; readonly bytes: number; readonly entries: number }[];
  readonly tailDigest: string;
  readonly tailPosition: number;
}

async function writeSyntheticAuditChain(
  workspaceRoot: string,
  fileSpecs: readonly SyntheticAuditSpec[]
): Promise<SyntheticAuditResult> {
  const auditDir = path.join(workspaceRoot, '.schegent');
  await fsp.mkdir(auditDir, { recursive: true, mode: 0o700 });

  let prevDigest = AUDIT_CHAIN_GENESIS;
  let globalIndex = 0;
  let totalBytes = 0;
  const perFile: { name: string; bytes: number; entries: number }[] = [];

  for (const spec of fileSpecs) {
    const chunks: string[] = [];
    let fileBytes = 0;
    let fileEntries = 0;

    while (fileBytes < spec.minBytes) {
      globalIndex += 1;
      fileEntries += 1;
      const line = JSON.stringify({
        schemaVersion: 3,
        id: `evt-${String(globalIndex).padStart(7, '0')}`,
        timestamp: new Date(BASE_EPOCH_MS + globalIndex * 250).toISOString(),
        runId: `run-${String(Math.floor(globalIndex / 20)).padStart(4, '0')}`,
        phase: 'speckit-implement',
        iteration: (globalIndex % 3) + 1,
        eventType: 'cli-invocation',
        outcome: 'info',
        actor: 'op-n05-benchmark',
        payload: {
          runnerKind: 'claude',
          step: globalIndex,
          detail: 'representative-audit-event-payload-for-5mib-rotation-boundary-characterization'
        },
        prevDigest,
        digestAlg: AUDIT_DIGEST_ALG
      });
      prevDigest = digestOf(line);
      const withNl = `${line}\n`;
      chunks.push(withNl);
      fileBytes += Buffer.byteLength(withNl, 'utf8');
    }

    const filePath = path.join(auditDir, spec.fileName);
    await fsp.writeFile(filePath, chunks.join(''), { encoding: 'utf8', mode: 0o600 });
    totalBytes += fileBytes;
    perFile.push({ name: spec.fileName, bytes: fileBytes, entries: fileEntries });
  }

  return {
    auditDir,
    fileCount: perFile.length,
    totalBytes,
    totalEntries: globalIndex,
    perFile,
    tailDigest: prevDigest,
    tailPosition: globalIndex
  };
}

interface SeededStage2Workspace {
  readonly tempRoot: string;
  readonly workspaceRoot: string;
  readonly globalStorageRoot: string;
  readonly datasetSummary: {
    readonly queues: number;
    readonly tasksTotal: number;
    readonly historyEntries: number;
    readonly terminalIntents: number;
    readonly catalogPhases: number;
    readonly catalogPipelines: number;
    readonly catalogWorkflows: number;
    readonly sessionRunDirs: number;
    readonly sessionFiles: number;
    readonly sessionBytes: number;
    readonly auditFiles: number;
    readonly auditEntries: number;
    readonly auditBytes: number;
  };
}

async function seedPopulatedStage2Workspace(label: string): Promise<SeededStage2Workspace> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `schegent-n05-stage2-${label}-`));
  const workspaceRoot = await fsp.realpath(
    await fsp.mkdir(path.join(tempRoot, 'workspace'), { recursive: true }).then(() => path.join(tempRoot, 'workspace'))
  );
  const globalStorageRoot = await fsp.realpath(
    await fsp.mkdir(path.join(tempRoot, 'globalStorage'), { recursive: true, mode: 0o700 }).then(() => path.join(tempRoot, 'globalStorage'))
  );

  // 1. Populate real on-disk schema-9 SQLite operational store + catalog store
  const scopeId = deriveWorkspaceScopeId(workspaceRoot);
  const seedSqlite = await SqliteApplicationStore.openAtTrustedLocation({
    trustedRootDir: globalStorageRoot,
    relativeSegments: ['sqlite', scopeId],
    databaseFileName: 'schegent-state.db',
    sourceKind: 'host_global_storage_uri'
  });

  const seedLogger = new SanitizedLogger();
  const seedLegacyMemento = createMemoryMemento();
  const seedOpMemento = createSwitchableOperationalMemento(seedLegacyMemento, seedLogger, {
    requireDurableBatch: true
  });
  seedOpMemento.attachSqlite(seedSqlite, scopeId);
  const seedStore = new WorkspaceStateStore(seedOpMemento, seedLogger);
  await seedStore.initialize();

  const queueCount = 5;
  const tasksPerQueue = 20;
  const historyPerQueue = 50;
  const now = Date.now();
  const futureScheduleAt = now + 10 * 60 * 1000;
  const futureRetryAt = now + 10 * 60 * 1000;

  const queueIds = Array.from({ length: queueCount }, (_, i) => makeQueueId(i));
  await seedStore.setQueueRegistry({
    entries: queueIds.map((id, i) => ({
      id,
      name: i === 0 ? 'Default Queue' : `Queue ${i}`,
      position: i,
      schedule: null,
      createdAt: BASE_EPOCH_MS,
      updatedAt: BASE_EPOCH_MS
    })),
    updatedAt: BASE_EPOCH_MS
  });

  for (let q = 0; q < queueCount; q += 1) {
    const qId = queueIds[q]!;
    const requests: FeatureRequest[] = [];
    for (let t = 0; t < tasksPerQueue; t += 1) {
      const taskId = `q${q}-task-${String(t).padStart(3, '0')}`;
      const isReplayedInFlight = q === 0 && t === 0;
      const isDelayedRetryInFlight = q === 1 && t === 0;
      const isCreditPausedInFlight = q === 3 && t === 0;
      const isInFlight = isReplayedInFlight || isDelayedRetryInFlight || isCreditPausedInFlight;
      const isCompleted = !isInFlight && t < 10;
      requests.push({
        id: taskId,
        description: `Populated workspace task ${t} on queue ${q} for Stage 2 startup characterization.`,
        enqueuedAt: BASE_EPOCH_MS + t * 100,
        createdAt: BASE_EPOCH_MS + t * 100,
        startedAt: isInFlight || isCompleted ? BASE_EPOCH_MS + t * 100 + 50 : null,
        updatedAt: BASE_EPOCH_MS + t * 100 + 80,
        completedAt: isCompleted ? BASE_EPOCH_MS + t * 100 + 500 : null,
        status: isInFlight ? 'in-flight' : isCompleted ? 'completed' : 'pending',
        queueId: qId,
        position: t,
        runId: isInFlight || isCompleted ? `run-${taskId}` : null
      } as FeatureRequest);
    }

    const queueState: QueueState = {
      paused: false,
      pausedReason: null,
      inFlightId: q === 0 || q === 1 || q === 3 ? `q${q}-task-000` : null,
      updatedAt: BASE_EPOCH_MS,
      queueLifecycle: q === 2 ? 'idle-pending' : 'active-empty',
      pauseSource: null,
      scheduledStartAt: q === 2 ? futureScheduleAt : null,
      scheduledStartSource: q === 2 ? 'operator-chooser' : null,
      requests
    };
    await seedStore.setQueue(queueState, qId);

    for (let h = 0; h < historyPerQueue; h += 1) {
      const ts = BASE_EPOCH_MS + (q * historyPerQueue + h) * 1000;
      await seedStore.appendHistory(qId, {
        runId: `hist-run-${q}-${h}`,
        featureId: `hist-feat-${q}-${h}`,
        descriptionPreview: `Completed workflow history entry #${h} on queue ${q}.`,
        terminalStatus: 'completed',
        startedAt: new Date(ts).toISOString(),
        completedAt: new Date(ts + 450).toISOString(),
        durationMs: 450,
        lastErrorSummary: null,
        auditLogPointer: `runId:hist-run-${q}-${h}`
      } as PersistedHistoryEntry);
    }
  }

  // Persisted runs + 1 journalled terminal transition intent on Queue 0
  const replayRun = buildSampleRun({
    id: 'run-q0-task-000',
    featureId: 'q0-task-000',
    status: 'completed',
    phasesCompleted: [],
    lastTransitionAt: BASE_EPOCH_MS + 5_000
  });
  const intent: TerminalTransitionIntent = {
    schemaVersion: 1,
    run: replayRun,
    description: 'Replayed terminal transition on Stage 2 startup',
    createdAt: BASE_EPOCH_MS + 5_000
  };
  await seedStore.setTerminalTransitionIntent(replayRun.id, intent);

  const delayedRetryRun = buildSampleRun({
    id: 'run-q1-task-000',
    featureId: 'q1-task-000',
    status: 'paused',
    pendingRetryAt: futureRetryAt,
    pendingRetryCause: 'rate_limit',
    delayedRetryCount: 1
  });
  await seedStore.setRun(queueIds[1]!, delayedRetryRun, unfencedCommit('test-fixture'));

  const creditPausedRun = buildSampleRun({
    id: 'run-q3-task-000',
    featureId: 'q3-task-000',
    status: 'paused',
    manualPauseAt: null,
    manualPauseCause: null,
    lastError: null
  });
  await seedStore.setRun(queueIds[3]!, creditPausedRun, unfencedCommit('test-fixture'));

  // Seed SQLite-backed catalog definitions (12 Phases, 4 Pipelines, 2 Workflows)
  const catalogPhases = 12;
  const catalogPipelines = 4;
  const catalogWorkflows = 2;
  const switchableCatalogFs = createSwitchableCatalogFsAdapter(
    createCatalogFsAdapter(null, seedLogger),
    () => true
  );
  await switchableCatalogFs.attachSqlite(seedSqlite, scopeId);
  const seedCatalogStore = createCatalogStore({
    fs: switchableCatalogFs,
    clock: systemClock,
    digest: nodeDigest,
    provenance: createQueueRunProvenance(() => [])
  });
  const initialRead = await seedCatalogStore.read();
  expect(initialRead.outcome).toBe('read');
  const initialRevs = initialRead.outcome === 'read' ? initialRead.snapshot.revisions : { phase: '', pipeline: '', workflow: '' };

  const phaseDefs = Array.from({ length: catalogPhases }, (_, i) => {
    const id = `n05-phase-${String(i + 1).padStart(2, '0')}`;
    return {
      id,
      body: {
        id,
        name: `N05 Phase ${i + 1}`,
        instruction: `Execute step ${i + 1} for realistic Stage 2 catalog refresh measurement.`,
        loopable: i % 3 === 0
      }
    };
  });
  const phaseDraft = await seedCatalogStore.saveDraftLayer({
    kind: 'phase',
    expectedRevision: initialRevs.phase,
    definitions: phaseDefs
  });
  expect(phaseDraft.outcome).toBe('saved');
  const phasePub = await seedCatalogStore.publishLayer({
    kind: 'phase',
    expectedRevision: phaseDraft.outcome === 'saved' ? phaseDraft.revision : '',
    ids: phaseDefs.map((d) => d.id)
  });
  expect(phasePub.outcome).toBe('published');

  const pipelineDefs = Array.from({ length: catalogPipelines }, (_, p) => {
    const id = `n05-pipeline-${String(p + 1).padStart(2, '0')}`;
    return {
      id,
      body: {
        id,
        name: `N05 Pipeline ${p + 1}`,
        phases: [
          phaseDefs[(p * 3) % catalogPhases]!.id,
          phaseDefs[(p * 3 + 1) % catalogPhases]!.id,
          phaseDefs[(p * 3 + 2) % catalogPhases]!.id
        ]
      }
    };
  });
  const pipeDraft = await seedCatalogStore.saveDraftLayer({
    kind: 'pipeline',
    expectedRevision: initialRevs.pipeline,
    definitions: pipelineDefs
  });
  expect(pipeDraft.outcome).toBe('saved');
  const pipePub = await seedCatalogStore.publishLayer({
    kind: 'pipeline',
    expectedRevision: pipeDraft.outcome === 'saved' ? pipeDraft.revision : '',
    ids: pipelineDefs.map((d) => d.id)
  });
  expect(pipePub.outcome).toBe('published');

  const workflowDefs = Array.from({ length: catalogWorkflows }, (_, w) => {
    const id = `n05-workflow-${String(w + 1).padStart(2, '0')}`;
    return {
      id,
      body: {
        id,
        name: `N05 Workflow ${w + 1}`,
        nodes: [
          { id: 'n1', pipelineId: pipelineDefs[w * 2]!.id },
          { id: 'n2', pipelineId: pipelineDefs[w * 2 + 1]!.id }
        ],
        connections: [{ from: 'n1', to: 'n2', when: 'completed' }]
      }
    };
  });
  const wfDraft = await seedCatalogStore.saveDraftLayer({
    kind: 'workflow',
    expectedRevision: initialRevs.workflow,
    definitions: workflowDefs
  });
  expect(wfDraft.outcome).toBe('saved');
  const wfPub = await seedCatalogStore.publishLayer({
    kind: 'workflow',
    expectedRevision: wfDraft.outcome === 'saved' ? wfDraft.revision : '',
    ids: workflowDefs.map((d) => d.id)
  });
  expect(wfPub.outcome).toBe('published');

  switchableCatalogFs.detachSqlite();
  seedOpMemento.detachSqlite();
  seedSqlite.close();

  // 2. Populate `.schegent/sessions/` (20 run dirs x 3 files x 16 KiB = 960 KiB)
  const sessionRunDirs = 20;
  const filesPerRunDir = 3;
  const sessionFileBytes = 16 * 1024;
  const sessionBody = Buffer.alloc(sessionFileBytes, 's');
  const sessionsRoot = path.join(workspaceRoot, '.schegent', 'sessions');
  for (let r = 0; r < sessionRunDirs; r += 1) {
    const dir = path.join(sessionsRoot, `session-run-${String(r).padStart(3, '0')}`);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    for (let f = 0; f < filesPerRunDir; f += 1) {
      await fsp.writeFile(path.join(dir, `transcript-${f}.jsonl`), sessionBody, { mode: 0o600 });
    }
  }

  // 3. Populate `.schegent/audit.log` + 3 rotated archives (~60 KiB across 4 files)
  const auditSeed = await writeSyntheticAuditChain(workspaceRoot, [
    { fileName: 'audit.log.20261121-100000', minBytes: 15 * 1024 },
    { fileName: 'audit.log.20261122-100000', minBytes: 15 * 1024 },
    { fileName: 'audit.log.20261123-100000', minBytes: 15 * 1024 },
    { fileName: 'audit.log', minBytes: 15 * 1024 }
  ]);

  return {
    tempRoot,
    workspaceRoot,
    globalStorageRoot,
    datasetSummary: {
      queues: queueCount,
      tasksTotal: queueCount * tasksPerQueue,
      historyEntries: queueCount * historyPerQueue,
      terminalIntents: 1,
      catalogPhases,
      catalogPipelines,
      catalogWorkflows,
      sessionRunDirs,
      sessionFiles: sessionRunDirs * filesPerRunDir,
      sessionBytes: sessionRunDirs * filesPerRunDir * sessionFileBytes,
      auditFiles: auditSeed.fileCount,
      auditEntries: auditSeed.totalEntries,
      auditBytes: auditSeed.totalBytes
    }
  };
}

class RecordingSidebarView {
  public visible = true;
  public readonly posts: { readonly type: string; readonly payload: unknown; readonly postedAt: number }[] = [];
  private readonly onLiveSnapshotWaiters: Array<(snapshot: WorkflowSnapshot, postedAt: number) => void> = [];

  public readonly webview = {
    cspSource: 'vscode-webview://n05-stage2-fixture',
    html: '',
    options: {} as unknown,
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => uri.fsPath }),
    postMessage: (message: { type: string; payload?: unknown }): Promise<boolean> => {
      const postedAt = performance.now();
      this.posts.push({ type: message.type, payload: message.payload, postedAt });
      if (message.type === STATE_SNAPSHOT && message.payload !== undefined) {
        const snap = message.payload as WorkflowSnapshot;
        if (snap.queues.length > 0) {
          for (const resolve of this.onLiveSnapshotWaiters.splice(0)) {
            resolve(snap, postedAt);
          }
        }
      }
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (_listener: (raw: unknown) => void) => ({ dispose: () => undefined })
  };

  public onDidChangeVisibility(_listener: () => void) {
    return { dispose: () => undefined };
  }

  public onDidDispose(_listener: () => void) {
    return { dispose: () => undefined };
  }

  public waitForLiveSnapshot(): Promise<{ readonly snapshot: WorkflowSnapshot; readonly postedAt: number }> {
    const existing = this.posts.find(
      (p) => p.type === STATE_SNAPSHOT && (p.payload as WorkflowSnapshot | undefined)?.queues.length
    );
    if (existing !== undefined) {
      return Promise.resolve({ snapshot: existing.payload as WorkflowSnapshot, postedAt: existing.postedAt });
    }
    return new Promise((resolve) => {
      this.onLiveSnapshotWaiters.push((snapshot, postedAt) => resolve({ snapshot, postedAt }));
    });
  }
}

async function runStage2ActivationIteration(
  seeded: SeededStage2Workspace,
  iterationIndex: number
): Promise<Stage2IterationMetrics> {
  const { workspaceRoot, globalStorageRoot } = seeded;
  const hostSubscriptions: vscode.Disposable[] = [];
  const disposables: vscode.Disposable[] = [];
  const logger = new SanitizedLogger();
  const ownerId = `schegent-n05-${process.pid}-${iterationIndex}`;

  // Point vscode workspace stub at this iteration's workspace folder
  disposeWorkspaceFolderPicker();
  (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(workspaceRoot), name: `n05-ws-${iterationIndex}`, index: 0 }
  ];

  const workspaceStateMemento = createMemoryMemento();
  const globalStateMemento = createMemoryMemento();
  const fakeContext = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(globalStorageRoot),
    storageUri: undefined,
    workspaceState: workspaceStateMemento,
    globalState: globalStateMemento,
    subscriptions: hostSubscriptions
  } as unknown as vscode.ExtensionContext;

  // Stage 1: Sidebar opens immediately with PlaceholderProjector (before Stage 2 starts)
  const { runtimeLogSink, evidenceHealth, webviewLogSink } = createRuntimeEvidenceWiring(
    fakeContext,
    logger
  );
  const placeholder = new PlaceholderProjector({ reason: 'no-workspace' });
  const sidebarProvider = new SidebarViewProvider({
    extensionRoot: REPO_ROOT,
    projector: placeholder,
    logger
  });
  const fakeView = new RecordingSidebarView();
  await sidebarProvider.resolveWebviewView(
    fakeView as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }
  );
  // Confirm Stage 1 placeholder snapshot landed before Stage 2 runs
  expect(fakeView.posts.length).toBeGreaterThanOrEqual(1);
  expect((fakeView.posts[0]!.payload as WorkflowSnapshot).queues).toHaveLength(0);

  const operationalMemento = createSwitchableOperationalMemento(workspaceStateMemento, logger, {
    requireDurableBatch: true
  });
  const store = new WorkspaceStateStore(operationalMemento, logger);
  registerOperationalMementoForStore(store, operationalMemento);

  let cleanupRef: (() => Promise<void>) | undefined;

  try {
    const { result, eventLoop } = await withEventLoopProbe(async () => {
      const stage2Start = performance.now();

      // --- Stage 2 pre-producer wiring (mirrors `wireStage2` in `src/extension.ts`) ---
      evidenceHealth.reset();
      const migrationEvents = await store.initialize();
      const settings = resolveWorkspaceSettings({ workspaceRoot, logger });

      const historyBox: { store?: ReturnType<typeof wireBackendExecution>['historyStore'] } = {};
      const session = await openWorkspaceSession({
        workspaceRoot,
        ownerId,
        logger,
        store,
        disposables,
        processEnvironmentPolicy: settings.processEnvironmentPolicy,
        getHistoryStore: () => historyBox.store!
      });

      const evidence = await wireEvidence({
        workspaceRoot,
        lock: session.lock,
        globalStorageRoot,
        logger,
        store,
        queue: session.queue,
        notifier: session.notifier,
        evidenceHealth,
        catalogSession: session.catalogSession,
        rotationSizeMB: settings.rotationSizeMB,
        rotationMaxAgeDays: settings.rotationMaxAgeDays,
        completedResetGeneration: null,
        ...migrationEvents
      });

      const backend = wireBackendExecution({
        workspaceRoot,
        cliPath: settings.cliPath,
        logger,
        store,
        auditWriter: evidence.auditWriter,
        disposables,
        hostSubscriptions,
        evidenceHealth,
        processEnvironmentPolicy: settings.processEnvironmentPolicy,
        memento: getOperationalMementoForStore(store) ?? workspaceStateMemento,
        isWorkspaceTrusted: () => vscode.workspace.isTrusted,
        hasPrimacy: () => session.lock.hasPrimacy(),
        onFenceLost: (listener) => session.lock.onFenceLost(listener)
      });
      historyBox.store = backend.historyStore;

      const { phaseRunner, runSafety } = await wirePhaseExecution({
        context: fakeContext,
        workspaceRoot,
        logger,
        store,
        queue: session.queue,
        notifier: session.notifier,
        auditWriter: evidence.auditWriter,
        historyStore: backend.historyStore,
        rawTranscript: backend.rawTranscript,
        promptBuilder: backend.promptBuilder,
        runnerRegistry: backend.runnerRegistry,
        evidenceHealth,
        sessionRetention: evidence.sessionRetention,
        protectedSessionRunIds: evidence.protectedSessionRunIds,
        backend
      });

      const { recordContainmentAcceptance, ...runSafetyRest } = runSafety;
      const controller = new SchegentWorkflowController(
        phaseRunner,
        store,
        session.queue,
        session.statusBar,
        session.notifier,
        logger,
        session.lock,
        {
          cliPath: settings.cliPath,
          cwd: workspaceRoot,
          iterationCap: settings.iterationCap,
          timeoutMs: settings.timeoutSeconds * 1000,
          maxDurationMs: settings.maxDurationSeconds * 1000,
          inheritProcessEnv: settings.processEnvironmentPolicy.inheritProcessEnv,
          ...(settings.processEnvironmentPolicy.processEnvAllowlist !== undefined
            ? { processEnvAllowlist: settings.processEnvironmentPolicy.processEnvAllowlist }
            : {}),
          defaultRunnerKind: backend.backendKind,
          requireProbe: true,
          isAuditEvidenceAvailable: () => evidenceHealth.getSnapshot().audit.status !== 'unavailable',
          getForceContinueOnRetryCap: () => false,
          getMaxUnchangedComparisons: () => 3,
          cliPathResolver: (runnerKind) => resolveCliPath(runnerKind, workspaceRoot, settings.cliPath)
        },
        {
          monitor: backend.monitor,
          historyStore: backend.historyStore,
          catalog: session.catalogSession.catalog,
          auditWriter: evidence.auditWriter,
          backendCapabilities: backend.backendCapabilities,
          executionLease: session.executionLeases,
          startFailures: session.queueStartFailures,
          getQueueFailurePolicyDefault: () => 'halt-on-failure',
          ...runSafetyRest,
          ...(recordContainmentAcceptance !== undefined ? { recordContainmentAcceptance } : {}),
          getRetryCap: () => 2,
          getRawTranscriptMode: () => 'always'
        }
      );
      backend.bindLivenessRecorder(controller);

      const guardedRunService = new GuardedRunService({
        isWorkspaceTrusted: () => vscode.workspace.isTrusted,
        lock: session.lock,
        queue: session.queue,
        controller,
        logger,
        audit: evidence.auditWriter,
        store
      });
      runSafety.bindGuardedRun(guardedRunService, backend.backendKind);

      const scheduled = wireScheduledWork({
        workspaceRoot,
        cliPath: settings.cliPath,
        logger,
        store,
        queue: session.queue,
        controller,
        auditWriter: evidence.auditWriter,
        notifier: session.notifier,
        statusBar: session.statusBar,
        lock: session.lock,
        guardedRunService,
        runnerRegistry: backend.runnerRegistry,
        catalogSession: session.catalogSession,
        backendKind: backend.backendKind,
        pollIntervalMinutes: settings.pollIntervalMinutes,
        processEnvironmentPolicy: settings.processEnvironmentPolicy
      });

      const livePicture = wireLivePicture({
        context: fakeContext,
        workspaceRoot,
        ownerId,
        logger,
        isWorkspaceTrusted: () => vscode.workspace.isTrusted,
        store,
        queue: session.queue,
        controller,
        historyStore: backend.historyStore,
        auditWriter: evidence.auditWriter,
        statusBar: session.statusBar,
        monitor: backend.monitor,
        watchdog: scheduled.watchdog,
        catalogSession: session.catalogSession,
        evidenceHealth,
        sessionRetention: evidence.sessionRetention,
        webviewLogSink,
        disposables,
        backendKind: backend.backendKind,
        backendCapabilities: backend.backendCapabilities,
        backendPing: backend.backendPing,
        backendQualification: backend.backendQualification,
        protectedSessionRunIds: evidence.protectedSessionRunIds,
        queueStartFailures: session.queueStartFailures,
        collectAllWorkflowPipelineRefs: evidence.collectAllWorkflowPipelineRefs,
        effectiveLimitSources: { limits: settings.limits, spendTrust: runSafety.spendWatcher.trustFor },
        bindCapabilityProjector: backend.bindCapabilityProjector,
        bindTelemetryProjector: backend.bindTelemetryProjector,
        transportUsage: () => backend.transportRouter.usage()
      });

      const wiringMs = performance.now() - stage2Start;

      cleanupRef = async () => {
        controller.closeAutoDrain();
        livePicture.projector.dispose();
        scheduled.watchdog.dispose();
        scheduled.queueScheduleWatchdog.dispose();
        scheduled.scheduledStartCoordinator.dispose();
        session.statusBar.dispose();
        for (const d of disposables.splice(0)) d.dispose();
        await backend.teardown();
        await session.executionLeases.releaseAll();
        await session.lock.release();
      };

      // --- Stage 2 producers (real `createStage2Producers` with pass-through sub-stage timers) ---
      let lockElectionMs = 0;
      let operatorAttributionMs = 0;
      let replayTerminalTransitionsMs = 0;
      let replayEvidenceBacklogMs = 0;
      let refreshCatalogMs = 0;
      let archiveMaintenanceMs = 0;
      let recoveryReArmMs = 0;
      let recoveryWatchdogMs = 0;
      let recoveryResumeMs = 0;
      let acquiredPrimacy = false;

      const timedLock = Object.create(session.lock) as typeof session.lock;
      timedLock.tryAcquire = async () => {
        const t0 = performance.now();
        const res = await session.lock.tryAcquire();
        lockElectionMs = performance.now() - t0;
        acquiredPrimacy = res.acquired;
        return res;
      };

      const pauseQueues = () =>
        pauseQueuesAtLifecycleBoundary({
          store,
          queue: session.queue,
          lock: session.lock,
          scheduledStartCoordinator: scheduled.scheduledStartCoordinator,
          logger
        });

      const producers = createStage2Producers({
        isWorkspaceTrusted: () => vscode.workspace.isTrusted,
        logger,
        store,
        auditWriter: {
          append: (entry) => evidence.auditWriter.append(entry),
          runArchiveMaintenance: async () => {
            const t0 = performance.now();
            const res = await evidence.auditWriter.runArchiveMaintenance();
            archiveMaintenanceMs = performance.now() - t0;
            return res;
          }
        } as typeof evidence.auditWriter,
        lock: timedLock,
        controller: {
          resumeExistingFromActivation: async () => {
            const t0 = performance.now();
            await controller.resumeExistingFromActivation();
            recoveryResumeMs = performance.now() - t0;
          },
          admitResume: (qId) => controller.admitResume(qId),
          scheduleAutoDrain: () => controller.scheduleAutoDrain()
        },
        watchdog: {
          reattachOnActivation: async () => {
            const t0 = performance.now();
            await scheduled.watchdog.reattachOnActivation();
            recoveryWatchdogMs = performance.now() - t0;
          },
          cancelPendingTimer: () => scheduled.watchdog.cancelPendingTimer()
        },
        scheduledStartCoordinator: {
          reArm: async () => {
            const t0 = performance.now();
            await scheduled.scheduledStartCoordinator.reArm();
            recoveryReArmMs = performance.now() - t0;
          }
        },
        replayEvidenceBacklog: async () => {
          const t0 = performance.now();
          await evidence.replayEvidenceBacklog();
          replayEvidenceBacklogMs = performance.now() - t0;
        },
        runSafety: {
          replayTerminalTransitions: async (selfOwnerId, beforeComposableRecovery) => {
            const t0 = performance.now();
            await runSafety.replayTerminalTransitions(selfOwnerId, beforeComposableRecovery);
            replayTerminalTransitionsMs = performance.now() - t0;
          },
          sweepCheckpointRetention: () => runSafety.sweepCheckpointRetention(),
          reconcileComposableWorkflowRuns: () => runSafety.reconcileComposableWorkflowRuns()
        },
        // Fire-and-forget external CLI probe (`<cli> --help`): never awaited by Stage 2,
        // stubbed to avoid external binary variance across developer machines.
        backendCapabilities: { scan: () => Promise.resolve(undefined) },
        startMountProbe: session.startMountProbe,
        refreshCatalog: async () => {
          const t0 = performance.now();
          await livePicture.refreshCatalog();
          refreshCatalogMs = performance.now() - t0;
        },
        operatorAttribution: {
          ensureStored: async () => {
            const t0 = performance.now();
            const res = await evidence.operatorAttribution.ensureStored();
            operatorAttributionMs = performance.now() - t0;
            return res;
          }
        },
        pauseQueuesOnStartup: pauseQueues
      });

      const producersStart = performance.now();
      await producers.run();
      const producersTotalMs = performance.now() - producersStart;

      // --- Sidebar handoff from PlaceholderProjector to live StateProjector (`extension.ts:154`) ---
      const handoffStart = performance.now();
      const liveSnapshotPromise = fakeView.waitForLiveSnapshot();
      sidebarProvider.setProjector(livePicture.projector);
      const { snapshot: liveSnapshot, postedAt } = await liveSnapshotPromise;
      const sidebarHandoffMs = postedAt - handoffStart;
      const stage2TotalToLiveSnapshotMs = postedAt - stage2Start;

      // Non-vacuity checks confirming real production work ran on the seeded workspace
      expect(acquiredPrimacy).toBe(true);
      expect(Object.keys(store.getTerminalTransitionIntents())).toHaveLength(0);
      expect(session.catalogSession.catalog.phases.length).toBeGreaterThanOrEqual(12);
      expect(liveSnapshot.queues.length).toBe(seeded.datasetSummary.queues);
      expect(liveSnapshot.history.length).toBeGreaterThanOrEqual(seeded.datasetSummary.historyEntries);

      const recoveryProducersMs = recoveryReArmMs + recoveryWatchdogMs + recoveryResumeMs;
      return {
        wiringMs,
        lockElectionMs,
        operatorAttributionMs,
        replayTerminalTransitionsMs,
        replayEvidenceBacklogMs,
        refreshCatalogMs,
        archiveMaintenanceMs,
        recoveryReArmMs,
        recoveryWatchdogMs,
        recoveryResumeMs,
        recoveryProducersMs,
        producersTotalMs,
        sidebarHandoffMs,
        stage2TotalToLiveSnapshotMs
      };
    });

    return { ...result, eventLoop };
  } finally {
    sidebarProvider.dispose();
    placeholder.dispose();
    if (cleanupRef !== undefined) await cleanupRef();
    for (const sub of hostSubscriptions.splice(0)) sub.dispose();
    await runtimeLogSink.flushAndDispose();
    disposeCutoverStore(store);
    disposeWorkspaceFolderPicker();
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  }
}

describe('FR-R7-18 (N05) — Stage 2 activation & 5 MiB audit verification characterization', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await removeTempRoot(root);
    }
  });

  it(
    'measures actual Stage 2 activation sub-stages while SidebarViewProvider opens to live snapshot',
    { timeout: 120_000 },
    async () => {
      const host = captureHostMetadata();
      const totalIterations = WARMUP_RUNS + MEASURED_RUNS;
      const measured: Stage2IterationMetrics[] = [];
      let datasetSummary: SeededStage2Workspace['datasetSummary'] | null = null;

      for (let i = 0; i < totalIterations; i += 1) {
        const seeded = await seedPopulatedStage2Workspace(`iter-${i}`);
        tempRoots.push(seeded.tempRoot);
        datasetSummary ??= seeded.datasetSummary;
        try {
          const sample = await runStage2ActivationIteration(seeded, i);
          if (i >= WARMUP_RUNS) {
            measured.push(sample);
          }
        } finally {
          await removeTempRoot(seeded.tempRoot);
          const idx = tempRoots.indexOf(seeded.tempRoot);
          if (idx >= 0) tempRoots.splice(idx, 1);
        }
      }

      const summary = {
        suite: 'stage2-activation-sidebar-open',
        host,
        warmupRuns: WARMUP_RUNS,
        measuredRuns: MEASURED_RUNS,
        dataset: datasetSummary,
        metricsMs: {
          wiring: statsOf(measured.map((m) => m.wiringMs)),
          lockElection: statsOf(measured.map((m) => m.lockElectionMs)),
          operatorAttribution: statsOf(measured.map((m) => m.operatorAttributionMs)),
          replayTerminalTransitions: statsOf(measured.map((m) => m.replayTerminalTransitionsMs)),
          replayEvidenceBacklog: statsOf(measured.map((m) => m.replayEvidenceBacklogMs)),
          refreshCatalog: statsOf(measured.map((m) => m.refreshCatalogMs)),
          archiveMaintenance: statsOf(measured.map((m) => m.archiveMaintenanceMs)),
          recoveryReArm: statsOf(measured.map((m) => m.recoveryReArmMs)),
          recoveryWatchdog: statsOf(measured.map((m) => m.recoveryWatchdogMs)),
          recoveryResume: statsOf(measured.map((m) => m.recoveryResumeMs)),
          recoveryProducersTotal: statsOf(measured.map((m) => m.recoveryProducersMs)),
          producersTotal: statsOf(measured.map((m) => m.producersTotalMs)),
          sidebarHandoff: statsOf(measured.map((m) => m.sidebarHandoffMs)),
          stage2TotalToLiveSnapshot: statsOf(measured.map((m) => m.stage2TotalToLiveSnapshotMs)),
          eventLoopDelayP50: statsOf(measured.map((m) => m.eventLoop.eldP50Ms)),
          eventLoopDelayP95: statsOf(measured.map((m) => m.eventLoop.eldP95Ms)),
          eventLoopDelayMax: statsOf(measured.map((m) => m.eventLoop.eldMaxMs)),
          immediateMaxGap: statsOf(measured.map((m) => m.eventLoop.immediateMaxGapMs))
        }
      };

      if (process.env.SCHEGENT_PRINT_N05_REPORT === '1') {
        console.log(`N05_STAGE2_REPORT ${JSON.stringify(summary, null, 2)}`);
      }

      expect(measured).toHaveLength(MEASURED_RUNS);
      expect(summary.metricsMs.stage2TotalToLiveSnapshot.p50).toBeGreaterThan(0);
      expect(
        summary.metricsMs.stage2TotalToLiveSnapshot.p95,
        `Stage 2 time-to-live-snapshot p95 (${summary.metricsMs.stage2TotalToLiveSnapshot.p95} ms) ` +
          `exceeded the ${STAGE2_LIVE_SNAPSHOT_P95_CEILING_MS} ms N05 threshold`
      ).toBeLessThanOrEqual(STAGE2_LIVE_SNAPSHOT_P95_CEILING_MS);
    }
  );

  it(
    'measures on-demand whole-file audit chain verification at the 5 MiB rotation boundary (single file + multi-archive)',
    { timeout: 120_000 },
    async () => {
      const host = captureHostMetadata();
      const workloads = [
        {
          id: 'single-5mib-live',
          specs: [{ fileName: 'audit.log', minBytes: FIVE_MIB }]
        },
        {
          id: 'multi-archive-20mib-4files',
          specs: [
            { fileName: 'audit.log.20261121-100000', minBytes: FIVE_MIB },
            { fileName: 'audit.log.20261122-100000', minBytes: FIVE_MIB },
            { fileName: 'audit.log.20261123-100000', minBytes: FIVE_MIB },
            { fileName: 'audit.log', minBytes: FIVE_MIB }
          ]
        }
      ] as const;

      const reportWorkloads: unknown[] = [];

      for (const workload of workloads) {
        const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `schegent-n05-audit-${workload.id}-`));
        tempRoots.push(tempRoot);
        const chain = await writeSyntheticAuditChain(tempRoot, workload.specs);
        const activeCheckpoint: CheckpointRead = {
          status: 'active',
          checkpoint: {
            version: 1,
            workspaceKey: 'a'.repeat(64),
            state: 'active',
            origin: 'new',
            headDigest: chain.tailDigest,
            position: chain.tailPosition,
            establishedAtMs: BASE_EPOCH_MS,
            updatedAtMs: BASE_EPOCH_MS + 1_000
          }
        };

        const syncWallMs: number[] = [];
        const syncEldP50: number[] = [];
        const syncEldP95: number[] = [];
        const syncEldMax: number[] = [];
        const syncGapMax: number[] = [];
        const syncTicks: number[] = [];

        const cmdWallMs: number[] = [];
        const cmdEldP50: number[] = [];
        const cmdEldP95: number[] = [];
        const cmdEldMax: number[] = [];
        const cmdGapMax: number[] = [];
        const cmdTicks: number[] = [];

        const totalIterations = WARMUP_RUNS + MEASURED_RUNS;
        for (let i = 0; i < totalIterations; i += 1) {
          // 1. Direct synchronous `verifyAuditChainAt` baseline
          const syncProbe = await withEventLoopProbe(async () => {
            const t0 = performance.now();
            const checked = verifyAuditChainAt(chain.auditDir, { probeDigest: chain.tailDigest });
            const elapsedMs = performance.now() - t0;
            return { checked, elapsedMs };
          });
          expect(syncProbe.result.checked).not.toBeNull();
          expect(syncProbe.result.checked!.verdict.ok).toBe(true);
          if (syncProbe.result.checked!.verdict.ok) {
            expect(syncProbe.result.checked!.verdict.entries).toBe(chain.totalEntries);
            expect(syncProbe.result.checked!.verdict.positions.probe?.foundAt).toBe(chain.tailPosition);
          }

          // 2. Actual VS Code command entry point `runVerifyAuditChain`
          const sent: { level: string; message: string }[] = [];
          let breakCalls = 0;
          let lossCalls = 0;
          const notifier = {
            info: (message: string) => {
              sent.push({ level: 'info', message });
            },
            warn: (message: string) => {
              sent.push({ level: 'warn', message });
              return Promise.resolve(undefined);
            },
            error: (message: string) => {
              sent.push({ level: 'error', message });
            }
          } as unknown as Notifier;
          const logger = new SanitizedLogger();

          const cmdProbe = await withEventLoopProbe(async () => {
            const t0 = performance.now();
            await runVerifyAuditChain({
              workspaceRoot: tempRoot,
              notifier,
              logger,
              onBreak: () => {
                breakCalls += 1;
              },
              onLoss: () => {
                lossCalls += 1;
              },
              readCheckpoint: () => Promise.resolve(activeCheckpoint)
            });
            return performance.now() - t0;
          });
          expect(breakCalls).toBe(0);
          expect(lossCalls).toBe(0);
          expect(sent).toHaveLength(1);
          expect(sent[0]!.level).toBe('info');
          expect(sent[0]!.message).toContain('audit chain verified');
          expect(sent[0]!.message).toContain(`${chain.totalEntries} chained entries`);

          if (i >= WARMUP_RUNS) {
            syncWallMs.push(syncProbe.result.elapsedMs);
            syncEldP50.push(syncProbe.eventLoop.eldP50Ms);
            syncEldP95.push(syncProbe.eventLoop.eldP95Ms);
            syncEldMax.push(syncProbe.eventLoop.eldMaxMs);
            syncGapMax.push(syncProbe.eventLoop.immediateMaxGapMs);
            syncTicks.push(syncProbe.eventLoop.immediateTicks);

            cmdWallMs.push(cmdProbe.result);
            cmdEldP50.push(cmdProbe.eventLoop.eldP50Ms);
            cmdEldP95.push(cmdProbe.eventLoop.eldP95Ms);
            cmdEldMax.push(cmdProbe.eventLoop.eldMaxMs);
            cmdGapMax.push(cmdProbe.eventLoop.immediateMaxGapMs);
            cmdTicks.push(cmdProbe.eventLoop.immediateTicks);
          }
        }

        reportWorkloads.push({
          workloadId: workload.id,
          dataset: {
            fileCount: chain.fileCount,
            totalBytes: chain.totalBytes,
            totalMiB: Number((chain.totalBytes / (1024 * 1024)).toFixed(2)),
            totalEntries: chain.totalEntries,
            perFile: chain.perFile
          },
          syncVerifyAuditChainAt: {
            wallMs: statsOf(syncWallMs),
            eldP50Ms: statsOf(syncEldP50),
            eldP95Ms: statsOf(syncEldP95),
            eldMaxMs: statsOf(syncEldMax),
            immediateMaxGapMs: statsOf(syncGapMax),
            immediateTicks: statsOf(syncTicks)
          },
          commandRunVerifyAuditChain: {
            wallMs: statsOf(cmdWallMs),
            eldP50Ms: statsOf(cmdEldP50),
            eldP95Ms: statsOf(cmdEldP95),
            eldMaxMs: statsOf(cmdEldMax),
            immediateMaxGapMs: statsOf(cmdGapMax),
            immediateTicks: statsOf(cmdTicks)
          }
        });
      }

      const summary = {
        suite: 'audit-chain-verification-5mib',
        host,
        warmupRuns: WARMUP_RUNS,
        measuredRuns: MEASURED_RUNS,
        workloads: reportWorkloads
      };

      if (process.env.SCHEGENT_PRINT_N05_REPORT === '1') {
        console.log(`N05_AUDIT_REPORT ${JSON.stringify(summary, null, 2)}`);
      }

      expect(reportWorkloads).toHaveLength(2);
      for (const entry of reportWorkloads as Array<{
        readonly workloadId: string;
        readonly syncVerifyAuditChainAt: { readonly immediateTicks: DistStats };
        readonly commandRunVerifyAuditChain: {
          readonly eldMaxMs: DistStats;
          readonly immediateMaxGapMs: DistStats;
          readonly immediateTicks: DistStats;
        };
      }>) {
        // Synchronous CLI oracle remains strictly synchronous (1 spanning tick).
        expect(entry.syncVerifyAuditChainAt.immediateTicks.p50).toBe(1);
        // Chunked async command path must yield to the event loop and stay under the 50 ms stall gate.
        expect(
          entry.commandRunVerifyAuditChain.immediateTicks.p50,
          `${entry.workloadId}: expected chunked async verification to yield multiple times`
        ).toBeGreaterThanOrEqual(10);
        expect(
          entry.commandRunVerifyAuditChain.eldMaxMs.p95,
          `${entry.workloadId}: monitorEventLoopDelay max p95 (${entry.commandRunVerifyAuditChain.eldMaxMs.p95} ms) ` +
            `exceeded ${AUDIT_CMD_EVENT_LOOP_STALL_P95_CEILING_MS} ms`
        ).toBeLessThanOrEqual(AUDIT_CMD_EVENT_LOOP_STALL_P95_CEILING_MS);
        expect(
          entry.commandRunVerifyAuditChain.immediateMaxGapMs.p95,
          `${entry.workloadId}: setImmediate max gap p95 (${entry.commandRunVerifyAuditChain.immediateMaxGapMs.p95} ms) ` +
            `exceeded ${AUDIT_CMD_EVENT_LOOP_STALL_P95_CEILING_MS} ms`
        ).toBeLessThanOrEqual(AUDIT_CMD_EVENT_LOOP_STALL_P95_CEILING_MS);
      }
    }
  );
});
