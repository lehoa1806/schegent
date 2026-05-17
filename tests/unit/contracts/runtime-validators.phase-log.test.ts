// Feature 020 — BUG-001 regression suite. Drives accepted / rejected
// payloads for the three phase-log IPC commands through the SINGLE
// inbound gate `validateInboundMessage`. The validator must:
//   1. Accept the documented happy-path payload.
//   2. Reject any unexpected top-level OR nested key with
//      `unexpected-payload-fields`.
//   3. Reject a missing `payload` with `missing-payload`.
//   4. Reject `iterationN` values that are neither integer ≥ 1 nor
//      `null` (read) / require integer ≥ 1 (start-tail).
//   5. Reject empty / oversized `sessionId` on stop-tail.
//
// The wire format pinned in
// `specs/020-phase-level-logs/contracts/phase-log-ipc.md` uses
// `iterationN: number | null` (null = "host picks the latest"). The
// task description's `"latest"` string was spec-author shorthand —
// strings are rejected.
import { describe, expect, it } from 'vitest';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';

const READ = 'CMD_READ_PHASE_LOG';
const START = 'CMD_START_PHASE_LOG_TAIL';
const STOP = 'CMD_STOP_PHASE_LOG_TAIL';

const SELECTION = {
  queueId: 'queue-1',
  taskId: 'task-1',
  pipelineId: 'pipeline-1',
  phaseId: 'phase-1',
  iterationN: 3
};

function readMsg(payload: unknown, correlationId = 'cid'): unknown {
  return { type: READ, correlationId, payload };
}

function startMsg(payload: unknown, correlationId = 'cid'): unknown {
  return { type: START, correlationId, payload };
}

function stopMsg(payload: unknown, correlationId = 'cid'): unknown {
  return { type: STOP, correlationId, payload };
}

describe('validateInboundMessage — phase-log commands (020 BUG-001)', () => {
  describe('happy paths', () => {
    it('accepts CMD_READ_PHASE_LOG with full selection (iterationN: number)', () => {
      const result = validateInboundMessage(readMsg({ selection: SELECTION }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.command.type).toBe(READ);
        expect((result.command as { payload: { selection: typeof SELECTION } }).payload.selection)
          .toEqual(SELECTION);
      }
    });

    it('accepts CMD_READ_PHASE_LOG with iterationN: null (host picks latest)', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, iterationN: null } })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(
          (result.command as { payload: { selection: { iterationN: number | null } } }).payload
            .selection.iterationN
        ).toBeNull();
      }
    });

    it('accepts CMD_READ_PHASE_LOG with iterationN omitted (coerced to null)', () => {
      const { iterationN: _drop, ...selectionNoIter } = SELECTION;
      const result = validateInboundMessage(readMsg({ selection: selectionNoIter }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(
          (result.command as { payload: { selection: { iterationN: number | null } } }).payload
            .selection.iterationN
        ).toBeNull();
      }
    });

    it('accepts CMD_START_PHASE_LOG_TAIL with iterationN: number ≥ 1', () => {
      const result = validateInboundMessage(startMsg({ selection: SELECTION }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.command.type).toBe(START);
    });

    it('accepts CMD_STOP_PHASE_LOG_TAIL with non-empty sessionId', () => {
      const result = validateInboundMessage(stopMsg({ sessionId: 'tail-session-abc' }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.command.type).toBe(STOP);
        expect((result.command as { payload: { sessionId: string } }).payload.sessionId).toBe(
          'tail-session-abc'
        );
      }
    });
  });

  describe('rejects unexpected top-level keys (unexpected-payload-fields)', () => {
    it('CMD_READ_PHASE_LOG with extra top-level key', () => {
      const result = validateInboundMessage(
        readMsg({ selection: SELECTION, extra: 1 })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unexpected-payload-fields');
    });

    it('CMD_START_PHASE_LOG_TAIL with extra top-level key', () => {
      const result = validateInboundMessage(
        startMsg({ selection: SELECTION, extra: 'x' })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unexpected-payload-fields');
    });

    it('CMD_STOP_PHASE_LOG_TAIL with extra top-level key', () => {
      const result = validateInboundMessage(
        stopMsg({ sessionId: 'tail-session-abc', extra: true })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unexpected-payload-fields');
    });
  });

  describe('rejects unexpected nested selection keys', () => {
    it('CMD_READ_PHASE_LOG with extra selection.* key', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, runId: 'leaked' } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unexpected-payload-fields');
    });

    it('CMD_START_PHASE_LOG_TAIL with extra selection.* key', () => {
      const result = validateInboundMessage(
        startMsg({ selection: { ...SELECTION, absPath: '/etc/passwd' } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unexpected-payload-fields');
    });
  });

  describe('rejects missing payload (missing-payload)', () => {
    it('CMD_READ_PHASE_LOG with no payload field', () => {
      const result = validateInboundMessage({ type: READ, correlationId: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing-payload');
    });

    it('CMD_START_PHASE_LOG_TAIL with no payload field', () => {
      const result = validateInboundMessage({ type: START, correlationId: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing-payload');
    });

    it('CMD_STOP_PHASE_LOG_TAIL with no payload field', () => {
      const result = validateInboundMessage({ type: STOP, correlationId: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing-payload');
    });

    it('CMD_READ_PHASE_LOG with missing selection field', () => {
      const result = validateInboundMessage(readMsg({}));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-selection');
    });
  });

  describe('rejects iterationN type mismatch (invalid-iterationN)', () => {
    it('CMD_READ_PHASE_LOG rejects string "latest" (wire uses null, not "latest")', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, iterationN: 'latest' } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-iterationN');
    });

    it('CMD_READ_PHASE_LOG rejects iterationN: 0 (must be ≥ 1)', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, iterationN: 0 } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-iterationN');
    });

    it('CMD_READ_PHASE_LOG rejects iterationN: 1.5 (must be integer)', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, iterationN: 1.5 } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-iterationN');
    });

    it('CMD_START_PHASE_LOG_TAIL rejects iterationN: null (must be integer ≥ 1)', () => {
      const result = validateInboundMessage(
        startMsg({ selection: { ...SELECTION, iterationN: null } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-iterationN');
    });

    it('CMD_START_PHASE_LOG_TAIL rejects iterationN omitted', () => {
      const { iterationN: _drop, ...selectionNoIter } = SELECTION;
      const result = validateInboundMessage(startMsg({ selection: selectionNoIter }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-iterationN');
    });
  });

  describe('rejects empty / oversized / non-string identifiers', () => {
    it('CMD_READ_PHASE_LOG rejects empty queueId', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, queueId: '' } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-queueId');
    });

    it('CMD_READ_PHASE_LOG rejects non-string taskId', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, taskId: 42 } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-taskId');
    });

    it('CMD_READ_PHASE_LOG rejects oversized pipelineId (>256)', () => {
      const result = validateInboundMessage(
        readMsg({ selection: { ...SELECTION, pipelineId: 'p'.repeat(257) } })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-pipelineId');
    });

    it('CMD_STOP_PHASE_LOG_TAIL rejects empty sessionId', () => {
      const result = validateInboundMessage(stopMsg({ sessionId: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-sessionId');
    });

    it('CMD_STOP_PHASE_LOG_TAIL rejects oversized sessionId (>256)', () => {
      const result = validateInboundMessage(stopMsg({ sessionId: 's'.repeat(257) }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-sessionId');
    });

    it('CMD_STOP_PHASE_LOG_TAIL rejects non-string sessionId', () => {
      const result = validateInboundMessage(stopMsg({ sessionId: 999 }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-sessionId');
    });
  });

  describe('error envelope carries type + correlationId for diagnostic attribution', () => {
    it('CMD_READ_PHASE_LOG unexpected-payload-fields preserves type + correlationId', () => {
      const result = validateInboundMessage(
        readMsg({ selection: SELECTION, extra: 1 }, 'cid-42')
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.type).toBe(READ);
        expect(result.correlationId).toBe('cid-42');
      }
    });

    it('CMD_STOP_PHASE_LOG_TAIL missing-payload preserves type + correlationId', () => {
      const result = validateInboundMessage({ type: STOP, correlationId: 'cid-99' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.type).toBe(STOP);
        expect(result.correlationId).toBe('cid-99');
      }
    });
  });
});
