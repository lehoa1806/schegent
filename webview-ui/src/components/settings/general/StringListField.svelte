<script lang="ts">
  // FR-R3-143 (T030) — an editable list of strings, used by `kind: 'string-list'`.
  //
  // WHY IT VALIDATES RATHER THAN TRUSTING THE HOST. `sanitizeProcessEnvAllowlist`
  // (`src/runner/spawn-env.ts:40`) drops a name that does not match the pattern
  // SILENTLY, at spawn time. An operator who typed `MY-VAR` would see the save
  // accepted, the row persisted, and the variable simply never arrive — with
  // nothing anywhere saying why. So the entry is refused here, visibly, at the
  // moment it is added, against the pattern the host itself reads
  // (`SETTINGS_SCHEMA`, threaded through `FieldSpec.itemPattern`).
  //
  // WHY `FatalSignaturesTab.svelte` IS NOT REUSED. It is a tab, not a control:
  // it owns its own header, its own save/reset pair, its own dirty tracking, its
  // own IPC call and its own status line, and it renders one specific setting.
  // Making it a field row means undoing all of that. The duplication that
  // remains between the two is filed, not fixed, at T045.
  //
  // The two also ADD differently, and that half is now decided rather than
  // filed: see the `'string-list'` kind in `field-types.ts`. The short version
  // is that this control is for entries with an `itemPattern` — refuse at add,
  // keep the list always-valid, rows read-only — and free text belongs in a
  // tab with editable rows instead.

  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import type { ControlDescription } from '../../hover-text/hover-text-types';

  interface Props {
    /** Bound list. Edited immutably: every mutation assigns a new array. */
    value: string[];
    /** Regex source the host validates against, from `SETTINGS_SCHEMA`. */
    itemPattern?: string;
    /** Shown when an entry fails `itemPattern`. */
    invalidMessage?: string;
    /**
     * Prefix for this control's `data-testid`s and hover-text control ids. The
     * entry field takes it verbatim, so it matches the `general-settings-input-*`
     * / description-key convention every other field kind follows; Add and
     * Remove take `-add` and `-remove-<i>`.
     */
    controlIdPrefix: string;
    labelledBy: string;
    inputDescription: ControlDescription;
    addDescription: ControlDescription;
    removeDescription: ControlDescription;
  }

  let {
    value = $bindable(),
    itemPattern,
    invalidMessage,
    controlIdPrefix,
    labelledBy,
    inputDescription,
    addDescription,
    removeDescription
  }: Props = $props();

  let entry = $state('');
  let error = $state('');

  const pattern = $derived(itemPattern === undefined ? null : new RegExp(itemPattern));

  function add(): void {
    const candidate = entry.trim();
    if (candidate.length === 0) {
      error = 'Enter a name first.';
      return;
    }
    if (pattern !== null && !pattern.test(candidate)) {
      error = invalidMessage ?? `"${candidate}" is not an accepted entry.`;
      return;
    }
    if (value.includes(candidate)) {
      error = `${candidate} is already in the list.`;
      return;
    }
    value = [...value, candidate];
    entry = '';
    error = '';
  }

  // FR-R3-143 (review) — by POSITION, for the reason the `each` below is keyed
  // by position: a projected list can hold the same name twice. Filtering by
  // value removed every match, so a single click on either row of a duplicate
  // pair emptied both, and the operator's next Save wrote a list they had not
  // authored. `add()` cannot produce a duplicate, which is why this survived —
  // the state only arrives from a hand-edited `settings.json`.
  function remove(index: number): void {
    value = value.filter((_, existing) => existing !== index);
    error = '';
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter') return;
    // Enter in a settings field must add the entry, not submit anything ambient.
    ev.preventDefault();
    add();
  }
</script>

<!--
  The redesign’s list language, as on the signature table: a bordered box with a rule between
  rows, each name in the code face and a remove icon at the row’s end; the entry field and its
  Add button sit under it.
-->
<div class="string-list" data-testid="string-list-{controlIdPrefix}">
  {#if value.length === 0}
    <!-- Not `.empty`: the page sheet sets that class as the large centred empty state. -->
    <p class="list-empty small muted" data-testid="string-list-empty-{controlIdPrefix}">Empty — nothing extra is forwarded.</p>
  {:else}
    <ul class="entries">
      <!--
        FR-R3-143 (T035) — keyed by INDEX, not by name.
        `(name)` crashed the whole tab with `each_key_duplicate` on a projected
        list containing the same name twice. `add()` above cannot produce that,
        which is exactly why it was invisible: the duplicate arrives from a
        hand-edited `settings.json`, where nothing forbids it — the manifest
        constrains each element with `itemPattern` and says nothing about
        uniqueness, and `sanitizeProcessEnvAllowlist` de-dupes at spawn time
        precisely because duplicates are expected to arrive.
        Identity here is positional anyway: the per-row control ids below are
        built from `i`.
      -->
      {#each value as name, i (i)}
        <li>
          <code>{name}</code>
          <button
            type="button"
            class="icon-btn remove"
            data-testid="general-settings-remove-{controlIdPrefix}-{i}"
            aria-label="Remove {name}"
            onclick={() => remove(i)}
            use:hoverTextAnchor={{
              controlId: `${controlIdPrefix}-remove-${i}`,
              description: removeDescription
            }}
          ><svg class="i" aria-hidden="true"><use href="#i-x"></use></svg></button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="add-row">
    <input
      type="text"
      class="input mono"
      aria-labelledby={labelledBy}
      aria-invalid={error !== ''}
      data-testid="general-settings-input-{controlIdPrefix}"
      bind:value={entry}
      onkeydown={onKeydown}
      use:hoverTextAnchor={{
        controlId: controlIdPrefix,
        description: inputDescription
      }}
    />
    <button
      type="button"
      class="btn btn-secondary add"
      data-testid="general-settings-add-{controlIdPrefix}"
      onclick={add}
      use:hoverTextAnchor={{
        controlId: `${controlIdPrefix}-add`,
        description: addDescription
      }}
    ><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>Add</button>
  </div>
  {#if error !== ''}
    <p class="error small" data-testid="string-list-error-{controlIdPrefix}" role="alert">{error}</p>
  {/if}
</div>

<style>
  .string-list {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1-5);
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
  }
  .entries li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--schegent-space-2);
    padding: var(--schegent-space-0-5) var(--schegent-space-0-5) var(--schegent-space-0-5)
      var(--schegent-space-2-5);
    border-bottom: 1px solid var(--schegent-border);
  }
  .entries li:last-child {
    border-bottom: 0;
  }
  .entries li:hover {
    background: var(--schegent-list-hover);
  }
  .entries code {
    min-width: 0;
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-secondary);
    overflow-wrap: anywhere;
  }
  .list-empty,
  .error {
    margin: 0;
  }
  .error {
    color: var(--schegent-error-text);
  }
  /* The entry field and its button share the control height, so they line up. */
  .add-row {
    display: flex;
    gap: var(--schegent-space-1-5);
  }
  .add-row .input {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
  }
</style>
