// FR-R6-F13 T014 — ACP session updates to F07 display parts and F06 usage readings (research R5,
// FR-015, FR-016). Every display event must pass F07's own validator.
import { describe, expect, it } from 'vitest';

import { mapSessionUpdate, toNormalizedEvent, type DisplayPart } from '../../../src/services/acp-runtime/session-update-mapper';
import { asAcpNormalizedEvent } from '../../../src/services/phase-log/acp-live-projection';

function display(update: unknown): DisplayPart {
  const mapped = mapSessionUpdate(update);
  if (mapped.kind !== 'display') throw new Error(`expected display, got ${mapped.kind}`);
  return mapped.part;
}

describe('mapSessionUpdate display rows', () => {
  it('maps agent and user message chunks to message text', () => {
    expect(display({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })).toEqual({
      kind: 'message',
      text: 'hi',
      sourceEventId: null
    });
    expect(display({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ask' } })).toMatchObject({
      kind: 'message',
      text: 'ask'
    });
  });

  it('shows a non-text content block as a placeholder', () => {
    expect(display({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } })).toMatchObject({
      kind: 'message',
      text: '[non-text content]'
    });
  });

  it('maps a thought chunk to status', () => {
    expect(display({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })).toEqual({
      kind: 'status',
      text: 'thinking',
      sourceEventId: null
    });
  });

  it('maps a tool call with its title, raw input and id', () => {
    expect(
      display({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read file', kind: 'read', rawInput: { path: 'a' } })
    ).toEqual({ kind: 'tool-call', toolName: 'Read file', toolArgs: { path: 'a' }, sourceEventId: 'call-1' });
  });

  it('falls back to the tool kind, then to "tool"', () => {
    expect(display({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'edit' })).toMatchObject({ toolName: 'edit' });
    expect(display({ sessionUpdate: 'tool_call', toolCallId: 'c' })).toMatchObject({ toolName: 'tool' });
  });

  it('keeps a tool call id of 256 characters and drops a longer one', () => {
    const atCap = 'c'.repeat(256);
    expect(display({ sessionUpdate: 'tool_call', toolCallId: atCap, title: 't' }).sourceEventId).toBe(atCap);
    expect(display({ sessionUpdate: 'tool_call', toolCallId: 'c'.repeat(257), title: 't' }).sourceEventId).toBeNull();
  });

  // Review S-1: the id becomes a row key, which no display sanitizer passes over.
  it('drops a tool call id that carries a control, format, lone-surrogate or line-separator character', () => {
    for (const codePoint of [0x00, 0x0a, 0x1b, 0x7f, 0x9b, 0x200b, 0x202e, 0x2028, 0x2029, 0xd800]) {
      const toolCallId = `call${String.fromCodePoint(codePoint)}1`;
      expect(display({ sessionUpdate: 'tool_call', toolCallId, title: 't' }).sourceEventId).toBeNull();
      expect(display({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }).sourceEventId).toBeNull();
    }
    expect(display({ sessionUpdate: 'tool_call', toolCallId: 'call 1/a:b', title: 't' }).sourceEventId).toBe('call 1/a:b');
  });

  it('maps a terminal tool update to a result from its text content, else the status word', () => {
    expect(
      display({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'line one' } },
          { type: 'diff', path: 'x', newText: 'y' },
          { type: 'content', content: { type: 'text', text: 'line two' } }
        ]
      })
    ).toEqual({ kind: 'tool-result', text: 'line one\nline two', sourceEventId: 'call-1' });
    expect(display({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' })).toMatchObject({
      kind: 'tool-result',
      text: 'failed'
    });
  });

  it('maps a plan to one line per entry in order', () => {
    expect(
      display({
        sessionUpdate: 'plan',
        entries: [
          { content: 'first', priority: 'high', status: 'completed' },
          { content: 'second', priority: 'low', status: 'pending' }
        ]
      })
    ).toEqual({ kind: 'plan', text: '[completed] first\n[pending] second', sourceEventId: null });
  });
});

describe('mapSessionUpdate usage and ignored rows', () => {
  it('maps a usage update with the cost amount as a decimal string', () => {
    expect(mapSessionUpdate({ sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } })).toEqual({
      kind: 'usage',
      usage: { used: 1200, size: 200000, cost: { amount: '0.01', currency: 'USD' } }
    });
    expect(mapSessionUpdate({ sessionUpdate: 'usage_update', used: 900, size: 200000 })).toEqual({
      kind: 'usage',
      usage: { used: 900, size: 200000 }
    });
  });

  it('drops a cost that is not a non-negative decimal', () => {
    const exponent = mapSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 1e-7, currency: 'USD' } });
    const negative = mapSessionUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: -1, currency: 'USD' } });
    expect(exponent).toEqual({ kind: 'usage', usage: { used: 1, size: 2 } });
    expect(negative).toEqual({ kind: 'usage', usage: { used: 1, size: 2 } });
  });

  it('ignores a non-terminal tool update', () => {
    expect(mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress' })).toEqual({
      kind: 'ignored',
      reason: 'non-terminal-tool-update'
    });
  });

  it('ignores an unknown kind', () => {
    expect(mapSessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toEqual({
      kind: 'ignored',
      reason: 'unknown-kind'
    });
  });

  it('ignores a malformed update of a known kind', () => {
    const malformed: unknown[] = [
      null,
      { sessionUpdate: 3 },
      { sessionUpdate: 'agent_message_chunk' },
      { sessionUpdate: 'plan', entries: 'x' },
      { sessionUpdate: 'plan', entries: [{ content: 1, status: 'pending' }] },
      { sessionUpdate: 'usage_update', used: -1, size: 2 },
      { sessionUpdate: 'usage_update', used: 1.5, size: 2 },
      { sessionUpdate: 'tool_call_update', status: 'completed' }
    ];
    for (const update of malformed) {
      expect(mapSessionUpdate(update)).toEqual({ kind: 'ignored', reason: 'invalid-update' });
    }
  });
});

describe('toNormalizedEvent', () => {
  it('produces events that F07 accepts, for every display kind', () => {
    const parts: DisplayPart[] = [
      display({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }),
      display({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } }),
      display({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', rawInput: { p: 1 } }),
      display({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }),
      display({ sessionUpdate: 'plan', entries: [{ content: 'x', priority: 'low', status: 'pending' }] })
    ];
    for (const part of parts) {
      const live = toNormalizedEvent(part, { generation: 3, attemptId: 'attempt-1', origin: 'live' });
      const history = toNormalizedEvent(part, { generation: 3, attemptId: null, origin: 'history' });
      expect(asAcpNormalizedEvent(live)).not.toBeNull();
      expect(asAcpNormalizedEvent(history)).not.toBeNull();
      expect(live).toMatchObject({ connectionGeneration: '3', attemptId: 'attempt-1', origin: 'live', kind: part.kind });
    }
  });

  it('carries no tool fields on a non-tool event', () => {
    const event = toNormalizedEvent(display({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }), {
      generation: 1,
      attemptId: null,
      origin: 'live'
    });
    expect(Object.keys(event).sort()).toEqual(['attemptId', 'connectionGeneration', 'kind', 'origin', 'sourceEventId', 'text']);
  });
});
