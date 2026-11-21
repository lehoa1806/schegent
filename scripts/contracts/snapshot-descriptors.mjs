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
  ALL_PHASE_CAPABILITIES,
  APPROVAL_MODES,
  CANDIDATE_AVAILABILITY_POLICIES,
  CATALOG_LIFECYCLE_KINDS,
  CONTAINMENT_EFFECTS,
  CONTROL_ACTION_KINDS,
  CONTROL_COMMAND_REFUSAL_REASONS,
  DECISION_FIELD_TYPES,
  EFFECT_OUTCOMES,
  EVIDENCE_BASES,
  EVIDENCE_POLICY_ORIGINS,
  EXECUTION_BRANCH_DISPOSITIONS,
  EXECUTION_DECISION_EXIT_REASONS,
  EXECUTION_DECISION_LIMIT_ORIGINS,
  FOR_EACH_ON_ITEM_ERROR_POLICIES,
  IDENTITY_STATES,
  NATIVE_REVIEW_KINDS,
  PHASE_EFFORT_LEVELS,
  PHASE_EVIDENCE_POLICIES,
  PHASE_HOST_VERIFICATIONS,
  PHASE_SIDE_EFFECTS,
  PIPELINE_INPUT_PORT_TYPES,
  PIPELINE_OUTPUT_PORT_TYPES,
  QUEUE_FAILURE_POLICIES,
  REPEAT_ON_EXHAUSTED_POLICIES,
  RESULT_OPERATOR_KINDS,
  RETRY_CAP_OUTCOMES,
  RUN_OUTPUT_STATUSES,
  SESSION_POLICIES,
  SUPPORTED_BACKENDS,
  TYPED_CONDITION_OPERATORS,
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_CONTROL_ACTIONS,
  WORKFLOW_HANDOFF_MODES,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_SELECTION_RULES
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
const AUDIT_CATEGORIES = Object.freeze([
  'phase-transition',
  'file-write',
  'cli-invocation',
  'error',
  'warning',
  'system'
]);
const FRESHNESS_STATES = Object.freeze([
  'live',
  'slowing',
  'stalled',
  'paused',
  'idle',
  'holding'
]);
const MONITOR_STATUSES = Object.freeze([
  'starting',
  'running',
  'stalled',
  'completed',
  'failed',
  'timed_out',
  'canceled',
  'paused'
]);
const PHASE_STATES = Object.freeze([
  'not-started',
  'active',
  'completed',
  'skipped',
  'disabled'
]);
const PHASE_RESULT_STATES = Object.freeze([
  'clean',
  'ambiguities-remain',
  'issues-remain',
  'failed',
  'timed-out'
]);
const TELEMETRY_STATUSES = Object.freeze([
  'active',
  'sleeping',
  'zombie',
  'exited',
  'killed',
  'unavailable'
]);
const EVIDENCE_OVERALL_STATUSES = Object.freeze(['healthy', 'degraded', 'unavailable']);
const EVIDENCE_SINK_STATUSES = Object.freeze(['healthy', 'degraded', 'unavailable']);
const EVIDENCE_CONTINUATION_POLICIES = Object.freeze(['fail-closed', 'continue-degraded']);
const BACKEND_PING_FAILURE_CAUSES = Object.freeze([
  'not-found',
  'not-executable',
  'non-zero-exit',
  'timed-out',
  'already-in-progress',
  'unknown'
]);
const LIMIT_ORIGINS = Object.freeze(['default', 'user', 'workspace', 'workspace-folder', 'phase']);
const SOURCE_STATUSES = Object.freeze(['effective', 'invalid']);
const WORKFLOW_DERIVED_PORT_TYPES = Object.freeze([
  ...new Set([...PIPELINE_INPUT_PORT_TYPES, ...PIPELINE_OUTPUT_PORT_TYPES])
]);
const CONNECTED_NODE_STATES = Object.freeze([
  'completed',
  'in-flight',
  'failed',
  'canceled',
  'available',
  'blocked',
  'unvisited'
]);
const BACKEND_CONTAINMENTS = Object.freeze(['os-enforced', 'none']);
const BACKEND_CONTAINMENT_MECHANISMS = Object.freeze(['codex-sandbox-workspace-write', 'none']);
const BACKEND_GRANT_STATES = Object.freeze(['granted', 'not-granted', 'not-required']);
const BACKEND_ADMISSION_PROJECTIONS = Object.freeze([
  'contained',
  'acceptance-required',
  'accepted',
  'executable-unresolved'
]);

const effectiveLimit = (valueSchema) =>
  d.obj({
    value: valueSchema,
    origin: d.ref('LimitOrigin')
  });

const PHASE_DEFINITION_BASE_FIELDS = Object.freeze({
  phaseId: d.str(),
  name: d.str(),
  description: d.field(d.str(), { optional: true }),
  version: d.num(),
  model: d.field(d.str(), { optional: true }),
  effort: d.field(d.enum(PHASE_EFFORT_LEVELS), { optional: true }),
  sideEffects: d.field(d.enum(PHASE_SIDE_EFFECTS), { optional: true }),
  evidencePolicy: d.field(d.enum(PHASE_EVIDENCE_POLICIES), { optional: true }),
  evidencePolicyDeclaredAt: d.field(d.enum(EVIDENCE_POLICY_ORIGINS), { optional: true }),
  hostVerification: d.field(d.enum(PHASE_HOST_VERIFICATIONS), { optional: true }),
  hostVerificationDeclaredAt: d.field(d.enum(EVIDENCE_POLICY_ORIGINS), { optional: true }),
  capabilities: d.field(d.arr(d.enum(ALL_PHASE_CAPABILITIES)), { optional: true }),
  timeoutSeconds: d.field(d.num(), { optional: true }),
  spendBoundUsd: d.field(d.num(), { optional: true }),
  spendBoundTokens: d.field(d.num(), { optional: true }),
  loopable: d.field(d.bool(), { optional: true }),
  retryCondition: d.field(d.str(), { optional: true }),
  isRequired: d.field(d.bool(), { optional: true }),
  forceContinueOnRetryCap: d.field(d.bool(), { optional: true }),
  onRetryCap: d.field(d.enum(RETRY_CAP_OUTCOMES), { optional: true }),
  runner: d.field(d.ref('BackendRunnerKind'), { optional: true }),
  nativeReview: d.field(d.enum(NATIVE_REVIEW_KINDS), { optional: true }),
  resultContract: d.field(d.ref('ResultContract'), { optional: true })
});

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
  QueueFailurePolicy: d.enum(QUEUE_FAILURE_POLICIES),
  ScheduledStartSource: d.enum(SCHEDULED_START_SOURCES),
  WorkflowStatus: d.enum(WORKFLOW_STATUSES),
  WorkflowControlAction: d.enum(WORKFLOW_CONTROL_ACTIONS),
  ManualPauseCause: d.enum(MANUAL_PAUSE_CAUSES),
  ResolvedScope: d.enum(RESOLVED_SCOPES),
  SettingScope: d.enum(SETTING_SCOPES),
  RuntimeLogLevel: d.enum(RUNTIME_LOG_LEVELS),
  AuditCategory: d.enum(AUDIT_CATEGORIES),
  FreshnessState: d.enum(FRESHNESS_STATES),
  MonitorStatus: d.enum(MONITOR_STATUSES),
  PhaseState: d.enum(PHASE_STATES),
  PhaseResultState: d.enum(PHASE_RESULT_STATES),
  TelemetryStatus: d.enum(TELEMETRY_STATUSES),
  EvidenceOverallStatus: d.enum(EVIDENCE_OVERALL_STATUSES),
  EvidenceSinkStatus: d.enum(EVIDENCE_SINK_STATUSES),
  EvidenceSinkHealth: d.obj({
    status: d.ref('EvidenceSinkStatus'),
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
  LimitOrigin: d.enum(LIMIT_ORIGINS),
  ScalarValue: d.union([d.str(), d.num(), d.bool()]),

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
    category: d.field(d.ref('AuditCategory'), { nullable: true }),
    lastEventAt: d.field(d.str(), { nullable: true }),
    freshness: d.ref('FreshnessState'),
    staleSeconds: d.field(d.num(), { nullable: true })
  }),

  RunLivenessProjection: d.obj({
    lastActivityAt: d.str(),
    stdoutLines: d.num({ min: 0 }),
    stderrLines: d.num({ min: 0 })
  }),

  RunProgressProjection: d.obj({
    phasesCompleted: d.num({ min: 0 }),
    phaseCount: d.num({ min: 0 }),
    iterationCap: d.num({ min: 0 }),
    maxPhaseInvocations: d.num({ min: 0 }),
    percent: d.num({ min: 0, max: 100 })
  }),

  DelayedRetryState: d.obj({
    pendingRetryAt: d.field(d.str(), { nullable: true }),
    pendingRetryCause: d.field(d.enum(['transient_error', 'rate_limit']), { nullable: true }),
    delayedRetryCount: d.num({ min: 0 })
  }),

  RunOutputRecord: d.obj({
    name: d.str(),
    status: d.enum(RUN_OUTPUT_STATUSES),
    reference: d.field(d.str(), { optional: true })
  }),

  CreditPollingProjection: d.obj({
    state: d.enum(['polling', 'stopped', 'unreachable']),
    windowEndsAt: d.field(d.num(), { nullable: true })
  }),

  ExecutionDecisionSettingOrigin: d.enum(EXECUTION_DECISION_LIMIT_ORIGINS),

  ExecutionDecisionSettingSources: d.obj({
    maxIterations: d.ref('ExecutionDecisionSettingOrigin'),
    capOutcome: d.ref('ExecutionDecisionSettingOrigin'),
    noProgressThreshold: d.field(d.ref('ExecutionDecisionSettingOrigin'), { optional: true })
  }),

  EffectiveLimitsProjection: d.obj({
    iterationCap: effectiveLimit(d.num()),
    idleTimeoutSeconds: effectiveLimit(d.num()),
    maxDurationSeconds: effectiveLimit(d.num()),
    retryCap: effectiveLimit(d.num()),
    onRetryCap: effectiveLimit(d.enum(RETRY_CAP_OUTCOMES)),
    unchangedComparisons: d.obj({
      value: d.num(),
      origin: d.ref('LimitOrigin'),
      state: d.enum(['active', 'disabled', 'inert-cap-outcome', 'inert-no-retry-condition'])
    }),
    phaseRetryPolicy: d.field(
      d.obj({
        retryCondition: d.str(),
        capOutcome: d.enum(RETRY_CAP_OUTCOMES),
        noProgressThreshold: d.field(d.num(), { optional: true }),
        settingSources: d.ref('ExecutionDecisionSettingSources')
      }),
      { optional: true }
    ),
    spend: d.discUnion('kind', {
      none: d.obj({ kind: d.lit('none') }),
      bounded: d.obj({
        kind: d.lit('bounded'),
        denomination: d.enum(['usd', 'tokens']),
        limit: effectiveLimit(d.num()),
        trust: d.enum(['enforced', 'not-trustworthy'])
      })
    })
  }),

  PhaseTile: d.obj({
    name: d.ref('PhaseName'),
    order: d.num(),
    state: d.ref('PhaseState'),
    iteration: d.num(),
    lastResult: d.field(d.ref('PhaseResultState'), { nullable: true }),
    elapsedMs: d.num(),
    subProgress: d.field(
      d.obj({
        current: d.num(),
        total: d.num(),
        label: d.enum(['task', 'iteration'])
      }),
      { nullable: true }
    ),
    displayName: d.field(d.str(), { optional: true }),
    isRequired: d.field(d.bool(), { optional: true }),
    isFuture: d.field(d.bool(), { optional: true }),
    phaseMessage: d.field(
      d.obj({
        fromPhaseId: d.str(),
        entryCount: d.num(),
        byteSize: d.num(),
        truncated: d.bool(),
        invalidReason: d.field(d.str(), { nullable: true })
      }),
      { optional: true, nullable: true }
    ),
    lastRetryDecision: d.field(
      d.obj({
        missingKeys: d.arr(d.str())
      }),
      { optional: true }
    )
  }),

  TaskPhaseProgressProjection: d.obj({
    settled: d.int({ min: 0 }),
    total: d.int({ min: 0 })
  }),

  DegradedPhaseEntry: d.obj({
    phaseId: d.str(),
    condition: d.str()
  }),

  QueueSummary: d.obj({
    id: d.str(),
    name: d.str(),
    position: d.num(),
    state: d.enum(['active', 'manually-paused']),
    pauseSource: d.field(d.enum(['operator', 'cascade', 'retry-cap']), { nullable: true }),
    schedule: d.field(
      d.obj({
        expression: d.str(),
        kind: d.enum(['relative', 'absolute']),
        targetAt: d.str()
      }),
      { nullable: true }
    ),
    taskCount: d.num({ min: 0 }),
    failurePolicy: d.ref('QueueFailurePolicy'),
    failurePolicyOverride: d.field(d.ref('QueueFailurePolicy'), { nullable: true })
  }),

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

  AuditTailEntry: d.obj({
    id: d.str(),
    timestamp: d.str(),
    phase: d.field(d.ref('PhaseName'), { nullable: true }),
    category: d.ref('AuditCategory'),
    summary: d.str(),
    runId: d.str(),
    scope: d.enum(['task', 'system']),
    taskId: d.field(d.str(), { optional: true }),
    phaseId: d.field(d.str(), { optional: true }),
    outcome: d.field(d.enum(['success', 'error', 'pending']), { optional: true }),
    runner: d.field(d.str(), { optional: true })
  }),

  DebugLogEntry: d.obj({
    id: d.num(),
    timestamp: d.str(),
    level: d.enum(RUNTIME_LOG_LEVELS),
    message: d.str()
  }),

  CliMonitorState: d.obj({
    runId: d.str(),
    phase: d.ref('PhaseName'),
    status: d.ref('MonitorStatus'),
    pid: d.field(d.num(), { nullable: true }),
    startedAt: d.str(),
    lastStdoutAt: d.field(d.str(), { nullable: true }),
    lastStderrAt: d.field(d.str(), { nullable: true }),
    lastProgressAt: d.field(d.str(), { nullable: true }),
    stdoutLines: d.num({ min: 0 }),
    stderrLines: d.num({ min: 0 }),
    exitCode: d.field(d.num(), { nullable: true }),
    signal: d.field(d.str(), { nullable: true }),
    detectedIssues: d.arr(d.enum(['rate_limited', 'stall'])),
    msSinceLastStdout: d.field(d.num(), { nullable: true }),
    msSinceLastStderr: d.field(d.num(), { nullable: true }),
    maxDurationMs: d.field(d.num(), { nullable: true }),
    deadlineApproaching: d.bool(),
    held: d.bool()
  }),

  TelemetrySnapshot: d.obj({
    pid: d.num(),
    status: d.ref('TelemetryStatus'),
    cpuPercent: d.field(d.num(), { nullable: true }),
    memoryRssBytes: d.field(d.num(), { nullable: true }),
    uptimeMs: d.field(d.num(), { nullable: true }),
    sampledAt: d.str()
  }),

  BackendEffectProjection: d.obj({
    effect: d.enum(CONTAINMENT_EFFECTS),
    outcome: d.enum(EFFECT_OUTCOMES),
    basis: d.enum(EVIDENCE_BASES)
  }),

  BackendQualificationProjection: d.obj({
    identityState: d.enum(IDENTITY_STATES),
    versionMinor: d.field(d.str(), { nullable: true }),
    effects: d.arr(d.ref('BackendEffectProjection')),
    admission: d.enum(BACKEND_ADMISSION_PROJECTIONS)
  }),

  BackendPosture: d.obj({
    kind: d.ref('BackendRunnerKind'),
    containment: d.enum(BACKEND_CONTAINMENTS),
    mechanism: d.enum(BACKEND_CONTAINMENT_MECHANISMS),
    grant: d.enum(BACKEND_GRANT_STATES),
    problem: d.field(d.str(), { optional: true }),
    refusal: d.field(d.str(), { optional: true }),
    notice: d.field(d.str(), { optional: true }),
    qualification: d.field(d.ref('BackendQualificationProjection'), { optional: true })
  }),

  BackendGrantEntryProblems: d.arr(d.str()),

  BuilderVersionEntry: d.obj({
    versionId: d.str(),
    createdAt: d.num(),
    publishedAt: d.field(d.num(), { nullable: true }),
    isActive: d.bool(),
    note: d.field(d.str(), { nullable: true })
  }),

  ChangedField: d.discUnion('change', {
    differs: d.obj({
      field: d.str(),
      change: d.lit('differs')
    }),
    collection: d.obj({
      field: d.str(),
      change: d.lit('collection'),
      added: d.arr(d.str()),
      removed: d.arr(d.str()),
      reordered: d.arr(d.str())
    })
  }),

  ChangedFieldSummary: d.discUnion('kind', {
    'no-prior-version': d.obj({ kind: d.lit('no-prior-version') }),
    unchanged: d.obj({ kind: d.lit('unchanged') }),
    changed: d.obj({
      kind: d.lit('changed'),
      fields: d.arr(d.ref('ChangedField'))
    })
  }),

  BuilderLifecycle: d.obj({
    state: d.enum(['draft', 'active', 'active-with-draft']),
    createdAt: d.num(),
    updatedAt: d.num(),
    activeVersionId: d.field(d.str(), { optional: true }),
    expectedDraftVersion: d.str(),
    versions: d.arr(d.ref('BuilderVersionEntry')),
    changedFields: d.field(d.ref('ChangedFieldSummary'), { optional: true })
  }),

  PhaseSourceStatus: d.enum(SOURCE_STATUSES),
  PipelineSourceStatus: d.enum(SOURCE_STATUSES),
  WorkflowSourceStatus: d.enum(SOURCE_STATUSES),

  DecisionField: d.obj({
    fieldId: d.str(),
    type: d.enum(DECISION_FIELD_TYPES),
    required: d.bool(),
    selector: d.arr(d.str())
  }),

  ResultContractSource: d.discUnion('kind', {
    'declared-output': d.obj({
      kind: d.lit('declared-output'),
      outputKey: d.str()
    }),
    'backend-result': d.obj({
      kind: d.lit('backend-result')
    }),
    'diagnostic-records': d.obj({
      kind: d.lit('diagnostic-records'),
      recordType: d.str()
    })
  }),

  TypedOperand: d.discUnion('source', {
    'result-field': d.obj({
      source: d.lit('result-field'),
      fieldId: d.str()
    }),
    'node-result': d.obj({
      source: d.lit('node-result'),
      nodeId: d.str(),
      fieldId: d.str()
    })
  }),

  TypedLeaf: d.obj({
    left: d.ref('TypedOperand'),
    operator: d.enum(TYPED_CONDITION_OPERATORS),
    right: d.field(
      d.union([d.ref('ScalarValue'), d.arr(d.ref('ScalarValue'))]),
      { optional: true }
    )
  }),

  TypedConditionTest: d.union([
    d.ref('TypedLeaf'),
    d.obj({ all: d.arr(d.ref('TypedLeaf')) }),
    d.obj({ any: d.arr(d.ref('TypedLeaf')) })
  ]),

  TypedCondition: d.obj({
    version: d.lit(1),
    kind: d.lit('typed'),
    test: d.ref('TypedConditionTest')
  }),

  ResultContract: d.obj({
    version: d.lit(1),
    operator: d.enum(RESULT_OPERATOR_KINDS),
    operatorVersion: d.lit(1),
    fields: d.arr(d.ref('DecisionField')),
    source: d.ref('ResultContractSource'),
    completion: d.ref('TypedCondition')
  }),

  PhaseDefinition: d.union([
    d.obj({
      ...PHASE_DEFINITION_BASE_FIELDS,
      instruction: d.str()
    }),
    d.obj({
      ...PHASE_DEFINITION_BASE_FIELDS,
      skill: d.str()
    })
  ]),

  PipelineInputPort: d.obj({
    portId: d.str(),
    label: d.str(),
    type: d.enum(PIPELINE_INPUT_PORT_TYPES),
    required: d.field(d.bool(), { optional: true }),
    description: d.field(d.str(), { optional: true })
  }),

  PipelineOutputPort: d.obj({
    portId: d.str(),
    label: d.str(),
    type: d.enum(PIPELINE_OUTPUT_PORT_TYPES),
    description: d.field(d.str(), { optional: true })
  }),

  PhaseBinding: d.discUnion('kind', {
    input: d.obj({
      kind: d.lit('input'),
      phaseIndex: d.int({ min: 0 }),
      inputKey: d.str(),
      source: d.discUnion('from', {
        'pipeline-input': d.obj({
          from: d.lit('pipeline-input'),
          portId: d.str()
        }),
        'phase-output': d.obj({
          from: d.lit('phase-output'),
          phaseIndex: d.int({ min: 0 }),
          portId: d.str()
        })
      })
    }),
    output: d.obj({
      kind: d.lit('output'),
      phaseIndex: d.int({ min: 0 }),
      portId: d.str(),
      outputKey: d.str()
    })
  }),

  PipelineExecutionDefaults: d.obj({
    runner: d.field(d.str(), { optional: true }),
    model: d.field(d.str(), { optional: true }),
    effort: d.field(d.enum(PHASE_EFFORT_LEVELS), { optional: true }),
    timeoutSeconds: d.field(d.num(), { optional: true })
  }),

  PipelineDefinition: d.obj({
    pipelineId: d.str(),
    name: d.str(),
    description: d.field(d.str(), { optional: true }),
    version: d.num(),
    phaseIds: d.arr(d.str()),
    inputs: d.arr(d.ref('PipelineInputPort')),
    outputs: d.arr(d.ref('PipelineOutputPort')),
    bindings: d.arr(d.ref('PhaseBinding')),
    executionDefaults: d.field(d.ref('PipelineExecutionDefaults'), { optional: true }),
    recommendedNext: d.arr(d.str())
  }),

  WorkflowConditionOperand: d.discUnion('source', {
    'node-output': d.obj({
      source: d.lit('node-output'),
      nodeId: d.str(),
      field: d.str()
    }),
    'node-status': d.obj({
      source: d.lit('node-status'),
      nodeId: d.str()
    })
  }),

  WorkflowCondition: d.obj({
    left: d.ref('WorkflowConditionOperand'),
    operator: d.enum(WORKFLOW_CONDITION_OPERATORS),
    right: d.field(
      d.union([d.ref('ScalarValue'), d.arr(d.ref('ScalarValue'))]),
      { optional: true }
    )
  }),

  ContextSelector: d.obj({
    selectorId: d.str(),
    sourceNodePath: d.str(),
    required: d.bool(),
    priority: d.num()
  }),

  HandoffPolicy: d.obj({
    version: d.lit(1),
    approval: d.enum(APPROVAL_MODES),
    session: d.enum(SESSION_POLICIES),
    selectors: d.arr(d.ref('ContextSelector'))
  }),

  CandidateRetryConfig: d.obj({
    initialDelayMs: d.field(d.num(), { optional: true }),
    multiplier: d.field(d.num(), { optional: true }),
    maxDelayMs: d.field(d.num(), { optional: true })
  }),

  CandidateSpec: d.obj({
    candidateId: d.str(),
    nodeId: d.str(),
    priority: d.field(d.num(), { optional: true }),
    maxAttempts: d.field(d.num(), { optional: true }),
    retry: d.field(d.ref('CandidateRetryConfig'), { optional: true }),
    allowUnverifiedTrial: d.field(d.bool(), { optional: true })
  }),

  CandidateBlockControl: d.obj({
    version: d.lit(1),
    kind: d.lit('candidate-block'),
    candidates: d.arr(d.ref('CandidateSpec')),
    availabilityPolicy: d.field(d.enum(CANDIDATE_AVAILABILITY_POLICIES), { optional: true }),
    maxDispatches: d.field(d.num(), { optional: true }),
    monitoringWindowMs: d.field(d.num(), { optional: true }),
    budget: d.field(
      d.discUnion('mode', {
        'count-only': d.obj({ mode: d.lit('count-only') }),
        'strict-usd': d.obj({ mode: d.lit('strict-usd'), limitMicrousd: d.num() })
      }),
      { optional: true }
    )
  }),

  WorkflowDecisionResultField: d.obj({
    fieldId: d.str(),
    type: d.enum(DECISION_FIELD_TYPES),
    required: d.bool()
  }),

  DecisionResultBinding: d.obj({
    fieldId: d.str(),
    source: d.discUnion('kind', {
      'node-result': d.obj({
        kind: d.lit('node-result'),
        nodeId: d.str(),
        fieldId: d.str()
      }),
      'selected-candidate': d.obj({
        kind: d.lit('selected-candidate'),
        fieldId: d.str()
      })
    })
  }),

  WorkflowDecisionResults: d.obj({
    version: d.lit(1),
    fields: d.arr(d.ref('WorkflowDecisionResultField')),
    bindings: d.arr(d.ref('DecisionResultBinding'))
  }),

  WorkflowNodeControl: d.discUnion('kind', {
    repeat: d.obj({
      version: d.lit(1),
      kind: d.lit('repeat'),
      maxIterations: d.num(),
      until: d.ref('TypedCondition'),
      carry: d.arr(
        d.obj({
          fieldId: d.str(),
          inputPortId: d.str()
        })
      ),
      onExhausted: d.field(d.enum(REPEAT_ON_EXHAUSTED_POLICIES), { optional: true })
    }),
    'for-each': d.obj({
      version: d.lit(1),
      kind: d.lit('for-each'),
      collection: d.discUnion('source', {
        'workflow-input': d.obj({
          source: d.lit('workflow-input'),
          portId: d.str()
        }),
        'node-output': d.obj({
          source: d.lit('node-output'),
          nodeId: d.str(),
          portId: d.str()
        })
      }),
      itemKeyField: d.field(d.str(), { optional: true }),
      itemInputPortId: d.str(),
      maxItems: d.field(d.num(), { optional: true }),
      onItemError: d.field(d.enum(FOR_EACH_ON_ITEM_ERROR_POLICIES), { optional: true })
    })
  }),

  WorkflowInputPort: d.obj({
    portId: d.str(),
    label: d.str(),
    type: d.enum(PIPELINE_INPUT_PORT_TYPES),
    required: d.field(d.bool(), { optional: true }),
    description: d.field(d.str(), { optional: true })
  }),

  WorkflowOutputPort: d.obj({
    portId: d.str(),
    label: d.str(),
    type: d.enum(PIPELINE_OUTPUT_PORT_TYPES),
    required: d.field(d.bool(), { optional: true }),
    description: d.field(d.str(), { optional: true })
  }),

  WorkflowNode: d.obj({
    nodeId: d.str(),
    kind: d.field(d.enum(WORKFLOW_NODE_KINDS), { optional: true }),
    phaseId: d.field(d.str(), { optional: true }),
    workflowId: d.field(d.str(), { optional: true }),
    pipelineId: d.field(d.str(), { optional: true }),
    label: d.field(d.str(), { optional: true }),
    control: d.field(d.ref('WorkflowNodeControl'), { optional: true })
  }),

  WorkflowConnectionEndpoint: d.obj({
    nodeId: d.str(),
    portId: d.field(d.str(), { optional: true }),
    kind: d.field(d.enum(['node', 'return']), { optional: true })
  }),

  WorkflowConnection: d.obj({
    from: d.obj({
      nodeId: d.str(),
      portId: d.field(d.str(), { optional: true })
    }),
    to: d.ref('WorkflowConnectionEndpoint'),
    handoff: d.field(d.enum(WORKFLOW_HANDOFF_MODES), { optional: true }),
    condition: d.field(
      d.union([d.ref('WorkflowCondition'), d.ref('TypedCondition')]),
      { optional: true }
    ),
    priority: d.field(d.num(), { optional: true }),
    isDefault: d.field(d.bool(), { optional: true }),
    selection: d.field(d.enum(WORKFLOW_SELECTION_RULES), { optional: true }),
    contextPolicy: d.field(d.ref('HandoffPolicy'), { optional: true })
  }),

  WorkflowBinding: d.discUnion('kind', {
    input: d.obj({
      kind: d.lit('input'),
      nodeId: d.str(),
      inputKey: d.str(),
      type: d.field(d.enum(PIPELINE_INPUT_PORT_TYPES), { optional: true }),
      required: d.field(d.bool(), { optional: true }),
      source: d.discUnion('from', {
        'workflow-input': d.obj({
          from: d.lit('workflow-input'),
          portId: d.str()
        }),
        'node-output': d.obj({
          from: d.lit('node-output'),
          nodeId: d.str(),
          portId: d.str()
        })
      }),
      selection: d.field(d.enum(WORKFLOW_SELECTION_RULES), { optional: true })
    }),
    output: d.obj({
      kind: d.lit('output'),
      nodeId: d.str(),
      portId: d.str(),
      outputKey: d.field(d.str(), { optional: true }),
      sourcePortId: d.field(d.str(), { optional: true }),
      type: d.field(d.enum(PIPELINE_OUTPUT_PORT_TYPES), { optional: true }),
      label: d.field(d.str(), { optional: true }),
      selection: d.field(d.enum(WORKFLOW_SELECTION_RULES), { optional: true })
    })
  }),

  WorkflowDefinition: d.obj({
    workflowId: d.str(),
    name: d.str(),
    description: d.field(d.str(), { optional: true }),
    version: d.num(),
    inputs: d.field(d.arr(d.ref('WorkflowInputPort')), { optional: true }),
    outputs: d.field(d.arr(d.ref('WorkflowOutputPort')), { optional: true }),
    nodes: d.arr(d.ref('WorkflowNode')),
    connections: d.arr(d.ref('WorkflowConnection')),
    bindings: d.field(d.arr(d.ref('WorkflowBinding')), { optional: true }),
    startNodeIds: d.arr(d.str()),
    executionDefaults: d.field(d.ref('PipelineExecutionDefaults'), { optional: true }),
    recommendedNext: d.field(d.arr(d.str()), { optional: true }),
    control: d.field(d.ref('CandidateBlockControl'), { optional: true }),
    decisionResults: d.field(d.ref('WorkflowDecisionResults'), { optional: true })
  }),

  WorkflowDerivedPort: d.obj({
    nodeId: d.str(),
    portId: d.str(),
    label: d.str(),
    type: d.enum(WORKFLOW_DERIVED_PORT_TYPES)
  }),

  WorkflowCatalogFieldErrorProjection: d.obj({
    field: d.str(),
    code: d.str(),
    message: d.str()
  }),

  PipelineDef: d.obj({
    id: d.str(),
    name: d.str(),
    phases: d.arr(d.str()),
    description: d.field(d.str(), { optional: true }),
    version: d.field(d.num(), { optional: true }),
    inputs: d.field(d.arr(d.ref('PipelineInputPort')), { optional: true }),
    outputs: d.field(d.arr(d.ref('PipelineOutputPort')), { optional: true }),
    bindings: d.field(d.arr(d.ref('PhaseBinding')), { optional: true }),
    executionDefaults: d.field(d.ref('PipelineExecutionDefaults'), { optional: true }),
    recommendedNext: d.field(d.arr(d.str()), { optional: true })
  }),

  PhaseDef: d.obj({
    id: d.str(),
    name: d.str(),
    description: d.field(d.str(), { optional: true }),
    version: d.field(d.num(), { optional: true }),
    instruction: d.field(d.str(), { optional: true }),
    skill: d.field(d.str(), { optional: true }),
    model: d.field(d.str(), { optional: true }),
    effort: d.field(d.enum(PHASE_EFFORT_LEVELS), { optional: true }),
    timeoutSeconds: d.field(d.num(), { optional: true }),
    spendBoundUsd: d.field(d.num(), { optional: true }),
    spendBoundTokens: d.field(d.num(), { optional: true }),
    loopable: d.field(d.bool(), { optional: true }),
    retryCondition: d.field(d.str(), { optional: true }),
    isRequired: d.field(d.bool(), { optional: true }),
    forceContinueOnRetryCap: d.field(d.bool(), { optional: true }),
    onRetryCap: d.field(d.enum(RETRY_CAP_OUTCOMES), { optional: true }),
    runner: d.field(d.ref('BackendRunnerKind'), { optional: true }),
    sideEffects: d.field(d.enum(PHASE_SIDE_EFFECTS), { optional: true }),
    evidencePolicy: d.field(d.enum(PHASE_EVIDENCE_POLICIES), { optional: true }),
    evidencePolicyDeclaredAt: d.field(d.enum(EVIDENCE_POLICY_ORIGINS), { optional: true }),
    hostVerification: d.field(d.enum(PHASE_HOST_VERIFICATIONS), { optional: true }),
    hostVerificationDeclaredAt: d.field(d.enum(EVIDENCE_POLICY_ORIGINS), { optional: true }),
    promptVersion: d.field(d.str(), { optional: true }),
    capabilities: d.field(d.arr(d.enum(ALL_PHASE_CAPABILITIES)), { optional: true }),
    resultContract: d.field(d.ref('ResultContract'), { optional: true }),
    nativeReview: d.field(d.enum(NATIVE_REVIEW_KINDS), { optional: true })
  }),

  LaunchablePort: d.obj({
    portId: d.str(),
    label: d.str(),
    type: d.enum(PIPELINE_INPUT_PORT_TYPES),
    required: d.field(d.bool(), { optional: true }),
    description: d.field(d.str(), { optional: true }),
    nodeId: d.field(d.str(), { optional: true })
  }),

  LaunchableOutputPort: d.obj({
    portId: d.str(),
    label: d.str(),
    type: d.str(),
    required: d.field(d.bool(), { optional: true }),
    description: d.field(d.str(), { optional: true }),
    nodeId: d.field(d.str(), { optional: true })
  }),

  LaunchableNodeSummary: d.obj({
    nodeId: d.str(),
    kind: d.enum(['phase', 'workflow', 'pipeline']),
    targetId: d.str(),
    label: d.field(d.str(), { optional: true })
  }),

  CapabilityNotice: d.obj({
    phaseName: d.str(),
    backend: d.ref('BackendRunnerKind'),
    outcome: d.enum(['residual', 'refused']),
    text: d.str()
  }),

  LaunchPhaseSettings: d.obj({
    phaseName: d.str(),
    backend: d.ref('BackendRunnerKind'),
    model: d.discUnion('kind', {
      value: d.obj({ kind: d.lit('value'), value: d.str() }),
      'backend-default': d.obj({ kind: d.lit('backend-default') })
    }),
    effort: d.discUnion('kind', {
      value: d.obj({ kind: d.lit('value'), value: d.enum(PHASE_EFFORT_LEVELS) }),
      'backend-default': d.obj({ kind: d.lit('backend-default') })
    }),
    idleTimeoutSeconds: effectiveLimit(d.num())
  }),

  LaunchRunSettings: d.obj({
    phases: d.arr(d.ref('LaunchPhaseSettings')),
    maxDurationSeconds: effectiveLimit(d.num())
  }),

  Launchable: d.obj({
    kind: d.enum(['pipeline', 'workflow']),
    id: d.str(),
    name: d.str(),
    description: d.field(d.str(), { optional: true }),
    activeVersionId: d.str(),
    inputs: d.arr(d.ref('LaunchablePort')),
    outputs: d.field(d.arr(d.ref('LaunchableOutputPort')), { optional: true }),
    startNodeIds: d.field(d.arr(d.str()), { optional: true }),
    nodes: d.field(d.arr(d.ref('LaunchableNodeSummary')), { optional: true }),
    backends: d.field(d.arr(d.ref('BackendRunnerKind')), { optional: true }),
    capabilityNotices: d.field(d.arr(d.ref('CapabilityNotice')), { optional: true }),
    runSettings: d.field(d.ref('LaunchRunSettings'), { optional: true })
  }),

  LaunchSection: d.discUnion('state', {
    entries: d.obj({
      state: d.lit('entries'),
      entries: d.arr(d.ref('Launchable'))
    }),
    'no-definitions': d.obj({ state: d.lit('no-definitions') }),
    'none-active': d.obj({ state: d.lit('none-active') })
  }),

  LaunchProjection: d.obj({
    pipelines: d.ref('LaunchSection'),
    workflows: d.ref('LaunchSection')
  }),

  ExecutionDecisionBranchRecord: d.obj({
    connectionIndex: d.int({ min: -1 }),
    targetNodeId: d.field(d.str(), { optional: true }),
    isDefault: d.bool(),
    priority: d.field(d.int(), { optional: true }),
    disposition: d.enum(EXECUTION_BRANCH_DISPOSITIONS),
    summary: d.str(),
    observedValue: d.field(d.ref('ScalarValue'), { optional: true })
  }),

  ExecutionDecisionObservation: d.obj({
    version: d.lit(1),
    decisionId: d.str(),
    runId: d.str(),
    nodeId: d.str(),
    attemptId: d.field(d.str(), { optional: true }),
    evaluatedAt: d.num({ min: 0 }),
    iteration: d.int({ min: 1 }),
    maxIterations: d.int({ min: 1 }),
    retryCondition: d.str(),
    capOutcome: d.enum(RETRY_CAP_OUTCOMES),
    noProgressThreshold: d.field(d.int({ min: 0 }), { optional: true }),
    settingSources: d.ref('ExecutionDecisionSettingSources'),
    observedValues: d.rec(d.ref('ScalarValue')),
    exitReason: d.enum(EXECUTION_DECISION_EXIT_REASONS),
    branches: d.arr(d.ref('ExecutionDecisionBranchRecord'))
  }),

  ControlLegalActionEntry: d.obj({
    kind: d.enum(CONTROL_ACTION_KINDS),
    allowed: d.bool(),
    reason: d.field(d.enum(CONTROL_COMMAND_REFUSAL_REASONS), { optional: true }),
    candidateId: d.field(d.str(), { optional: true })
  }),

  ControlCandidateProjection: d.obj({
    candidateId: d.str(),
    nodeId: d.str(),
    backend: d.str(),
    priority: d.num(),
    authoredOrder: d.num(),
    attemptsUsed: d.num({ min: 0 }),
    maxAttempts: d.num({ min: 1 }),
    eligibility: d.enum(['eligible', 'intervention', 'retired']),
    retirementReason: d.field(d.enum(['attempts-exhausted', 'permanent-failure']), { optional: true }),
    policyExcluded: d.bool(),
    availabilityStatus: d.field(d.str(), { optional: true }),
    availabilitySource: d.field(d.str(), { optional: true }),
    fresh: d.field(d.bool(), { optional: true }),
    resetAt: d.field(d.num(), { optional: true }),
    nextCheckAt: d.field(d.num(), { optional: true }),
    notBefore: d.field(d.num(), { optional: true }),
    phaseId: d.field(d.str(), { optional: true }),
    phaseName: d.field(d.str(), { optional: true }),
    instructionSummary: d.field(d.str(), { optional: true }),
    operatorKind: d.field(d.str(), { optional: true }),
    quotaIdentity: d.field(d.str(), { optional: true }),
    permitWaitPosition: d.field(d.num(), { optional: true })
  }),

  ConnectedRepeatCompletedPassProjection: d.obj({
    iteration: d.num(),
    invocationId: d.str(),
    status: d.enum(['completed', 'failed', 'canceled']),
    resultRef: d.field(d.str(), { optional: true })
  }),

  ConnectedRepeatNodeProjection: d.obj({
    version: d.field(d.lit(1), { optional: true }),
    kind: d.field(d.lit('repeat'), { optional: true }),
    iteration: d.num(),
    currentPass: d.field(d.num(), { optional: true }),
    maxIterations: d.num(),
    conditionResult: d.enum(['true', 'false', 'unresolved', 'not-evaluated']),
    currentChildInvocationId: d.field(d.str(), { optional: true, nullable: true }),
    onExhausted: d.enum(REPEAT_ON_EXHAUSTED_POLICIES),
    exhaustionReason: d.field(d.str(), { optional: true }),
    carryEnvelopeRef: d.field(d.str(), { optional: true }),
    carryValues: d.field(d.rec(d.ref('ScalarValue')), { optional: true }),
    leafAttemptCount: d.num({ min: 0 }),
    rootDispatchesUsed: d.field(d.num({ min: 0 }), { optional: true }),
    rootMaxDispatches: d.field(d.num({ min: 0 }), { optional: true }),
    completedPasses: d.arr(d.ref('ConnectedRepeatCompletedPassProjection')),
    legalActions: d.field(d.arr(d.ref('ControlLegalActionEntry')), { optional: true })
  }),

  ConnectedForEachSlotProjection: d.obj({
    index: d.int({ min: 0 }),
    itemKey: d.str(),
    invocationId: d.field(d.str(), { optional: true }),
    state: d.enum(['pending', 'executing', 'completed', 'failed']),
    resultRef: d.field(d.str(), { optional: true }),
    error: d.field(
      d.obj({
        code: d.enum(['child-failed', 'invalid-child-result', 'dispatch-budget-exhausted']),
        message: d.str()
      }),
      { optional: true }
    )
  }),

  ConnectedForEachNodeProjection: d.obj({
    version: d.lit(1),
    kind: d.lit('for-each'),
    collectionRef: d.field(d.str(), { optional: true }),
    collectionSha256: d.field(d.str(), { optional: true }),
    itemCount: d.int({ min: 0 }),
    currentIndex: d.int({ min: 0 }),
    onItemError: d.enum(FOR_EACH_ON_ITEM_ERROR_POLICIES),
    hasErrors: d.bool(),
    errorCount: d.int({ min: 0 }),
    resultIndexRef: d.field(d.str(), { optional: true }),
    refusalCode: d.field(d.str(), { optional: true }),
    leafAttemptCount: d.num({ min: 0 }),
    rootDispatchesUsed: d.field(d.num({ min: 0 }), { optional: true }),
    rootMaxDispatches: d.field(d.num({ min: 0 }), { optional: true }),
    slots: d.arr(d.ref('ConnectedForEachSlotProjection')),
    legalActions: d.field(d.arr(d.ref('ControlLegalActionEntry')), { optional: true })
  }),

  ControlProjection: d.obj({
    version: d.lit(1),
    rootRunId: d.str(),
    queueId: d.str(),
    invocationId: d.str(),
    workflowId: d.str(),
    nodeId: d.field(d.str(), { optional: true }),
    generation: d.int({ min: 0 }),
    frameKind: d.enum(['root-workflow', 'child-workflow', 'candidate-block', 'repeat', 'for-each']),
    state: d.str(),
    availabilityPolicy: d.field(d.enum(CANDIDATE_AVAILABILITY_POLICIES), { optional: true }),
    selectedCandidateId: d.field(d.str(), { optional: true }),
    manualSelectionCandidateId: d.field(d.str(), { optional: true }),
    allowedCandidateIds: d.field(d.arr(d.str()), { optional: true }),
    candidates: d.field(d.arr(d.ref('ControlCandidateProjection')), { optional: true }),
    attemptsUsed: d.num({ min: 0 }),
    maxDispatches: d.num({ min: 0 }),
    rootDispatchesUsed: d.num({ min: 0 }),
    rootMaxDispatches: d.num({ min: 0 }),
    enclosingIteration: d.field(d.num(), { optional: true }),
    enclosingMaxIterations: d.field(d.num(), { optional: true }),
    monitoringStartedAt: d.field(d.num(), { optional: true }),
    monitoringExpiresAt: d.field(d.num(), { optional: true }),
    monitoringRenewals: d.field(d.num(), { optional: true }),
    resultStatus: d.field(d.str(), { optional: true }),
    resultReason: d.field(d.str(), { optional: true }),
    recoveryCoverage: d.field(d.enum(['complete', 'partial', 'unavailable']), { optional: true }),
    effectCertainty: d.field(d.enum(['safe', 'uncertain', 'unknown']), { optional: true }),
    manifestTruncated: d.field(d.bool(), { optional: true }),
    preexistingDirtyCount: d.field(d.num(), { optional: true }),
    spendMode: d.enum(['count-only', 'strict-usd']),
    spendEnforcementQuality: d.enum(['verified', 'estimated', 'unavailable', 'count-only']),
    verifiedMicrousd: d.field(d.num(), { optional: true }),
    estimatedMicrousd: d.field(d.num(), { optional: true }),
    unpricedAttemptCount: d.field(d.num(), { optional: true }),
    maxMicrousd: d.field(d.num(), { optional: true }),
    activeAttemptOvershootNote: d.field(d.str(), { optional: true }),
    durableNotices: d.field(d.arr(d.str()), { optional: true }),
    policyObservations: d.field(d.arr(d.rec(d.ref('ScalarValue'))), { optional: true }),
    repeatProjection: d.field(d.ref('ConnectedRepeatNodeProjection'), { optional: true }),
    forEachProjection: d.field(d.ref('ConnectedForEachNodeProjection'), { optional: true }),
    legalActions: d.arr(d.ref('ControlLegalActionEntry')),
    evidenceRefs: d.arr(d.str())
  }),

  ConnectedInvocationAttemptProjection: d.obj({
    attemptId: d.str(),
    attemptIndex: d.int({ min: 0 }),
    nodeId: d.str(),
    nodeKind: d.enum(['phase', 'workflow']),
    status: d.str(),
    startedAt: d.num(),
    endedAt: d.field(d.num(), { optional: true }),
    queueItemId: d.field(d.str(), { optional: true }),
    childInvocationId: d.field(d.str(), { optional: true }),
    failureCode: d.field(d.str(), { optional: true })
  }),

  ConnectedPendingHandoffProjection: d.obj({
    fromNodeId: d.str(),
    toNodeId: d.field(d.str(), { nullable: true }),
    connectionId: d.field(d.str(), { optional: true }),
    boundInputPortIds: d.arr(d.str())
  }),

  ConnectedInvocationProjection: d.obj({
    invocationId: d.str(),
    parentInvocationId: d.field(d.str(), { nullable: true }),
    workflowId: d.str(),
    workflowName: d.field(d.str(), { optional: true }),
    frozenVersionId: d.field(d.str(), { optional: true }),
    depth: d.int({ min: 0 }),
    nodePath: d.str(),
    status: d.str(),
    currentNodeId: d.field(d.str(), { nullable: true }),
    activeAttemptId: d.field(d.str(), { nullable: true }),
    activeAttemptIndex: d.field(d.int({ min: 0 }), { nullable: true }),
    allowedActions: d.arr(d.ref('WorkflowControlAction')),
    waitingReason: d.field(d.str(), { nullable: true }),
    pauseCause: d.field(d.str(), { nullable: true }),
    pauseExplanation: d.field(d.str(), { optional: true, nullable: true }),
    pauseGuidance: d.field(d.str(), { optional: true, nullable: true }),
    failureReason: d.field(d.str(), { nullable: true }),
    pendingRetryAt: d.field(d.num(), { nullable: true }),
    pendingRetryCause: d.field(d.str(), { nullable: true }),
    pendingHandoff: d.field(d.ref('ConnectedPendingHandoffProjection'), {
      optional: true,
      nullable: true
    }),
    outputPortIds: d.arr(d.str()),
    attempts: d.arr(d.ref('ConnectedInvocationAttemptProjection')),
    controlProjection: d.field(d.ref('ControlProjection'), { optional: true })
  }),

  ConnectedNodeProjection: d.obj({
    nodeId: d.str(),
    pipelineId: d.str(),
    state: d.enum(CONNECTED_NODE_STATES),
    actions: d.arr(d.enum(['start', 'restart'])),
    attemptCount: d.int({ min: 0 }),
    latestQueueItemId: d.field(d.str(), { optional: true }),
    nodeKind: d.field(d.enum(['phase', 'workflow', 'pipeline']), { optional: true }),
    label: d.field(d.str(), { optional: true }),
    frozenVersionId: d.field(d.str(), { optional: true }),
    childInvocationIds: d.field(d.arr(d.str()), { optional: true }),
    decisionObservation: d.field(d.ref('ExecutionDecisionObservation'), { optional: true }),
    repeatProjection: d.field(d.ref('ConnectedRepeatNodeProjection'), { optional: true }),
    forEachProjection: d.field(d.ref('ConnectedForEachNodeProjection'), { optional: true })
  }),

  ConnectedRunProjection: d.obj({
    connectedRunId: d.str(),
    workflowId: d.str(),
    revision: d.int({ min: 0 }),
    hydrating: d.bool(),
    nodes: d.arr(d.ref('ConnectedNodeProjection')),
    queueId: d.field(d.str(), { optional: true }),
    status: d.field(d.str(), { optional: true }),
    rootInvocationId: d.field(d.str(), { optional: true }),
    activeInvocationId: d.field(d.str(), { optional: true }),
    rootAllowedActions: d.field(d.arr(d.ref('WorkflowControlAction')), { optional: true }),
    recoveryDisposition: d.field(
      d.obj({
        status: d.str(),
        reason: d.str(),
        targetInvocationId: d.str(),
        targetAttemptId: d.field(d.str(), { optional: true })
      }),
      { optional: true, nullable: true }
    ),
    invocations: d.field(d.arr(d.ref('ConnectedInvocationProjection')), { optional: true }),
    decisionObservations: d.field(d.arr(d.ref('ExecutionDecisionObservation')), { optional: true }),
    controlProjection: d.field(d.ref('ControlProjection'), { optional: true })
  })
});
