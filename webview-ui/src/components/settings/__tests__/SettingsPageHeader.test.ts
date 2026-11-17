// The Settings page header's "Search settings" field, as the redesign's settings page draws it:
// the first of the header's actions, a magnifier and a search input in a `.search` box, left of
// the unsaved count, Revert and Save.
//
// The mockup gives the field no behaviour. Here it hands what is typed to the page's search
// (`settings-search.test.ts` holds what a query finds, `SettingsSurface.test.ts` what the page
// then shows) and tells assistive technology how many settings match once typing pauses.
// `SettingsSurface.test.ts` holds the header's count, Revert and Save.
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INLINE_BODY_MAX_CHARS } from '../../hover-text/hover-text-types';
import { SETTINGS_PAGE_HEADER_DESCRIPTIONS } from '../SettingsPageHeader.descriptions';
import SettingsPageHeader from '../SettingsPageHeader.svelte';
import { SettingsPage } from '../settings-page.svelte';

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
