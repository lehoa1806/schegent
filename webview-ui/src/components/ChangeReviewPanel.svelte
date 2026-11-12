<script lang="ts">
  import { untrack } from 'svelte';
  import {
    availabilityPhrase,
    type ChangeEntry,
    type ReviewDescriptor
  } from '../../../src/contracts/change-review';
  import type { ExecutionLaneCandidateVisibility } from '../lib/messages';
  import { requestChangeReview } from '../lib/execution-visibility-ipc';

  interface Props {
    lane: ExecutionLaneCandidateVisibility;
    isPrimary: boolean;
  }

  const { lane, isPrimary }: Props = $props();

  let loading = $state(false);
  let statusNotice = $state('');
  let descriptor = $state<ReviewDescriptor | null>(null);
  let entries = $state<readonly ChangeEntry[]>([]);
  let nextCursor = $state<string | null>(null);
  let unavailableReason = $state<string | null>(null);

  const requestId = $derived(lane.integrationRequestId);

  function releaseCurrentReview(): void {
    void requestChangeReview({ op: 'cancelOpen' });
    if (descriptor !== null) {
      void requestChangeReview({ op: 'close', reviewId: descriptor.reviewId });
    }
  }

  // FR-R6-F12 (AC-09) — changing the inspected integration request or unmounting cancels any
  // in-flight open and closes any live review handle so the 8-review host budget never leaks.
  $effect(() => {
    const activeRequestId = requestId;
    untrack(() => {
      descriptor = null;
      entries = [];
      nextCursor = null;
      unavailableReason = null;
      statusNotice = activeRequestId === null ? '' : 'Candidate change review ready to open.';
    });

    return () => untrack(() => releaseCurrentReview());
  });

  async function openReview(openInEditor: boolean): Promise<void> {
    if (lane.integrationRequestId === null) return;
    loading = true;
    unavailableReason = null;
    statusNotice = openInEditor
      ? 'Opening immutable candidate diff in VS Code…'
      : 'Loading pinned candidate file inventory…';
    const env = await requestChangeReview({
      op: 'open',
      requestId: lane.integrationRequestId,
      ...(lane.comparisonRevision !== null ? { expectedRevision: lane.comparisonRevision } : {}),
      openInEditor
    });
    loading = false;
    if (env.boundaryRefusal !== null) {
      statusNotice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'open') {
      if (!env.response.result.ok) {
        statusNotice = `Change review refused: ${env.response.result.reason}.`;
        return;
      }
      const opened = env.response.result.value;
      if (opened.state === 'unavailable') {
        descriptor = null;
        entries = [];
        nextCursor = null;
        unavailableReason = opened.reason;
        statusNotice = `${availabilityPhrase('unavailable')} (${opened.reason}).`;
        return;
      }
      descriptor = opened.review;
      entries = opened.firstPage.entries;
      nextCursor = opened.firstPage.nextCursor;
      const editorNote =
        env.response.editor.mode === 'none'
          ? ''
          : ` Opened ${env.response.editor.opened} file diff(s) via ${env.response.editor.mode} editor.`;
      statusNotice = `Loaded ${entries.length} of ${opened.review.total} changed file(s) at revision ${opened.review.comparisonRevision.slice(0, 12)}.${editorNote}`;
    }
  }

  async function cancelOpen(): Promise<void> {
    const env = await requestChangeReview({ op: 'cancelOpen' });
    loading = false;
    statusNotice =
      env.response.op === 'cancelOpen' && env.response.canceled
        ? 'Canceled in-flight change review open.'
        : 'No active review open to cancel.';
  }

  async function recheckFreshness(): Promise<void> {
    if (descriptor === null) return;
    loading = true;
    const env = await requestChangeReview({ op: 'classify', reviewId: descriptor.reviewId });
    loading = false;
    if (env.boundaryRefusal !== null) {
      statusNotice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'classify' && env.response.result.ok) {
      descriptor = env.response.result.value;
      statusNotice = `Comparison state: ${descriptor.state}${descriptor.reason ? ` (${descriptor.reason})` : ''}.`;
    }
  }

  async function loadNextPage(): Promise<void> {
    if (nextCursor === null) return;
    loading = true;
    const env = await requestChangeReview({ op: 'page', cursor: nextCursor });
    loading = false;
    if (env.response.op === 'page' && env.response.result.ok) {
      entries = [...entries, ...env.response.result.value.entries];
      nextCursor = env.response.result.value.nextCursor;
      statusNotice = `Showing ${entries.length} of ${descriptor?.total ?? entries.length} changed file(s).`;
    }
  }

  async function closeActiveReview(): Promise<void> {
    if (descriptor === null) return;
    const id = descriptor.reviewId;
    descriptor = null;
    entries = [];
    nextCursor = null;
    await requestChangeReview({ op: 'close', reviewId: id });
    statusNotice = 'Closed candidate change review.';
  }

  function stateLabel(d: ReviewDescriptor): string {
    if (d.state === 'current') return 'Current: matches frozen target commit';
    if (d.state === 'stale') return `Stale: target or candidate moved (${d.reason ?? 'stale'})`;
    return `${availabilityPhrase('uncertain')} (${d.reason ?? 'uncertain'})`;
  }
</script>

<section class="change-review" aria-label="Workspace lane and candidate change review" data-testid="change-review-panel">
  <header class="cr-header">
    <h3>Execution workspace &amp; change review</h3>
    <span class="badge" data-testid="lane-mode-badge">
      {lane.mode === 'isolated-lane' ? 'Isolated Git lane' : 'Shared workspace'}
    </span>
  </header>

  {#if lane.mode === 'shared-workspace'}
    <p class="cr-note" data-testid="lane-shared-note">
      This execution ran in the shared workspace without an isolated candidate branch.
    </p>
  {:else}
    <dl class="cr-meta">
      <div>
        <dt>Lane</dt>
        <dd>{lane.laneId ?? 'Not recorded'} ({lane.laneState ?? 'unknown'})</dd>
      </div>
      <div>
        <dt>Candidate</dt>
        <dd>{lane.candidateId ?? 'None produced yet'}</dd>
      </div>
      <div>
        <dt>Integration</dt>
        <dd>{lane.integrationState ?? 'Not queued'} {lane.targetRef ? `→ ${lane.targetRef}` : ''}</dd>
      </div>
      <div>
        <dt>Comparison revision</dt>
        <dd>{lane.comparisonRevision ? lane.comparisonRevision.slice(0, 16) : 'Not frozen'}</dd>
      </div>
    </dl>

    {#if lane.integrationRequestId !== null && isPrimary}
      <div class="cr-actions">
        <button
          type="button"
          class="btn"
          disabled={loading}
          data-testid="change-review-inspect-btn"
          onclick={() => void openReview(false)}
        >
          Inspect changed files
        </button>
        <button
          type="button"
          class="btn"
          disabled={loading}
          data-testid="change-review-open-editor-btn"
          onclick={() => void openReview(true)}
        >
          Open diff in editor
        </button>
        {#if loading}
          <button
            type="button"
            class="btn"
            data-testid="change-review-cancel-btn"
            onclick={() => void cancelOpen()}
          >
            Cancel open
          </button>
        {/if}
        {#if descriptor !== null}
          <button
            type="button"
            class="btn"
            disabled={loading}
            data-testid="change-review-recheck-btn"
            onclick={() => void recheckFreshness()}
          >
            Re-check freshness
          </button>
          <button
            type="button"
            class="btn"
            disabled={loading}
            data-testid="change-review-close-btn"
            onclick={() => void closeActiveReview()}
          >
            Close review
          </button>
        {/if}
      </div>
    {/if}

    {#if statusNotice !== ''}
      <p class="cr-note" role="status" aria-live="polite" data-testid="change-review-status">
        {statusNotice}
      </p>
    {/if}

    {#if unavailableReason !== null}
      <p class="cr-warning" data-testid="change-review-unavailable">
        {availabilityPhrase('unavailable')}: {unavailableReason} (no partial file inventory is rendered).
      </p>
    {/if}

    {#if descriptor !== null}
      <div class="cr-posture" data-testid="change-review-posture" data-review-state={descriptor.state}>
        <span class="badge">{stateLabel(descriptor)}</span>
        <span>
          Approval: {descriptor.approval.eligible ? 'Eligible' : `Ineligible (${descriptor.approval.reason})`}
        </span>
        <span>
          Landing: {descriptor.landing.eligible ? 'Eligible' : `Ineligible (${descriptor.landing.reason})`}
        </span>
        {#if descriptor.truncated}
          <span>{availabilityPhrase('partial')} (loaded {descriptor.loaded} of {descriptor.total})</span>
        {/if}
      </div>

      {#if entries.length > 0}
        <ul class="cr-files" data-testid="change-review-file-list">
          {#each entries as entry (entry.index)}
            <li class="cr-file-item">
              <span class="badge">{entry.kind}</span>
              <!-- FR-013: repository filenames rendered strictly as inert text -->
              <span class="cr-path">{entry.newPath ?? entry.oldPath ?? '(unnamed)'}</span>
              {#if entry.kind === 'renamed' && entry.oldPath !== null}
                <span class="cr-sub">(from {entry.oldPath}, {entry.similarity ?? 0}% match)</span>
              {/if}
              {#if entry.binary}
                <span class="cr-sub">[binary]</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if nextCursor !== null}
        <button
          type="button"
          class="btn"
          disabled={loading}
          data-testid="change-review-load-more"
          onclick={() => void loadNextPage()}
        >
          Load more files
        </button>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .change-review { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm, 4px); }
  .cr-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
  .cr-header h3 { margin: 0; font-size: 0.9rem; }
  .cr-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px; margin: 0; font-size: 0.82em; }
  .cr-meta dt { color: var(--schegent-muted-fg); }
  .cr-meta dd { margin: 1px 0 0; word-break: break-all; }
  .cr-actions, .cr-posture { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 0.82em; }
  .btn { padding: 3px 9px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm, 4px); background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); cursor: pointer; font: inherit; font-size: 0.85em; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .badge { display: inline-block; padding: 1px 6px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm, 4px); font-size: 0.85em; }
  .cr-note, .cr-warning { margin: 0; font-size: 0.82em; color: var(--schegent-muted-fg); }
  .cr-files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
  .cr-file-item { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 0.82em; }
  .cr-path { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  .cr-sub { color: var(--schegent-muted-fg); }
</style>
