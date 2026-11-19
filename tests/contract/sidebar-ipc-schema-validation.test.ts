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
  COMMAND_TYPES,
  CMD_CANCEL,
  CMD_PING_BACKEND,
  CMD_READ_METRICS,
  CMD_READ_PHASE_LOG,
  CMD_READ_REPORT,
  CMD_RESUME_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_START,
  CMD_START_QUEUE
} from '../../src/contracts/sidebar-ipc';
import { buildIdleSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { workflowSnapshot as visualFixtureSnapshot } from '../visual/fixtures/workflow-snapshot';
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

describe('sidebar-ipc.schema.json Draft 2020-12 contract validation (FR-R7-05 / SC-003)', () => {
  it('declares Draft 2020-12 and defines every inbound command + WorkflowSnapshot in $defs', () => {
    expect(ROOT_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(ROOT_SCHEMA.$defs['WorkflowSnapshot']).toBeDefined();
    expect(ROOT_SCHEMA.$defs['InboundCommand']).toBeDefined();
    for (const cmd of COMMAND_TYPES) {
      expect(ROOT_SCHEMA.$defs[`Command_${cmd}`], `missing $defs.Command_${cmd}`).toBeDefined();
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

  it('validates the populated visual fixture WorkflowSnapshot', () => {
    const populated = wireRoundTrip(visualFixtureSnapshot);
    const result = validateAgainstSchema(ROOT_SCHEMA, populated, '#/$defs/WorkflowSnapshot');
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
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

    // 5. Mutate queue.orderedItems[0].phaseProgress to malformed object
    const badProgress = base();
    const queueObj = badProgress['queue'] as Record<string, unknown>;
    ((queueObj['orderedItems'] as Record<string, unknown>[])[0]!)['phaseProgress'] = {
      completed: 'two',
      total: 4
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, badProgress, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 6. Missing required top-level field (`producedAt`)
    const missingField = base();
    delete missingField['producedAt'];
    expect(validateAgainstSchema(ROOT_SCHEMA, missingField, '#/$defs/WorkflowSnapshot').valid).toBe(false);

    // 7. Extra unexpected top-level key
    const extraKey = base();
    extraKey['unannouncedField'] = 123;
    expect(validateAgainstSchema(ROOT_SCHEMA, extraKey, '#/$defs/WorkflowSnapshot').valid).toBe(false);
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
