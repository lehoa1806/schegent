/**
 * The Settings page: its sections and its one save model, as the redesign's settings page has
 * them.
 *
 * The page lists its sections in a navigation and shows one at a time: Backends, unless the page is
 * opened on another (the Queues list's "Queue defaults" opens it on Queues). The others stay
 * mounted, only hidden, so an edit made in one section is still counted, saved and reverted while
 * another is shown. A section is marked while it holds an unsaved edit.
 *
 * While the header's search field holds a word, the page shows every section that holds a matching
 * setting in place of the one section, and no section is the current one. Choosing a section ends
 * the search; emptying the field returns to the section that was shown. `settings-search.svelte.ts`
 * holds what a query finds. A search changes only what is on screen, never what is counted, saved
 * or reverted.
 *
 * One save model per page: edits accumulate in the drafts of the page's parts, the page header
 * counts them and offers one Revert and one Save, and no row or part saves or resets on its own.
 *
 * A part is whatever holds a draft: the general fields, which the host writes as one
 * transactional batch; the queue settings and each queue's failure behaviour, which it writes
 * through the queue commands; and the failure signatures, which it writes as their own list. Each
 * part keeps its draft, its validation and its write. The page only asks each one what changed and
 * whether it can save, and tells it to save or to revert. Save runs every part that can save side
 * by side: they post different updates and none waits on another.
 *
 * A part with changes it cannot save yet (a failure signature row left empty) is counted but
 * skipped by Save, and keeps its warning until the row is filled or removed. Save is on while any
 * part can save; Revert is on while anything has changed.
 */
import { untrack } from 'svelte';
import { SettingsSearch } from './settings-search.svelte';

/** The page's sections, in the order and the words of the redesign's section navigation. */
export const SETTINGS_SECTIONS = [
  { id: 'backends', label: 'Backends' },
  { id: 'execution', label: 'Runs and retries' },
  { id: 'queues', label: 'Queues' },
  { id: 'logging', label: 'Logs and retention' },
  { id: 'privacy', label: 'Privacy and evidence' },
  { id: 'trust', label: 'Trust and prompts' },
  { id: 'signatures', label: 'Failure signatures' }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** The words the navigation shows for a section. */
export function settingsSectionLabel(id: SettingsSectionId): string {
  const section = SETTINGS_SECTIONS.find((entry) => entry.id === id);
  return section === undefined ? id : section.label;
}

export interface SettingsPart {
  /** The part's unsaved edits, counted under the section that shows each one. */
  changes(): Partial<Record<SettingsSectionId, number>>;
  /** True when the part has edits it can write now. */
  canSave(): boolean;
  /** Writes the part's edits. Resolves when the host has answered or the wait has ended. */
  save(): Promise<void>;
  /** Drops the part's edits and shows the saved values again. */
  revert(): void;
}

export class SettingsPage {
  /** The header's search. While it holds a word, it decides which sections are on screen. */
  readonly search = new SettingsSearch();
  #parts = $state.raw<readonly SettingsPart[]>([]);
  #saving = $state(false);
  #section = $state<SettingsSectionId>('backends');

  /** A page showing the given section, Backends unless another is named. */
  constructor(opening: SettingsSectionId = 'backends') {
    this.#section = opening;
  }

  /** The section chosen in the navigation: the one shown whenever no search is on. */
  get section(): SettingsSectionId {
    return this.#section;
  }

  /** The section the navigation marks as current; none while a search is on. */
  get current(): SettingsSectionId | undefined {
    return this.search.active ? undefined : this.#section;
  }

  /** Shows the given section in place of whatever is shown, and ends a search. */
  select(id: SettingsSectionId): void {
    this.search.clear();
    this.#section = id;
  }

  /** True when the given section is on screen. */
  shows(id: SettingsSectionId): boolean {
    return this.search.active ? this.search.found(id) : this.#section === id;
  }

  /** The last section on screen, in page order; none while no section is. */
  get lastShown(): SettingsSectionId | undefined {
    return SETTINGS_SECTIONS.filter((section) => this.shows(section.id)).at(-1)?.id;
  }

  /** True while any part holds an unsaved edit in the given section. */
  sectionChanged(id: SettingsSectionId): boolean {
    return this.#parts.some((part) => (part.changes()[id] ?? 0) > 0);
  }

  /**
   * Adds a part and returns the function that removes it. Call it from an `$effect`, so the part
   * leaves with the component that holds its draft. The list is read untracked: the effect writes
   * it, and a tracked read would run the effect again on its own write.
   */
  register(part: SettingsPart): () => void {
    this.#parts = [...untrack(() => this.#parts), part];
    return () => {
      this.#parts = untrack(() => this.#parts).filter((entry) => entry !== part);
    };
  }

  /** Every unsaved edit on the page. */
  get changedCount(): number {
    let total = 0;
    for (const part of this.#parts) {
      for (const count of Object.values(part.changes())) total += count;
    }
    return total;
  }

  get canSave(): boolean {
    return !this.#saving && this.#parts.some((part) => part.canSave());
  }

  async save(): Promise<void> {
    if (!this.canSave) return;
    this.#saving = true;
    try {
      const results = await Promise.allSettled(
        this.#parts.filter((part) => part.canSave()).map((part) => part.save())
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure !== undefined) throw failure.reason;
    } finally {
      this.#saving = false;
    }
  }

  revert(): void {
    for (const part of this.#parts) part.revert();
  }
}
