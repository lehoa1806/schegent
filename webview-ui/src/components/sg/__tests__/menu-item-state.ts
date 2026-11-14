// How a test reads whether a menu item is off (decision 5 of the port review, 2026-11-14).
//
// The menus turn an item off with `aria-disabled="true"`, never with `disabled`. A natively
// disabled button cannot take focus, so the arrow keys would pass over it, and a keyboard user
// could not reach it to read why it is off. `SgMenu` refuses a click on an `aria-disabled` item
// before the item's own handler sees it. Reading `.disabled` would pass on an item that is off
// and out of reach, so a test reads a menu item through this, which fails on that item instead.

import { expect } from 'vitest';

/** Whether the menu item is off. Fails on a missing item, a non-item, or a natively disabled one. */
export function isMenuItemOff(item: Element | null): boolean {
  if (item === null) throw new Error('the menu item is not in the document');
  expect(item.getAttribute('role'), 'not a menu item').toMatch(/^menuitem/);
  expect(item.hasAttribute('disabled'), 'a menu item must stay in reach of the arrow keys').toBe(
    false
  );
  return item.getAttribute('aria-disabled') === 'true';
}
