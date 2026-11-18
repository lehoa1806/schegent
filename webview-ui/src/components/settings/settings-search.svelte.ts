// The Settings page's search: the model behind the header's "Search settings" field.
//
// The redesign's settings page (`schegent_redesign_surfaces.html`) draws the field and gives it
// no behaviour, so the rules are the port's own, and they are those of its other search fields:
// the field filters the page. While it holds a word, the page shows only the settings that match.
//
// A setting is found by its fixed words: its name, its note, its setting key, its description,
// the headings and notes of the blocks it sits in and its section's name. It is never found by a
// value the user can edit, so a setting cannot leave the page while it is being edited. Every
// word typed must be found; the order and the case of the words do not matter. The words are
// compared as plain text and are never made into a pattern.
//
// A closed group that holds a found setting opens while the search is on, because the page hides
// a group's summary meanwhile and the user could not open it. When the search ends, the group
// closes again, as it was, unless it holds the focus or the page has since kept it open for a
// setting the user asked for.
//
// A component marks its settings with the actions of `settingsSearch()`. `row` marks one
// setting, `group` a block of settings whose words find every setting inside it. Each action
// hides its element while a search is on and no setting inside it matches. `refusal` marks where
// the host's refusal of a save is drawn, so the page can bring it into sight
// (`settings-refusals.ts`). The section a component belongs to comes from
// `provideSettingsSearch`, which `SettingsSection` calls. A component mounted outside a section,
// as a unit test mounts one, gets actions that do nothing, so it shows every setting.
import { getContext, setContext, untrack } from 'svelte';
import type { Action } from 'svelte/action';
import type { ControlDescription } from '../hover-text/hover-text-types';
import type { Refusals } from './settings-refusals';

/** The fixed words of a setting or a block. A part that is absent is left out. */
export type SearchWords = readonly (string | undefined)[];

/** Gives the words a setting or a block is found by, read again for each search. */
export type SearchText = () => SearchWords;

/** A hover description as search words: its title, if it has one, and its body. */
export function descriptionWords(description: ControlDescription): SearchWords {
  return [description.title, description.body];
}

/** One setting: the element that shows it, the section it is in, and its words. */
export interface SearchRow {
  readonly section: string;
  readonly sectionName: string;
  readonly node: HTMLElement;
  readonly text: SearchText;
}

/** A block of settings, such as a backend card. Its words find every setting inside it. */
export interface SearchGroup {
  readonly node: HTMLElement;
  readonly text: SearchText;
}

export class SettingsSearch {
  /** What the field holds, as typed. */
  query = $state('');
  #rows = $state.raw<readonly SearchRow[]>([]);
  #groups = $state.raw<readonly SearchGroup[]>([]);
  /** The closed groups a search opened, to close again when it ends. */
  readonly #opened = new WeakSet<HTMLDetailsElement>();

  /** The words typed, in lower case. Every change of the query gives a new list. */
  #words = $derived.by((): readonly string[] => {
    const text = this.query.trim().toLowerCase();
    return text === '' ? [] : text.split(/\s+/);
  });

  #matching = $derived.by((): readonly SearchRow[] =>
    this.#words.length === 0 ? [] : this.#rows.filter((row) => this.#holdsEveryWord(row))
  );

  /** True while the field holds a word. */
  get active(): boolean {
    return this.#words.length > 0;
  }

  /** How many settings the search finds. */
  get count(): number {
    return this.#matching.length;
  }

  /** True when the search finds a setting in the given section. */
  found(section: string): boolean {
    return this.#matching.some((row) => row.section === section);
  }

  /** True when the element is, or holds, a setting the search finds. */
  holdsMatch(node: HTMLElement | undefined): boolean {
    if (node === undefined) return false;
    return this.#matching.some((row) => node.contains(row.node));
  }

  /** The count in the words of a status line; empty while there is no search. */
  get summary(): string {
    if (!this.active) return '';
    const count = this.count;
    if (count === 0) return 'No setting matches.';
    return count === 1 ? '1 setting matches.' : `${count} settings match.`;
  }

  /** Ends the search. */
  clear(): void {
    this.query = '';
  }

  /** Opens a group that holds a found setting. A group the search opens, it closes again. */
  openForSearch(group: HTMLDetailsElement): void {
    if (group.open) return;
    group.open = true;
    this.#opened.add(group);
  }

  /**
   * Closes a group the search opened, now that the search has ended. A group that holds the focus
   * stays open, so the setting the user is in does not vanish under the caret.
   */
  closeAfterSearch(group: HTMLDetailsElement): void {
    if (!this.#opened.delete(group)) return;
    if (!group.contains(group.ownerDocument.activeElement)) group.open = false;
  }

  /** Opens a group for good: the search will not close it when it ends. */
  keepOpen(group: HTMLDetailsElement): void {
    this.#opened.delete(group);
    group.open = true;
  }

  /**
   * Adds a setting and returns the function that removes it. The list is read untracked: the
   * caller is an effect that writes it, and a tracked read would run that effect again on its
   * own write.
   */
  addRow(row: SearchRow): () => void {
    this.#rows = [...untrack(() => this.#rows), row];
    return () => {
      this.#rows = untrack(() => this.#rows).filter((entry) => entry !== row);
    };
  }

  /** Adds a block of settings and returns the function that removes it. */
  addGroup(group: SearchGroup): () => void {
    this.#groups = [...untrack(() => this.#groups), group];
    return () => {
      this.#groups = untrack(() => this.#groups).filter((entry) => entry !== group);
    };
  }

  #holdsEveryWord(row: SearchRow): boolean {
    const around = this.#groups.filter((group) => group.node.contains(row.node));
    const parts = [row.sectionName, ...row.text(), ...around.flatMap((group) => group.text())];
    // One part to a line: a word holds no white space, so it cannot match across two parts.
    const text = parts
      .filter((part) => part !== undefined)
      .join('\n')
      .toLowerCase();
    return this.#words.every((word) => text.includes(word));
  }
}

/** What a section gives the settings inside it: the page's search and the section's own name. */
export interface SearchScope {
  readonly search: SettingsSearch;
  readonly section: string;
  readonly name: string;
  /** Ends the search and shows the section. */
  readonly show: () => void;
  /** The page's refusals, which it brings into sight. */
  readonly refusals: Refusals;
}

/** What a component uses to take part in the search. */
export interface SearchParts {
  /** Marks an element as one setting, found by the words its function returns. */
  readonly row: Action<HTMLElement, SearchText>;
  /** Marks an element as a block of settings. Its words, if any, find every setting inside. */
  readonly group: Action<HTMLElement, SearchText | undefined>;
  /** True when the element is, or holds, a setting the search finds. */
  readonly holdsMatch: (node: HTMLElement | undefined) => boolean;
  /**
   * Brings into sight a setting the user asked for by another control. When the search hides
   * the element, the search ends and the element's section shows; otherwise nothing changes.
   */
  readonly reveal: (node: HTMLElement | undefined) => void;
  /**
   * Marks an element that draws the host's refusal of a save, while the function given returns
   * true, or for as long as the element exists when none is given. The page brings it into sight.
   */
  readonly refusal: Action<HTMLElement, (() => boolean) | undefined>;
}

const SCOPE = Symbol('settings-search');

const NO_WORDS: SearchText = () => [];

const ALWAYS = (): boolean => true;

/** For a component outside any section: nothing is registered and nothing is hidden. */
const NO_SEARCH: SearchParts = {
  row: () => undefined,
  group: () => undefined,
  holdsMatch: () => false,
  reveal: () => undefined,
  refusal: () => undefined
};

/** The groups around a node, the nearest first. */
function groupsAround(node: HTMLElement): HTMLDetailsElement[] {
  const groups: HTMLDetailsElement[] = [];
  for (let group = node.closest('details'); group !== null; ) {
    groups.push(group);
    group = group.parentElement?.closest('details') ?? null;
  }
  return groups;
}

/**
 * Makes the caller the search scope of every component inside it. The scope is a function, so
 * the caller's props are read where they are used and not when the component is created.
 */
export function provideSettingsSearch(scope: () => SearchScope): void {
  setContext(SCOPE, scope);
}

/**
 * The search parts for the calling component: the scope of the section around it, or parts that
 * do nothing when no section is around it. Call it while the component is created.
 *
 * Use an action only on an element whose `hidden` the template does not set itself.
 */
export function settingsSearch(): SearchParts {
  const scope = getContext<(() => SearchScope) | undefined>(SCOPE);
  if (scope === undefined) return NO_SEARCH;

  const row: Action<HTMLElement, SearchText> = (node, text) => {
    $effect(() => {
      const { search, section, name } = scope();
      return search.addRow({ section, sectionName: name, node, text });
    });
    $effect(() => {
      const { search } = scope();
      const shown = !search.active || search.holdsMatch(node);
      node.hidden = !shown;
      // A setting the search finds must be seen, so a closed group around it opens. While a search
      // is on the group's summary is not drawn, so the user could not open it.
      const group = node.closest('details');
      if (group === null) return;
      if (!search.active) search.closeAfterSearch(group);
      else if (shown) search.openForSearch(group);
    });
  };

  const group: Action<HTMLElement, SearchText | undefined> = (node, text = NO_WORDS) => {
    $effect(() => scope().search.addGroup({ node, text }));
    $effect(() => {
      const { search } = scope();
      node.hidden = search.active && !search.holdsMatch(node);
    });
  };

  const reveal = (node: HTMLElement | undefined): void => {
    if (node === undefined) return;
    const { search, show } = scope();
    if (search.active && !search.holdsMatch(node)) show();
    for (const around of groupsAround(node)) search.keepOpen(around);
  };

  // The scope is read untracked: the refusal is added again only when it is drawn again.
  const refusal: Action<HTMLElement, (() => boolean) | undefined> = (node, refused = ALWAYS) => {
    $effect(() => {
      if (!refused()) return;
      const { search, show, refusals } = untrack(scope);
      return refusals.add(node, () => {
        if (node.closest('[hidden]') !== null) show();
        for (const around of groupsAround(node)) search.keepOpen(around);
      });
    });
  };

  return { row, group, holdsMatch: (node) => scope().search.holdsMatch(node), reveal, refusal };
}
