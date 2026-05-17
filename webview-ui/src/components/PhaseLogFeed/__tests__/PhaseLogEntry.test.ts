// Feature 020 T020 — PhaseLogEntry: kind icons, truncation indicator
// with byte count, error-flag visual on tool-result.is_error === true.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import PhaseLogEntry from '../PhaseLogEntry.svelte';
import type { PhaseLogDisplayEntry } from '../../../../../src/services/phase-log/types';

afterEach(() => cleanup());

function entry(
  over: Partial<PhaseLogDisplayEntry> & Pick<PhaseLogDisplayEntry, 'kind' | 'body'>
): PhaseLogDisplayEntry {
  return {
    seq: 1,
    ts: '2026-05-14T12:00:00.000Z',
    bodyTruncated: null,
    ...over
  } as PhaseLogDisplayEntry;
}

describe('Feature 020 T020 — PhaseLogEntry rendering', () => {
  it('renders assistant-text body text', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: { entry: entry({ kind: 'assistant-text', body: { text: 'hello' } }) }
    });
    const root = getByTestId('phase-log-entry');
    expect(root.getAttribute('data-kind')).toBe('assistant-text');
    expect(root.textContent).toContain('hello');
  });

  it('renders tool-use with tool name + truncated input', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: {
        entry: entry({
          kind: 'tool-use',
          body: { toolName: 'Read', toolInput: '{"file":"x"}' }
        })
      }
    });
    const root = getByTestId('phase-log-entry');
    expect(root.getAttribute('data-kind')).toBe('tool-use');
    expect(root.textContent).toContain('Read');
  });

  it('shows the error visual when tool-result is_error === true', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: {
        entry: entry({
          kind: 'tool-result',
          body: { toolResult: 'oops', isError: true }
        })
      }
    });
    const root = getByTestId('phase-log-entry');
    expect(root.getAttribute('data-is-error')).toBe('true');
  });

  it('does not flag the error visual when is_error is false', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: {
        entry: entry({
          kind: 'tool-result',
          body: { toolResult: 'ok', isError: false }
        })
      }
    });
    const root = getByTestId('phase-log-entry');
    expect(root.getAttribute('data-is-error')).not.toBe('true');
  });

  it('shows a truncation indicator with the original byte count', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: {
        entry: entry({
          kind: 'assistant-text',
          body: { text: 'x'.repeat(100) },
          bodyTruncated: { text: { originalLength: 5000 } }
        })
      }
    });
    const indicator = getByTestId('phase-log-entry-truncation');
    expect(indicator.textContent).toContain('5000');
  });

  it('omits the truncation indicator when bodyTruncated is null', () => {
    const { queryByTestId } = render(PhaseLogEntry, {
      props: {
        entry: entry({ kind: 'assistant-text', body: { text: 'small' } })
      }
    });
    expect(queryByTestId('phase-log-entry-truncation')).toBeNull();
  });

  it('renders truncated-head synthetic kind with droppedEntryCount', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: {
        entry: entry({
          kind: 'truncated-head',
          body: { droppedEntryCount: 42 }
        })
      }
    });
    const root = getByTestId('phase-log-entry');
    expect(root.getAttribute('data-kind')).toBe('truncated-head');
    expect(root.textContent).toContain('42');
  });
});

// Feature 029 T020 — snapshot rendering of 5 representative tool-use
// entries (Read, Glob, Grep, Bash, Write). Locks in the
// ToolCallCard-based rendering so future regressions are caught.
describe('Feature 029 T020 — PhaseLogEntry tool-use snapshots', () => {
  function toolUse(name: string, args: Record<string, unknown>): PhaseLogDisplayEntry {
    return entry({
      kind: 'tool-use',
      body: {
        toolName: name,
        toolArguments: args as Record<string, never>,
        toolInput: JSON.stringify(args)
      }
    });
  }

  it('renders Read tool-use as a card with file_path scalar', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: { entry: toolUse('Read', { file_path: '/a/b.ts' }) }
    });
    const card = getByTestId('tool-call-card');
    expect(card.getAttribute('data-tool')).toBe('Read');
    expect(card.textContent).toContain('file_path');
    expect(card.textContent).toContain('/a/b.ts');
  });

  it('renders Glob tool-use with pattern + path', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: { entry: toolUse('Glob', { pattern: 'src/**/*.ts', path: '.' }) }
    });
    const card = getByTestId('tool-call-card');
    expect(card.getAttribute('data-tool')).toBe('Glob');
    expect(card.textContent).toContain('pattern');
    expect(card.textContent).toContain('src/**/*.ts');
  });

  it('renders Grep tool-use with pattern + glob', () => {
    const { getByTestId } = render(PhaseLogEntry, {
      props: {
        entry: toolUse('Grep', {
          pattern: 'TODO',
          path: 'src',
          output_mode: 'files_with_matches'
        })
      }
    });
    const card = getByTestId('tool-call-card');
    expect(card.getAttribute('data-tool')).toBe('Grep');
    expect(card.textContent).toContain('output_mode');
    expect(card.textContent).toContain('files_with_matches');
  });

  it('renders Bash tool-use with multi-line command as code block', () => {
    const cmd = 'cd /tmp\necho hello\nls -la';
    const { getByTestId, container } = render(PhaseLogEntry, {
      props: { entry: toolUse('Bash', { command: cmd, description: 'demo' }) }
    });
    const card = getByTestId('tool-call-card');
    expect(card.getAttribute('data-tool')).toBe('Bash');
    // command contains a newline → renders inside <pre><code>.
    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('echo hello');
  });

  it('renders Write tool-use with multi-line content as code block', () => {
    const content = '# Heading\n\nFirst paragraph.\nSecond paragraph.';
    const { getByTestId, container } = render(PhaseLogEntry, {
      props: { entry: toolUse('Write', { file_path: '/a.md', content }) }
    });
    const card = getByTestId('tool-call-card');
    expect(card.getAttribute('data-tool')).toBe('Write');
    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('# Heading');
    expect(code?.textContent).toContain('Second paragraph.');
  });
});
