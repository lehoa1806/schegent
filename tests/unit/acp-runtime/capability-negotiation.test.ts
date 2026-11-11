// FR-R6-F13 T012 — initialize parameters, capability validation, profile requirements and the
// per-operation matrix (FR-004, FR-005, FR-007, FR-019).
import { describe, expect, it } from 'vitest';

import { ACP_OPERATIONS, type AgentProfile, type NegotiatedCapabilities } from '../../../src/contracts/acp-runtime';
import {
  initializeParams,
  missingRequirement,
  negotiate,
  operationAllowed
} from '../../../src/services/acp-runtime/capability-negotiation';

const NONE: NegotiatedCapabilities = {
  protocolVersion: 1,
  loadSession: false,
  image: false,
  audio: false,
  embeddedContext: false,
  authMethodCount: 0
};

function profile(requiredCapabilities: AgentProfile['requiredCapabilities']): AgentProfile {
  return {
    profileId: 'fixture-agent',
    revision: 1,
    kind: 'native',
    executableRef: 'fixture-agent',
    attribution: { provider: 'fixture', backend: 'fixture', model: 'fixture' },
    requiredCapabilities,
    qualification: 'fixture'
  };
}

describe('initializeParams', () => {
  it('advertises protocol version 1 with no file system and no terminal', () => {
    expect(initializeParams()).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    });
  });
});

describe('negotiate', () => {
  it('reads every granted capability', () => {
    const result = negotiate({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true } },
      authMethods: [{ id: 'a' }, { id: 'b' }]
    });
    expect(result).toEqual({
      ok: true,
      capabilities: { protocolVersion: 1, loadSession: true, image: true, audio: false, embeddedContext: true, authMethodCount: 2 }
    });
  });

  it('treats absent capability fields as false', () => {
    expect(negotiate({ protocolVersion: 1 })).toEqual({ ok: true, capabilities: NONE });
    expect(negotiate({ protocolVersion: 1, agentCapabilities: {} })).toEqual({ ok: true, capabilities: NONE });
  });

  it('refuses any other protocol version', () => {
    expect(negotiate({ protocolVersion: 2 })).toEqual({ ok: false, reason: 'protocol-version-unsupported' });
    expect(negotiate({ protocolVersion: 0 })).toEqual({ ok: false, reason: 'protocol-version-unsupported' });
  });

  it('fails protocol-violation on a malformed answer', () => {
    const malformed: unknown[] = [
      null,
      'x',
      [],
      {},
      { protocolVersion: '1' },
      { protocolVersion: 1.5 },
      { protocolVersion: 1, agentCapabilities: 'yes' },
      { protocolVersion: 1, agentCapabilities: { loadSession: 'true' } },
      { protocolVersion: 1, agentCapabilities: { promptCapabilities: [] } },
      { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: 1 } } },
      { protocolVersion: 1, authMethods: {} }
    ];
    for (const value of malformed) {
      expect(negotiate(value)).toEqual({ ok: false, reason: 'protocol-violation' });
    }
  });
});

describe('missingRequirement', () => {
  it('names the first requirement the agent did not grant', () => {
    expect(missingRequirement(profile([]), NONE)).toBeNull();
    expect(missingRequirement(profile(['load-session']), NONE)).toBe('load-session');
    expect(missingRequirement(profile(['load-session', 'audio']), { ...NONE, loadSession: true })).toBe('audio');
    expect(missingRequirement(profile(['embedded-context', 'image']), { ...NONE, embeddedContext: true, image: true })).toBeNull();
  });
});

describe('operationAllowed', () => {
  it('allows the operations that need nothing on a bare agent', () => {
    const allowed = ACP_OPERATIONS.filter((operation) => operationAllowed(operation, NONE));
    expect(allowed).toEqual(['initialize', 'session-new', 'prompt-text', 'prompt-resource-link', 'cancel']);
  });

  it('allows each gated operation only with its capability', () => {
    expect(operationAllowed('session-load', { ...NONE, loadSession: true })).toBe(true);
    expect(operationAllowed('prompt-embedded-resource', { ...NONE, embeddedContext: true })).toBe(true);
    expect(operationAllowed('prompt-image', { ...NONE, image: true })).toBe(true);
    expect(operationAllowed('prompt-image', { ...NONE, embeddedContext: true })).toBe(false);
  });
});
