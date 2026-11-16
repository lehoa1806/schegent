/**
 * The Settings page's sections, as the mockup's section navigation has them (`SET_SECS` and
 * `st.setSec` in `schegent_redesign_surfaces.html`): the sections in the mockup's order and words,
 * one shown at a time, Backends first, and a section marked while it holds an unsaved edit.
 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, SettingsPage, type SettingsPart } from '../settings-page.svelte';

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
