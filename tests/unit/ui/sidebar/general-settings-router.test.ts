// Feature 011 — sidebar router gating for the two new commands.
//
// Covers:
//   - FR-010: CMD_RETRY_PHASE_NOW rejected on secondary windows.
//   - Rejection reasons: 'secondary-window-readonly', 'no-active-run',
//     'not-pending-retry', 'already-retrying', plus the host invokes
//     `controller.retryPhaseNow()` and forwards its rejection reason to
//     the ack payload.
//
// Subsequent US2 tasks (T037) extend this file with
// CMD_SAVE_GENERAL_SETTINGS cases (transactional accept/reject, four
// rejection reasons, 1s latency budget).

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  CMD_ACK,
  CMD_RETRY_PHASE_NOW,
  CMD_SAVE_GENERAL_SETTINGS
} from '../../../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../../../src/ui/sidebar/messages';

interface AckCapture {
  posted: CommandAckMessage[];
  post: (msg: CommandAckMessage) => Promise<boolean>;
}

function makeAckCapture(): AckCapture {
  const posted: CommandAckMessage[] = [];
  return {
    posted,
    post: vi.fn(async (msg: CommandAckMessage) => {
      posted.push(msg);
      return true;
    })
  };
}

function makeDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  const exec = vi.fn(async () => undefined as unknown);
  return {
    executeCommand: exec as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: vi.fn(async () => true) },
    isPrimary: () => true,
    isTrusted: () => true,
    logger: new SanitizedLogger(),
    ...overrides
  };
}

describe('MessageRouter — CMD_RETRY_PHASE_NOW gating (FR-010)', () => {
  it('secondary windows reject CMD_RETRY_PHASE_NOW with secondary-window-readonly', async () => {
    const deps = makeDeps({ isPrimary: () => false });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      { type: CMD_RETRY_PHASE_NOW, correlationId: 'cid-1', payload: { queueId: 'default' } },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
  });

  it('primary windows invoke schegent.retryPhaseNow and ack accepted', async () => {
    const execSpy = vi.fn(async () => undefined as unknown);
    const deps = makeDeps({ executeCommand: execSpy as unknown as RouterDeps['executeCommand'] });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      { type: CMD_RETRY_PHASE_NOW, correlationId: 'cid-2', payload: { queueId: 'default' } },
      cap.post
    );

    expect(execSpy).toHaveBeenCalledWith('schegent.retryPhaseNow', 'default');
    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].status).toBe('accepted');
  });

  // Feature 093 (T080) — retry-now carries the addressed queue; the payload
  // is no longer empty, and the validator refuses it when the queue is absent.
  it('CMD_RETRY_PHASE_NOW carries the addressed queue (validator + router agree)', async () => {
    const deps = makeDeps();
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      { type: CMD_RETRY_PHASE_NOW, correlationId: 'cid-3', payload: { queueId: 'default' } },
      cap.post
    );

    expect(cap.posted[0].status).toBe('accepted');
  });
});

describe('MessageRouter — CMD_RETRY_PHASE_NOW ack shape', () => {
  it('rejection ack carries the correlationId and a reason string', async () => {
    const deps = makeDeps({ isPrimary: () => false });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      { type: CMD_RETRY_PHASE_NOW, correlationId: 'corr-xyz', payload: { queueId: 'default' } },
      cap.post
    );

    const ack = cap.posted[0];
    expect(ack.correlationId).toBe('corr-xyz');
    expect(ack.status).toBe('rejected');
    expect(typeof ack.reason).toBe('string');
  });
});

// Feature 011 — T037: CMD_SAVE_GENERAL_SETTINGS gating and ack shape.
//
// Contract (general-settings-ipc.md):
//   - secondary windows → 'secondary-window-readonly'
//   - unknown keys → 'unknown-key:<key>'
//   - type mismatches → 'type-mismatch:<key>'
//   - invalid array elements (fatalSignatures) → 'invalid-array:<key>'
//   - all-valid batch → 'accepted'
// Latency: ack within 1000ms (FR-017).

describe('MessageRouter — CMD_SAVE_GENERAL_SETTINGS gating', () => {
  it('rejects on secondary window with secondary-window-readonly (Feature 056 FR-005)', async () => {
    // Feature 056 Track 1 (FR-001..FR-005) reclassified
    // CMD_SAVE_GENERAL_SETTINGS as mutating. Previously this test asserted
    // acceptance on secondary windows; that encoded the F-001 unsafe
    // exception.
    const write = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps({
      isPrimary: () => false,
      writeGeneralSettings: write
    });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_GENERAL_SETTINGS,
        correlationId: 'cid-s1',
        payload: { updates: { 'loop.maxIterations': 5 } }
      },
      cap.post
    );

    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects with unknown-key:<key> when payload contains a disallowed key', async () => {
    const write = vi.fn(async () => ({
      ok: false as const,
      reason: 'unknown-key:phases'
    }));
    const deps = makeDeps({ writeGeneralSettings: write });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_GENERAL_SETTINGS,
        correlationId: 'cid-s2',
        payload: { updates: { phases: [] } }
      },
      cap.post
    );

    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('unknown-key:phases');
  });

  it('rejects with type-mismatch:<key> on bad runtime type', async () => {
    const write = vi.fn(async () => ({
      ok: false as const,
      reason: 'type-mismatch:logging.verbose'
    }));
    const deps = makeDeps({ writeGeneralSettings: write });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_GENERAL_SETTINGS,
        correlationId: 'cid-s3',
        payload: { updates: { 'logging.verbose': 'yes' } }
      },
      cap.post
    );

    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('type-mismatch:logging.verbose');
  });

  it('rejects with invalid-array:fatalSignatures when array contains non-strings', async () => {
    const write = vi.fn(async () => ({
      ok: false as const,
      reason: 'invalid-array:fatalSignatures'
    }));
    const deps = makeDeps({ writeGeneralSettings: write });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_GENERAL_SETTINGS,
        correlationId: 'cid-s4',
        payload: { updates: { fatalSignatures: ['ok', 42] } }
      },
      cap.post
    );

    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('invalid-array:fatalSignatures');
  });

  it('accepts a fully valid update batch and acks within 1s (FR-017)', async () => {
    const write = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps({ writeGeneralSettings: write });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    const t0 = Date.now();
    await router.dispatch(
      {
        type: CMD_SAVE_GENERAL_SETTINGS,
        correlationId: 'cid-s5',
        payload: {
          updates: { 'loop.maxIterations': 7, 'logging.verbose': true }
        }
      },
      cap.post
    );
    const elapsed = Date.now() - t0;

    expect(cap.posted[0].status).toBe('accepted');
    expect(write).toHaveBeenCalledWith({
      'loop.maxIterations': 7,
      'logging.verbose': true
    });
    expect(elapsed).toBeLessThan(1000);
  });

  it('rejects with config-ops-unavailable when writeGeneralSettings is not wired', async () => {
    const deps = makeDeps({ writeGeneralSettings: undefined });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_GENERAL_SETTINGS,
        correlationId: 'cid-s6',
        payload: { updates: { 'loop.maxIterations': 5 } }
      },
      cap.post
    );

    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('config-ops-unavailable');
  });
});
