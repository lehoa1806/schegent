import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import type { Action } from 'svelte/action';

import SgMenuHarness from './SgMenuHarness.svelte';

afterEach(() => {
  cleanup();
});

interface Mounted {
  readonly trigger: HTMLElement;
  readonly menu: HTMLElement;
  readonly otherTrigger: HTMLElement;
  readonly otherMenu: HTMLElement;
  readonly outside: HTMLElement;
  readonly onPick: ReturnType<typeof vi.fn>;
  readonly item: (name: string) => HTMLElement;
}

function menuOf(trigger: HTMLElement): HTMLElement {
  const menu = trigger.parentElement?.querySelector<HTMLElement>('[role="menu"]');
  if (menu === null || menu === undefined) throw new Error('the trigger has no menu beside it');
  return menu;
}

function mount(): Mounted {
  const onPick = vi.fn();
  const { getByTestId } = render(SgMenuHarness, { onPick });
  const trigger = getByTestId('menu-default');
  const menu = menuOf(trigger);
  const otherTrigger = getByTestId('menu-nightly');
  return {
    trigger,
    menu,
    otherTrigger,
    otherMenu: menuOf(otherTrigger),
    outside: getByTestId('outside'),
    onPick,
    item: (name) => {
      const found = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (candidate) => candidate.textContent.trim() === name
      );
      if (found === undefined) throw new Error(`no menu item named ${name}`);
      return found;
    }
  };
}

async function openMenu(mounted: Mounted): Promise<void> {
  await fireEvent.click(mounted.trigger);
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(mounted.item('Open'));
  });
}

describe('SgMenu', () => {
  it('starts closed, as a named menu button', () => {
    const { trigger, menu } = mount();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label')).toBe('Actions for Default');
    expect(menu.hidden).toBe(true);
  });

  it('opens on a click and focuses the first item', async () => {
    const mounted = mount();
    await openMenu(mounted);
    expect(mounted.trigger.getAttribute('aria-expanded')).toBe('true');
    expect(mounted.menu.hidden).toBe(false);
  });

  it('closes on a second click of the button', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent.click(mounted.trigger);
    expect(mounted.menu.hidden).toBe(true);
    expect(mounted.trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves between the items with the arrow keys, Home and End, wrapping', async () => {
    const mounted = mount();
    await openMenu(mounted);
    const focusedAfter = async (key: string): Promise<Element | null> => {
      await fireEvent.keyDown(mounted.menu, { key });
      return document.activeElement;
    };
    // "Make default" is disabled and still a stop, so a keyboard user can reach
    // it and read it, as the WAI-ARIA menu pattern has it (decision 5 of the
    // port review, 2026-11-14).
    expect(await focusedAfter('ArrowDown')).toBe(mounted.item('Make default'));
    expect(await focusedAfter('ArrowDown')).toBe(mounted.item('Rename…'));
    expect(await focusedAfter('ArrowDown')).toBe(mounted.item('Delete queue…'));
    expect(await focusedAfter('ArrowDown')).toBe(mounted.item('Open'));
    expect(await focusedAfter('ArrowUp')).toBe(mounted.item('Delete queue…'));
    expect(await focusedAfter('Home')).toBe(mounted.item('Open'));
    expect(await focusedAfter('End')).toBe(mounted.item('Delete queue…'));
  });

  it('closes on Escape and returns focus to the button', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent.keyDown(mounted.menu, { key: 'Escape' });
    expect(mounted.menu.hidden).toBe(true);
    expect(document.activeElement).toBe(mounted.trigger);
  });

  it('keeps Escape to itself, so nothing behind the menu also closes', async () => {
    const mounted = mount();
    const onDocumentKeydown = vi.fn();
    document.addEventListener('keydown', onDocumentKeydown);
    try {
      await openMenu(mounted);
      await fireEvent.keyDown(mounted.item('Open'), { key: 'Escape' });
      expect(mounted.menu.hidden).toBe(true);
      expect(onDocumentKeydown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocumentKeydown);
    }
  });

  it('closes on Tab', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent.keyDown(mounted.menu, { key: 'Tab' });
    expect(mounted.menu.hidden).toBe(true);
  });

  it('runs the chosen item, then closes and returns focus to the button', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent.click(mounted.item('Rename…'));
    expect(mounted.onPick).toHaveBeenCalledTimes(1);
    expect(mounted.onPick).toHaveBeenCalledWith('rename');
    expect(mounted.menu.hidden).toBe(true);
    expect(document.activeElement).toBe(mounted.trigger);
  });

  it('refuses a disabled item, and stays open on it', async () => {
    const mounted = mount();
    await openMenu(mounted);
    const disabled = mounted.item('Make default');
    await fireEvent.keyDown(mounted.menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(disabled);

    // Enter and Space on a button arrive as a click, so this covers the keys too.
    await fireEvent.click(disabled);
    expect(mounted.onPick).not.toHaveBeenCalled();
    expect(mounted.menu.hidden).toBe(false);
    expect(document.activeElement).toBe(disabled);
  });

  it('keeps one menu open at a time', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent.click(mounted.otherTrigger);
    await vi.waitFor(() => {
      expect(mounted.otherMenu.hidden).toBe(false);
    });
    expect(mounted.menu.hidden).toBe(true);
    expect(mounted.trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a press outside it, and not on a press inside it', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent.mouseDown(mounted.item('Rename…'));
    expect(mounted.menu.hidden).toBe(false);
    await fireEvent.mouseDown(mounted.outside);
    expect(mounted.menu.hidden).toBe(true);
  });

  it('keeps keyboard focus after a queued scroll and closes when scrolling moves the button', async () => {
    const mounted = mount();
    const bounds = vi.spyOn(mounted.trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 80, 24, 24));
    await openMenu(mounted);
    await fireEvent.keyDown(mounted.menu, { key: 'End' });
    await fireEvent.scroll(document);
    expect(mounted.menu.hidden).toBe(false);
    expect(document.activeElement).toBe(mounted.item('Delete queue…'));
    bounds.mockReturnValue(new DOMRect(50, 60, 24, 24));
    await fireEvent.scroll(document);
    expect(mounted.menu.hidden).toBe(true);
  });

  it('closes when the window is resized', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent(window, new Event('resize'));
    expect(mounted.menu.hidden).toBe(true);
  });

  it('stays open while something that does not hold the button scrolls', async () => {
    const mounted = mount();
    await openMenu(mounted);
    await fireEvent.scroll(mounted.outside);
    expect(mounted.menu.hidden).toBe(false);
  });

  it('runs a caller’s action on the button once, and its cleanup when the menu goes', () => {
    // The Settings page describes every control on hover and focus, the menu's button included,
    // and the menu knows nothing about descriptions: the caller hands it the action.
    const destroy = vi.fn();
    const triggerAction = vi.fn<Action<HTMLButtonElement>>(() => ({ destroy }));
    const { getByTestId, unmount } = render(SgMenuHarness, { triggerAction });

    expect(triggerAction).toHaveBeenCalledTimes(1);
    expect(triggerAction).toHaveBeenCalledWith(getByTestId('menu-default'));
    expect(destroy).not.toHaveBeenCalled();

    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('opens and chooses as before on a button that carries an action', async () => {
    const onPick = vi.fn();
    const { getByTestId } = render(SgMenuHarness, { onPick, triggerAction: () => {} });
    const trigger = getByTestId('menu-default');
    const menu = menuOf(trigger);

    await fireEvent.click(trigger);
    await vi.waitFor(() => {
      expect(menu.hidden).toBe(false);
    });
    await fireEvent.click(menu.querySelector('[role="menuitem"]') as HTMLElement);
    expect(onPick).toHaveBeenCalledWith('open');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });
});
