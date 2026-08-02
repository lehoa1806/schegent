// Feature 056 Track 1 (FR-001..FR-005) — Regression tests proving the
// four catalog / general-settings save commands are rejected on
// secondary VS Code windows. The fourth command
// (CMD_SAVE_GENERAL_SETTINGS) is covered by
// tests/unit/ui/sidebar/general-settings-router.test.ts; this file
// covers the three catalog saves.
//
// MUTATING_COMMANDS is the only gate preventing a secondary host from
// rewriting VS Code workspace configuration during a multi-window
// session (CLAUDE.md hard rule). These tests pin the new policy in
// source and would fail loudly if anyone reverted message-router.ts.

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  CMD_ACK,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_PHASES,
  CMD_SAVE_MODELS
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
  return {
    executeCommand: vi.fn(async () => undefined as unknown) as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: vi.fn(async () => true) },
    updateConfig: vi.fn(async () => undefined),
    isPrimary: () => false,
    isTrusted: () => true,
    logger: new SanitizedLogger(),
    ...overrides
  };
}

describe('Feature 056 Track 1 — secondary-host gate for catalog saves', () => {
  it('CMD_SAVE_PIPELINES is rejected on a secondary host (FR-002)', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const deps = makeDeps({ updateConfig });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_PIPELINES,
        correlationId: 'cid-pipelines-secondary',
        payload: { pipelines: [] }
      },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('CMD_SAVE_PHASES is rejected on a secondary host (FR-002)', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const deps = makeDeps({ updateConfig });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'cid-phases-secondary',
        payload: { phases: [] }
      },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('CMD_SAVE_MODELS is rejected on a secondary host (FR-002)', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const deps = makeDeps({ updateConfig });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_MODELS,
        correlationId: 'cid-models-secondary',
        payload: { models: { claude: [], codex: [], agy: [] } }
      },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('CMD_SAVE_PIPELINES still works on the primary host (FR-001)', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const deps = makeDeps({ isPrimary: () => true, updateConfig });
    const router = new MessageRouter(deps);
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_PIPELINES,
        correlationId: 'cid-pipelines-primary',
        payload: { pipelines: [] }
      },
      cap.post
    );

    expect(cap.posted[0].status).toBe('accepted');
    expect(updateConfig).toHaveBeenCalledWith('pipelines', []);
  });
});
