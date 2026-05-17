/**
 * Feature 018 — Settings UI Hover Text & Descriptions.
 *
 * Pure positioning module. Given a trigger rect, a popover size, the
 * viewport, and a preferred anchor, returns the resolved side and
 * coordinates clamped to viewport bounds. No DOM access — testable
 * with plain values.
 */

import type { HoverTextAnchor, HoverTextPreferredPlacement } from './hover-text-types';

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly side: HoverTextAnchor;
  readonly offsetX: number;
  readonly offsetY: number;
}

const GAP = 6;
const EDGE_PAD = 4;

function spaceOn(side: HoverTextAnchor, trigger: Rect, viewport: Viewport): number {
  switch (side) {
    case 'top': return trigger.top;
    case 'bottom': return viewport.height - trigger.bottom;
    case 'left': return trigger.left;
    case 'right': return viewport.width - trigger.right;
  }
}

function fits(side: HoverTextAnchor, trigger: Rect, popover: Size, viewport: Viewport): boolean {
  const available = spaceOn(side, trigger, viewport) - GAP - EDGE_PAD;
  const need = side === 'top' || side === 'bottom' ? popover.height : popover.width;
  return available >= need;
}

function pickAutoSide(trigger: Rect, popover: Size, viewport: Viewport): HoverTextAnchor {
  const order: HoverTextAnchor[] = ['bottom', 'top', 'right', 'left'];
  for (const side of order) {
    if (fits(side, trigger, popover, viewport)) return side;
  }
  // Nothing fits; pick the side with the most room.
  let best: HoverTextAnchor = 'bottom';
  let bestRoom = -Infinity;
  for (const side of order) {
    const room = spaceOn(side, trigger, viewport);
    if (room > bestRoom) {
      bestRoom = room;
      best = side;
    }
  }
  return best;
}

const OPPOSITE: Record<HoverTextAnchor, HoverTextAnchor> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left'
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function computePlacement(
  trigger: Rect,
  popover: Size,
  viewport: Viewport,
  anchor: HoverTextAnchor = 'bottom',
  preferredPlacement: HoverTextPreferredPlacement = 'auto'
): Placement {
  // Resolve the side: 'auto' picks the side with the most viewport room.
  // A named placement is used if it fits; otherwise the opposite side is
  // tried (flip behavior), then the anchor, then auto.
  let side: HoverTextAnchor;
  if (preferredPlacement === 'auto') {
    side = pickAutoSide(trigger, popover, viewport);
  } else if (fits(preferredPlacement, trigger, popover, viewport)) {
    side = preferredPlacement;
  } else if (fits(OPPOSITE[preferredPlacement], trigger, popover, viewport)) {
    side = OPPOSITE[preferredPlacement];
  } else if (fits(anchor, trigger, popover, viewport)) {
    side = anchor;
  } else {
    side = pickAutoSide(trigger, popover, viewport);
  }

  let offsetX = 0;
  let offsetY = 0;
  switch (side) {
    case 'top':
      offsetX = trigger.left + trigger.width / 2 - popover.width / 2;
      offsetY = trigger.top - popover.height - GAP;
      break;
    case 'bottom':
      offsetX = trigger.left + trigger.width / 2 - popover.width / 2;
      offsetY = trigger.bottom + GAP;
      break;
    case 'left':
      offsetX = trigger.left - popover.width - GAP;
      offsetY = trigger.top + trigger.height / 2 - popover.height / 2;
      break;
    case 'right':
      offsetX = trigger.right + GAP;
      offsetY = trigger.top + trigger.height / 2 - popover.height / 2;
      break;
  }

  // Clamp to viewport bounds (with edge padding).
  offsetX = clamp(offsetX, EDGE_PAD, viewport.width - popover.width - EDGE_PAD);
  offsetY = clamp(offsetY, EDGE_PAD, viewport.height - popover.height - EDGE_PAD);

  return { side, offsetX, offsetY };
}
