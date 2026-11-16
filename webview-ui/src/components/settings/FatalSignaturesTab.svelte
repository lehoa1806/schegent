<script lang="ts">
  /**
   * Feature 011 T069 — Fatal Signatures sub-tab.
   *
   * Renders two visual sections per contracts/fatal-signatures.md:
   *   1. Built-in (read-only) — mirrors `FATAL_SIGNATURES` from
   *      `webview-ui/src/lib/fatal-signature-registry.ts`. No edit
   *      controls; the section's "Built-in registry" heading and its
   *      "read-only" tag mark the whole list once (FR-038 / SC-010),
   *      where each row carried its own "Built-in" badge before the
   *      redesign.
   *   2. Operator-defined (editable) — vertical list of text inputs
   *      reflecting `snapshot.generalSettings.fatalSignatures`. Save
   *      goes through the shared `saveGeneralSettings` helper with the
   *      unprefixed key `fatalSignatures`.
   *
   * Defense-in-depth validation:
   *   - empty / whitespace-only inputs blocked from save (FR-029-like),
   *   - duplicates flagged inline (host merger dedupes anyway).
   *
   * WHY THIS ADDS DIFFERENTLY FROM `general/StringListField.svelte`, which is
   * the other editable list on this surface: a signature is free text matched
   * as a substring, so there is no pattern to refuse at add and no way to fix
   * a character except by editing the row. That is a decision, not drift —
   * `general/field-types.ts`, on the `'string-list'` kind, carries the rule and
   * the reasoning. Read it before giving a third list a fourth behaviour.
   *
   * The `{#each}` below is keyed by INDEX and must stay that way; the reason
   * and its regression test are at
   * `__tests__/FatalSignaturesTab.duplicate-key.test.ts`.
   *
   * Feature 018 — Settings UI Hover Text & Descriptions: every focusable
   * control on this tab uses the `use:hoverTextAnchor` action which
   * manages `aria-describedby` and lazily portals a hover/focus
   * popover when the description body exceeds 80 chars. Built-in
   * items are non-focusable so they are described by the section
   * header alone.
   */
  import {
    OUTCOME_NOT_YET_KNOWN_TEXT,
    boundaryRefusalText,
    isOutcomeNotYetKnown
  } from '../../lib/boundary-refusal-text';
  import type { GeneralSettings, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
  import { FATAL_SIGNATURES } from '../../lib/fatal-signature-registry';
  import { saveGeneralSettings, type SaveResult } from '../../lib/save-general-settings';
  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { FATAL_SIGNATURES_DESCRIPTIONS } from './FatalSignaturesTab.descriptions';

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

  const currentSettings = $derived<GeneralSettings>(
    snapshot.generalSettings ?? IDLE_GENERAL_SETTINGS
  );

  const projectedAdditions = $derived<readonly string[]>(
    currentSettings.fatalSignatures ?? []
  );

  let draft = $state<string[]>([]);
  let lastProjectedJson = $state('');
  let status = $state<{
    status: 'idle' | 'pending' | 'accepted' | 'rejected' | 'unknown';
    reason?: string;
  }>({ status: 'idle' });

  // FR-R4-F05 (I5, I6, I8, FR-024) — a timeout reads as not yet known, never "Save rejected",
  // and a late answer replaces it through the same path. Unmounting aborts the wait.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  function showSaveResult(result: SaveResult): void {
    status = result.status === 'accepted'
      ? { status: 'accepted' }
      : isOutcomeNotYetKnown(result.reason)
        ? { status: 'unknown' }
        : { status: 'rejected', reason: result.reason };
  }

  $effect(() => {
    const next = [...projectedAdditions];
    const nextJson = JSON.stringify(next);
    if (nextJson === lastProjectedJson) return;
    draft = next;
    lastProjectedJson = nextJson;
    status = { status: 'idle' };
  });

  function addEntry(): void {
    draft = [...draft, ''];
  }

  function removeEntry(index: number): void {
    draft = draft.filter((_, i) => i !== index);
  }

  function updateEntry(index: number, value: string): void {
    draft = draft.map((v, i) => (i === index ? value : v));
  }

  const trimmedDraft = $derived(draft.map((s) => s.trim()));

  const hasEmpty = $derived(trimmedDraft.some((s) => s.length === 0));

  const intraOperatorDupes = $derived.by(() => {
    const seen = new Map<string, number>();
    for (const s of trimmedDraft) {
      if (s.length === 0) continue;
      seen.set(s, (seen.get(s) ?? 0) + 1);
    }
    const out: string[] = [];
    for (const [k, count] of seen) {
      if (count > 1) out.push(k);
    }
    return out;
  });

  const builtInOverlaps = $derived.by(() => {
    const builtInSet = new Set<string>(FATAL_SIGNATURES);
    const overlapping: string[] = [];
    for (const s of trimmedDraft) {
      if (s.length === 0) continue;
      if (builtInSet.has(s)) overlapping.push(s);
    }
    return overlapping;
  });

  const dirty = $derived(JSON.stringify(trimmedDraft) !== JSON.stringify([...projectedAdditions]));

  const canSave = $derived(dirty && !hasEmpty);

  async function save(): Promise<void> {
    if (!canSave) return;
    status = { status: 'pending' };
    showSaveResult(
      await saveGeneralSettings({ fatalSignatures: trimmedDraft }, undefined, {
        signal: lifetime.signal,
        onLateOutcome: showSaveResult
      })
    );
  }

  function resetAll(): void {
    draft = [...projectedAdditions];
    status = { status: 'idle' };
  }
</script>

<!--
  The redesign’s failure-signature section: the built-in list under a read-only tag, then the
  operator’s additions as an editable table with Add under it. The tab keeps its own heading,
  and its Save and Reset sit at the end of that heading’s row behind an unsaved-changes chip, as
  the General tab’s do. The built-in list stays first, the order spec 011’s contract gives the two
  (`contracts/fatal-signatures.md`, “Built-ins always render first”).
-->
<section class="fatal-signatures-tab" data-testid="settings-fatal-signatures-tab">
  <header class="tab-header">
    <div class="titlerow">
      <h2>{FATAL_SIGNATURES_DESCRIPTIONS['tab-header'].title}</h2>
      <div class="push">
        {#if dirty}
          <span class="chip s-warn">Unsaved changes</span>
        {/if}
        <button
          type="button"
          class="btn btn-secondary"
          data-testid="fatal-reset"
          disabled={!dirty}
          onclick={resetAll}
          use:hoverTextAnchor={{
            controlId: 'fatal-reset',
            description: FATAL_SIGNATURES_DESCRIPTIONS['operator-reset']
          }}
        >Reset</button>
        <button
          type="button"
          class="btn btn-primary"
          data-testid="fatal-save"
          disabled={!canSave}
          onclick={save}
          use:hoverTextAnchor={{
            controlId: 'fatal-save',
            description: FATAL_SIGNATURES_DESCRIPTIONS['operator-save']
          }}
        >Save</button>
      </div>
    </div>
    <p class="lead small muted">{FATAL_SIGNATURES_DESCRIPTIONS['tab-header'].body}</p>
  </header>

  <section class="section" data-testid="fatal-built-in-section" aria-labelledby="fatal-built-in-heading">
    <h3 id="fatal-built-in-heading">
      {FATAL_SIGNATURES_DESCRIPTIONS['built-in-section-header'].title} <span class="tag">read-only</span>
    </h3>
    <p class="section-lead small muted">{FATAL_SIGNATURES_DESCRIPTIONS['built-in-section-header'].body}</p>
    <ul class="builtin-list mono small" data-testid="fatal-built-in-list">
      {#each FATAL_SIGNATURES as sig}
        <li>{sig}</li>
      {/each}
    </ul>
  </section>

  <section class="section" data-testid="fatal-operator-section" aria-labelledby="fatal-operator-heading">
    <h3 id="fatal-operator-heading">{FATAL_SIGNATURES_DESCRIPTIONS['operator-section-header'].title}</h3>
    <p class="section-lead small muted">{FATAL_SIGNATURES_DESCRIPTIONS['operator-section-header'].body}</p>

    {#if draft.length === 0}
      <p class="empty-msg small muted" data-testid="fatal-operator-empty">
        No operator-defined fatal signatures. Click + Add to create one.
      </p>
    {:else}
      <div class="table-wrap">
        <table class="t fit" data-testid="fatal-operator-list">
          <thead>
            <tr>
              <th scope="col">Text to match</th>
              <th scope="col"><span class="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {#each draft as entry, i (i)}
              <tr>
                <td>
                  <input
                    type="text"
                    class="input mono"
                    data-testid="fatal-operator-input-{i}"
                    aria-label="Fatal signature {i + 1}"
                    value={entry}
                    oninput={(e) => updateEntry(i, (e.target as HTMLInputElement).value)}
                    placeholder="verbatim substring"
                    spellcheck="false"
                    use:hoverTextAnchor={{
                      controlId: `fatal-operator-input-${i}`,
                      description: FATAL_SIGNATURES_DESCRIPTIONS['operator-input']
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    class="icon-btn"
                    data-testid="fatal-operator-remove-{i}"
                    aria-label="Remove fatal signature {i + 1}"
                    onclick={() => removeEntry(i)}
                    use:hoverTextAnchor={{
                      controlId: `fatal-operator-remove-${i}`,
                      description: FATAL_SIGNATURES_DESCRIPTIONS['operator-remove']
                    }}
                  ><svg class="i" aria-hidden="true"><use href="#i-x"></use></svg></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <button
      type="button"
      class="btn btn-ghost btn-sm add"
      data-testid="fatal-add"
      onclick={addEntry}
      use:hoverTextAnchor={{
        controlId: 'fatal-add',
        description: FATAL_SIGNATURES_DESCRIPTIONS['operator-add']
      }}
    ><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>Add</button>

    {#if hasEmpty}
      <div class="warning small" data-testid="fatal-operator-warning-empty" role="status">
        At least one entry is empty. Fill or remove it before saving.
      </div>
    {/if}
    {#if intraOperatorDupes.length > 0}
      <div class="warning small" data-testid="fatal-operator-warning-dupes" role="status">
        Duplicate entries: {intraOperatorDupes.join(', ')} — the host
        will dedupe them on save.
      </div>
    {/if}
    {#if builtInOverlaps.length > 0}
      <div class="warning small" data-testid="fatal-operator-warning-builtin-overlap" role="status">
        Already in the built-in registry: {builtInOverlaps.join(', ')}
        — these entries are redundant and will keep the
        <code>built-in</code> attribution.
      </div>
    {/if}
    {#if status.status === 'pending'}
      <div class="save-status small muted" data-testid="fatal-status" role="status">Saving...</div>
    {:else if status.status === 'accepted'}
      <div class="save-status small s-ok" data-testid="fatal-status" role="status">Saved.</div>
    {:else if status.status === 'unknown'}
      <div class="save-status small muted" data-testid="fatal-status" role="status">{OUTCOME_NOT_YET_KNOWN_TEXT}</div>
    {:else if status.status === 'rejected'}
      <div class="save-status small s-err" data-testid="fatal-status" role="alert">
        Save rejected. {boundaryRefusalText(status.reason ?? '')}
      </div>
    {/if}
  </section>
</section>

<style>
  .tab-header h2 {
    font-weight: 600;
  }
  .lead {
    margin: var(--schegent-space-0-5) 0 0;
  }
  /* Each part heads with an h3 set as the redesign’s section heading (`.section > h2`), as
     the General tab’s sub-sections do. */
  .section > h3 {
    display: flex;
    align-items: center;
    gap: var(--schegent-space-2);
    margin-bottom: var(--schegent-space-2);
    font-size: var(--schegent-text-subheading);
    font-weight: 600;
  }
  .section-lead {
    margin: 0 0 var(--schegent-space-2);
  }
  .builtin-list {
    margin: 0;
    padding-left: 18px;
  }
  .empty-msg {
    margin: 0;
  }
  .add {
    margin-top: var(--schegent-space-1-5);
  }
  .warning,
  .save-status {
    margin-top: var(--schegent-space-2);
    line-height: 1.45;
  }
  .warning {
    color: var(--schegent-status-warning-text);
  }
  .warning code {
    font-family: var(--schegent-mono-font);
  }
</style>
