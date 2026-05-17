import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import HoverTextHarness from './HoverTextHarness.svelte';

const SHORT_BODY = 'Short inline help text.';
const LONG_BODY =
  'A longer description of this control that intentionally exceeds the eighty character cutoff used to switch from inline rendering into the popover surface form.';

afterEach(() => cleanup());

describe('hoverTextAnchor — inline mode (body <= 80 chars)', () => {
  it('injects <p id="desc-..."> sibling and sets aria-describedby permanently', () => {
    const { container, getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'short-ctrl', description: { body: SHORT_BODY } }
    });
    const help = container.querySelector('p#desc-short-ctrl');
    expect(help).not.toBeNull();
    expect(help?.textContent).toBe(SHORT_BODY);
    const ctrl = getByTestId('harness-control');
    expect(ctrl.getAttribute('aria-describedby')).toBe('desc-short-ctrl');
    expect(ctrl.hasAttribute('data-hover-text-anchored')).toBe(false);
  });

  it('does not create a popover host in inline mode', () => {
    render(HoverTextHarness, {
      props: { controlId: 'short-ctrl', description: { body: SHORT_BODY } }
    });
    expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe('hoverTextAnchor — popover mode (body > 80 chars)', () => {
  it('marks the anchor with data-hover-text-anchored="true" and starts closed', () => {
    const { getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
    });
    const ctrl = getByTestId('harness-control');
    expect(ctrl.getAttribute('data-hover-text-anchored')).toBe('true');
    expect(ctrl.hasAttribute('aria-describedby')).toBe(false);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('(a) hover opens the popover after 400ms and toggles aria-describedby', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(HoverTextHarness, {
        props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
      });
      const ctrl = getByTestId('harness-control');
      await fireEvent.mouseEnter(ctrl);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(399);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(document.querySelector('[role="tooltip"]#hover-text-long-ctrl')).not.toBeNull();
      expect(ctrl.getAttribute('aria-describedby')).toBe('hover-text-long-ctrl');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(b) mouseleave before 400ms cancels the open timer', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(HoverTextHarness, {
        props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
      });
      const ctrl = getByTestId('harness-control');
      await fireEvent.mouseEnter(ctrl);
      await vi.advanceTimersByTimeAsync(200);
      await fireEvent.mouseLeave(ctrl);
      await vi.advanceTimersByTimeAsync(1000);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      expect(ctrl.hasAttribute('aria-describedby')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) focus opens at 0ms', async () => {
    const { getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
    });
    const ctrl = getByTestId('harness-control');
    await fireEvent.focus(ctrl);
    expect(document.querySelector('[role="tooltip"]#hover-text-long-ctrl')).not.toBeNull();
    expect(ctrl.getAttribute('aria-describedby')).toBe('hover-text-long-ctrl');
  });

  it('(d) hover-bridge: cursor moving from anchor into popover within 100ms keeps it open', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(HoverTextHarness, {
        props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
      });
      const ctrl = getByTestId('harness-control');
      await fireEvent.mouseEnter(ctrl);
      await vi.advanceTimersByTimeAsync(400);
      const popover = document.querySelector('[role="tooltip"]') as HTMLElement;
      expect(popover).not.toBeNull();
      await fireEvent.mouseLeave(ctrl);
      // Within the 100ms grace, the popover's own mouseenter cancels the leave timer.
      await vi.advanceTimersByTimeAsync(50);
      await fireEvent.mouseEnter(popover);
      await vi.advanceTimersByTimeAsync(1000);
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('(e) Escape closes the popover', async () => {
    const { getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
    });
    const ctrl = getByTestId('harness-control');
    await fireEvent.focus(ctrl);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await fireEvent.keyDown(ctrl, { key: 'Escape' });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(ctrl.hasAttribute('aria-describedby')).toBe(false);
  });

  it('(f) blur closes on microtask (no dangling aria-describedby)', async () => {
    const { getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
    });
    const ctrl = getByTestId('harness-control');
    await fireEvent.focus(ctrl);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await fireEvent.blur(ctrl);
    await Promise.resolve();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(ctrl.hasAttribute('aria-describedby')).toBe(false);
  });

  it('(g) opening twice on the same anchor still yields exactly one popover', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(HoverTextHarness, {
        props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
      });
      const ctrl = getByTestId('harness-control');
      await fireEvent.mouseEnter(ctrl);
      await vi.advanceTimersByTimeAsync(400);
      await fireEvent.mouseEnter(ctrl);
      await vi.advanceTimersByTimeAsync(400);
      expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(h) FR-015 regression: popover body carries the .hover-text-popover-body class so theme.css sizing applies', async () => {
    const { getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'long-ctrl', description: { body: LONG_BODY } }
    });
    const ctrl = getByTestId('harness-control');
    await fireEvent.focus(ctrl);
    const popover = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.classList.contains('hover-text-popover-body')).toBe(true);
    expect(popover.getAttribute('role')).toBe('tooltip');
    expect(popover.id).toBe('hover-text-long-ctrl');
  });

  it('(i) disabled=true attaches nothing (no marker, no inline, no popover)', () => {
    const { getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'long-ctrl', description: { body: LONG_BODY }, disabled: true }
    });
    const ctrl = getByTestId('harness-control');
    expect(ctrl.hasAttribute('data-hover-text-anchored')).toBe(false);
    expect(ctrl.hasAttribute('aria-describedby')).toBe(false);
    expect(document.querySelector('p#desc-long-ctrl')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe('hoverTextAnchor — disabled prop', () => {
  it('inline mode + disabled=true: no inline help, no aria-describedby', () => {
    const { container, getByTestId } = render(HoverTextHarness, {
      props: { controlId: 'short-ctrl', description: { body: SHORT_BODY }, disabled: true }
    });
    expect(container.querySelector('p#desc-short-ctrl')).toBeNull();
    expect(getByTestId('harness-control').hasAttribute('aria-describedby')).toBe(false);
  });
});
