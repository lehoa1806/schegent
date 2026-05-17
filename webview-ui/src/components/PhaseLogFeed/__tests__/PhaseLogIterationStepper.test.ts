// Feature 020 T021 — PhaseLogIterationStepper: prev/next bounds,
// latest-by-default, hidden when total = 1.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseLogIterationStepper from '../PhaseLogIterationStepper.svelte';

afterEach(() => cleanup());

describe('Feature 020 T021 — PhaseLogIterationStepper', () => {
  it('renders the stepper when iterations.length > 1', () => {
    const { getByTestId } = render(PhaseLogIterationStepper, {
      props: {
        iterations: [3, 2, 1],
        currentN: 3,
        onChange: vi.fn()
      }
    });
    expect(getByTestId('phase-log-iter-stepper')).toBeTruthy();
  });

  it('hides the stepper when iterations.length === 1', () => {
    const { queryByTestId } = render(PhaseLogIterationStepper, {
      props: {
        iterations: [1],
        currentN: 1,
        onChange: vi.fn()
      }
    });
    expect(queryByTestId('phase-log-iter-stepper')).toBeNull();
  });

  it('hides the stepper when iterations is empty', () => {
    const { queryByTestId } = render(PhaseLogIterationStepper, {
      props: {
        iterations: [],
        currentN: null,
        onChange: vi.fn()
      }
    });
    expect(queryByTestId('phase-log-iter-stepper')).toBeNull();
  });

  it('disables the prev button when currentN is the lowest iteration', () => {
    const { getByTestId } = render(PhaseLogIterationStepper, {
      props: {
        iterations: [3, 2, 1],
        currentN: 1,
        onChange: vi.fn()
      }
    });
    const prev = getByTestId('phase-log-iter-prev');
    expect(prev.hasAttribute('disabled')).toBe(true);
  });

  it('disables the next button when currentN is the highest iteration', () => {
    const { getByTestId } = render(PhaseLogIterationStepper, {
      props: {
        iterations: [3, 2, 1],
        currentN: 3,
        onChange: vi.fn()
      }
    });
    const next = getByTestId('phase-log-iter-next');
    expect(next.hasAttribute('disabled')).toBe(true);
  });

  it('fires onChange with the previous iteration when prev is clicked', async () => {
    const onChange = vi.fn();
    const { getByTestId } = render(PhaseLogIterationStepper, {
      props: { iterations: [3, 2, 1], currentN: 2, onChange }
    });
    await fireEvent.click(getByTestId('phase-log-iter-prev'));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('fires onChange with the next iteration when next is clicked', async () => {
    const onChange = vi.fn();
    const { getByTestId } = render(PhaseLogIterationStepper, {
      props: { iterations: [3, 2, 1], currentN: 2, onChange }
    });
    await fireEvent.click(getByTestId('phase-log-iter-next'));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('shows "iter N / total" label', () => {
    const { getByTestId } = render(PhaseLogIterationStepper, {
      props: { iterations: [3, 2, 1], currentN: 2, onChange: vi.fn() }
    });
    const label = getByTestId('phase-log-iter-label');
    expect(label.textContent).toContain('2');
    expect(label.textContent).toContain('3');
  });
});
