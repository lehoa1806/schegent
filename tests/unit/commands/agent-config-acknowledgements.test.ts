import { describe, expect, it, vi } from 'vitest';
import {
  FORGET_ALL_ACKS_LABEL,
  FORGET_ONE_ACK_LABEL,
  NO_AGENT_CONFIG_ACKS_MESSAGE,
  buildAgentConfigAckItems,
  runAgentConfigAcknowledgements,
  type AgentConfigAckRecord
} from '../../../src/commands/agent-config-acknowledgements';

const FP_1 = '1'.repeat(64);
const FP_2 = '2'.repeat(64);
const DIGEST_1 = 'a'.repeat(64);
const DIGEST_2 = 'b'.repeat(64);

const GRANT_1: AgentConfigAckRecord = {
  fingerprint: FP_1,
  backend: 'claude',
  grantedAt: 1_700_000_000_000,
  files: [{ name: '.claude/settings.json', size: 100, digest: DIGEST_1 }]
};

const GRANT_2: AgentConfigAckRecord = {
  fingerprint: FP_2,
  backend: 'claude',
  grantedAt: 1_700_000_100_000,
  files: [
    { name: '.claude/settings.json', size: 120, digest: DIGEST_2 },
    { name: 'CLAUDE.md', size: 42, digest: DIGEST_1 }
  ]
};

describe('Schegent: Agent Config Acknowledgements command (FR-R7-04, FR-006, SC-006)', () => {
  it('informs the operator when no acknowledgements are stored', async () => {
    const info = vi.fn();
    const pick = vi.fn();
    await runAgentConfigAcknowledgements({
      grants: () => ({}),
      forget: vi.fn(),
      forgetAll: vi.fn(),
      pick,
      confirm: vi.fn(),
      info
    });
    expect(pick).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(NO_AGENT_CONFIG_ACKS_MESSAGE);
  });

  it('orders rows newest-first and appends Forget All only when more than one grant exists', () => {
    const single = buildAgentConfigAckItems({ [FP_1]: GRANT_1 });
    expect(single).toHaveLength(1);
    expect(single[0]?.fingerprint).toBe(FP_1);

    const multi = buildAgentConfigAckItems({ [FP_1]: GRANT_1, [FP_2]: GRANT_2 });
    expect(multi).toHaveLength(3);
    expect(multi[0]?.fingerprint).toBe(FP_2);
    expect(multi[1]?.fingerprint).toBe(FP_1);
    expect(multi[2]?.fingerprint).toBeNull();
    expect(multi[2]?.label).toBe(FORGET_ALL_ACKS_LABEL);
  });

  it('forgets a single acknowledgement only after explicit modal confirmation', async () => {
    const forget = vi.fn(async () => true);
    const info = vi.fn();

    // Dismissal at confirm changes nothing.
    await runAgentConfigAcknowledgements({
      grants: () => ({ [FP_1]: GRANT_1 }),
      forget,
      forgetAll: vi.fn(),
      pick: async (items) => items[0],
      confirm: async () => undefined,
      info
    });
    expect(forget).not.toHaveBeenCalled();

    // Affirmative confirm withdraws the grant.
    await runAgentConfigAcknowledgements({
      grants: () => ({ [FP_1]: GRANT_1 }),
      forget,
      forgetAll: vi.fn(),
      pick: async (items) => items[0],
      confirm: async () => FORGET_ONE_ACK_LABEL,
      info
    });
    expect(forget).toHaveBeenCalledWith(FP_1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('forgot'));
  });

  it('reports when the selected acknowledgement was already gone', async () => {
    const info = vi.fn();
    await runAgentConfigAcknowledgements({
      grants: () => ({ [FP_1]: GRANT_1 }),
      forget: async () => false,
      forgetAll: vi.fn(),
      pick: async (items) => items[0],
      confirm: async () => FORGET_ONE_ACK_LABEL,
      info
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('already gone'));
  });

  it('forgets all acknowledgements when the sentinel row is confirmed', async () => {
    const forgetAll = vi.fn(async () => 2);
    const info = vi.fn();
    await runAgentConfigAcknowledgements({
      grants: () => ({ [FP_1]: GRANT_1, [FP_2]: GRANT_2 }),
      forget: vi.fn(),
      forgetAll,
      pick: async (items) => items[items.length - 1],
      confirm: async () => FORGET_ALL_ACKS_LABEL,
      info
    });
    expect(forgetAll).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('forgot 2'));
  });
});
