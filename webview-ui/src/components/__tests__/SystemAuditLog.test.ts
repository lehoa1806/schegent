import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import SystemAuditLog from '../SystemAuditLog.svelte';
import type { AuditTailEntry } from '../../lib/snapshot-types';

afterEach(() => cleanup());

function entry(overrides: Partial<AuditTailEntry> & { id: string }): AuditTailEntry {
  return Object.freeze({
    timestamp: '2026-08-02T02:00:00.000Z',
    phase: null,
    category: 'system',
    summary: `summary ${overrides.id}`,
    runId: 'run-default',
    scope: 'system',
    ...overrides
  });
}

describe('SystemAuditLog', () => {
  it('shows system-scope events and cross-lists task-scoped CLI invocations only', () => {
    const entries = [
      entry({ id: 'system', scope: 'system' }),
      entry({ id: 'task', scope: 'task', category: 'phase-transition' }),
      entry({ id: 'cli', scope: 'task', category: 'cli-invocation', command: 'claude --print' })
    ];
    const { getByTestId, queryByTestId } = render(SystemAuditLog, { props: { entries } });

    expect(getByTestId('system-entry-system')).not.toBeNull();
    expect(queryByTestId('system-entry-task')).toBeNull();
    expect(getByTestId('system-entry-cli')).not.toBeNull();
  });

  it('renders structured metadata, placeholders, outcomes, and newest-first ordering', () => {
    const entries = [
      entry({ id: 'old', timestamp: '2026-08-02T01:00:00.000Z' }),
      entry({
        id: 'new',
        timestamp: '2026-08-02T02:00:00.000Z',
        taskId: 'task-7',
        phaseId: 'speckit-plan',
        outcome: 'error',
        summary: 'terminal failure'
      })
    ];
    const { getByTestId } = render(SystemAuditLog, { props: { entries } });
    const rows = getByTestId('system-audit-list').querySelectorAll('li');

    expect(rows[0]?.getAttribute('data-testid')).toBe('system-entry-new');
    expect(getByTestId('system-entry-task-new').textContent).toContain('task-7');
    expect(getByTestId('system-entry-phase-new').textContent).toContain('speckit-plan');
    expect(getByTestId('system-entry-outcome-new').textContent).toContain('error');
    expect(getByTestId('system-entry-new').getAttribute('aria-label')).toContain('error');
    expect(getByTestId('system-entry-task-old').textContent).toContain('—');
  });

  it('renders CLI commands as literal text and strips terminal control sequences', () => {
    const entries = [
      entry({
        id: 'cli',
        scope: 'task',
        category: 'cli-invocation',
        command: '\u001b[31m<script>alert(1)</script>\u001b[0m'
      })
    ];
    const { container, getByTestId } = render(SystemAuditLog, { props: { entries } });
    const command = getByTestId('system-entry-command-cli');

    expect(command.textContent).toContain('<script>alert(1)</script>');
    expect(command.textContent).not.toContain('\u001b[31m');
    expect(container.querySelector('script')).toBeNull();
  });

  it('preserves unknown audit categories with the generic system glyph', () => {
    const unknown = { ...entry({ id: 'unknown' }), category: 'toString' } as unknown as AuditTailEntry;
    const { getByTestId } = render(SystemAuditLog, { props: { entries: [unknown] } });

    expect(getByTestId('system-entry-unknown')).not.toBeNull();
    expect(getByTestId('system-entry-category-unknown').textContent).toContain('·');
    expect(getByTestId('system-entry-category-unknown').textContent).toContain('toString');
  });

  it('renders the system-event empty state after filtering', () => {
    const taskOnly = entry({ id: 'task', scope: 'task', category: 'phase-transition' });
    const { getByTestId, queryByTestId } = render(SystemAuditLog, { props: { entries: [taskOnly] } });

    expect(getByTestId('system-empty').textContent).toBe('No system events yet.');
    expect(queryByTestId('system-audit-list')).toBeNull();
  });
});
