import { describe, expect, it } from 'vitest';
import { validateInboundMessage } from '../../../../src/ui/sidebar/ipc-validator';

describe('CMD_PING_BACKEND IPC boundary', () => {
  it.each(['claude', 'codex', 'agy'])('accepts the closed runner %s', (runner) => {
    const result = validateInboundMessage({
      type: 'CMD_PING_BACKEND', correlationId: 'ping', payload: { runner }
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { runner: 'gemini' },
    { runner: 'claude', path: '/tmp/forged' },
    { runner: 'codex', env: { TOKEN: 'secret' } },
    { runner: ['agy'] }
  ])('rejects forged payload %#', (payload) => {
    expect(validateInboundMessage({
      type: 'CMD_PING_BACKEND', correlationId: 'ping', payload
    }).ok).toBe(false);
  });
});
