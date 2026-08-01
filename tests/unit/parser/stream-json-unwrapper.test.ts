import { describe, expect, it } from 'vitest';
import { unwrapStreamJson } from '../../../src/parser/stream-json-unwrapper';

describe('unwrapStreamJson', () => {
  it('extracts Claude assistant text blocks', () => {
    const input = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'claude result' }] }
    });
    expect(unwrapStreamJson(input).text).toBe('claude result');
  });

  it('extracts current Codex item_completed agent messages with decoded newlines', () => {
    const input = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item_completed',
        item: {
          id: 'item-1',
          type: 'agent_message',
          text: '## Audit\n- issue one\n## Remaining Issues\nNone'
        }
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } })
    ].join('\n');

    expect(unwrapStreamJson(input).text).toBe(
      '## Audit\n- issue one\n## Remaining Issues\nNone'
    );
  });

  it('keeps older dotted Codex item.completed transcripts replayable', () => {
    const input = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Historical result.' }
    });

    expect(unwrapStreamJson(input).text).toBe('Historical result.');
  });

  it('preserves a newline boundary between separate Codex agent messages', () => {
    const input = [
      JSON.stringify({
        type: 'item_completed',
        item: { type: 'agent_message', text: 'Review complete.' }
      }),
      JSON.stringify({
        type: 'item_completed',
        item: { type: 'agent_message', text: '## Remaining Issues\nNone' }
      })
    ].join('\n');

    expect(unwrapStreamJson(input).text).toBe(
      'Review complete.\n## Remaining Issues\nNone'
    );
  });

  it('retains raw JSONL when no model message is present', () => {
    const input = JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' });
    expect(unwrapStreamJson(input).text).toBe(input);
  });
});
