import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPhaseLogTailWiring } from '../../../src/activation/phase-log-tail-wiring';
import { resolveStreamJsonlPath } from '../../../src/services/phase-log/phase-log-path';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { StateProjector } from '../../../src/ui/sidebar/state-projector';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { QueueManager } from '../../../src/queue/queue-manager';

/**
 * FR-R3-136 (FR-011, T1525h) — the phase-log tail keeps working in an untrusted
 * window; the audit append that records it does not.
 *
 * WHY THIS SURFACE, when Phase A covered commands and Phase B covered IPC.
 * `CMD_START_PHASE_LOG_TAIL` is deliberately absent from
 * `MUTATING_COMMAND_TYPES`, so the router's trust gate never sees it — and that
 * is correct, because a log view is precisely what the manifest's `limited`
 * claim promises stays available. The write is not the message; it is the
 * `phase-log-tail-started` audit entry `PhaseLogTailRegistry.start()` appends
 * once the tail is live, into `.schegent/audit.log`.
 *
 * THE REACHABILITY CLAIM IS PART OF WHAT THESE TESTS HOLD. `start()` refuses
 * unless the requested phase is in flight, and "in flight" is a projection of
 * PERSISTED state, not of anything this window did. The fixture below is
 * therefore an untrusted window that has elected nothing and spawned nothing,
 * over a `.schegent/` that arrived with the checkout — which is the shape of the
 * threat the whole feature is about, and it satisfies the guard.
 *
 * NON-VACUITY IS THE PAIRING, not a separate control. The trusted case and the
 * untrusted case run the same request against the same fixture and differ in one
 * thunk, and the untrusted case still returns `success` — so the missing append
 * is the gate refusing a write, and not the tail having failed to start. Remove
 * the gate and the untrusted case's `append` assertion fails; keep the gate but
 * break the tail and the `success` assertion fails.
 */

const SELECTION = Object.freeze({
  queueId: 'default',
  taskId: 'task-tail-trust',
  pipelineId: 'standard',
  phaseId: 'speckit-plan',
  iterationN: 1
});

/** The on-disk run id, which is not the task id — see the wiring's BUG-001 note. */
const RUN_ID = 'run-tail-trust';

let workspaceRoot: string;
let wiring: { dispose(): void } | null = null;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-tail-trust-'));
  // Composed by the production resolver rather than restated here: the layout
  // has one authority (`phase-log-path.ts`) and a fixture that hard-codes it
  // would keep passing after the layout moved.
  const streamPath = resolveStreamJsonlPath({
    workspaceRoot,
    runId: RUN_ID,
    pipelineId: SELECTION.pipelineId,
    phaseId: SELECTION.phaseId,
    iterationN: SELECTION.iterationN
  });
  await fs.mkdir(path.dirname(streamPath), { recursive: true });
  await fs.writeFile(
    streamPath,
    `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`,
    'utf8'
  );
});

afterEach(async () => {
  // Closes the `fs.watch` handle the started tail owns.
  wiring?.dispose();
  wiring = null;
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

interface Harness {
  readonly appended: { eventType: string }[];
  readonly lines: string[];
  readonly start: () => Promise<{ outcome: string }>;
  readonly startPhase: (phaseId: string) => Promise<unknown>;
}

function harness(isWorkspaceTrusted: () => boolean): Harness {
  const appended: { eventType: string }[] = [];
  const lines: string[] = [];
  const logger = new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]);

  const snapshot = {
    queue: { inFlight: { id: SELECTION.taskId, currentPhase: SELECTION.phaseId } }
  };
  const projector = {
    getCurrentSnapshot: () => snapshot,
    subscribe: () => ({ dispose: () => undefined })
  } as unknown as Pick<StateProjector, 'getCurrentSnapshot' | 'subscribe'>;

  const created = createPhaseLogTailWiring({
    workspaceRoot,
    projector,
    queue: { findById: () => ({ runId: RUN_ID }) } as unknown as Pick<QueueManager, 'findById'>,
    auditWriter: {
      append: async (entry: { eventType: string }) => {
        appended.push({ eventType: entry.eventType });
      }
    } as unknown as Pick<AuditLogWriter, 'append'>,
    isWorkspaceTrusted,
    logger
  });
  wiring = created;

  return {
    appended,
    lines,
    start: () => created.phaseLogTailService.start({ selection: SELECTION }),
    startPhase: (phaseId: string) =>
      created.phaseLogTailService.start({ selection: { ...SELECTION, phaseId } })
  };
}

describe('phase-log tail: the read survives an untrusted workspace, the write does not', () => {
  it('starts the tail and appends nothing while untrusted', async () => {
    const h = harness(() => false);

    const result = await h.start();

    expect(result.outcome).toBe('success');
    expect(h.appended).toEqual([]);
    expect(h.lines.some((line) => line.includes('audit append skipped'))).toBe(true);
  });

  it('appends the started event on the same request while trusted', async () => {
    const h = harness(() => true);

    const result = await h.start();

    expect(result.outcome).toBe('success');
    expect(h.appended).toEqual([{ eventType: 'phase-log-tail-started' }]);
  });

  it('re-reads trust per append rather than capturing it at construction (FR-005)', async () => {
    let trusted = false;
    const h = harness(() => trusted);

    // The grant lands after the wiring was built, which is the whole shape of
    // `onDidGrantWorkspaceTrust`: this module is never rebuilt.
    trusted = true;
    const result = await h.start();

    expect(result.outcome).toBe('success');
    expect(h.appended).toEqual([{ eventType: 'phase-log-tail-started' }]);
  });

  it('still refuses a phase that is not in flight, which is the guard the cases above passed', async () => {
    // The reachability claim from the other side. If this returned `success`
    // the fixture would prove nothing about persisted state, because the guard
    // it satisfies would not exist.
    const h = harness(() => true);

    const result = await h.startPhase('speckit-implement');

    expect(result).toEqual({ outcome: 'failure', reason: 'not-in-flight' });
    expect(h.appended).toEqual([]);
  });
});
