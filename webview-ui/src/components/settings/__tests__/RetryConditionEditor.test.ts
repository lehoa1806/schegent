/**
 * Feature 011 T053 — RetryConditionEditor.svelte unit tests.
 *
 * Covers:
 *   SC-006 — debounced (200ms) validation feedback.
 *   SC-007 — cross-artifact warning surfaces missing metric names.
 *   FR-025 — green "Valid" indicator on parse success; red error on
 *            parse failure with parser-provided text.
 *   FR-026 — yellow warning banner naming each identifier that does
 *            not appear in the phase's `instruction` text.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import RetryConditionEditor from '../RetryConditionEditor.svelte';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function flushDebounce(): Promise<void> {
  // Advance just past the 200ms debounce window.
  await vi.advanceTimersByTimeAsync(220);
}

describe('Feature 011 T053 — RetryConditionEditor (SC-006, SC-007)', () => {
  it('renders the initial source verbatim in the textarea', () => {
    const { container } = render(RetryConditionEditor, {
      props: {
        source: 'open_questions > 0',
        instruction: 'Resolve open_questions until none remain.'
      }
    });
    const textarea = container.querySelector('[data-testid="retry-condition-input"]');
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe('open_questions > 0');
  });

  it('shows green Valid indicator after 200ms debounce when expression parses', async () => {
    const { container } = render(RetryConditionEditor, {
      props: {
        source: 'open_questions > 0',
        instruction: 'Resolve open_questions until none remain.'
      }
    });
    await flushDebounce();
    const status = container.querySelector('[data-testid="retry-condition-status"]');
    expect(status).not.toBeNull();
    expect(status!.getAttribute('data-state')).toBe('valid');
    expect(status!.textContent).toMatch(/valid/i);
  });

  it('shows red error indicator after debounce when expression fails to parse', async () => {
    const { container } = render(RetryConditionEditor, {
      props: { source: 'open_questions >', instruction: 'foo' }
    });
    await flushDebounce();
    const status = container.querySelector('[data-testid="retry-condition-status"]');
    expect(status).not.toBeNull();
    expect(status!.getAttribute('data-state')).toBe('invalid');
    expect(status!.textContent).toMatch(/error|unexpected|expected/i);
  });

  it('does not flip status until debounce elapses (SC-006 timing)', async () => {
    const { container } = render(RetryConditionEditor, {
      props: { source: '', instruction: 'foo' }
    });
    const textarea = container.querySelector(
      '[data-testid="retry-condition-input"]'
    ) as HTMLTextAreaElement;
    // Simulate operator typing partial input
    await fireEvent.input(textarea, { target: { value: 'open_questions' } });
    // before debounce window elapses, status MUST still match the
    // pre-typing verdict (or the initial empty state)
    await vi.advanceTimersByTimeAsync(50);
    const earlyStatus = container.querySelector('[data-testid="retry-condition-status"]');
    // empty initial source -> initial state is 'invalid'; partial input is still invalid
    expect(earlyStatus!.getAttribute('data-state')).not.toBe('valid');
    await vi.advanceTimersByTimeAsync(200);
    const lateStatus = container.querySelector('[data-testid="retry-condition-status"]');
    // partial input does not parse — verdict should be 'invalid' after debounce
    expect(lateStatus!.getAttribute('data-state')).toBe('invalid');
  });

  it('renders yellow warning when expression names a metric not present in the instruction', async () => {
    const { container } = render(RetryConditionEditor, {
      props: {
        source: 'open_questions > 0 and missing_metric < 5',
        instruction: 'Resolve open_questions only — do not look up other metrics.'
      }
    });
    await flushDebounce();
    const warning = container.querySelector('[data-testid="retry-condition-warning"]');
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toContain('missing_metric');
    // open_questions IS in instruction, so it must NOT appear in the warning
    expect(warning!.textContent).not.toContain('open_questions');
  });

  it('does NOT render the cross-artifact warning when every identifier is in the instruction', async () => {
    const { container } = render(RetryConditionEditor, {
      props: {
        source: 'open_questions > 0',
        instruction: 'Resolve open_questions until none remain.'
      }
    });
    await flushDebounce();
    const warning = container.querySelector('[data-testid="retry-condition-warning"]');
    expect(warning).toBeNull();
  });

  it('emits a change event on validated source when operator commits', async () => {
    const onChange = vi.fn();
    const { container } = render(RetryConditionEditor, {
      props: {
        source: 'open_questions > 0',
        instruction: 'Resolve open_questions until none remain.',
        onchange: onChange
      }
    });
    const textarea = container.querySelector(
      '[data-testid="retry-condition-input"]'
    ) as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'open_questions > 1' } });
    await flushDebounce();
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last).toEqual(
      expect.objectContaining({ source: 'open_questions > 1', valid: true })
    );
  });
});
