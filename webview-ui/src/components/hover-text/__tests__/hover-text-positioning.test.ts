import { describe, it, expect } from 'vitest';
import {
  computePlacement,
  type Rect,
  type Size,
  type Viewport
} from '../hover-text-positioning';

const VIEWPORT_WIDE: Viewport = { width: 1200, height: 800 };
const POPOVER_DEFAULT: Size = { width: 240, height: 120 };

function rect(left: number, top: number, width: number, height: number): Rect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height
  };
}

describe('computePlacement', () => {
  it('places the popover below the trigger when room exists (default bottom)', () => {
    const trigger = rect(400, 200, 100, 24);
    const { side, offsetX, offsetY } = computePlacement(
      trigger,
      POPOVER_DEFAULT,
      VIEWPORT_WIDE
    );
    expect(side).toBe('bottom');
    expect(offsetY).toBeGreaterThan(trigger.bottom);
    expect(offsetX).toBeGreaterThanOrEqual(0);
    expect(offsetX + POPOVER_DEFAULT.width).toBeLessThanOrEqual(VIEWPORT_WIDE.width);
  });

  it('flips to top when there is no room below', () => {
    const trigger = rect(400, 700, 100, 24);
    const { side, offsetY } = computePlacement(
      trigger,
      POPOVER_DEFAULT,
      VIEWPORT_WIDE,
      'bottom',
      'bottom'
    );
    expect(side).toBe('top');
    expect(offsetY).toBeLessThan(trigger.top);
  });

  it('flips to left when right is clipped at sidebar edge', () => {
    const viewport: Viewport = { width: 320, height: 800 };
    const trigger = rect(260, 200, 40, 24);
    const popover: Size = { width: 240, height: 80 };
    const { side, offsetX } = computePlacement(
      trigger,
      popover,
      viewport,
      'right',
      'right'
    );
    expect(side).toBe('left');
    expect(offsetX).toBeGreaterThanOrEqual(0);
    expect(offsetX + popover.width).toBeLessThanOrEqual(viewport.width);
  });

  it('auto-mode picks the side with the most room', () => {
    const trigger = rect(100, 100, 40, 24);
    const popover: Size = { width: 240, height: 120 };
    const { side } = computePlacement(trigger, popover, VIEWPORT_WIDE, 'bottom', 'auto');
    expect(['bottom', 'right']).toContain(side);
  });

  it('auto-mode flips when the preferred anchor would clip', () => {
    const trigger = rect(50, 50, 40, 24);
    const popover: Size = { width: 240, height: 120 };
    const { side } = computePlacement(trigger, popover, VIEWPORT_WIDE, 'top', 'auto');
    expect(side).not.toBe('top');
    expect(side).not.toBe('left');
  });

  it('clamps offsetX to at least 0 (no negative offsets)', () => {
    const trigger = rect(0, 200, 24, 24);
    const popover: Size = { width: 240, height: 80 };
    const { offsetX } = computePlacement(trigger, popover, VIEWPORT_WIDE, 'bottom', 'bottom');
    expect(offsetX).toBeGreaterThanOrEqual(0);
  });

  it('clamps offsetY to at least 0 when the trigger is at the top edge', () => {
    const trigger = rect(400, 0, 100, 16);
    const popover: Size = { width: 240, height: 120 };
    const { offsetY, side } = computePlacement(
      trigger,
      popover,
      VIEWPORT_WIDE,
      'top',
      'top'
    );
    expect(offsetY).toBeGreaterThanOrEqual(0);
    expect(side).not.toBe('top');
  });

  it('clamps offsetX so the popover never extends past the right edge', () => {
    const trigger = rect(1100, 200, 60, 24);
    const popover: Size = { width: 240, height: 80 };
    const { offsetX } = computePlacement(trigger, popover, VIEWPORT_WIDE, 'bottom', 'bottom');
    expect(offsetX + popover.width).toBeLessThanOrEqual(VIEWPORT_WIDE.width);
  });

  it('clamps offsetY so the popover never extends past the bottom edge', () => {
    const trigger = rect(400, 760, 100, 24);
    const popover: Size = { width: 240, height: 120 };
    const { offsetY } = computePlacement(
      trigger,
      popover,
      VIEWPORT_WIDE,
      'bottom',
      'bottom'
    );
    expect(offsetY + popover.height).toBeLessThanOrEqual(VIEWPORT_WIDE.height);
  });

  it('keeps popover in-bounds at extremely narrow viewports', () => {
    const viewport: Viewport = { width: 200, height: 800 };
    const trigger = rect(150, 300, 30, 24);
    const popover: Size = { width: 240, height: 80 };
    const { offsetX } = computePlacement(trigger, popover, viewport, 'bottom', 'auto');
    // popover is wider than viewport; offsetX clamps to >= EDGE_PAD (4 in module).
    expect(offsetX).toBeGreaterThanOrEqual(0);
  });

  it('falls back to anchor when preferredPlacement does not fit but anchor does', () => {
    const trigger = rect(400, 400, 100, 24);
    const popover: Size = { width: 100, height: 60 };
    const { side } = computePlacement(trigger, popover, VIEWPORT_WIDE, 'bottom', 'top');
    expect(side).toBe('top');
  });
});
