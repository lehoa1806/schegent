// Feature 029 T019 — ToolCallCard renders a tool-use entry as a card
// with a header (tool name) + key-value argument list. Multi-line
// values render inside MultiLineCodeBlock; arrays render as a list
// with a cap-overflow indicator; nested objects render one level deep.
// Malformed-JSON fallback shows the raw text without throwing.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import ToolCallCard from '../../parts/ToolCallCard.svelte';
import type { PhaseLogDisplayEntry } from '../../../../../../src/services/phase-log/types';

afterEach(() => cleanup());

function toolUse(over: Partial<PhaseLogDisplayEntry['body']>): PhaseLogDisplayEntry {
  return {
    seq: 1,
    kind: 'tool-use',
    ts: null,
    body: over,
    bodyTruncated: null
  } as PhaseLogDisplayEntry;
}

describe('Feature 029 T019 — ToolCallCard', () => {
  it('renders the tool name in the header', () => {
    const { getByTestId } = render(ToolCallCard, {
      props: {
        entry: toolUse({
          toolName: 'Read',
          toolArguments: { file_path: '/x' }
        })
      }
    });
    const card = getByTestId('tool-call-card');
    expect(card.getAttribute('data-tool')).toBe('Read');
    expect(card.textContent).toContain('Read');
  });

  it('renders each top-level key as a label', () => {
    const { container } = render(ToolCallCard, {
      props: {
        entry: toolUse({
          toolName: 'Edit',
          toolArguments: {
            file_path: '/a.ts',
            old_string: 'foo',
            new_string: 'bar'
          }
        })
      }
    });
    const keys = Array.from(container.querySelectorAll('dt.arg-key')).map(
      (n) => n.textContent
    );
    expect(keys).toContain('file_path');
    expect(keys).toContain('old_string');
    expect(keys).toContain('new_string');
  });

  it('renders scalars inline (no <pre><code> wrapper)', () => {
    const { container } = render(ToolCallCard, {
      props: {
        entry: toolUse({
          toolName: 'Read',
          toolArguments: { file_path: '/x', offset: 10 }
        })
      }
    });
    // No multi-line code block for short scalars.
    expect(container.querySelector('[data-testid="multiline-code-block"]')).toBeNull();
  });

  it('renders multi-line string values inside MultiLineCodeBlock', () => {
    const content = 'line 1\nline 2\nline 3';
    const { container } = render(ToolCallCard, {
      props: {
        entry: toolUse({
          toolName: 'Write',
          toolArguments: { file_path: '/a.md', content }
        })
      }
    });
    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('line 1');
    expect(code?.textContent).toContain('line 3');
  });

  it('renders an array as a bulleted list with overflow marker', () => {
    const items = Array.from({ length: 75 }, (_, i) => `item-${i}`);
    const { container } = render(ToolCallCard, {
      props: {
        entry: toolUse({
          toolName: 'Custom',
          toolArguments: { results: items }
        })
      }
    });
    const list = container.querySelector('ul.array-list');
    expect(list).not.toBeNull();
    // Should show the cap + a "more" affordance.
    const overflow = container.querySelector('.array-more');
    expect(overflow?.textContent).toContain('+25 more');
  });

  it('renders a nested plain object one level deep', () => {
    const { container } = render(ToolCallCard, {
      props: {
        entry: toolUse({
          toolName: 'Custom',
          toolArguments: { config: { mode: 'fast', limit: 10 } }
        })
      }
    });
    const nested = container.querySelector('dl.nested-list');
    expect(nested).not.toBeNull();
    const keys = Array.from(nested?.querySelectorAll('dt.arg-key.nested') ?? []).map(
      (n) => n.textContent
    );
    expect(keys).toContain('mode');
    expect(keys).toContain('limit');
  });

  it('shows the truncation pill when bodyTruncated.toolArguments is set', () => {
    const { container } = render(ToolCallCard, {
      props: {
        entry: {
          ...toolUse({
            toolName: 'Custom',
            toolArguments: { __truncated: true, originalBytes: 9999 }
          }),
          bodyTruncated: { toolArguments: { originalLength: 9999 } }
        } as PhaseLogDisplayEntry
      }
    });
    expect(container.textContent).toContain('truncated');
    expect(container.textContent).toContain('9999');
  });

  it('falls back to raw text rendering when toolInput is malformed', () => {
    const { container } = render(ToolCallCard, {
      props: {
        entry: toolUse({
          toolName: 'Custom',
          toolInput: 'this is not json'
        })
      }
    });
    expect(container.textContent).toContain('could not parse');
    const code = container.querySelector('pre > code');
    expect(code?.textContent).toContain('this is not json');
  });

  it('does not throw when toolArguments contains the elision sentinel', () => {
    const args = { tree: { __elided: true } };
    expect(() =>
      render(ToolCallCard, {
        props: {
          entry: toolUse({ toolName: 'Custom', toolArguments: args })
        }
      })
    ).not.toThrow();
  });
});
