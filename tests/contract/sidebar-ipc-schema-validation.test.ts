// FR-R7-05 (SC-003) — Validates real host-emitted WorkflowSnapshots and inbound
// commands against the generated Draft 2020-12 JSON Schema
// (`src/contracts/generated/schemas/sidebar-ipc.schema.json`) using the
// zero-dependency schema validator (`tests/helpers/json-schema-validator.ts`).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CMD_ACK,
  COMMAND_TYPES,
  CMD_CANCEL,
  CMD_CONTINUE_WORKFLOW,
  CMD_PING_BACKEND,
  CMD_READ_METRICS,
  CMD_READ_PHASE_LOG,
  CMD_READ_REPORT,
  CMD_RESUME_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_START,
  CMD_START_QUEUE,
  HOST_MESSAGE_TYPES,
  MSG_PHASE_LOG_BATCH,
  STATE_SNAPSHOT,
  type CommandAckMessage,
  type PhaseLogBatchPushMessage,
  type StateSnapshotMessage
} from '../../src/contracts/sidebar-ipc';
import { buildIdleSnapshot, type WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { SnapshotTransport } from '../../src/ui/sidebar/snapshot-transport';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { workflowSnapshot as visualFixtureSnapshot } from '../visual/fixtures/workflow-snapshot';
import { policySmokeSnapshot } from '../visual/fixtures/policy-smoke-snapshot';
import { validateAgainstSchema, type JsonSchemaNode } from '../helpers/json-schema-validator';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'src/contracts/generated/schemas/sidebar-ipc.schema.json');

const ROOT_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as JsonSchemaNode & {
  $schema: string;
  properties: Record<string, unknown>;
  $defs: Record<string, JsonSchemaNode>;
};

function wireRoundTrip<T>(value: T): unknown {
  // Real postMessage serialization strips undefined-valued optional keys (JSON semantics).
  return JSON.parse(JSON.stringify(value)) as unknown;
}

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function buildDeeplyPopulatedSnapshot(): WorkflowSnapshot {
  const base = wireRoundTrip(visualFixtureSnapshot) as WorkflowSnapshot;
  const firstQueue = base.queues[0]!;
  const firstInFlight = firstQueue.inFlightRun!;
  const firstPhaseRecord = base.phaseCatalog!.records[0]!;
  const firstOrderedItem = base.queue.orderedItems[0]!;

  return {
    ...base,
    queues: [
      {
        ...firstQueue,
        inFlightRun: {
          ...firstInFlight,
          outputs: [
            { name: 'spec-doc', status: 'resolved', reference: 'specs/demo/spec.md' },
            { name: 'optional-summary', status: 'unresolved' }
          ],
          creditPolling: {
            state: 'polling',
            windowEndsAt: 1_754_040_000_000
          },
          effectiveLimits: {
            iterationCap: { value: 10, origin: 'workspace' },
            idleTimeoutSeconds: { value: 5400, origin: 'default' },
            maxDurationSeconds: { value: 21600, origin: 'user' },
            retryCap: { value: 5, origin: 'default' },
            onRetryCap: { value: 'continue-degraded', origin: 'phase' },
            unchangedComparisons: {
              value: 3,
              origin: 'workspace',
              state: 'active'
            },
            phaseRetryPolicy: {
              retryCondition: 'issues_remain > 0',
              capOutcome: 'continue-degraded',
              noProgressThreshold: 3,
              settingSources: {
                maxIterations: 'workspace',
                capOutcome: 'phase',
                noProgressThreshold: 'setting'
              }
            },
            spend: {
              kind: 'bounded',
              denomination: 'usd',
              limit: { value: 25, origin: 'workspace' },
              trust: 'enforced'
            }
          }
        }
      }
    ],
    queue: {
      ...base.queue,
      orderedItems: [
        {
          ...firstOrderedItem,
          phaseProgress: { settled: 2, total: 7 },
          degradedPhases: [{ phaseId: 'speckit-plan', condition: 'issues_remain > 0' }]
        },
        ...base.queue.orderedItems.slice(1)
      ]
    },
    phaseCatalog: {
      ...base.phaseCatalog!,
      records: [
        {
          ...firstPhaseRecord,
          lifecycle: {
            state: 'active-with-draft',
            createdAt: 1_754_030_000_000,
            updatedAt: 1_754_035_000_000,
            activeVersionId: 'v1',
            expectedDraftVersion: 'v2',
            versions: [
              {
                versionId: 'v2',
                createdAt: 1_754_035_000_000,
                publishedAt: null,
                isActive: false,
                note: 'Tightened verification clause'
              },
              {
                versionId: 'v1',
                createdAt: 1_754_030_000_000,
                publishedAt: 1_754_031_000_000,
                isActive: true,
                note: null
              }
            ],
            changedFields: {
              kind: 'changed',
              fields: [
                { field: 'instruction', change: 'differs' },
                {
                  field: 'capabilities',
                  change: 'collection',
                  added: ['workspace-write'],
                  removed: [],
                  reordered: []
                }
              ]
            }
          }
        },
        ...base.phaseCatalog!.records.slice(1)
      ]
    },
    launchables: {
      pipelines: {
        state: 'entries',
        entries: [
          {
            kind: 'pipeline',
            id: 'dev-new-feature',
            name: 'New Feature',
            activeVersionId: 'v1',
            inputs: [
              { portId: 'brief', label: 'Brief', type: 'text', required: true }
            ],
            backends: ['claude', 'codex'],
            capabilityNotices: [
              {
                phaseName: 'Plan',
                backend: 'codex',
                outcome: 'residual',
                text: 'Network access is unrestricted outside sandbox.'
              }
            ],
            runSettings: {
              phases: [
                {
                  phaseName: 'Specify',
                  backend: 'claude',
                  model: { kind: 'value', value: 'claude-sonnet-5-5' },
                  effort: { kind: 'value', value: 'high' },
                  idleTimeoutSeconds: { value: 1800, origin: 'phase' }
                }
              ],
              maxDurationSeconds: { value: 21600, origin: 'default' }
            }
          }
        ]
      },
      workflows: { state: 'none-active' }
    },
    connectedRuns: [
      {
        connectedRunId: 'crun-1',
        workflowId: 'dev-new-feature',
        revision: 3,
        hydrating: false,
        queueId: 'default',
        status: 'running',
        rootInvocationId: 'inv-root',
        activeInvocationId: 'inv-root',
        rootAllowedActions: ['pause', 'cancel'],
        recoveryDisposition: null,
        nodes: [
          {
            nodeId: 'speckit-plan',
            pipelineId: 'dev-new-feature',
            state: 'in-flight',
            actions: [],
            attemptCount: 1,
            latestQueueItemId: 'visual-task-active',
            nodeKind: 'phase',
            decisionObservation: {
              version: 1,
              decisionId: 'dec-1',
              runId: 'visual-run-active',
              nodeId: 'speckit-plan',
              evaluatedAt: 1_754_035_500_000,
              iteration: 1,
              maxIterations: 10,
              retryCondition: 'issues_remain > 0',
              capOutcome: 'fail',
              settingSources: {
                maxIterations: 'workspace',
                capOutcome: 'default'
              },
              observedValues: { issues_remain: 1 },
              exitReason: 'repeat',
              branches: [
                {
                  connectionIndex: 0,
                  targetNodeId: 'speckit-tasks',
                  isDefault: false,
                  disposition: 'condition-false',
                  summary: 'issues_remain = 0',
                  observedValue: 1
                }
              ]
            },
            repeatProjection: {
              version: 1,
              kind: 'repeat',
              iteration: 1,
              maxIterations: 3,
              conditionResult: 'false',
              currentChildInvocationId: 'inv-child-1',
              onExhausted: 'pause',
              leafAttemptCount: 1,
              completedPasses: [
                { iteration: 1, invocationId: 'inv-child-0', status: 'completed' }
              ]
            },
            forEachProjection: {
              version: 1,
              kind: 'for-each',
              itemCount: 1,
              currentIndex: 0,
              onItemError: 'stop',
              hasErrors: false,
              errorCount: 0,
              leafAttemptCount: 1,
              slots: [{ index: 0, itemKey: 'item-0', state: 'executing' }]
            }
          }
        ],
        invocations: [
          {
            invocationId: 'inv-root',
            parentInvocationId: null,
            workflowId: 'dev-new-feature',
            depth: 0,
            nodePath: 'root',
            status: 'running',
            currentNodeId: 'speckit-plan',
            activeAttemptId: 'att-1',
            activeAttemptIndex: 0,
            allowedActions: ['pause', 'cancel'],
            waitingReason: null,
            pauseCause: null,
            failureReason: null,
            pendingRetryAt: null,
            pendingRetryCause: null,
            pendingHandoff: {
              fromNodeId: 'speckit-clarify',
              toNodeId: 'speckit-plan',
              boundInputPortIds: ['brief']
            },
            outputPortIds: [],
            attempts: [
              {
                attemptId: 'att-1',
                attemptIndex: 0,
                nodeId: 'speckit-plan',
                nodeKind: 'phase',
                status: 'running',
                startedAt: 1_754_035_000_000
              }
            ]
          }
        ],
        controlProjection: {
          version: 1,
          rootRunId: 'visual-run-active',
          queueId: 'default',
          invocationId: 'inv-root',
          workflowId: 'dev-new-feature',
          generation: 1,
          frameKind: 'candidate-block',
          state: 'active',
          availabilityPolicy: 'first-ready',
          candidates: [
            {
              candidateId: 'cand-1',
              nodeId: 'speckit-plan',
              backend: 'codex',
              priority: 1,
              authoredOrder: 0,
              attemptsUsed: 1,
              maxAttempts: 3,
              eligibility: 'eligible',
              policyExcluded: false
            }
          ],
          attemptsUsed: 1,
          maxDispatches: 10,
          rootDispatchesUsed: 1,
          rootMaxDispatches: 100,
          spendMode: 'count-only',
          spendEnforcementQuality: 'count-only',
          legalActions: [{ kind: 'pause', allowed: true }],
          evidenceRefs: ['ev-1']
        }
      }
    ]
  };
}

describe('sidebar-ipc.schema.json Draft 2020-12 contract validation (FR-R7-05 / SC-003)', () => {
  it('declares Draft 2020-12 and defines every inbound command, host message, and WorkflowSnapshot in $defs', () => {
    expect(ROOT_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(ROOT_SCHEMA.$defs['WorkflowSnapshot']).toBeDefined();
    expect(ROOT_SCHEMA.$defs['WorkflowSnapshotRoutinePayload']).toBeDefined();
    expect(ROOT_SCHEMA.$defs['InboundCommand']).toBeDefined();
    expect(ROOT_SCHEMA.$defs['HostMessage']).toBeDefined();
    for (const cmd of COMMAND_TYPES) {
      expect(ROOT_SCHEMA.$defs[`Command_${cmd}`], `missing $defs.Command_${cmd}`).toBeDefined();
    }
    for (const msg of HOST_MESSAGE_TYPES) {
      expect(ROOT_SCHEMA.$defs[`HostMessage_${msg}`], `missing $defs.HostMessage_${msg}`).toBeDefined();
    }
  });

  it('validates buildIdleSnapshot() after wire JSON round-trip', () => {
    const idle = wireRoundTrip(
      buildIdleSnapshot({ isPrimary: true, producedAt: '2026-08-01T00:00:00.000Z' })
    );
    const result = validateAgainstSchema(ROOT_SCHEMA, idle, '#/$defs/WorkflowSnapshot');
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates the populated visual fixture and policySmokeSnapshot WorkflowSnapshots', () => {
    const populated = wireRoundTrip(visualFixtureSnapshot);
    const populatedResult = validateAgainstSchema(ROOT_SCHEMA, populated, '#/$defs/WorkflowSnapshot');
    expect(populatedResult.errors, JSON.stringify(populatedResult.errors, null, 2)).toEqual([]);
    expect(populatedResult.valid).toBe(true);

    const policySmoke = wireRoundTrip(policySmokeSnapshot);
    const policyResult = validateAgainstSchema(ROOT_SCHEMA, policySmoke, '#/$defs/WorkflowSnapshot');
    expect(policyResult.errors, JSON.stringify(policyResult.errors, null, 2)).toEqual([]);
    expect(policyResult.valid).toBe(true);
  });

  it('validates a deeply populated WorkflowSnapshot covering every nested projection shape', () => {
    const deepSnapshot = wireRoundTrip(buildDeeplyPopulatedSnapshot());
    const result = validateAgainstSchema(ROOT_SCHEMA, deepSnapshot, '#/$defs/WorkflowSnapshot');
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates live populated STATE_SNAPSHOT, CMD_ACK, and MSG_PHASE_LOG_BATCH host messages', () => {
    const stateSnapshotMsg: StateSnapshotMessage<WorkflowSnapshot> = {
      type: STATE_SNAPSHOT,
      payload: buildDeeplyPopulatedSnapshot(),
      sync: {
        mode: 'routine',
        revision: 7,
        baseRevision: 6,
        omittedSlices: ['phaseCatalog', 'workflowCatalog']
      }
    };
    const ackMsg: CommandAckMessage = {
      type: CMD_ACK,
      correlationId: 'corr-42',
      status: 'accepted',
      outcome: 'accepted',
      result: { ok: true }
    };
    const logBatchMsg: PhaseLogBatchPushMessage = {
      type: MSG_PHASE_LOG_BATCH,
      payload: {
        protocol: 1,
        tailSessionId: 'tail-sess-1',
        batchSeq: 1,
        generation: 'gen-1',
        mode: 'continue',
        toCursor: 'Y3Vyc29yLTE',
        entries: [
          {
            at: 128,
            n: 0,
            entry: {
              seq: 0,
              kind: 'assistant-text',
              ts: '2026-08-01T09:06:00.000Z',
              body: { text: 'hello' },
              bodyTruncated: { text: { originalLength: 4096 } }
            }
          }
        ]
      }
    };

    for (const msg of [stateSnapshotMsg, ackMsg, logBatchMsg]) {
      const wire = wireRoundTrip(msg);
      const specific = validateAgainstSchema(ROOT_SCHEMA, wire, `#/$defs/HostMessage_${msg.type}`);
      expect(specific.errors, `${msg.type} failed HostMessage_${msg.type}`).toEqual([]);
      expect(specific.valid).toBe(true);

      const union = validateAgainstSchema(ROOT_SCHEMA, wire, '#/$defs/HostMessage');
      expect(union.errors, `${msg.type} failed HostMessage`).toEqual([]);
      expect(union.valid).toBe(true);
    }
  });

  it('validates real SnapshotTransport full + routine (omitted slices) wire envelopes and rejects omitted slices on full/unsynced envelopes', () => {
    const transport = new SnapshotTransport();
    const snap1 = buildDeeplyPopulatedSnapshot();
    const snap2: WorkflowSnapshot = {
      ...snap1,
      producedAt: '2026-08-01T00:00:10.000Z'
    };

    const first = transport.preparePost(snap1);
    expect(first.sync.mode).toBe('full');
    expect(first.sync.revision).toBe(1);
    const wireFirst = wireRoundTrip(first.message);
    const firstSpecific = validateAgainstSchema(ROOT_SCHEMA, wireFirst, '#/$defs/HostMessage_STATE_SNAPSHOT');
    expect(firstSpecific.errors, JSON.stringify(firstSpecific.errors, null, 2)).toEqual([]);
    expect(firstSpecific.valid).toBe(true);
    const firstUnion = validateAgainstSchema(ROOT_SCHEMA, wireFirst, '#/$defs/HostMessage');
    expect(firstUnion.errors, JSON.stringify(firstUnion.errors, null, 2)).toEqual([]);
    expect(firstUnion.valid).toBe(true);

    const second = transport.preparePost(snap2);
    expect(second.sync.mode).toBe('routine');
    expect(second.sync.revision).toBe(2);
    expect(second.sync.baseRevision).toBe(1);
    expect(second.sync.omittedSlices).toEqual(
      expect.arrayContaining(['auditTail', 'history', 'availablePipelines', 'availablePhases', 'debugLogTail'])
    );
    const wireSecond = wireRoundTrip(second.message) as {
      type: string;
      payload: Record<string, unknown>;
      sync: Record<string, unknown>;
    };
    expect('auditTail' in wireSecond.payload).toBe(false);
    expect('history' in wireSecond.payload).toBe(false);
    expect('availablePipelines' in wireSecond.payload).toBe(false);
    expect('availablePhases' in wireSecond.payload).toBe(false);
    expect('debugLogTail' in wireSecond.payload).toBe(false);

    const secondSpecific = validateAgainstSchema(ROOT_SCHEMA, wireSecond, '#/$defs/HostMessage_STATE_SNAPSHOT');
    expect(secondSpecific.errors, JSON.stringify(secondSpecific.errors, null, 2)).toEqual([]);
    expect(secondSpecific.valid).toBe(true);
    const secondUnion = validateAgainstSchema(ROOT_SCHEMA, wireSecond, '#/$defs/HostMessage');
    expect(secondUnion.errors, JSON.stringify(secondUnion.errors, null, 2)).toEqual([]);
    expect(secondUnion.valid).toBe(true);

    // Unsynced full STATE_SNAPSHOT envelope (sync absent) remains valid when payload is complete.
    const unsyncedFull = wireRoundTrip({ type: STATE_SNAPSHOT, payload: snap1 });
    expect(validateAgainstSchema(ROOT_SCHEMA, unsyncedFull, '#/$defs/HostMessage_STATE_SNAPSHOT').valid).toBe(true);

    // Omitting required suppressible slices MUST still be rejected when sync.mode === 'full'.
    const fullWithOmittedSlices = {
      type: STATE_SNAPSHOT,
      payload: wireSecond.payload,
      sync: { mode: 'full', revision: 2 }
    };
    expect(
      validateAgainstSchema(ROOT_SCHEMA, fullWithOmittedSlices, '#/$defs/HostMessage_STATE_SNAPSHOT').valid
    ).toBe(false);
    expect(validateAgainstSchema(ROOT_SCHEMA, fullWithOmittedSlices, '#/$defs/HostMessage').valid).toBe(false);

    // Omitting required suppressible slices MUST still be rejected when sync is absent.
    const unsyncedWithOmittedSlices = {
      type: STATE_SNAPSHOT,
      payload: wireSecond.payload
    };
    expect(
      validateAgainstSchema(ROOT_SCHEMA, unsyncedWithOmittedSlices, '#/$defs/HostMessage_STATE_SNAPSHOT').valid
    ).toBe(false);
    expect(validateAgainstSchema(ROOT_SCHEMA, unsyncedWithOmittedSlices, '#/$defs/HostMessage').valid).toBe(false);

    // Under mode: 'routine', omitting a NON-suppressible required field (`producedAt`) MUST still be rejected.
    const routineMissingProducedAtPayload = { ...wireSecond.payload };
    delete routineMissingProducedAtPayload['producedAt'];
    expect(
      validateAgainstSchema(
        ROOT_SCHEMA,
        { type: STATE_SNAPSHOT, payload: routineMissingProducedAtPayload, sync: wireSecond.sync },
        '#/$defs/HostMessage_STATE_SNAPSHOT'
      ).valid
    ).toBe(false);

    // Under mode: 'routine', an extra unknown payload field or malformed present suppressible slice MUST be rejected.
    expect(
      validateAgainstSchema(
        ROOT_SCHEMA,
        {
          type: STATE_SNAPSHOT,
          payload: { ...wireSecond.payload, unknownExtra: 1 },
          sync: wireSecond.sync
        },
        '#/$defs/HostMessage_STATE_SNAPSHOT'
      ).valid
    ).toBe(false);
    expect(
      validateAgainstSchema(
        ROOT_SCHEMA,
        {
          type: STATE_SNAPSHOT,
          payload: { ...wireSecond.payload, auditTail: [{ bad: true }] },
          sync: wireSecond.sync
        },
        '#/$defs/HostMessage_STATE_SNAPSHOT'
      ).valid
    ).toBe(false);
  });

  it('validates a live snapshot projected by StateProjector', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-schema-proj-'));
    try {
      const store = new WorkspaceStateStore(new FakeMemento());
      await store.initialize();
      const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
      const projector = new StateProjector({
        store,
        audit,
        ownerId: 'schema-validator-window',
        debounceMs: 0
      });
      const liveSnapshot = wireRoundTrip(projector.getCurrentSnapshot());
      const result = validateAgainstSchema(ROOT_SCHEMA, liveSnapshot, '#/$defs/WorkflowSnapshot');
      expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
      expect(result.valid).toBe(true);
      projector.dispose();
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('validates representative inbound commands across families against #/$defs/InboundCommand', () => {
    const samples = [
      { type: CMD_START, correlationId: 'c1', payload: { description: 'Add schema validation' } },
      { type: CMD_CANCEL, correlationId: 'c2', payload: { taskId: 'task-1' } },
      { type: CMD_RESUME_QUEUE, correlationId: 'c3', payload: { queueId: 'default' } },
      { type: CMD_START_QUEUE, correlationId: 'c4' },
      { type: CMD_SAVE_QUEUE_SETTINGS, correlationId: 'c5', payload: { globalConcurrencyCap: 3, defaultQueueId: 'default' } },
      { type: CMD_PING_BACKEND, correlationId: 'c6', payload: { runner: 'claude' } },
      {
        type: CMD_READ_PHASE_LOG,
        correlationId: 'c7',
        payload: {
          selection: {
            queueId: 'default',
            taskId: 'task-1',
            pipelineId: 'pipe-1',
            phaseId: 'plan',
            iterationN: 1
          }
        }
      },
      { type: CMD_READ_METRICS, correlationId: 'c8', payload: { includeArchives: true } },
      { type: CMD_READ_REPORT, correlationId: 'c9', payload: { op: 'cancelActive' } }
    ];
    for (const cmd of samples) {
      const byName = validateAgainstSchema(ROOT_SCHEMA, cmd, `#/$defs/Command_${cmd.type}`);
      expect(byName.errors, `${cmd.type} failed Command_${cmd.type}`).toEqual([]);
      const byUnion = validateAgainstSchema(ROOT_SCHEMA, cmd, '#/$defs/InboundCommand');
      expect(byUnion.errors, `${cmd.type} failed InboundCommand`).toEqual([]);
    }
  });

  it('NON-VACUITY: rejects nested field mutations across WorkflowSnapshot', () => {
    const base = (): Record<string, unknown> =>
      wireRoundTrip(visualFixtureSnapshot) as Record<string, unknown>;

    // 1. Mutate queues[0].inFlightRun.status to an unknown literal
    const badRunStatus = base();
    ((badRunStatus['queues'] as Record<string, unknown>[])[0]!['inFlightRun'] as Record<string, unknown>)['status'] =
      'bogus-status';
    expect(validateAgainstSchema(ROOT_SCHEMA, badRunStatus, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 2. Mutate queues[0].startFailure to an unknown discriminated kind
    const badStartFailure = base();
    (badStartFailure['queues'] as Record<string, unknown>[])[0]!['startFailure'] = {
      kind: 'unknown-kind',
      at: '2026-08-01T00:00:00.000Z'
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, badStartFailure, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 3. Mutate evidenceHealth.audit.status to a bad value
    const badEvidence = base();
    ((badEvidence['evidenceHealth'] as Record<string, unknown>)['audit'] as Record<string, unknown>)['status'] =
      'broken-sink';
    expect(validateAgainstSchema(ROOT_SCHEMA, badEvidence, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 4. Mutate generalSettings.loopMaxIterations from number to string
    const badSettings = base();
    (badSettings['generalSettings'] as Record<string, unknown>)['loopMaxIterations'] = 'not-a-number';
    expect(validateAgainstSchema(ROOT_SCHEMA, badSettings, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 5. Mutate queue.orderedItems[0].phaseProgress to drifted `{ completed }` and malformed `{ settled }`
    const badProgressDrifted = base();
    const queueObjDrifted = badProgressDrifted['queue'] as Record<string, unknown>;
    ((queueObjDrifted['orderedItems'] as Record<string, unknown>[])[0]!)['phaseProgress'] = {
      completed: 2,
      total: 4
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, badProgressDrifted, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    const badProgressType = base();
    const queueObjType = badProgressType['queue'] as Record<string, unknown>;
    ((queueObjType['orderedItems'] as Record<string, unknown>[])[0]!)['phaseProgress'] = {
      settled: 'two',
      total: 4
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, badProgressType, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 6. Missing required top-level field (`producedAt`)
    const missingField = base();
    delete missingField['producedAt'];
    expect(validateAgainstSchema(ROOT_SCHEMA, missingField, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 7. Extra unexpected top-level key
    const extraKey = base();
    extraKey['unannouncedField'] = 123;
    expect(validateAgainstSchema(ROOT_SCHEMA, extraKey, '#/$defs/WorkflowSnapshot').valid).toBe(false);
  });

  it('NON-VACUITY: rejects host-message and deeply nested projection mutations (FR-R7-11 Task 11)', () => {
    const deepBase = (): Record<string, unknown> =>
      wireRoundTrip(buildDeeplyPopulatedSnapshot()) as Record<string, unknown>;

    // 1. Empty `{}` phase-log entry in MSG_PHASE_LOG_BATCH must be rejected
    const emptyLogBatchEntry = {
      type: MSG_PHASE_LOG_BATCH,
      payload: {
        protocol: 1,
        tailSessionId: 'tail-sess-1',
        batchSeq: 1,
        generation: 'gen-1',
        mode: 'continue',
        toCursor: null,
        entries: [{}]
      }
    };
    expect(
      validateAgainstSchema(ROOT_SCHEMA, emptyLogBatchEntry, '#/$defs/HostMessage_MSG_PHASE_LOG_BATCH').valid
    ).toBe(false);

    const emptyWireEntry = {
      ...emptyLogBatchEntry,
      payload: {
        ...emptyLogBatchEntry.payload,
        entries: [{ at: 0, n: 0, entry: {} }]
      }
    };
    expect(
      validateAgainstSchema(ROOT_SCHEMA, emptyWireEntry, '#/$defs/HostMessage_MSG_PHASE_LOG_BATCH').valid
    ).toBe(false);

    // 2. Unknown SnapshotSyncMeta.omittedSlices slice name must be rejected
    const badSyncSlice = {
      type: STATE_SNAPSHOT,
      payload: deepBase(),
      sync: {
        mode: 'routine',
        revision: 2,
        baseRevision: 1,
        omittedSlices: ['notARealSuppressibleSlice']
      }
    };
    expect(
      validateAgainstSchema(ROOT_SCHEMA, badSyncSlice, '#/$defs/HostMessage_STATE_SNAPSHOT').valid
    ).toBe(false);

    // 3. Mutated BuilderLifecycle (bad state & unknown key)
    const badLifecycle = deepBase();
    (((badLifecycle['phaseCatalog'] as Record<string, unknown>)['records'] as Record<string, unknown>[])[0]![
      'lifecycle'
    ] as Record<string, unknown>)['state'] = 'bogus-lifecycle';
    expect(validateAgainstSchema(ROOT_SCHEMA, badLifecycle, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 4. Mutated ConnectedRunProjection (unknown node state)
    const badConnected = deepBase();
    (((badConnected['connectedRuns'] as Record<string, unknown>[])[0]!['nodes'] as Record<string, unknown>[])[0]!)[
      'state'
    ] = 'bogus-node-state';
    expect(validateAgainstSchema(ROOT_SCHEMA, badConnected, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 5. Mutated LaunchProjection (unknown LaunchSection discriminator)
    const badLaunch = deepBase();
    (badLaunch['launchables'] as Record<string, unknown>)['pipelines'] = { state: 'loading' };
    expect(validateAgainstSchema(ROOT_SCHEMA, badLaunch, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 6. Mutated CreditPollingProjection (invalid state enum)
    const badCredit = deepBase();
    (((badCredit['queues'] as Record<string, unknown>[])[0]!['inFlightRun'] as Record<string, unknown>)[
      'creditPolling'
    ] as Record<string, unknown>)['state'] = 'waiting';
    expect(validateAgainstSchema(ROOT_SCHEMA, badCredit, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 7. Mutated EffectiveLimitsProjection (invalid spend arm)
    const badLimits = deepBase();
    (((badLimits['queues'] as Record<string, unknown>[])[0]!['inFlightRun'] as Record<string, unknown>)[
      'effectiveLimits'
    ] as Record<string, unknown>)['spend'] = { kind: 'unlimited' };
    expect(validateAgainstSchema(ROOT_SCHEMA, badLimits, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 8. Mutated DegradedPhaseEntry (drifted `{ outcome }` instead of `{ condition }`)
    const badDegraded = deepBase();
    (((badDegraded['queue'] as Record<string, unknown>)['orderedItems'] as Record<string, unknown>[])[0]!)[
      'degradedPhases'
    ] = [{ phaseId: 'speckit-plan', outcome: 'degraded' }];
    expect(validateAgainstSchema(ROOT_SCHEMA, badDegraded, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 9. Mutated RunOutputRecord (drifted `{ portId }` instead of `{ name }`)
    const badOutput = deepBase();
    (((badOutput['queues'] as Record<string, unknown>[])[0]!['inFlightRun'] as Record<string, unknown>)[
      'outputs'
    ]) = [{ portId: 'spec-doc', status: 'resolved' }];
    expect(validateAgainstSchema(ROOT_SCHEMA, badOutput, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 10. Drifted EvidenceSinkStatus `'failed'` and drifted WorkflowStatus `'awaiting-credit'`
    const badSinkStatus = deepBase();
    ((badSinkStatus['evidenceHealth'] as Record<string, unknown>)['audit'] as Record<string, unknown>)[
      'status'
    ] = 'failed';
    expect(validateAgainstSchema(ROOT_SCHEMA, badSinkStatus, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    const badWorkflowStatus = deepBase();
    (((badWorkflowStatus['queues'] as Record<string, unknown>[])[0]!['inFlightRun'] as Record<string, unknown>)[
      'status'
    ]) = 'awaiting-credit';
    expect(validateAgainstSchema(ROOT_SCHEMA, badWorkflowStatus, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 11. ControlCommandEnvelope & RunRequest: valid accepted, unknown action kind or missing target definition id rejected
    const validContinueControl = {
      type: CMD_CONTINUE_WORKFLOW,
      correlationId: 'corr-ctl-1',
      payload: {
        connectedRunId: 'crun-1',
        expectedRevision: 3,
        nodeId: 'speckit-plan',
        request: { pipelineId: 'default', inputs: [], supplemental: [], outputs: [] },
        controlCommand: {
          version: 1,
          commandId: '11111111-1111-1111-1111-111111111111',
          rootRunId: 'run-1',
          queueId: 'default',
          invocationId: 'inv-1',
          expectedGeneration: 1,
          action: { kind: 'pause' }
        }
      }
    };
    expect(
      validateAgainstSchema(ROOT_SCHEMA, validContinueControl, '#/$defs/Command_CMD_CONTINUE_WORKFLOW').valid
    ).toBe(true);

    // RunRequest with workflowId (without pipelineId) is accepted.
    expect(
      validateAgainstSchema(
        ROOT_SCHEMA,
        { workflowId: 'dev-new-feature', inputs: [], supplemental: [], outputs: [] },
        '#/$defs/RunRequest'
      ).valid
    ).toBe(true);

    // RunRequest without either pipelineId or workflowId is rejected.
    const requestWithoutTargetId = { inputs: [], supplemental: [], outputs: [] };
    expect(validateAgainstSchema(ROOT_SCHEMA, requestWithoutTargetId, '#/$defs/RunRequest').valid).toBe(false);
    expect(
      validateAgainstSchema(
        ROOT_SCHEMA,
        {
          ...validContinueControl,
          payload: { ...validContinueControl.payload, request: requestWithoutTargetId }
        },
        '#/$defs/Command_CMD_CONTINUE_WORKFLOW'
      ).valid
    ).toBe(false);

    const invalidContinueControl = {
      ...validContinueControl,
      payload: {
        ...validContinueControl.payload,
        controlCommand: {
          ...validContinueControl.payload.controlCommand,
          action: { kind: 'bogus-action' }
        }
      }
    };
    expect(
      validateAgainstSchema(ROOT_SCHEMA, invalidContinueControl, '#/$defs/Command_CMD_CONTINUE_WORKFLOW').valid
    ).toBe(false);
  });

  it('NON-VACUITY: rejects invalid inbound commands and validates validator self-check', () => {
    // Canonized CMD_RESUME_QUEUE rejects legacy unaccepted `prompt` field
    const resumeWithPrompt = {
      type: CMD_RESUME_QUEUE,
      correlationId: 'c1',
      payload: { queueId: 'default', prompt: 'legacy-drift' }
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, resumeWithPrompt, '#/$defs/Command_CMD_RESUME_QUEUE').valid).toBe(false);

    // Invalid runner enum
    const badPing = { type: CMD_PING_BACKEND, correlationId: 'c2', payload: { runner: 'unknown-cli' } };
    expect(validateAgainstSchema(ROOT_SCHEMA, badPing, '#/$defs/Command_CMD_PING_BACKEND').valid).toBe(false);

    // Missing required description
    const badStart = { type: CMD_START, correlationId: 'c3', payload: {} };
    expect(validateAgainstSchema(ROOT_SCHEMA, badStart, '#/$defs/Command_CMD_START').valid).toBe(false);

    // Self-check that validateAgainstSchema rejects prototype-chain property smuggling & bad values
    const selfCheck = validateAgainstSchema(
      { type: 'object', required: ['x'], properties: { x: { type: 'integer', minimum: 1 } }, additionalProperties: false },
      { x: 0 }
    );
    expect(selfCheck.valid).toBe(false);
    expect(selfCheck.errors.length).toBeGreaterThan(0);

    const protoSmuggle = validateAgainstSchema(
      { type: 'object', properties: { x: { type: 'integer' } }, additionalProperties: false },
      JSON.parse('{"x":1,"constructor":"bad","toString":"bad"}') as unknown
    );
    expect(protoSmuggle.valid).toBe(false);
  });
});
