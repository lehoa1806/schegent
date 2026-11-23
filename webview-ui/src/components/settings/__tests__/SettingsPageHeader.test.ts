// The Settings page header's "Search settings" field, as the redesign's settings page draws it:
// the first of the header's actions, a magnifier and a search input in a `.search` box, left of
// the unsaved count, Revert and Save.
//
// The mockup gives the field no behaviour. Here it hands what is typed to the page's search
// (`settings-search.test.ts` holds what a query finds, `SettingsSurface.test.ts` what the page
// then shows) and tells assistive technology how many settings match once typing pauses.
// `SettingsSurface.test.ts` holds the header's count and what Revert and Save do; the last
// describe here holds how they are off: dimmed by `aria-disabled`, so a press that turns one
// off leaves the focus on it, and a press while off does nothing.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INLINE_BODY_MAX_CHARS } from '../../hover-text/hover-text-types';
import { SETTINGS_PAGE_HEADER_DESCRIPTIONS } from '../SettingsPageHeader.descriptions';
import SettingsPageHeader from '../SettingsPageHeader.svelte';
import { SettingsPage, type SettingsPart } from '../settings-page.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A page with two settings to find, "Loop limit" and "Log level". */
function pageWithSettings(): SettingsPage {
  const page = new SettingsPage();
  page.search.addRow({
    section: 'execution',
    sectionName: 'Runs and retries',
    node: document.createElement('div'),
    text: () => ['Loop limit']
  });
  page.search.addRow({
    section: 'logging',
    sectionName: 'Logs and retention',
    node: document.createElement('div'),
    text: () => ['Log level']
  });
  return page;
}

function mount(page: SettingsPage = pageWithSettings()) {
  const view = render(SettingsPageHeader, { props: { page } });
  const field = view.getByTestId('settings-search') as HTMLInputElement;
  return { ...view, page, field };
}

describe('SettingsPageHeader, the search field as the redesign draws it', () => {
  it('puts "Search settings" first among the header actions, left of Revert and Save', () => {
    const { container, field } = mount();

    const actions = container.querySelector('.phead > .actions');
    const box = actions?.firstElementChild;
    expect(box?.classList.contains('search')).toBe(true);
    expect(field.parentElement).toBe(box);

    const controls = Array.from(actions?.querySelectorAll('input, button') ?? []).map((control) =>
      control.getAttribute('data-testid')
    );
    expect(controls).toEqual(['settings-search', 'settings-revert', 'settings-save']);
  });

  it('draws it as the mockup search fields are drawn: a magnifier and a search input', () => {
    const { field } = mount();

    const icon = field.parentElement?.querySelector('svg.i');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('use')?.getAttribute('href')).toBe('#i-search');

    expect(field.type).toBe('search');
    expect(field.classList.contains('input')).toBe(true);
    expect(field.placeholder).toBe('Search settings');
    expect(field.getAttribute('aria-label')).toBe('Search settings');
  });

  it('hands what is typed to the page search, and empties when the search is cleared', async () => {
    const { page, field } = mount();

    await fireEvent.input(field, { target: { value: 'Loop limit' } });
    expect(page.search.query).toBe('Loop limit');

    page.search.clear();
    await tick();
    expect(field.value).toBe('');
  });

  it('describes the field in a popover, so the header gains no line', () => {
    expect(SETTINGS_PAGE_HEADER_DESCRIPTIONS.search.title).toBe('Search settings');
    expect(SETTINGS_PAGE_HEADER_DESCRIPTIONS.search.body.length).toBeGreaterThan(
      INLINE_BODY_MAX_CHARS
    );

    const { container, field } = mount();
    expect(field.getAttribute('data-hover-text-anchored')).toBe('true');
    expect(field.getAttribute('data-hover-text-controlid')).toBe('search');
    expect(container.querySelector('.hover-text-inline-help')).toBeNull();
  });
});

describe('SettingsPageHeader, the search status line', () => {
  const PAUSE_MS = 500;

  it('is a polite status region inside the search box, empty while there is no search', () => {
    const { getByTestId, field } = mount();

    const status = getByTestId('settings-search-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.classList.contains('sr-only')).toBe(true);
    expect(status.parentElement).toBe(field.parentElement);
    expect(status.textContent).toBe('');
  });

  it('says how many settings match once typing has paused, not on each key', async () => {
    vi.useFakeTimers();
    const { getByTestId, field } = mount();
    const status = getByTestId('settings-search-status');

    await fireEvent.input(field, { target: { value: 'lo' } });
    await vi.advanceTimersByTimeAsync(PAUSE_MS - 1);
    expect(status.textContent).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect(status.textContent).toBe('2 settings match.');

    // A key inside the pause starts the wait again.
    await fireEvent.input(field, { target: { value: 'loo' } });
    await vi.advanceTimersByTimeAsync(PAUSE_MS - 1);
    await fireEvent.input(field, { target: { value: 'loop' } });
    await vi.advanceTimersByTimeAsync(PAUSE_MS - 1);
    expect(status.textContent).toBe('2 settings match.');
    await vi.advanceTimersByTimeAsync(1);
    expect(status.textContent).toBe('1 setting matches.');
  });

  it('says when nothing matches, and falls silent when the search ends', async () => {
    vi.useFakeTimers();
    const { getByTestId, field } = mount();
    const status = getByTestId('settings-search-status');

    await fireEvent.input(field, { target: { value: 'no-such-setting' } });
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    expect(status.textContent).toBe('No setting matches.');

    await fireEvent.input(field, { target: { value: '' } });
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    expect(status.textContent).toBe('');
  });
});

describe('SettingsPageHeader, Revert and Save while they are off', () => {
  /** A part of the page with one unsaved edit or none; its save and revert are spies. */
  function partWith(changed: boolean): SettingsPart {
    return {
      changes: () => (changed ? { execution: 1 } : {}),
      canSave: () => changed,
      save: vi.fn(() => Promise.resolve()),
      revert: vi.fn()
    };
  }

  it('marks both off with aria-disabled, not disabled, so a press keeps the focus', () => {
    const { getByTestId } = mount(new SettingsPage());

    for (const id of ['settings-revert', 'settings-save']) {
      const button = getByTestId(id);
      expect(button.getAttribute('aria-disabled'), id).toBe('true');
      expect(button.hasAttribute('disabled'), id).toBe(false);
    }
  });

  it('does nothing on a press while they are off', async () => {
    const page = new SettingsPage();
    const part = partWith(false);
    page.register(part);
    const { getByTestId } = mount(page);

    await fireEvent.click(getByTestId('settings-revert'));
    await fireEvent.click(getByTestId('settings-save'));

    expect(part.revert).not.toHaveBeenCalled();
    expect(part.save).not.toHaveBeenCalled();
  });

  it('turns both on once a part of the page has an edit to save', () => {
    const page = new SettingsPage();
    page.register(partWith(true));
    const { getByTestId } = mount(page);

    expect(getByTestId('settings-revert').getAttribute('aria-disabled')).toBe('false');
    expect(getByTestId('settings-save').getAttribute('aria-disabled')).toBe('false');
  });
});

describe('SettingsPageHeader, a refused save at the button boundary (W01)', () => {
  async function captureUnhandledRejections(action: () => Promise<void>): Promise<unknown[]> {
    const unhandled: unknown[] = [];
    const onNodeRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const onWindowRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      unhandled.push(event.reason);
    };
    process.on('unhandledRejection', onNodeRejection);
    window.addEventListener('unhandledrejection', onWindowRejection);
    try {
      await action();
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    } finally {
      process.off('unhandledRejection', onNodeRejection);
      window.removeEventListener('unhandledrejection', onWindowRejection);
    }
    return unhandled;
  }

  function rejectingPart(save: () => Promise<void>): SettingsPart {
    return {
      changes: () => ({ execution: 1 }),
      canSave: () => true,
      save,
      revert: vi.fn()
    };
  }

  it('catches a rejected page.save() with zero unhandled rejections, renders settings-save-error outside .phead > .actions, and keeps Save focusable for retry', async () => {
    const page = new SettingsPage();
    const save = vi.fn(() => Promise.reject(new Error('future-gate')));
    page.register(rejectingPart(save));
    const { container, getByTestId, queryByTestId } = mount(page);
    expect(queryByTestId('settings-save-error')).toBeNull();

    const saveButton = getByTestId('settings-save');
    saveButton.focus();

    const unhandled = await captureUnhandledRejections(async () => {
      await fireEvent.click(saveButton);
      await waitFor(() => expect(getByTestId('settings-save-error')).toBeTruthy());
    });

    expect(unhandled).toEqual([]);
    const errorNode = getByTestId('settings-save-error');
    expect(errorNode.getAttribute('role')).toBe('alert');
    expect(errorNode.textContent.trim()).toBe('The host refused this action (future-gate).');
    expect(errorNode.textContent).not.toContain('`');

    const header = container.querySelector('.phead');
    const actions = container.querySelector('.phead > .actions');
    expect(header?.contains(errorNode)).toBe(true);
    expect(actions?.contains(errorNode)).toBe(false);
    const controls = Array.from(actions?.querySelectorAll('input, button') ?? []).map((control) =>
      control.getAttribute('data-testid')
    );
    expect(controls).toEqual(['settings-search', 'settings-revert', 'settings-save']);

    expect(getByTestId('settings-unsaved').textContent.trim()).toBe('1 unsaved change');
    expect(saveButton.getAttribute('aria-disabled')).toBe('false');
    expect(saveButton.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(saveButton);
  });

  it('sanitizes raw paths and stacks from rejected save errors while mapping known boundary codes', async () => {
    const page = new SettingsPage();
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error('EACCES: open /synthetic/home/user-252/secret.json\n  at write (/host/fs.ts:42)')
      )
      .mockRejectedValueOnce('untrusted-workspace');
    page.register(rejectingPart(save));
    const { getByTestId } = mount(page);

    const unhandled = await captureUnhandledRejections(async () => {
      await fireEvent.click(getByTestId('settings-save'));
      await waitFor(() =>
        expect(getByTestId('settings-save-error').textContent.trim()).toBe(
          'The host refused this action.'
        )
      );
      expect(getByTestId('settings-save-error').textContent).not.toContain('user-252');
      expect(getByTestId('settings-save-error').textContent).not.toContain('secret.json');
      expect(getByTestId('settings-save-error').textContent).not.toContain('`');

      await fireEvent.click(getByTestId('settings-save'));
      await waitFor(() =>
        expect(getByTestId('settings-save-error').textContent.trim()).toBe(
          'The workspace is not trusted, so this action is unavailable.'
        )
      );
    });

    expect(unhandled).toEqual([]);
  });

  it('clears settings-save-error when retry starts and stays clear when retry succeeds', async () => {
    let finishRetry: (() => void) | undefined;
    const page = new SettingsPage();
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('future-gate'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRetry = resolve;
          })
      );
    page.register(rejectingPart(save));
    const { getByTestId, queryByTestId } = mount(page);

    const unhandled = await captureUnhandledRejections(async () => {
      await fireEvent.click(getByTestId('settings-save'));
      await waitFor(() => expect(getByTestId('settings-save-error')).toBeTruthy());

      await fireEvent.click(getByTestId('settings-save'));
      await waitFor(() => expect(queryByTestId('settings-save-error')).toBeNull());

      finishRetry?.();
      await tick();
    });

    expect(unhandled).toEqual([]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(queryByTestId('settings-save-error')).toBeNull();
  });

  it('clears settings-save-error when Revert is activated', async () => {
    const page = new SettingsPage();
    const part = rejectingPart(vi.fn(() => Promise.reject(new Error('future-gate'))));
    page.register(part);
    const { getByTestId, queryByTestId } = mount(page);

    const unhandled = await captureUnhandledRejections(async () => {
      await fireEvent.click(getByTestId('settings-save'));
      await waitFor(() => expect(getByTestId('settings-save-error')).toBeTruthy());

      await fireEvent.click(getByTestId('settings-revert'));
      await waitFor(() => expect(queryByTestId('settings-save-error')).toBeNull());
    });

    expect(unhandled).toEqual([]);
    expect(part.revert).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale save rejection that arrives after Revert was clicked while save was pending', async () => {
    let rejectPending: ((reason?: unknown) => void) | undefined;
    let dirty = true;
    const page = new SettingsPage();
    page.register({
      changes: () => (dirty ? { execution: 1 } : {}),
      canSave: () => dirty,
      save: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectPending = reject;
          })
      ),
      revert: vi.fn(() => {
        dirty = false;
      })
    });
    const { getByTestId, queryByTestId } = mount(page);

    const unhandled = await captureUnhandledRejections(async () => {
      await fireEvent.click(getByTestId('settings-save'));
      await fireEvent.click(getByTestId('settings-revert'));
      rejectPending?.(new Error('future-gate'));
      await tick();
    });

    expect(unhandled).toEqual([]);
    expect(queryByTestId('settings-save-error')).toBeNull();
  });

  it('ignores a late save rejection after the header unmounts with zero unhandled rejections', async () => {
    let rejectPending: ((reason?: unknown) => void) | undefined;
    const page = new SettingsPage();
    page.register(
      rejectingPart(
        vi.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectPending = reject;
            })
        )
      )
    );
    const { getByTestId, unmount } = mount(page);

    const unhandled = await captureUnhandledRejections(async () => {
      await fireEvent.click(getByTestId('settings-save'));
      unmount();
      rejectPending?.(new Error('future-gate'));
      await tick();
    });

    expect(unhandled).toEqual([]);
  });

  it('handles non-string error messages, throwing getters, and token-shaped messages safely without leaking or throwing', async () => {
    const nullProtoMessage = new Error('placeholder');
    Object.defineProperty(nullProtoMessage, 'message', {
      value: Object.create(null) as unknown,
      configurable: true
    });
    const undefinedMessage = new Error('placeholder');
    Object.defineProperty(undefinedMessage, 'message', {
      value: undefined,
      configurable: true
    });
    const throwingGetter = new Error('placeholder');
    Object.defineProperty(throwingGetter, 'message', {
      get() {
        throw new Error('getter exploded');
      },
      configurable: true
    });
    const tokenLikeError = new Error('sk-ant-api03-synthetic0123456789abcdef');

    const page = new SettingsPage();
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(nullProtoMessage)
      .mockRejectedValueOnce(undefinedMessage)
      .mockRejectedValueOnce(throwingGetter)
      .mockRejectedValueOnce(tokenLikeError);
    page.register(rejectingPart(save));
    const { getByTestId } = mount(page);

    const unhandled = await captureUnhandledRejections(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await fireEvent.click(getByTestId('settings-save'));
        await waitFor(() =>
          expect(getByTestId('settings-save-error').textContent.trim()).toBe(
            'The host refused this action.'
          )
        );
        expect(getByTestId('settings-save-error').textContent).not.toContain('sk-ant');
        expect(getByTestId('settings-save-error').textContent).not.toContain('undefined');
      }
    });

    expect(unhandled).toEqual([]);
    expect(save).toHaveBeenCalledTimes(4);
  });
});
