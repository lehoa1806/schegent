<script lang="ts">
  /**
   * Feature 011 T069 — Fatal Signatures sub-tab.
   *
   * Renders two visual sections per contracts/fatal-signatures.md:
   *   1. Built-in (read-only) — mirrors `FATAL_SIGNATURES` from
   *      `webview-ui/src/lib/fatal-signature-registry.ts`. No edit
   *      controls; static "Built-in" badge per FR-038 / SC-010.
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
  import type { GeneralSettings, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
  import { FATAL_SIGNATURES } from '../../lib/fatal-signature-registry';
  import { saveGeneralSettings } from '../../lib/save-general-settings';
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
  let status = $state<{ status: 'idle' | 'pending' | 'accepted' | 'rejected'; reason?: string }>({
    status: 'idle'
  });

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
    const result = await saveGeneralSettings({ fatalSignatures: trimmedDraft });
    status = result.status === 'accepted'
      ? { status: 'accepted' }
      : { status: 'rejected', reason: result.reason };
  }

  function resetAll(): void {
    draft = [...projectedAdditions];
    status = { status: 'idle' };
  }
</script>

<section class="fatal-signatures-tab" data-testid="settings-fatal-signatures-tab">
  <header class="tab-header">
    <h2>{FATAL_SIGNATURES_DESCRIPTIONS['tab-header'].title}</h2>
    <p class="hint">{FATAL_SIGNATURES_DESCRIPTIONS['tab-header'].body}</p>
  </header>

  <div class="section" data-testid="fatal-built-in-section">
    <header class="section-header">
      <h3>{FATAL_SIGNATURES_DESCRIPTIONS['built-in-section-header'].title}</h3>
      <span class="badge badge-builtin">Read-only</span>
    </header>
    <p class="hint">{FATAL_SIGNATURES_DESCRIPTIONS['built-in-section-header'].body}</p>
    <ul class="signature-list" data-testid="fatal-built-in-list">
      {#each FATAL_SIGNATURES as sig}
        <li class="signature-item">
          <code class="sig-text">{sig}</code>
          <span class="badge badge-builtin">Built-in</span>
        </li>
      {/each}
    </ul>
  </div>

  <div class="section" data-testid="fatal-operator-section">
    <header class="section-header">
      <h3>{FATAL_SIGNATURES_DESCRIPTIONS['operator-section-header'].title}</h3>
      <div class="actions">
        <button
          type="button"
          class="btn btn-primary"
          data-testid="fatal-add"
          onclick={addEntry}
          use:hoverTextAnchor={{
            controlId: 'fatal-add',
            description: FATAL_SIGNATURES_DESCRIPTIONS['operator-add']
          }}
        >+ Add</button>
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
        <button
          type="button"
          class="btn btn-ghost"
          data-testid="fatal-reset"
          disabled={!dirty}
          onclick={resetAll}
          use:hoverTextAnchor={{
            controlId: 'fatal-reset',
            description: FATAL_SIGNATURES_DESCRIPTIONS['operator-reset']
          }}
        >Reset</button>
      </div>
    </header>
    <p class="hint">{FATAL_SIGNATURES_DESCRIPTIONS['operator-section-header'].body}</p>

    {#if draft.length === 0}
      <p class="empty-msg" data-testid="fatal-operator-empty">
        No operator-defined fatal signatures. Click + Add to create one.
      </p>
    {:else}
      <ul class="signature-list editable" data-testid="fatal-operator-list">
        {#each draft as entry, i (i)}
          <li class="signature-item editable-row">
            <input
              type="text"
              class="text-input"
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
            <button
              type="button"
              class="btn btn-destructive btn-tight"
              data-testid="fatal-operator-remove-{i}"
              aria-label="Remove fatal signature {i + 1}"
              onclick={() => removeEntry(i)}
              use:hoverTextAnchor={{
                controlId: `fatal-operator-remove-${i}`,
                description: FATAL_SIGNATURES_DESCRIPTIONS['operator-remove']
              }}
            >Remove</button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if hasEmpty}
      <div class="warning" data-testid="fatal-operator-warning-empty" role="status">
        At least one entry is empty. Fill or remove it before saving.
      </div>
    {/if}
    {#if intraOperatorDupes.length > 0}
      <div class="warning" data-testid="fatal-operator-warning-dupes" role="status">
        Duplicate entries: {intraOperatorDupes.join(', ')} — the host
        will dedupe them on save.
      </div>
    {/if}
    {#if builtInOverlaps.length > 0}
      <div class="warning" data-testid="fatal-operator-warning-builtin-overlap" role="status">
        Already in the built-in registry: {builtInOverlaps.join(', ')}
        — these entries are redundant and will keep the
        <code>built-in</code> attribution.
      </div>
    {/if}
    {#if status.status === 'pending'}
      <div class="status pending" data-testid="fatal-status" role="status">Saving...</div>
    {:else if status.status === 'accepted'}
      <div class="status accepted" data-testid="fatal-status" role="status">Saved.</div>
    {:else if status.status === 'rejected'}
      <div class="status rejected" data-testid="fatal-status" role="alert">
        Save rejected: <code>{status.reason ?? 'unknown'}</code>
      </div>
    {/if}
  </div>
</section>

<style>
  .fatal-signatures-tab {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 8px 0;
  }
  .tab-header h2 {
    margin: 0 0 4px 0;
    font-size: 1.1em;
    font-weight: 600;
  }
  .hint {
    margin: 0 0 8px 0;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 0;
    border-top: 1px solid var(--schegent-divider);
    border-radius: 0;
    background: transparent;
    padding: var(--schegent-space-4) 0;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-header h3 {
    margin: 0;
    font-size: 0.95em;
    font-weight: 600;
    flex: 1;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .signature-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .signature-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--schegent-divider);
    border-radius: var(--schegent-radius-sm);
    background: var(--vscode-input-background);
  }
  .signature-item.editable-row {
    background: transparent;
  }
  .sig-text {
    flex: 1;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    color: var(--schegent-fg);
    background: transparent;
    padding: 0;
  }
  .text-input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--schegent-fg);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius-sm);
    padding: 4px 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
  }
  .text-input:focus {
    outline: none;
    border-color: var(--schegent-focus-border);
  }
  .badge {
    font-size: 0.7em;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--schegent-radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge-builtin {
    background: var(--vscode-list-hoverBackground);
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-divider);
  }
  .empty-msg {
    color: var(--schegent-muted-fg);
    font-style: italic;
    margin: 4px 0;
    font-size: 0.85em;
  }
  .warning {
    color: var(--schegent-color-warning);
    background: color-mix(in srgb, var(--schegent-color-warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--schegent-color-warning) 30%, transparent);
    border-radius: var(--schegent-radius);
    padding: 6px 8px;
    font-size: 0.85em;
  }
  .status {
    font-size: 0.85em;
    padding: 4px 8px;
    border-radius: var(--schegent-radius);
  }
  .status.pending { color: var(--schegent-muted-fg); }
  .status.accepted { color: var(--vscode-charts-green); }
  .status.rejected { color: var(--schegent-error-text); }
  .btn {
    padding: 4px 12px;
    border-radius: var(--schegent-radius-sm);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-tight { padding: 2px 8px; font-size: 0.8em; }
  .btn-primary { background: var(--schegent-button-bg); color: var(--schegent-button-fg); }
  .btn-primary:hover:not(:disabled) { background: var(--schegent-button-hover); }
  .btn-ghost { background: transparent; color: var(--schegent-muted-fg); }
  .btn-ghost:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
  .btn-destructive { background: transparent; color: var(--schegent-error-text); border-color: var(--schegent-color-error); }
  code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
  }
</style>
