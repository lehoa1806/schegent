// Feature 020 T015 — `projectStreamJsonlLine`: 5 accepted kinds,
// framing kinds dropped. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §4 +
// specs/020-phase-level-logs/research.md §4.

import { describe, expect, it } from 'vitest';
import { projectStreamJsonlLine } from '../../../../src/services/phase-log/phase-log-display-projector';

describe('Feature 020 T015 — projectStreamJsonlLine', () => {
  it('projects assistant text content to assistant-text kind', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello world' }]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('assistant-text');
    expect(e?.body.text).toBe('hello world');
  });

  it('projects assistant tool_use content to tool-use kind', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('tool-use');
    expect(e?.body.toolName).toBe('Read');
    expect(e?.body.toolInput).toContain('file_path');
  });

  it('projects user tool_result content to tool-result kind', () => {
    const line = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: 'file contents',
            is_error: false
          }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('tool-result');
    expect(e?.body.toolResult).toBe('file contents');
    expect(e?.body.isError).toBe(false);
  });

  it('flags tool-result entries with is_error === true', () => {
    const line = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'oops', is_error: true }]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.isError).toBe(true);
  });

  it('projects system lines to system kind', () => {
    const line = {
      type: 'system',
      subtype: 'init',
      session_id: 's1'
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('system');
    expect(e?.body.systemSubtype).toBe('init');
  });

  it('projects result lines to result kind', () => {
    const line = {
      type: 'result',
      duration_ms: 1234,
      num_turns: 3,
      total_cost_usd: 0.0042
    };
    const e = projectStreamJsonlLine(line);
    expect(e).not.toBeNull();
    expect(e?.kind).toBe('result');
    expect(e?.body.resultSummary).toBeTruthy();
  });

  it('returns null for framing kinds (message_start, message_stop, content_block_delta)', () => {
    expect(projectStreamJsonlLine({ type: 'message_start' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'message_stop' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'content_block_delta' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'content_block_start' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'content_block_stop' })).toBeNull();
    expect(projectStreamJsonlLine({ type: 'message_delta' })).toBeNull();
  });

  it('returns null for unknown types', () => {
    expect(projectStreamJsonlLine({ type: 'totally_unknown' })).toBeNull();
    expect(projectStreamJsonlLine({})).toBeNull();
    expect(projectStreamJsonlLine(null)).toBeNull();
  });
});

describe('Feature 029 — projectStreamJsonlLine populates toolArguments', () => {
  it('emits toolArguments as the original object for tool_use with scalar args', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/x', offset: 10 }
          }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.toolArguments).toEqual({ file_path: '/x', offset: 10 });
    // Legacy toolInput string remains for backward compatibility.
    expect(e?.body.toolInput).toContain('file_path');
  });

  it('preserves multi-line content as a string value (not stringified twice)', () => {
    const content = 'line 1\nline 2\nline 3';
    const line = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/a.md', content }
          }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    const args = e?.body.toolArguments as Record<string, unknown> | undefined;
    expect(args?.content).toBe(content);
  });

  it('elides values deeper than MAX_TOOL_ARGUMENT_DEPTH', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10; i++) {
      nested = { down: nested };
    }
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Custom', input: { tree: nested } }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    // The recursion starts at depth=0 on the wrapper `{ tree: ... }` and
    // returns `{ __elided: true }` as soon as depth >= 8. So the path
    // `tree.down × 7` is the first elision sentinel (1 key for `tree`
    // already consumed when we read `args.tree`; 7 more `down` hops
    // land us at depth 8).
    let cursor: unknown = (e?.body.toolArguments as Record<string, unknown>).tree;
    for (let i = 0; i < 7; i++) {
      cursor = (cursor as Record<string, unknown>).down;
    }
    expect(cursor).toEqual({ __elided: true });
  });

  it('wraps a bare-string tool input as { value }', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Custom', input: 'free form prompt' }
        ]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.toolArguments).toEqual({ value: 'free form prompt' });
    expect(e?.body.toolInput).toBe('free form prompt');
  });

  it('omits toolArguments when input is undefined', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'NoArgs' }]
      }
    };
    const e = projectStreamJsonlLine(line);
    expect(e?.body.toolArguments).toBeUndefined();
    expect(e?.body.toolInput).toBe('');
  });
});
