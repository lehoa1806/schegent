import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { CostTimelinePoint } from '../../lib/messages';
import MetricsCostChart from '../MetricsDashboard/MetricsCostChart.svelte';

afterEach(() => cleanup());

function point(index: number): CostTimelinePoint {
  return Object.freeze({
    date: `day-${String(index).padStart(3, '0')}`,
    dailyCostUsd: index + 1,
    cumulativeCostUsd: (index + 1) * 2
  });
}

describe('MetricsCostChart accessibility and density', () => {
  it('uses roving focus and arrow-key navigation across data points', async () => {
    const timeline = [point(0), point(1), point(2)];
    const onActivePointChange = vi.fn();
    const { getByTestId } = render(MetricsCostChart, {
      props: { timeline, activePointIndex: null, onActivePointChange }
    });
    const first = getByTestId('metrics-cost-trend-point-day-000');
    const second = getByTestId('metrics-cost-trend-point-day-001');
    const third = getByTestId('metrics-cost-trend-point-day-002');

    expect(first.getAttribute('tabindex')).toBe('0');
    expect(second.getAttribute('tabindex')).toBe('-1');
    expect(third.getAttribute('tabindex')).toBe('-1');

    first.focus();
    await fireEvent.keyDown(first, { key: 'ArrowRight' });
    await tick();
    await Promise.resolve();
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(second);
    expect(onActivePointChange).toHaveBeenLastCalledWith(1);

    await fireEvent.keyDown(second, { key: 'End' });
    await tick();
    await Promise.resolve();
    expect(third.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(third);
    expect(onActivePointChange).toHaveBeenLastCalledWith(2);
  });

  it('bounds dense timelines while preserving their first and last dates', () => {
    const timeline = Array.from({ length: 300 }, (_, index) => point(index));
    const { container, getByTestId, getByText } = render(MetricsCostChart, {
      props: { timeline, activePointIndex: null, onActivePointChange: vi.fn() }
    });

    expect(container.querySelectorAll('circle[role="button"]')).toHaveLength(120);
    expect(getByTestId('metrics-cost-trend-point-day-000')).not.toBeNull();
    expect(getByTestId('metrics-cost-trend-point-day-299')).not.toBeNull();
    expect(getByText(/Showing 120 evenly sampled dates from 300/)).not.toBeNull();
  });
});
