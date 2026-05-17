import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import MonitorPill from '../MonitorPill.svelte';
import type { CliMonitorState, MonitorStatus } from '../../lib/snapshot-types';

afterEach(() => cleanup());

function buildState(overrides: Partial<CliMonitorState> = {}): CliMonitorState {
  return Object.freeze({
    runId: 'run-1',
    phase: 'speckit-specify',
    status: 'running',
    pid: 1234,
    startedAt: '2026-05-10T10:00:00.000Z',
    lastStdoutAt: '2026-05-10T10:00:42.000Z',
    lastStderrAt: null,
    lastProgressAt: null,
    stdoutLines: 5,
    stderrLines: 0,
    exitCode: null,
    signal: null,
    detectedIssues: Object.freeze([]),
    msSinceLastStdout: 42_000,
    msSinceLastStderr: null,
    ...overrides
  });
}

const SEVEN_STATUSES: ReadonlyArray<MonitorStatus> = [
  'starting',
  'running',
  'stalled',
  'completed',
  'failed',
  'timed_out',
  'canceled'
];

describe('MonitorPill', () => {
  it('renders nothing when monitor === null', () => {
    const { container } = render(MonitorPill, { props: { monitor: null } });
    expect(container.querySelector('[data-testid="monitor-pill"]')).toBeNull();
  });

  it.each(SEVEN_STATUSES)('renders status %s with data-testid + SR-readable label', (status) => {
    const { container, getByTestId } = render(MonitorPill, {
      props: { monitor: buildState({ status }) }
    });
    const pill = getByTestId('monitor-pill');
    expect(pill).not.toBeNull();
    expect(pill.getAttribute('data-status')).toBe(status);
    const label = container.querySelector(`[data-testid="monitor-pill-label"]`);
    expect(label).not.toBeNull();
    expect(label!.textContent?.toLowerCase()).toContain(status.replace('_', ' '));
    const ariaRoot = pill.getAttribute('aria-label') ?? '';
    expect(ariaRoot.toLowerCase()).toContain(status.replace('_', ' '));
  });

  it('renders "last stdout: 42s" when msSinceLastStdout === 42_000', () => {
    const { getByTestId } = render(MonitorPill, {
      props: { monitor: buildState({ msSinceLastStdout: 42_000 }) }
    });
    const stdoutInfo = getByTestId('monitor-last-stdout');
    expect(stdoutInfo.textContent).toContain('last stdout');
    expect(stdoutInfo.textContent).toContain('42s');
  });

  it('renders "last stderr: 1m 5s" when msSinceLastStderr === 65_000', () => {
    const { getByTestId } = render(MonitorPill, {
      props: { monitor: buildState({ msSinceLastStderr: 65_000 }) }
    });
    const stderrInfo = getByTestId('monitor-last-stderr');
    expect(stderrInfo.textContent).toContain('last stderr');
    expect(stderrInfo.textContent).toContain('1m 5s');
  });

  it('omits last-stdout indicator when msSinceLastStdout === null', () => {
    const { container } = render(MonitorPill, {
      props: { monitor: buildState({ msSinceLastStdout: null }) }
    });
    expect(container.querySelector('[data-testid="monitor-last-stdout"]')).toBeNull();
  });

  it('omits last-stderr indicator when msSinceLastStderr === null', () => {
    const { container } = render(MonitorPill, {
      props: { monitor: buildState({ msSinceLastStderr: null }) }
    });
    expect(container.querySelector('[data-testid="monitor-last-stderr"]')).toBeNull();
  });

  it('honors prefers-reduced-motion via @media query (no inline animation overrides)', () => {
    const { container } = render(MonitorPill, {
      props: { monitor: buildState({ status: 'stalled' }) }
    });
    const pill = container.querySelector('[data-testid="monitor-pill"]') as HTMLElement;
    expect(pill).not.toBeNull();
    const inlineStyle = pill.getAttribute('style') ?? '';
    expect(inlineStyle).not.toMatch(/animation:/i);
    expect(inlineStyle).not.toMatch(/transition:/i);
  });

  it('uses VS Code theme variables only (no hardcoded hex/rgb colors in styles)', () => {
    const { container } = render(MonitorPill, {
      props: { monitor: buildState({ status: 'running' }) }
    });
    const styleEls = container.ownerDocument.querySelectorAll('style');
    let combined = '';
    styleEls.forEach((el) => { combined += el.textContent ?? ''; });
    expect(combined).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(combined).not.toMatch(/rgb\(/);
    expect(combined).not.toMatch(/rgba\(/);
  });
});
