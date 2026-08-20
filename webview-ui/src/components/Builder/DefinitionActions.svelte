<script lang="ts">
  // Feature 101 (US3, T041, FR-016 – FR-025) — the lifecycle actions of one
  // definition, on whichever surface is showing it.
  //
  // Two surfaces, one component. A row offers what its state admits — Publish and
  // Discard draft where a draft exists, Deactivate where something is live — and a
  // history entry offers Restore this version and nothing else (FR-019). Splitting
  // that into two components would put the dispatch, the pending lock, and the
  // refusal report in two places for four actions that share all three.
  //
  // Nothing is posted from here. Every one of the four goes through
  // `lib/catalog-lifecycle.ts` (FR-025), which is also where the two confirmations
  // live (feature 100, FR-049/FR-050): a gate beside the post it authorises cannot
  // be forgotten by a second call site, only deleted, and
  // `tests/lint/destructive-actions.lint.test.ts` fails on that. So this file has
  // no `useConfirm` of its own, and that absence is the design rather than an
  // omission — adding one here would ask twice.
  //
  // The refusal report is text interpolation only, never Svelte's raw-HTML
  // directive (FR-038): defect fields and messages quote operator-authored
  // documents, and a Pipeline whose id is markup must render as characters.
  import type { CatalogKind } from '../../../../src/contracts/catalog-store';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import {
    deactivateDefinition,
    discardDefinitionDraft,
    publishDefinition,
    restoreDefinitionVersion,
    type LifecycleResult
  } from '../../lib/catalog-lifecycle';
  import { deriveDefinitionRowView, type DefinitionRowAction } from './definition-row-state';

  interface Props {
    kind: CatalogKind;
    /** The definition's own id — the wire target, and the test handle's stem. */
    definitionId: string;
    /** What the operator recognises. The confirmations name it; the id alone will not do. */
    definitionName: string;
    lifecycle: BuilderLifecycle;
    /** `history` swaps the row's three actions for Restore this version (FR-019). */
    surface?: 'row' | 'history';
    /** The version Restore copies. Required on `history`, meaningless on a row. */
    versionId?: string;
  }

  const {
    kind,
    definitionId,
    definitionName,
    lifecycle,
    surface = 'row',
    versionId
  }: Props = $props();

  const ACTION_LABEL: Readonly<Record<DefinitionRowAction, string>> = Object.freeze({
    publish: 'Publish',
    'discard-draft': 'Discard draft',
    deactivate: 'Deactivate',
    restore: 'Restore this version'
  });

  const RESTORE_ONLY: readonly DefinitionRowAction[] = Object.freeze<DefinitionRowAction[]>([
    'restore'
  ]);
  const NONE: readonly DefinitionRowAction[] = Object.freeze<DefinitionRowAction[]>([]);

  /**
   * What a refusal means, in the operator's words.
   *
   * The reasons are a closed union on the wire precisely so this table can exist
   * (feature 100, FR-015). A free-text reason would leave nothing to write here but
   * the raw token.
   */
  const REFUSAL_HEADLINE: Readonly<Record<string, string>> = Object.freeze({
    'stale-draft': 'This definition changed in another window. Reload before trying again.',
    'no-definition': 'This definition no longer exists in the catalog.',
    'no-draft': 'There is no draft here to publish or discard.',
    'not-active': 'This definition is not active, so there is nothing to deactivate.',
    'validation-failed': 'The definition does not validate. Nothing was published.',
    referenced: 'An active definition still references this one.',
    'version-unreadable': 'That version could not be read, so nothing was restored.',
    'store-refused': 'The catalog store refused the write.',
    timeout: 'The extension host did not answer. Nothing was written.'
  });

  interface RefusalDetail {
    readonly field: string;
    readonly message: string;
  }

  interface RefusalView {
    readonly headline: string;
    /** Every defect, together — never the first one (FR-023). */
    readonly defects: readonly RefusalDetail[];
    /** Every blocking reference, for the same reason (feature 100, FR-025). */
    readonly blockers: readonly RefusalDetail[];
  }

  let refusal = $state<RefusalView | null>(null);
  let pending = $state<DefinitionRowAction | null>(null);

  const handle = $derived(
    surface === 'history' && versionId ? `${definitionId}-${versionId}` : definitionId
  );

  const offered = $derived<readonly DefinitionRowAction[]>(
    surface === 'history'
      ? versionId
        ? RESTORE_ONLY
        : NONE
      : deriveDefinitionRowView(lifecycle).actions
  );

  function listOf(source: unknown, key: string): readonly Record<string, unknown>[] {
    if (typeof source !== 'object' || source === null) return [];
    const raw = (source as Record<string, unknown>)[key];
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is Record<string, unknown> => {
      return typeof item === 'object' && item !== null;
    });
  }

  function textOf(item: Record<string, unknown>, key: string): string {
    const value = item[key];
    return typeof value === 'string' ? value : '';
  }

  /**
   * Project a rejected result into what the operator reads.
   *
   * Defensive about shape on purpose: the payload crossed IPC, and a refusal that
   * throws while being rendered is a refusal the operator never sees.
   */
  function refusalViewOf(result: LifecycleResult): RefusalView | null {
    if (result.status === 'accepted') return null;
    // The operator closed the prompt themselves. Nothing happened, and saying so
    // would report their own decision back to them as a failure (FR-022).
    if (result.reason === 'declined') return null;

    const payload = result.result;
    return {
      headline: REFUSAL_HEADLINE[result.reason] ?? `The operation was refused (${result.reason}).`,
      defects: listOf(payload, 'defects').map((defect) => ({
        field: textOf(defect, 'field'),
        message: textOf(defect, 'message')
      })),
      blockers: listOf(payload, 'blockers').map((blocker) => ({
        field: textOf(blocker, 'field'),
        message: `${textOf(blocker, 'kind')} ${textOf(blocker, 'id')}`.trim()
      }))
    };
  }

  function dispatchFor(
    action: DefinitionRowAction,
    originatingElement: HTMLElement | null
  ): Promise<LifecycleResult> {
    const target = {
      kind,
      id: definitionId,
      expectedDraftVersion: lifecycle.expectedDraftVersion
    };
    switch (action) {
      case 'publish':
        return publishDefinition(target);
      case 'deactivate':
        return deactivateDefinition(target, { definitionName, originatingElement });
      case 'discard-draft':
        return discardDefinitionDraft(target, {
          definitionName,
          originatingElement,
          // A definition with no active version has nothing behind the draft, so
          // discarding it removes the entry rather than an edit to it (FR-030).
          // The two prompts read differently and this is what picks between them.
          removesEntry: lifecycle.state === 'draft'
        });
      case 'restore':
        return restoreDefinitionVersion({ ...target, fromVersionId: versionId ?? '' });
      default: {
        // Restore was the `default` arm until review: an action added to
        // `DefinitionRowAction` would have posted a *write* nobody asked for,
        // caught today only by the ingress validator refusing an empty
        // `fromVersionId`. Failing to compile is the right time to find out.
        const unhandled: never = action;
        throw new Error(`Unhandled definition action: ${String(unhandled)}`);
      }
    }
  }

  async function run(action: DefinitionRowAction, event: MouseEvent): Promise<void> {
    if (pending !== null) return;
    const originatingElement = event.currentTarget as HTMLElement | null;
    pending = action;
    // The previous refusal described a state the definition may no longer be in.
    refusal = null;
    try {
      refusal = refusalViewOf(await dispatchFor(action, originatingElement));
    } finally {
      pending = null;
    }
  }
</script>

<div class="definition-actions" data-testid="definition-actions-{handle}">
  {#if offered.length > 0}
    <div class="action-buttons">
      {#each offered as action (action)}
        <button
          type="button"
          class="action-button action-{action}"
          data-testid="definition-action-{action}-{handle}"
          disabled={pending !== null}
          onclick={(event) => void run(action, event)}>{ACTION_LABEL[action]}</button
        >
      {/each}
    </div>
  {/if}
  {#if refusal}
    <div
      class="action-refusal"
      role="status"
      data-testid="definition-action-refusal-{handle}"
    >
      <p class="refusal-headline">{refusal.headline}</p>
      {#if refusal.defects.length > 0}
        <ul>
          {#each refusal.defects as defect, index (defect.field + index)}
            <li data-testid="definition-action-defect-{handle}-{index}">
              <span class="refusal-field">{defect.field}</span>: {defect.message}
            </li>
          {/each}
        </ul>
      {/if}
      {#if refusal.blockers.length > 0}
        <ul>
          {#each refusal.blockers as blocker, index (blocker.field + index)}
            <li data-testid="definition-action-blocker-{handle}-{index}">
              <span class="refusal-field">{blocker.message}</span>
              {blocker.field}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .definition-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .action-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .action-button {
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 0.85em;
    padding: 1px 6px;
  }

  .action-button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .action-button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .action-publish {
    border-color: var(--vscode-button-background);
  }

  .action-discard-draft,
  .action-deactivate {
    color: var(--vscode-errorForeground);
  }

  .action-refusal {
    border-left: 2px solid var(--vscode-errorForeground);
    font-size: 0.85em;
    padding-left: 6px;
  }

  .refusal-headline {
    color: var(--vscode-errorForeground);
    margin: 0;
  }

  .action-refusal ul {
    margin: 2px 0 0;
    padding-left: 18px;
  }

  .refusal-field {
    font-weight: 600;
  }
</style>
