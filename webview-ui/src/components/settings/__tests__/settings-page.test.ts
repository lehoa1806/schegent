/**
 * The Settings page's sections, as the mockup's section navigation has them (`SET_SECS` and
 * `st.setSec` in `schegent_redesign_surfaces.html`): the sections in the mockup's order and words,
 * one shown at a time, Backends first unless the page is opened on another, and a section marked
 * while it holds an unsaved edit. The last block covers the page while its search field holds a
 * word.
 */
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SECTIONS,
  SettingsPage,
  type SettingsPart,
  type SettingsSectionId
} from '../settings-page.svelte';

/** A part that reports the given unsaved edits and can save them. */
function partWith(changes: ReturnType<SettingsPart['changes']>): SettingsPart {
  return {
    changes: () => changes,
    canSave: () => true,
    save: () => Promise.resolve(),
    revert: () => undefined
  };
}

describe('SettingsPage sections', () => {
  it('lists the mockup sections in its order and words', () => {
    expect(SETTINGS_SECTIONS.map((section) => [section.id, section.label])).toEqual([
      ['backends', 'Backends'],
      ['execution', 'Runs and retries'],
      ['queues', 'Queues'],
      ['logging', 'Logs and retention'],
      ['privacy', 'Privacy and evidence'],
      ['trust', 'Trust and prompts'],
      ['signatures', 'Failure signatures']
    ]);
  });

  it('opens on Backends and shows no other section', () => {
    const page = new SettingsPage();
    expect(page.section).toBe('backends');
    expect(SETTINGS_SECTIONS.filter((section) => page.shows(section.id)).map((section) => section.id))
      .toEqual(['backends']);
  });

  // The Queues list's "Queue defaults" opens the page on its Queues section, as the mockup's
  // button carries `data-sec="queues"`.
  it('opens on the section it is given, and on that section only', () => {
    const page = new SettingsPage('queues');
    expect(page.section).toBe('queues');
    expect(SETTINGS_SECTIONS.filter((section) => page.shows(section.id)).map((section) => section.id))
      .toEqual(['queues']);
  });

  it('shows the section it is given in place of the one it showed', () => {
    const page = new SettingsPage();
    page.select('trust');
    expect(page.section).toBe('trust');
    expect(page.shows('trust')).toBe(true);
    expect(page.shows('backends')).toBe(false);
  });

  it('marks a section while any part holds an unsaved edit in it', () => {
    const page = new SettingsPage();
    page.register(partWith({ execution: 2 }));
    const remove = page.register(partWith({ signatures: 1, logging: 0 }));
    expect(SETTINGS_SECTIONS.filter((section) => page.sectionChanged(section.id)).map((section) => section.id))
      .toEqual(['execution', 'signatures']);

    remove();
    expect(page.sectionChanged('signatures')).toBe(false);
    expect(page.sectionChanged('execution')).toBe(true);
  });
});

// The redesign's "Search settings" field. While it holds a word the page shows every section that
// holds a matching setting, and no section is the current one; choosing a section ends the search.
// `settings-search.test.ts` holds the rules for what a query finds.
describe('SettingsPage search', () => {
  function pageWithSettings(opening?: SettingsSectionId): SettingsPage {
    const page = new SettingsPage(opening);
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

  function shownSections(page: SettingsPage): SettingsSectionId[] {
    return SETTINGS_SECTIONS.filter((section) => page.shows(section.id)).map(
      (section) => section.id
    );
  }

  it('shows every section that holds a match, whichever section was shown', () => {
    const page = pageWithSettings();

    page.search.query = 'lo';
    expect(shownSections(page)).toEqual(['execution', 'logging']);

    page.search.query = 'loop';
    expect(shownSections(page)).toEqual(['execution']);
  });

  it('shows no section when nothing matches', () => {
    const page = pageWithSettings();

    page.search.query = 'no-such-setting';
    expect(shownSections(page)).toEqual([]);
  });

  it('has no current section while a search is on', () => {
    const page = pageWithSettings();
    expect(page.current).toBe('backends');

    page.search.query = 'loop';
    expect(page.current).toBeUndefined();
  });

  it('ends the search when a section is chosen, and shows that section', () => {
    const page = pageWithSettings();

    page.search.query = 'loop';
    page.select('privacy');
    expect(page.search.query).toBe('');
    expect(page.current).toBe('privacy');
    expect(shownSections(page)).toEqual(['privacy']);
  });

  it('returns to the section it showed when the search is cleared', () => {
    const page = pageWithSettings('trust');

    page.search.query = 'loop';
    expect(shownSections(page)).toEqual(['execution']);

    page.search.clear();
    expect(page.current).toBe('trust');
    expect(shownSections(page)).toEqual(['trust']);
  });
});
