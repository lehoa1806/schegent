import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import SystemDebugLog from '../SystemDebugLog.svelte';
import type { DebugLogEntry } from '../../lib/snapshot-types';

afterEach(() => cleanup());

function entry(overrides: Partial<DebugLogEntry> & { id: number }): DebugLogEntry {
  return Object.freeze({
    timestamp: '2026-08-02T02:00:00.000Z',
    level: 'DEBUG',
    message: `message ${overrides.id}`,
    ...overrides
  });
}

describe('SystemDebugLog', () => {
  it('renders its established empty state', () => {
    const { getByTestId, queryByTestId } = render(SystemDebugLog, { props: { entries: [] } });
    expect(getByTestId('system-empty').textContent).toBe('No debug log entries yet.');
    expect(queryByTestId('system-debug-list')).toBeNull();
  });

  it('renders debug entries newest-first with level metadata', () => {
    const entries = [
      entry({ id: 1, level: 'INFO', message: 'older' }),
      entry({ id: 2, level: 'ERROR', message: 'newer' })
    ];
    const { getByTestId } = render(SystemDebugLog, { props: { entries } });
    const rows = getByTestId('system-debug-list').querySelectorAll('li');

    expect(rows[0]?.getAttribute('data-testid')).toBe('system-entry-2');
    expect(getByTestId('system-entry-2').classList.contains('level-error')).toBe(true);
    expect(getByTestId('system-entry-level-2').textContent).toContain('ERROR');
    expect(getByTestId('system-entry-message-2').textContent).toContain('newer');
  });

  it('renders HTML-like host-projected messages as literal text', () => {
    const { container, getByTestId } = render(SystemDebugLog, {
      props: { entries: [entry({ id: 3, message: '<script>alert(1)</script>' })] }
    });
    expect(getByTestId('system-entry-message-3').textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
  });
});
