<script lang="ts">
  // Feature 101 (US4, T056, FR-027 – FR-030b) — one definition's version history.
  //
  // An inline expansion of the row, not a modal (FR-030a). A modal would take the
  // catalog away to show one definition's past, and the operator opens history to
  // compare it against what is in front of them.
  //
  // The list is rendered exactly as given. The host orders it newest-first and
  // retention decides what is in it (data-model.md §7); sorting it here, counting
  // it, or explaining what is missing would all be this panel reasoning about a
  // corpus it cannot see, and getting it wrong silently.
  //
  // Bodies are pulled one at a time through `lib/catalog-history-ipc.ts` — the
  // only call site of the command, per `tests/lint/no-inline-catalog-history-ipc.test.ts`.
  // Nothing is posted from here, and Restore is `DefinitionActions` in its
  // `history` surface (FR-019, FR-025) rather than a fifth dispatch path.
  //
  // Text interpolation only, never Svelte's raw-HTML directive (FR-038): version
  // notes and definition bodies are operator-authored documents.
  import type { CatalogKind } from '../../../../src/contracts/catalog-store';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import { readDefinitionVersion } from '../../lib/catalog-history-ipc';
  import DefinitionActions from './DefinitionActions.svelte';
  import { EM_DASH, formatDefinitionTimestamp } from './definition-row-state';
  import {
    describeReason,
    formatVersionBody,
    viewOfReadResult,
    type VersionBodyView
  } from './version-body-view';

  interface Props {
    kind: CatalogKind;
    /** The definition whose history this is — the wire target and the test handle. */
    definitionId: string;
    /** What Restore's confirmations name. The id alone is not what the operator recognises. */
    definitionName: string;
    lifecycle: BuilderLifecycle;
    /** Focus returns here on close (FR-030b). Null when the row could not supply one. */
    opener?: HTMLElement | null;
    /** The row owns whether the panel is mounted; the panel only asks to be closed. */
    onclose: () => void;
  }

  const {
    kind,
    definitionId,
    definitionName,
    lifecycle,
    opener = null,
    onclose
  }: Props = $props();

  let selected = $state<string | null>(null);
  let view = $state<VersionBodyView | null>(null);

  /**
   * Which read the panel is currently showing.
   *
   * Reads resolve out of order — a slow v3 can land after a fast v1 — and the
   * panel shows one body under one heading. Applying a stale result would put
   * one version's content under another version's name, which is worse than
   * showing nothing: the operator would restore from what they read.
   */
  let issued = 0;

  async function show(versionId: string): Promise<void> {
    const token = (issued += 1);
    selected = versionId;
    view = { status: 'pending' };
    const result = await readDefinitionVersion({ kind, id: definitionId, versionId });
    // Superseded while in flight. Discarded, not merged — see above.
    if (token !== issued) return;
    view = viewOfReadResult(result);
  }

  function close(): void {
    // The row can re-render out from under the panel between opening and
    // closing, leaving an opener that is detached or gone. Focus is a courtesy
    // and must not be the thing that stops the panel closing.
    try {
      opener?.focus();
    } catch {
      // A detached or non-focusable opener simply keeps focus where it is.
    }
    onclose();
  }

  const bodyText = $derived(view?.status === 'ready' ? formatVersionBody(view.body) : null);
</script>

<!-- The id is the row's `aria-controls` target, so the toggle and the region it
     expands are related for a screen reader as well as visually. -->
<section
  class="definition-history"
  id="definition-history-{definitionId}"
  data-testid="definition-history-{definitionId}"
>
  <header class="history-header">
    <h4 class="history-title">Version history</h4>
    <button
      type="button"
      class="history-close"
      data-testid="definition-history-close-{definitionId}"
      onclick={close}>Close</button
    >
  </header>

  {#if lifecycle.versions.length === 0}
    <p class="history-empty" data-testid="definition-history-empty-{definitionId}">
      No versions yet.
    </p>
  {:else}
    <ul class="history-entries">
      <!-- Rendered in the order supplied. The host orders; this does not re-order. -->
      {#each lifecycle.versions as entry (entry.versionId)}
        <li
          class="history-entry"
          class:is-selected={selected === entry.versionId}
          data-testid="definition-history-entry-{definitionId}-{entry.versionId}"
          data-version-id={entry.versionId}
        >
          <div class="entry-line">
            <span class="entry-version">{entry.versionId}</span>
            {#if entry.isActive}
              <span
                class="entry-active"
                data-testid="definition-history-active-{definitionId}-{entry.versionId}"
                >Active</span
              >
            {/if}
            <span class="entry-field">
              <span class="entry-label">Created</span>
              <span data-testid="definition-history-created-{definitionId}-{entry.versionId}"
                >{formatDefinitionTimestamp(entry.createdAt)}</span
              >
            </span>
            <span class="entry-field">
              <span class="entry-label">Published</span>
              <!-- Never published is an absence, and absences read as the dash
                   the rest of the surface uses (FR-028, FR-014). -->
              <span data-testid="definition-history-published-{definitionId}-{entry.versionId}"
                >{entry.publishedAt === null
                  ? EM_DASH
                  : formatDefinitionTimestamp(entry.publishedAt)}</span
              >
            </span>
            <button
              type="button"
              class="entry-view"
              data-testid="definition-history-open-{definitionId}-{entry.versionId}"
              onclick={() => void show(entry.versionId)}>View</button
            >
          </div>
          <!-- No note is an empty cell. `{null}` would interpolate the word. -->
          <p class="entry-note" data-testid="definition-history-note-{definitionId}-{entry.versionId}">
            {entry.note ?? ''}
          </p>
          <DefinitionActions
            {kind}
            {definitionId}
            {definitionName}
            {lifecycle}
            surface="history"
            versionId={entry.versionId}
          />
        </li>
      {/each}
    </ul>
  {/if}

  {#if view !== null && selected !== null}
    <div class="history-body" data-testid="definition-history-body-{definitionId}">
      <h5 class="body-title">{selected}</h5>
      {#if view.status === 'pending'}
        <p
          class="body-pending"
          role="status"
          data-testid="definition-history-body-pending-{definitionId}"
        >
          Reading this version...
        </p>
      {:else if view.status === 'ready' && bodyText !== null}
        <!-- Read-only by construction: a `pre` holding interpolated text. No
             input, no textarea, no contenteditable, anywhere in here (FR-030). -->
        <pre
          class="body-content"
          data-testid="definition-history-body-ready-{definitionId}">{bodyText}</pre>
      {:else}
        <!-- The read failed, and it says so. It never falls back to an empty
             body, which would be indistinguishable from a definition with no
             content (FR-012b). -->
        <p
          class="body-error"
          role="status"
          data-testid="definition-history-body-error-{definitionId}"
        >
          {describeReason(view.status === 'error' ? view.reason : 'read-failed')}
        </p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .definition-history {
    border-left: 2px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.85em;
    margin: 2px 0 4px 8px;
    padding-left: 8px;
  }

  .history-header {
    align-items: baseline;
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }

  .history-title {
    font-size: 1em;
    font-weight: 600;
    margin: 0;
  }

  .history-close,
  .entry-view {
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 1em;
    padding: 1px 6px;
  }

  .history-close:hover,
  .entry-view:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .history-empty {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }

  .history-entries {
    display: flex;
    flex-direction: column;
    gap: 4px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .history-entry {
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 4px;
  }

  .history-entry.is-selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }

  .entry-line {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
  }

  .entry-version {
    font-weight: 600;
  }

  .entry-active {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px;
    padding: 0 4px;
  }

  .entry-field {
    display: flex;
    gap: 4px;
  }

  .entry-label {
    color: var(--vscode-descriptionForeground);
  }

  .entry-note {
    margin: 2px 0;
  }

  .history-body {
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 4px;
  }

  .body-title {
    font-size: 1em;
    font-weight: 600;
    margin: 0 0 2px;
  }

  .body-pending {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }

  .body-error {
    color: var(--vscode-errorForeground);
    margin: 0;
  }

  /* Feature 186 (US3, T024, FR-004, D-4) — no `max-height`/`overflow` here.
     Every host that mounts this panel already supplies one scroll region of
     its own (`.pane-right` on Phases, `.wf-inspector` on Pipelines and
     Workflows, both already `overflow-y: auto`), so this flows inside
     whichever single ancestor scroll region already exists rather than
     nesting a second one inside it. */
  .body-content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
