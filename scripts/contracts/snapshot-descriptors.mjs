// Authoritative WorkflowSnapshot & slice descriptors for FR-R7-05.
//
// Single source of truth for:
//   - Host snapshot slice types (`src/contracts/generated/snapshot-types.ts`)
//   - Self-contained webview snapshot mirror (`webview-ui/src/lib/generated/snapshot-mirror.ts`)
//   - Nested Draft 2020-12 JSON Schema (`src/contracts/generated/schemas/sidebar-ipc.schema.json`)
//
// Starts with the hardest union-bearing slices (`QueueRuntime`, `BackendPingState`,
// `RunOriginRef`) to prove descriptor expressiveness across discriminated unions,
// nested projections, JSDoc documentation, and explicit receiver-side optionality.

import { d } from './descriptor-dsl.mjs';
import {
  CATALOG_LIFECYCLE_KINDS,
  QUEUE_FAILURE_POLICIES,
  SUPPORTED_BACKENDS
} from './canonical-enums.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 4;

const MANUAL_PAUSE_CAUSES = Object.freeze([
  'operator-paused',
  'queue-paused-mid-run',
  'breakpoint-paused',
  'verify-paused',
  'spend-bound-reached'
]);

const QUEUE_LIFECYCLES = Object.freeze([
  'running',
  'operator-paused',
  'idle-pending',
  'active-empty'
]);

const SCHEDULED_START_SOURCES = Object.freeze([
  'operator-chooser',
  'operator-restart',
  'programmatic-now',
  'programmatic-scheduled',
  'migration-default',
  'system-rate-limit-recovery'
]);

const RESOLVED_SCOPES = Object.freeze(['user', 'workspace', 'workspace-trust']);
const SETTING_SCOPES = Object.freeze(['workspace', 'user', 'default']);
const RUNTIME_LOG_LEVELS = Object.freeze(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const WORKFLOW_STATUSES = Object.freeze([
  'idle',
  'running',
  'paused',
  'awaiting-credit',
  'completed',
  'failed',
  'canceled'
]);
const QUEUE_ITEM_STATUSES = Object.freeze([
  'pending',
  'in-flight',
  'paused',
  'completed',
  'failed',
  'canceled'
]);
const EVIDENCE_OVERALL_STATUSES = Object.freeze(['healthy', 'degraded', 'unavailable']);
const EVIDENCE_SINK_STATUSES = Object.freeze(['healthy', 'degraded', 'failed']);
const EVIDENCE_CONTINUATION_POLICIES = Object.freeze(['fail-closed', 'continue-degraded']);
const BACKEND_PING_FAILURE_CAUSES = Object.freeze([
  'not-found',
  'not-executable',
  'non-zero-exit',
  'timed-out',
  'already-in-progress',
  'unknown'
]);

const GENERAL_SETTING_SCOPE_KEYS = Object.freeze([
  'cliPath',
  'loggingVerbose',
  'loopMaxIterations',
  'invocationIdleTimeoutSeconds',
  'invocationMaxDurationSeconds',
  'watchdogPollIntervalMinutes',
  'auditRotationSizeMB',
  'auditRotationMaxAgeDays',
  'defaultWorkflowId',
  'fatalSignatures',
  'claudeAutoCompactPctOverride',
  'runtimeLogLevel',
  'runtimeLogFilePath',
  'retryMaxAttempts',
  'codexPath',
  'agyPath',
  'runtimeLogMaxBytes',
  'runtimeLogMaxGenerations',
  'sessionRetentionMaxAgeDays',
  'sessionRetentionMaxBytes',
  'rawTranscriptMode',
  'transportCaptureMode',
  'retryForceContinueOnCap',
  'cliInheritEnvironment',
  'cliEnvironmentMode',
  'cliEnvironmentAllowlist',
  'backendProbeTimeoutSeconds',
  'uiConfirmationsEnable',
  'multiRootSuppressWarning',
  'backendRunner',
  'spendMaxUsdPerRun',
  'spendMaxTokensPerRun',
  'queueHaltOnTaskFailure'
]);

function generalSettingsScopesObject() {
  const fields = {};
  for (const key of GENERAL_SETTING_SCOPE_KEYS) {
    fields[key] = d.ref('SettingScope');
  }
  return d.obj(fields);
}

const GENERAL_SETTINGS_FIELDS = Object.freeze({
  cliPath: d.str(),
  loggingVerbose: d.bool(),
  loopMaxIterations: d.num(),
  invocationIdleTimeoutSeconds: d.num(),
  invocationMaxDurationSeconds: d.num(),
  watchdogPollIntervalMinutes: d.num(),
  auditRotationSizeMB: d.num(),
  auditRotationMaxAgeDays: d.num(),
  defaultWorkflowId: d.str(),
  fatalSignatures: d.arr(d.str()),
  claudeAutoCompactPctOverride: d.field(d.num(), { undefinable: true }),
  runtimeLogLevel: d.ref('RuntimeLogLevel'),
  runtimeLogFilePath: d.str(),
  retryMaxAttempts: d.num(),
  codexPath: d.str(),
  agyPath: d.str(),
  runtimeLogMaxBytes: d.num(),
  runtimeLogMaxGenerations: d.num(),
  sessionRetentionMaxAgeDays: d.num(),
  sessionRetentionMaxBytes: d.num(),
  rawTranscriptMode: d.enum(['always', 'errors-only', 'off']),
  transportCaptureMode: d.enum(['inherit', 'off', 'errors-only', 'on']),
  retryForceContinueOnCap: d.bool(),
  cliInheritEnvironment: d.bool(),
  cliEnvironmentMode: d.str(),
  cliEnvironmentAllowlist: d.arr(d.str()),
  backendProbeTimeoutSeconds: d.num(),
  uiConfirmationsEnable: d.bool(),
  multiRootSuppressWarning: d.bool(),
  backendRunner: d.enum(SUPPORTED_BACKENDS, {
    refName: 'BackendRunnerKind',
    webviewType: 'BackendRunnerKind'
  }),
  spendMaxUsdPerRun: d.field(d.num(), { nullable: true }),
  spendMaxTokensPerRun: d.field(d.num(), { nullable: true }),
  queueHaltOnTaskFailure: d.enum(QUEUE_FAILURE_POLICIES, {
    refName: 'QueueFailurePolicy',
    webviewType: 'QueueFailurePolicy'
  }),
  scopes: generalSettingsScopesObject()
});

// ---- Host-side type imports for `src/contracts/generated/snapshot-types.ts` ----
export const HOST_SNAPSHOT_IMPORTS = Object.freeze({
  '../backend-kinds': ['BackendRunnerKind'],
  '../catalog-version': ['CatalogVersionRef'],
  '../phase-identity': ['PhaseName'],
  '../pipeline-definitions': ['PipelineDefinition', 'PipelineSourceStatus'],
  '../process-definitions': ['PhaseDefinition', 'PhaseSourceStatus'],
  '../run-origin': ['RunOriginRef'],
  '../run-results': ['RunOutputRecord'],
  '../sidebar-ipc': ['ConnectedRunProjection'],
  '../sidebar-ipc/transport-usage': ['TransportUsage'],
  '../sidebar-ipc/trust': ['ResolvedScope'],
  '../sidebar-ipc/uncontained-grant': [
    'BackendGrantEntryProblems',
    'BackendPosture'
  ],
  '../snapshot-projections': [
    'ActiveFeatureSummary',
    'ActivePipelineSummary',
    'AuditTailEntry',
    'BuilderLifecycle',
    'CliMonitorState',
    'CreditPollingProjection',
    'DegradedPhaseEntry',
    'DelayedRetryState',
    'EffectiveLimitsProjection',
    'LaunchProjection',
    'LiveActivity',
    'PhaseTile',
    'QueueItemStatus',
    'QueueSettingsProjection',
    'QueueSummary',
    'RunLivenessProjection',
    'RunProgressProjection',
    'SessionArtifactsProjection',
    'StreamPressureProjection',
    'TaskPhaseProgressProjection',
    'WorkflowCatalogFieldErrorProjection',
    'WorkflowStatus'
  ],
  '../snapshot-vocabulary': [
    'DebugLogEntry',
    'PipelineDef',
    'QueueLifecycle',
    'TelemetrySnapshot'
  ],
  '../workflow-definitions': [
    'WorkflowDefinition',
    'WorkflowDerivedPort',
    'WorkflowSourceStatus'
  ],
  '../../config/general-settings': ['GeneralSettings'],
  '../../config/pipeline-config': ['PhaseDef'],
  '../../queue/feature-request': ['ScheduledStartSource'],
  '../../services/backend-ping-service': ['BackendPingState'],
  '../../services/evidence-health/evidence-health-monitor': ['EvidenceHealthSnapshot'],
  '../../state/workflow-run': ['ManualPauseCause']
});

// ---- Webview-local type imports (strictly inside webview-ui/src/lib/, ZERO repo/src) ----
export const WEBVIEW_LOCAL_IMPORTS = Object.freeze({
  './queue-failure-policy.js': ['QueueFailurePolicy'],
  '../snapshot-types.js': [
    'ActiveFeatureSummary',
    'ActivePipelineSummary',
    'AuditTailEntry',
    'BackendGrantEntryProblems',
    'BackendPosture',
    'BackendRunnerKind',
    'CliMonitorState',
    'ConnectedRunProjection',
    'CreditPollingProjection',
    'DebugLogEntry',
    'DegradedPhaseEntry',
    'DelayedRetryState',
    'EffectiveLimitsProjection',
    'EvidenceOverallStatus',
    'EvidenceSinkHealthProjection',
    'LaunchProjection',
    'LiveActivity',
    'PhaseCatalogSourceRecord',
    'PhaseDefinition',
    'PhaseName',
    'PhaseTile',
    'PipelineCatalogSourceRecord',
    'PipelineDefinition',
    'PortablePhaseDefinition',
    'PortablePipelineDefinition',
    'PortableWorkflowDefinition',
    'QueueItemStatus',
    'QueueLifecycle',
    'QueueSettingsProjection',
    'QueueSummary',
    'RunLivenessProjection',
    'RunOutputRecord',
    'RunProgressProjection',
    'RuntimeLogLevel',
    'ScheduledStartSource',
    'SessionArtifactsProjection',
    'SettingScope',
    'StreamPressureProjection',
    'TaskPhaseProgressProjection',
    'TelemetrySnapshot',
    'WorkflowCatalogSourceProjection',
    'WorkflowStatus'
  ]
});

export const WEBVIEW_LEAF_ALIASES = Object.freeze([
  {
    name: 'MirrorCatalogKind',
    doc: 'Closed catalog kind vocabulary mirrored from canonical descriptor.',
    schema: d.enum(CATALOG_LIFECYCLE_KINDS)
  },
  {
    name: 'MirrorHistoryTerminalStatus',
    schema: d.enum(['completed', 'failed', 'canceled'])
  },
  {
    name: 'MirrorManualPauseCause',
    schema: d.enum(MANUAL_PAUSE_CAUSES)
  },
  {
    name: 'MirrorResolvedScope',
    schema: d.enum(RESOLVED_SCOPES)
  },
  {
    name: 'MirrorTransportUsage',
    doc: 'Projected CLI transport capture disk usage for the Settings surface.',
    schema: d.obj({
      version: d.lit(1),
      retainedBytes: d.num(),
      runCount: d.num(),
      legacyBytes: d.num(),
      agesOutBy: d.field(d.str(), { nullable: true }),
      measuredAt: d.str()
    })
  }
]);

// ---- Authoritative snapshot slice declarations (emitted to host, webview, and JSON Schema) ----
export const SNAPSHOT_DECLARATIONS = Object.freeze([
  d.snapshotType({
    name: 'TransportDropCounts',
    hostSkip: true,
    doc: 'Lines and bytes the transport sink refused under backpressure (FR-R3-106).',
    schema: d.obj({
      lines: d.num(),
      bytes: d.num()
    })
  }),

  d.snapshotType({
    name: 'BackendPingFailureCause',
    hostSkip: true,
    doc: 'Closed cause vocabulary for failed backend connectivity probes.',
    schema: d.enum(BACKEND_PING_FAILURE_CAUSES)
  }),

  d.snapshotType({
    name: 'BackendPingState',
    hostSkip: true,
    doc: 'Discriminated union describing the current backend ping probe lifecycle.',
    asType: true,
    schema: d.discUnion('status', {
      idle: d.obj({ status: d.lit('idle') }),
      running: d.obj({
        status: d.lit('running'),
        runner: d.enum(SUPPORTED_BACKENDS, {
          refName: 'BackendRunnerKind',
          webviewType: 'BackendRunnerKind'
        }),
        startedAt: d.num(),
        timeoutSeconds: d.num()
      }),
      success: d.obj({
        status: d.lit('success'),
        runner: d.enum(SUPPORTED_BACKENDS, {
          refName: 'BackendRunnerKind',
          webviewType: 'BackendRunnerKind'
        }),
        startedAt: d.num(),
        completedAt: d.num(),
        latencyMs: d.num(),
        timeoutSeconds: d.num()
      }),
      failure: d.obj({
        status: d.lit('failure'),
        runner: d.enum(SUPPORTED_BACKENDS, {
          refName: 'BackendRunnerKind',
          webviewType: 'BackendRunnerKind'
        }),
        startedAt: d.num(),
        completedAt: d.num(),
        latencyMs: d.num(),
        timeoutSeconds: d.num(),
        cause: d.ref('BackendPingFailureCause'),
        exitCode: d.field(d.num(), { optional: true })
      })
    })
  }),

  d.snapshotType({
    name: 'CatalogVersionRef',
    hostSkip: true,
    doc: 'Published catalog version frozen into a run plan (Feature 103).',
    schema: d.obj({
      kind: d.enum(CATALOG_LIFECYCLE_KINDS, { webviewType: 'MirrorCatalogKind' }),
      id: d.str(),
      versionId: d.str()
    })
  }),

  d.snapshotType({
    name: 'RunOriginRef',
    hostSkip: true,
    asType: true,
    doc: 'Discriminated provenance describing how a run was started (Feature 103).',
    schema: d.discUnion('kind', {
      standalone: d.obj({ kind: d.lit('standalone') }),
      'workflow-member': d.obj({
        kind: d.lit('workflow-member'),
        workflowId: d.str()
      })
    })
  }),

  d.snapshotType({
    name: 'PhaseCatalogFieldErrorProjection',
    webviewSkip: true,
    doc: 'Per-field validation error on a Phase catalog record.',
    schema: d.obj({
      field: d.str(),
      code: d.str(),
      message: d.str()
    })
  }),

  d.snapshotType({
    name: 'PhaseCatalogSourceProjection',
    webviewSkip: true,
    doc: 'One resolved or draft-only Phase record in the Phase catalog projection.',
    schema: d.obj({
      key: d.str({ doc: '`${phaseId}::${index}` or `draft::${phaseId}::${index}`.' }),
      phaseId: d.str(),
      status: d.ref('PhaseSourceStatus'),
      definition: d.field(d.ref('PhaseDefinition'), { nullable: true }),
      display: d.rec(d.unknown()),
      errors: d.arr(d.ref('PhaseCatalogFieldErrorProjection')),
      modelAvailable: d.field(d.bool(), { optional: true }),
      lifecycle: d.field(d.ref('BuilderLifecycle'), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'PhaseCatalogProjection',
    doc: 'Authoritative source-aware Phase catalog projection.',
    schema: d.obj({
      state: d.enum(['ready', 'error']),
      records: d.arr(
        d.ref('PhaseCatalogSourceProjection', { webviewType: 'PhaseCatalogSourceRecord' })
      ),
      effective: d.arr(d.ref('PhaseDefinition', { webviewType: 'PortablePhaseDefinition' })),
      revision: d.str({ doc: 'Store revision echoed back on save.' }),
      warnings: d.arr(d.obj({ code: d.str(), message: d.str() })),
      error: d.field(d.obj({ code: d.str(), message: d.str() }), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'PipelineCatalogFieldErrorProjection',
    webviewSkip: true,
    doc: 'Per-field validation error on a Pipeline catalog record.',
    schema: d.obj({
      field: d.str(),
      code: d.str(),
      message: d.str()
    })
  }),

  d.snapshotType({
    name: 'PipelineCatalogSourceProjection',
    webviewSkip: true,
    doc: 'One resolved or draft-only Pipeline record in the Pipeline catalog projection.',
    schema: d.obj({
      key: d.str(),
      pipelineId: d.str(),
      status: d.ref('PipelineSourceStatus'),
      definition: d.field(d.ref('PipelineDefinition'), { nullable: true }),
      display: d.rec(d.unknown()),
      errors: d.arr(d.ref('PipelineCatalogFieldErrorProjection')),
      modelAvailable: d.field(d.bool(), { optional: true }),
      consumingWorkflowIds: d.field(d.arr(d.str()), { optional: true }),
      lifecycle: d.field(d.ref('BuilderLifecycle'), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'PipelineCatalogProjection',
    doc: 'Authoritative source-aware Pipeline catalog projection.',
    schema: d.obj({
      state: d.enum(['ready', 'error']),
      records: d.arr(
        d.ref('PipelineCatalogSourceProjection', { webviewType: 'PipelineCatalogSourceRecord' })
      ),
      effective: d.arr(d.ref('PipelineDefinition', { webviewType: 'PortablePipelineDefinition' })),
      revision: d.str({ doc: 'Store revision echoed back on save.' }),
      warnings: d.arr(d.obj({ code: d.str(), message: d.str() })),
      error: d.field(d.obj({ code: d.str(), message: d.str() }), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'WorkflowCatalogSourceProjection',
    webviewSkip: true,
    doc: 'One resolved or draft-only Workflow record in the Workflow catalog projection.',
    schema: d.obj({
      key: d.str(),
      workflowId: d.str(),
      status: d.ref('WorkflowSourceStatus'),
      definition: d.field(d.ref('WorkflowDefinition'), { nullable: true }),
      display: d.rec(d.unknown()),
      errors: d.arr(d.ref('WorkflowCatalogFieldErrorProjection')),
      derivedInputs: d.arr(d.ref('WorkflowDerivedPort')),
      derivedOutputs: d.arr(d.ref('WorkflowDerivedPort')),
      lifecycle: d.field(d.ref('BuilderLifecycle'), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'WorkflowCatalogProjection',
    doc: 'Authoritative source-aware Workflow catalog projection.',
    schema: d.obj({
      state: d.enum(['ready', 'error']),
      records: d.arr(d.ref('WorkflowCatalogSourceProjection')),
      effective: d.arr(d.ref('WorkflowDefinition', { webviewType: 'PortableWorkflowDefinition' })),
      revision: d.str({ doc: 'Store revision echoed back on save.' }),
      warnings: d.arr(d.obj({ code: d.str(), message: d.str() })),
      error: d.field(d.obj({ code: d.str(), message: d.str() }), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'QueueItem',
    doc: 'Projected queued/active/historical task item.',
    schema: d.obj({
      id: d.str(),
      label: d.str(),
      enqueuedAt: d.str(),
      startedAt: d.field(d.str(), { nullable: true }),
      updatedAt: d.str(),
      completedAt: d.field(d.str(), { nullable: true }),
      status: d.ref('QueueItemStatus'),
      retryCount: d.num(),
      lastErrorSummary: d.field(d.str(), { nullable: true }),
      pausedReason: d.field(d.str(), { nullable: true }),
      currentPhase: d.field(d.ref('PhaseName'), { nullable: true }),
      queueId: d.field(d.str(), { webviewOptional: true }),
      position: d.num(),
      pauseCause: d.field(
        d.enum(['queue-paused', 'phase-paused', 'manually-paused-task', 'breakpoint']),
        { nullable: true, webviewOptional: true }
      ),
      currentPipelineId: d.field(d.str(), {
        nullable: true,
        webviewOptional: true,
        doc: 'Pipeline id under which this task is executing or last executed.'
      }),
      hasOnDiskLogs: d.field(d.bool(), {
        webviewOptional: true,
        doc: 'Heuristic flag indicating the task reached phase execution.'
      }),
      paused: d.field(
        d.obj({
          pauseSource: d.enum(['operator-paused', 'system-paused']),
          pauseCauseCategory: d.field(
            d.enum(['rate-limit', 'fatal-signature', 'operator-canceled']),
            { optional: true }
          ),
          resetsAtMs: d.field(d.num(), { optional: true })
        }),
        { optional: true, doc: 'Paused-row enrichment present only while status === paused.' }
      ),
      phaseProgress: d.field(d.ref('TaskPhaseProgressProjection'), {
        nullable: true,
        doc: 'Settled-phase progress pair; null means unknown, never 0 of 0.'
      }),
      degradedPhases: d.field(d.arr(d.ref('DegradedPhaseEntry')), {
        optional: true,
        doc: 'Phases carried past their retry cap; absent when not degraded.'
      })
    })
  }),

  d.snapshotType({
    name: 'QueueProjection',
    doc: 'Top-level queue projection for the default queue and summary buckets.',
    schema: d.obj({
      inFlight: d.field(d.ref('QueueItem'), { nullable: true }),
      pending: d.arr(d.ref('QueueItem')),
      recent: d.arr(d.ref('QueueItem')),
      orderedItems: d.arr(d.ref('QueueItem')),
      queues: d.field(d.arr(d.ref('QueueSummary')), { webviewOptional: true }),
      paused: d.bool(),
      pausedReason: d.field(d.str(), { nullable: true, webviewOptional: true }),
      lifecycle: d.field(d.ref('QueueLifecycle'), { webviewOptional: true }),
      scheduledStartAt: d.field(d.num(), { nullable: true, webviewOptional: true }),
      scheduledStartSource: d.field(d.ref('ScheduledStartSource'), {
        nullable: true,
        webviewOptional: true
      }),
      migrationNotice: d.field(d.enum(['pending', 'dismissed']), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'HistoryEntry',
    doc: 'Recorded terminal run entry projected for the History surface.',
    schema: d.obj({
      runId: d.str(),
      featureId: d.str(),
      descriptionPreview: d.str(),
      terminalStatus: d.enum(['completed', 'failed', 'canceled'], {
        webviewType: 'MirrorHistoryTerminalStatus'
      }),
      startedAt: d.str(),
      completedAt: d.str(),
      durationMs: d.num(),
      lastErrorSummary: d.field(d.str(), { nullable: true }),
      auditLogPointer: d.str(),
      queueId: d.str(),
      catalogVersion: d.field(d.ref('CatalogVersionRef'), { optional: true }),
      origin: d.field(d.ref('RunOriginRef'), { optional: true }),
      descriptionLength: d.field(d.num(), { optional: true })
    })
  }),

  d.snapshotType({
    name: 'GeneralSettings',
    hostSkip: true,
    doc: 'Typed read of scalar schegent.* settings projected with effective scopes.',
    schema: d.obj(GENERAL_SETTINGS_FIELDS)
  }),

  d.snapshotType({
    name: 'GeneralSettingsProjection',
    doc: 'GeneralSettings projection plus optional measured transport capture disk usage.',
    intersectionBase: 'GeneralSettings',
    webviewIntersectionBase: 'GeneralSettings',
    jsonBaseFields: GENERAL_SETTINGS_FIELDS,
    schema: d.obj({
      transportUsage: d.field(
        d.ref('TransportUsage', { webviewType: 'MirrorTransportUsage' }),
        { optional: true }
      )
    })
  }),

  d.snapshotType({
    name: 'InFlightRunProjection',
    doc: 'Per-queue active Run projection nested under QueueRuntime.inFlightRun.',
    schema: d.obj({
      runId: d.str(),
      status: d.ref('WorkflowStatus'),
      feature: d.field(d.ref('ActiveFeatureSummary'), { nullable: true }),
      pipeline: d.field(d.ref('ActivePipelineSummary'), { nullable: true }),
      elapsedMs: d.field(d.num(), { nullable: true }),
      liveActivity: d.ref('LiveActivity'),
      liveness: d.field(d.ref('RunLivenessProjection'), {
        nullable: true,
        webviewOptional: true
      }),
      progress: d.field(d.ref('RunProgressProjection'), {
        nullable: true,
        webviewOptional: true
      }),
      delayedRetry: d.ref('DelayedRetryState'),
      resumeTargetPhaseId: d.field(d.str(), { nullable: true }),
      outputs: d.arr(d.ref('RunOutputRecord')),
      catalogVersion: d.field(d.ref('CatalogVersionRef'), { optional: true }),
      origin: d.field(d.ref('RunOriginRef'), { optional: true }),
      creditPolling: d.field(d.ref('CreditPollingProjection'), { optional: true, nullable: true }),
      effectiveLimits: d.field(d.ref('EffectiveLimitsProjection'), { optional: true, nullable: true })
    })
  }),

  d.snapshotType({
    name: 'QueueRuntime',
    doc: 'Per-queue published runtime state (Feature 092), including discriminated startFailure union.',
    schema: d.obj({
      queueId: d.str(),
      name: d.str(),
      position: d.num(),
      lifecycle: d.ref('QueueLifecycle'),
      inFlightRun: d.field(d.ref('InFlightRunProjection'), { nullable: true }),
      phases: d.arr(d.ref('PhaseTile')),
      phaseOverrides: d.arr(
        d.obj({
          phaseId: d.str(),
          action: d.enum(['skipped', 'disabled', 'removed'])
        })
      ),
      manualPause: d.field(
        d.obj({
          at: d.str(),
          cause: d.enum(MANUAL_PAUSE_CAUSES, {
            refName: 'ManualPauseCause',
            webviewType: 'MirrorManualPauseCause'
          })
        }),
        { nullable: true }
      ),
      phaseBreakpoints: d.arr(
        d.obj({
          phaseId: d.str(),
          setAt: d.str(),
          actor: d.enum(['operator', 'system'])
        })
      ),
      startFailure: d.field(
        d.discUnion('kind', {
          admission: d.obj({
            kind: d.lit('admission'),
            admission: d.enum(['admitNew', 'admitResume']),
            at: d.str(),
            summary: d.field(d.str(), { nullable: true })
          }),
          halted: d.obj({
            kind: d.lit('halted'),
            taskId: d.str(),
            taskName: d.str(),
            at: d.str()
          }),
          'stranded-run': d.obj({
            kind: d.lit('stranded-run'),
            runId: d.str(),
            phase: d.str(),
            at: d.str()
          })
        }),
        { nullable: true }
      ),
      pendingCount: d.num(),
      tasks: d.arr(d.ref('QueueItem')),
      scheduledStartAt: d.field(d.num(), { nullable: true }),
      scheduledStartSource: d.field(d.ref('ScheduledStartSource'), { nullable: true })
    })
  }),

  d.snapshotType({
    name: 'EvidenceHealthSnapshot',
    webviewName: 'EvidenceHealthProjection',
    hostSkip: true,
    doc: 'Per-sink evidence durability and transport backpressure drop counts.',
    schema: d.obj({
      overall: d.ref('EvidenceOverallStatus'),
      audit: d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
      rawTranscript: d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
      runtimeLog: d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
      metricsRollup: d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
      historyPointer: d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
      auditCheckpoint: d.field(
        d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
        { webviewOptional: true }
      ),
      transport: d.field(
        d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
        { webviewOptional: true }
      ),
      verboseDiagnostics: d.field(
        d.ref('EvidenceSinkHealth', { webviewType: 'EvidenceSinkHealthProjection' }),
        { webviewOptional: true }
      ),
      transportDrops: d.field(d.ref('TransportDropCounts'), {
        webviewOptional: true,
        doc: 'Transport lines/bytes dropped under backpressure (optional in webview for legacy host tolerance).'
      })
    })
  }),

  d.snapshotType({
    name: 'TrustProjection',
    webviewSkip: true,
    doc: 'Fail-closed Workspace Trust and per-capability trust resolution projection.',
    schema: d.obj({
      workspaceTrust: d.bool(),
      resolvedTrust: d.obj({
        phases: d.bool(),
        retryConditions: d.bool()
      }),
      resolvedScope: d.obj({
        phases: d.ref('ResolvedScope'),
        retryConditions: d.ref('ResolvedScope')
      })
    })
  }),

  d.snapshotType({
    name: 'WorkflowSnapshot',
    doc: 'Authoritative v4 sidebar state snapshot envelope pushed via STATE_SNAPSHOT.',
    schema: d.obj({
      schemaVersion: d.lit(SNAPSHOT_SCHEMA_VERSION),
      isPrimary: d.bool(),
      queues: d.arr(d.ref('QueueRuntime')),
      queue: d.ref('QueueProjection'),
      defaultRunnerKind: d.field(
        d.enum(SUPPORTED_BACKENDS, {
          refName: 'BackendRunnerKind',
          webviewType: 'BackendRunnerKind'
        }),
        { webviewOptional: true }
      ),
      auditTail: d.arr(d.ref('AuditTailEntry')),
      debugLogTail: d.field(d.arr(d.ref('DebugLogEntry')), { webviewOptional: true }),
      monitor: d.field(d.ref('CliMonitorState'), { nullable: true }),
      history: d.arr(d.ref('HistoryEntry')),
      producedAt: d.str(),
      availablePipelines: d.arr(d.ref('PipelineDef', { webviewType: 'PipelineDefinition' })),
      availablePhases: d.arr(d.ref('PhaseDef', { webviewType: 'PhaseDefinition' })),
      availableModels: d.rec(d.arr(d.str()), {
        readonly: false,
        keyType: 'BackendRunnerKind',
        webviewKeyType: 'BackendRunnerKind',
        keyEnum: SUPPORTED_BACKENDS
      }),
      configuredModels: d.field(
        d.rec(d.arr(d.str()), {
          readonly: false,
          keyType: 'BackendRunnerKind',
          webviewKeyType: 'BackendRunnerKind',
          keyEnum: SUPPORTED_BACKENDS
        }),
        { webviewOptional: true }
      ),
      availableBackends: d.arr(
        d.enum(SUPPORTED_BACKENDS, {
          refName: 'BackendRunnerKind',
          webviewType: 'BackendRunnerKind'
        })
      ),
      backendPostures: d.field(d.arr(d.ref('BackendPosture')), { webviewOptional: true }),
      backendGrantProblems: d.field(d.ref('BackendGrantEntryProblems'), { webviewOptional: true }),
      backendPingState: d.field(d.ref('BackendPingState'), { webviewOptional: true }),
      generalSettings: d.field(d.ref('GeneralSettingsProjection'), { webviewOptional: true }),
      queueSettings: d.field(d.ref('QueueSettingsProjection'), { webviewOptional: true }),
      sessionArtifacts: d.field(d.ref('SessionArtifactsProjection'), { webviewOptional: true }),
      streamPressure: d.field(d.ref('StreamPressureProjection'), { webviewOptional: true }),
      evidenceHealth: d.field(
        d.ref('EvidenceHealthSnapshot', { webviewType: 'EvidenceHealthProjection' }),
        { webviewOptional: true }
      ),
      phaseCatalog: d.field(d.ref('PhaseCatalogProjection'), { optional: true }),
      pipelineCatalog: d.field(d.ref('PipelineCatalogProjection'), { optional: true }),
      workflowCatalog: d.field(d.ref('WorkflowCatalogProjection'), { optional: true }),
      launchables: d.field(d.ref('LaunchProjection'), { optional: true }),
      defaultWorkflowId: d.field(d.str(), { optional: true }),
      connectedRuns: d.field(d.arr(d.ref('ConnectedRunProjection')), { optional: true }),
      telemetry: d.field(d.ref('TelemetrySnapshot'), { nullable: true, webviewOptional: true }),
      workspaceTrust: d.field(d.bool(), { webviewOptional: true }),
      resolvedTrust: d.field(
        d.obj({
          phases: d.bool(),
          retryConditions: d.bool()
        }),
        { webviewOptional: true }
      ),
      resolvedScope: d.field(
        d.obj({
          phases: d.enum(RESOLVED_SCOPES, {
            refName: 'ResolvedScope',
            webviewType: 'MirrorResolvedScope'
          }),
          retryConditions: d.enum(RESOLVED_SCOPES, {
            refName: 'ResolvedScope',
            webviewType: 'MirrorResolvedScope'
          })
        }),
        { webviewOptional: true }
      ),
      confirmSuppression: d.field(
        d.obj({
          version: d.lit(1),
          suppressedActionKeys: d.arr(d.str())
        }),
        { optional: true }
      ),
      confirmationsEnabled: d.field(d.bool(), { optional: true })
    })
  })
]);

// ---- Referenced nested `$defs` for Draft 2020-12 JSON Schema validation ----
export const SHARED_SNAPSHOT_DEFS = Object.freeze({
  BackendRunnerKind: d.enum(SUPPORTED_BACKENDS),
  PhaseName: d.str({ minLen: 1 }),
  QueueItemStatus: d.enum(QUEUE_ITEM_STATUSES),
  QueueLifecycle: d.enum(QUEUE_LIFECYCLES),
  ScheduledStartSource: d.enum(SCHEDULED_START_SOURCES),
  WorkflowStatus: d.enum(WORKFLOW_STATUSES),
  ManualPauseCause: d.enum(MANUAL_PAUSE_CAUSES),
  ResolvedScope: d.enum(RESOLVED_SCOPES),
  SettingScope: d.enum(SETTING_SCOPES),
  RuntimeLogLevel: d.enum(RUNTIME_LOG_LEVELS),
  EvidenceOverallStatus: d.enum(EVIDENCE_OVERALL_STATUSES),
  EvidenceSinkHealth: d.obj({
    status: d.enum(EVIDENCE_SINK_STATUSES),
    continuationPolicy: d.enum(EVIDENCE_CONTINUATION_POLICIES),
    failureCount: d.num({ min: 0 }),
    lastFailureAt: d.field(d.str(), { nullable: true }),
    cause: d.field(d.str(), { nullable: true })
  }),
  TransportDropCounts: d.obj({
    lines: d.num({ min: 0 }),
    bytes: d.num({ min: 0 })
  }),
  BackendPingFailureCause: d.enum(BACKEND_PING_FAILURE_CAUSES),
  BackendPingState: SNAPSHOT_DECLARATIONS.find((x) => x.name === 'BackendPingState').schema,
  CatalogVersionRef: SNAPSHOT_DECLARATIONS.find((x) => x.name === 'CatalogVersionRef').schema,
  RunOriginRef: SNAPSHOT_DECLARATIONS.find((x) => x.name === 'RunOriginRef').schema,
  GeneralSettings: SNAPSHOT_DECLARATIONS.find((x) => x.name === 'GeneralSettings').schema,
  EvidenceHealthSnapshot: SNAPSHOT_DECLARATIONS.find((x) => x.name === 'EvidenceHealthSnapshot').schema,
  TransportUsage: d.obj({
    version: d.lit(1),
    retainedBytes: d.num({ min: 0 }),
    runCount: d.num({ min: 0 }),
    legacyBytes: d.num({ min: 0 }),
    agesOutBy: d.field(d.str(), { nullable: true }),
    measuredAt: d.str()
  }),
  ActiveFeatureSummary: d.obj({
    id: d.str(),
    label: d.str(),
    startedAt: d.str()
  }),
  ActivePipelineSummary: d.obj({
    id: d.str(),
    name: d.str()
  }),
  LiveActivity: d.obj({
    summary: d.field(d.str(), { nullable: true }),
    category: d.field(d.str(), { nullable: true }),
    lastEventAt: d.field(d.str(), { nullable: true }),
    freshness: d.enum(['live', 'stale', 'idle']),
    staleSeconds: d.field(d.num(), { nullable: true })
  }),
  RunLivenessProjection: d.obj(
    {
      lastActivityAt: d.field(d.str(), { nullable: true }),
      stdoutLines: d.num({ min: 0 }),
      stderrLines: d.num({ min: 0 })
    },
    { closed: false }
  ),
  RunProgressProjection: d.obj(
    {
      phasesCompleted: d.num({ min: 0 }),
      phaseCount: d.num({ min: 0 }),
      iterationCap: d.num({ min: 0 }),
      maxPhaseInvocations: d.num({ min: 0 }),
      percent: d.num({ min: 0, max: 100 })
    },
    { closed: false }
  ),
  DelayedRetryState: d.obj({
    pendingRetryAt: d.field(d.str(), { nullable: true }),
    pendingRetryCause: d.field(d.str(), { nullable: true }),
    delayedRetryCount: d.num({ min: 0 })
  }),
  RunOutputRecord: d.obj(
    {
      portId: d.str(),
      status: d.str()
    },
    { closed: false }
  ),
  CreditPollingProjection: d.obj({}, { closed: false }),
  EffectiveLimitsProjection: d.obj({}, { closed: false }),
  PhaseTile: d.obj(
    {
      name: d.str(),
      displayName: d.str(),
      order: d.num(),
      state: d.str(),
      iteration: d.num(),
      lastResult: d.field(d.str(), { nullable: true }),
      elapsedMs: d.num(),
      subProgress: d.field(
        d.obj({ current: d.num(), total: d.num(), label: d.str() }, { closed: false }),
        { nullable: true }
      )
    },
    { closed: false }
  ),
  TaskPhaseProgressProjection: d.obj(
    {
      completed: d.num({ min: 0 }),
      total: d.num({ min: 0 })
    },
    { closed: false }
  ),
  DegradedPhaseEntry: d.obj(
    {
      phaseId: d.str(),
      outcome: d.str()
    },
    { closed: false }
  ),
  QueueSummary: d.obj(
    {
      id: d.str(),
      name: d.str(),
      position: d.num()
    },
    { closed: false }
  ),
  QueueSettingsProjection: d.obj({
    globalConcurrencyCap: d.int({ min: 1 }),
    defaultQueueId: d.str({ minLen: 1 })
  }),
  SessionArtifactsProjection: d.obj({
    artifactCount: d.num({ min: 0 }),
    totalBytes: d.num({ min: 0 }),
    lastSweepAt: d.field(d.str(), { nullable: true }),
    lastSweepFailures: d.num({ min: 0 })
  }),
  StreamPressureProjection: d.obj({
    liveBuffers: d.num({ min: 0 }),
    retainedBytes: d.num({ min: 0 }),
    ceilingBytes: d.num({ min: 0 }),
    machineMemoryBytes: d.num({ min: 0 })
  }),
  AuditTailEntry: d.obj(
    {
      id: d.str(),
      timestamp: d.str(),
      category: d.str(),
      summary: d.str()
    },
    { closed: false }
  ),
  DebugLogEntry: d.obj({
    id: d.num(),
    timestamp: d.str(),
    level: d.enum(RUNTIME_LOG_LEVELS),
    message: d.str()
  }),
  CliMonitorState: d.obj(
    {
      status: d.str()
    },
    { closed: false }
  ),
  TelemetrySnapshot: d.obj(
    {
      status: d.str()
    },
    { closed: false }
  ),
  BackendPosture: d.obj(
    {
      kind: d.enum(SUPPORTED_BACKENDS)
    },
    { closed: false }
  ),
  BackendGrantEntryProblems: d.arr(d.str()),
  BuilderLifecycle: d.obj({}, { closed: false }),
  PhaseSourceStatus: d.str(),
  PipelineSourceStatus: d.str(),
  WorkflowSourceStatus: d.str(),
  PhaseDefinition: d.obj({ phaseId: d.str() }, { closed: false }),
  PipelineDefinition: d.obj({ pipelineId: d.str() }, { closed: false }),
  WorkflowDefinition: d.obj({ workflowId: d.str() }, { closed: false }),
  WorkflowDerivedPort: d.obj(
    { nodeId: d.str(), portId: d.str(), label: d.str(), type: d.str() },
    { closed: false }
  ),
  WorkflowCatalogFieldErrorProjection: d.obj({
    field: d.str(),
    code: d.str(),
    message: d.str()
  }),
  PipelineDef: d.obj({ id: d.str(), name: d.str() }, { closed: false }),
  PhaseDef: d.obj({ id: d.str(), name: d.str() }, { closed: false }),
  LaunchProjection: d.obj({}, { closed: false }),
  ConnectedRunProjection: d.obj({}, { closed: false })
});
