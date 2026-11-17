// The Settings page's search: which settings a query finds.
//
// The redesign's settings page draws a "Search settings" field and gives it no behaviour, so the
// rules are the port's own. A setting is found by its fixed words (its name, its note, its setting
// key, its description, the headings it sits under and its section's name) and never by a value
// the user can edit, so a setting cannot leave the page while it is being edited. Every word typed
// must be found; the order and the case of the words do not matter.
import { describe, expect, it } from 'vitest';

import { SettingsSearch } from '../settings-search.svelte';

function node(parent?: HTMLElement): HTMLElement {
  const element = document.createElement('div');
  parent?.append(element);
  return element;
}

/** Three settings in two sections; the path sits in the Claude card, a group. */
function searchWithSettings() {
  const search = new SettingsSearch();
  const card = node();
  const loop = node();
  const silent = node();
  const path = node(card);

  search.addRow({
    section: 'execution',
    sectionName: 'Runs and retries',
    node: loop,
    text: () => ['Loop limit', undefined, 'schegent.loop.maxIterations']
  });
  search.addRow({
    section: 'execution',
    sectionName: 'Runs and retries',
    node: silent,
    text: () => ['Stop a step that is silent for', 'schegent.invocation.idleTimeoutSeconds']
  });
  const removePath = search.addRow({
    section: 'backends',
    sectionName: 'Backends',
    node: path,
    text: () => ['CLI path', 'schegent.cli.path']
  });
  const removeCard = search.addGroup({ node: card, text: () => ['Claude'] });

  return { search, card, loop, silent, path, removePath, removeCard };
}

describe('SettingsSearch', () => {
  it('is not a search until the field holds a word', () => {
    const { search, loop } = searchWithSettings();

    for (const query of ['', '   ', '\t']) {
      search.query = query;
      expect(search.active, `"${query}" is no search`).toBe(false);
      expect(search.count).toBe(0);
      expect(search.found('execution')).toBe(false);
      expect(search.holdsMatch(loop)).toBe(false);
      expect(search.summary).toBe('');
    }
  });

  it('finds a setting whose words hold every word typed, in any order and any case', () => {
    const { search, loop, silent } = searchWithSettings();

    for (const query of ['loop limit', 'LIMIT loop', '  Limit   LOOP  ']) {
      search.query = query;
      expect(search.active).toBe(true);
      expect(search.count, `"${query}" finds one setting`).toBe(1);
      expect(search.holdsMatch(loop)).toBe(true);
      expect(search.holdsMatch(silent)).toBe(false);
    }
  });

  it('leaves out a setting that lacks one of the words', () => {
    const { search } = searchWithSettings();

    search.query = 'loop silent';
    expect(search.count).toBe(0);
    expect(search.found('execution')).toBe(false);
  });

  it('finds a setting by a part of a word, such as a part of its key', () => {
    const { search, silent } = searchWithSettings();

    search.query = 'idletimeout';
    expect(search.count).toBe(1);
    expect(search.holdsMatch(silent)).toBe(true);
  });

  it('reads the words typed as plain text, never as a pattern', () => {
    const { search, loop } = searchWithSettings();

    for (const query of ['.*', 'l..p', 'loop|silent', '[a-z]+', '(']) {
      search.query = query;
      expect(search.count, `"${query}" is not a pattern`).toBe(0);
    }

    search.query = 'loop.max';
    expect(search.holdsMatch(loop)).toBe(true);
  });

  it('finds every setting of a section by the section name', () => {
    const { search, loop, silent, path } = searchWithSettings();

    search.query = 'retries';
    expect(search.count).toBe(2);
    expect(search.holdsMatch(loop)).toBe(true);
    expect(search.holdsMatch(silent)).toBe(true);
    expect(search.holdsMatch(path)).toBe(false);
    expect(search.found('execution')).toBe(true);
    expect(search.found('backends')).toBe(false);
  });

  it('finds the settings inside a group by the group name', () => {
    const { search, path } = searchWithSettings();

    search.query = 'claude cli';
    expect(search.count).toBe(1);
    expect(search.holdsMatch(path)).toBe(true);
    expect(search.found('backends')).toBe(true);
  });

  it('answers for anything that holds a found setting, and for nothing else', () => {
    const { search, card, loop } = searchWithSettings();
    const page = node();
    page.append(card, loop);

    search.query = 'schegent.cli.path';
    expect(search.holdsMatch(card)).toBe(true);
    expect(search.holdsMatch(page)).toBe(true);
    expect(search.holdsMatch(loop)).toBe(false);
    expect(search.holdsMatch(node())).toBe(false);
  });

  it('says how many settings match, in the words of a status line', () => {
    const { search } = searchWithSettings();

    search.query = 'schegent';
    expect(search.summary).toBe('3 settings match.');
    search.query = 'loop';
    expect(search.summary).toBe('1 setting matches.');
    search.query = 'no-such-setting';
    expect(search.summary).toBe('No setting matches.');
  });

  it('forgets a setting or a group once it is removed', () => {
    const { search, path, removePath, removeCard } = searchWithSettings();

    search.query = 'claude';
    expect(search.holdsMatch(path)).toBe(true);

    // Without the card, the path is found by its own words only.
    removeCard();
    expect(search.count).toBe(0);
    search.query = 'cli path';
    expect(search.count).toBe(1);

    removePath();
    expect(search.count).toBe(0);
    expect(search.found('backends')).toBe(false);
  });

  it('ends the search when it is cleared', () => {
    const { search } = searchWithSettings();

    search.query = 'loop';
    search.clear();
    expect(search.query).toBe('');
    expect(search.active).toBe(false);
  });
});
