<script lang="ts">
  import { untrack } from 'svelte';
  import { availabilityPhrase } from '../../../src/contracts/change-review';
  import type { HandoffExplanation } from '../../../src/contracts/phase-context/context-manifest';
  import type { ExecutionAttemptVisibility } from '../lib/messages';
  import {
    requestDecidePhaseHandoff,
    requestExecutionVisibility
  } from '../lib/execution-visibility-ipc';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import {
    acpStateLabel,
    evidenceSummary,
    latestRevisionState,
    qualityLabel,
    recoveryLabel,
    streamLabel
  } from '../lib/visibility-panel-labels';
  import ChangeReviewPanel from './ChangeReviewPanel.svelte';

  type AttemptRow = ExecutionAttemptVisibility['hierarchy']['attempts'][number];

  interface Props {
    rootExecutionId: string;
    isPrimary: boolean;
  }

  const { rootExecutionId, isPrimary }: Props = $props();

  let loading = $state(false);
  let detail = $state<ExecutionAttemptVisibility | null>(null);
  let knownAttempts = $state<readonly AttemptRow[]>([]);
  let selectedAttemptId = $state<string | null>(null);
  let notice = $state('');
  let editingHandoffId = $state<string | null>(null);
  let editingProducerAttemptId = $state<string | null>(null);
  let editedNote = $state('');

  let requestGen = 0;
  let lastSeenResyncCount = snapshotStore.resyncCount;

  const wantedRootId = $derived(rootExecutionId);
  const visibleAttempts = $derived(
    knownAttempts.length > 0 ? knownAttempts : (detail?.hierarchy.attempts ?? [])
  );

  $effect(() => {
    const targetRoot = wantedRootId;
    untrack(() => {
      selectedAttemptId = null;
      knownAttempts = [];
      detail = null;
      notice = '';
      editingHandoffId = null;
      editingProducerAttemptId = null;
      editedNote = '';
      void loadVisibility(targetRoot, null);
    });
    return () => {
      requestGen += 1;
    };
  });

  // Hide/reveal resynchronisation: refresh when the panel becomes visible again, preserving the
  // operator's selected attempt filter and keyboard focus.
  $effect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void loadVisibility(wantedRootId, selectedAttemptId);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  $effect(() => {
    void snapshotStore.snapshot;
    const currentResync = snapshotStore.resyncCount;
    if (currentResync === lastSeenResyncCount) return;
    lastSeenResyncCount = currentResync;
    if (!expanded && detail === null) return;
    untrack(() => {
      void loadVisibility(wantedRootId, selectedAttemptId);
    });
  });

  async function loadVisibility(
    targetRoot = wantedRootId,
    targetAttemptId: string | null = selectedAttemptId
  ): Promise<void> {
    const gen = ++requestGen;
    loading = true;
    const env = await requestExecutionVisibility({
      op: 'attemptDetail',
      rootExecutionId: targetRoot,
      ...(targetAttemptId !== null ? { attemptId: targetAttemptId } : {})
    });
    if (gen !== requestGen) return;
    loading = false;
    if (env.boundaryRefusal !== null) {
      notice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'attemptDetail') {
      const nextDetail = env.response.detail;
      detail = nextDetail;
      if (nextDetail.available && (targetAttemptId === null || knownAttempts.length === 0)) {
        knownAttempts = nextDetail.hierarchy.attempts;
      }
    }
  }

  function selectAttempt(attemptId: string | null): void {
    selectedAttemptId = attemptId;
    void loadVisibility(wantedRootId, attemptId);
  }

  // The redesign folds diagnostics under a quiet summary line. The disclosure opens itself when it
  // has something for the operator: a handoff waiting on this window's approval, whose button is
  // here and nowhere else, or a notice. It never folds itself, so an approval's result stays shown.
  let expanded = $state(false);
  const needsAttention = $derived(
    notice !== '' ||
      (isPrimary &&
        detail !== null &&
        detail.available &&
        detail.handoffs.some((h) => latestRevisionState(h) === 'waiting-approval'))
  );
  $effect(() => {
    if (needsAttention) expanded = true;
  });

  async function approveHandoff(h: HandoffExplanation): Promise<void> {
    const decisionId = `approve-${h.handoffId}-r${h.revision}`;
    const env = await requestDecidePhaseHandoff({
      op: 'approve',
      handoffId: h.handoffId,
      expectedRevision: h.revision,
      decisionId
    });
    if (env.boundaryRefusal !== null) {
      notice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'approve') {
      notice = env.response.result.ok
        ? `Approved handoff ${h.handoffId} revision ${env.response.result.revision}.`
        : `Could not approve handoff: ${env.response.result.failure}.`;
      await loadVisibility(wantedRootId, selectedAttemptId);
    }
  }

  async function submitEditedHandoff(h: HandoffExplanation): Promise<void> {
    const summary = editedNote.trim();
    if (summary === '') return;
    const targetAttemptId =
      editingProducerAttemptId ??
      (h.sources.length > 0 ? h.sources[0].producer.attemptId : undefined);
    const env = await requestDecidePhaseHandoff({
      op: 'editSummary',
      handoffId: h.handoffId,
      baseRevision: h.revision,
      summary,
      ...(targetAttemptId !== undefined ? { producerAttemptId: targetAttemptId } : {})
    });
    editingHandoffId = null;
    editingProducerAttemptId = null;
    editedNote = '';
    if (env.boundaryRefusal !== null) {
      notice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'editSummary' || env.response.op === 'edit') {
      notice = env.response.result.ok
        ? `Saved edited handoff revision ${env.response.result.revision.revision}.`
        : `Could not edit handoff: ${env.response.result.failure}.`;
      await loadVisibility(wantedRootId, selectedAttemptId);
    }
  }
</script>

<!-- Drawn as the redesign's diagnostics disclosure (`details.diag`): a quiet summary line, then the
     readings as the redesign's key and value rows, the workspace lane and the handoffs. -->
<details class="diag exec-visibility" data-testid="execution-visibility-panel" bind:open={expanded}>
  <summary>Diagnostics: execution evidence, handoffs and change review</summary>

  <div class="ev-body">
    {#if !isPrimary}
      <p class="ev-note" data-testid="execution-visibility-readonly-note">
        Read-only secondary window: execution diagnostics are visible, while handoff approvals and change review actions require the primary window.
      </p>
    {/if}

    {#if notice !== ''}
      <p class="ev-notice" role="status" aria-live="polite" data-testid="execution-visibility-notice">{notice}</p>
    {/if}

    <!-- The readings, with Refresh at the end of their row. -->
    <div class="ev-head">
      {#if detail === null}
        <p class="ev-note">Loading execution visibility…</p>
      {:else if !detail.available}
        <p class="ev-note" data-testid="execution-visibility-unavailable">
          {availabilityPhrase('unavailable')} ({detail.unavailableReason ?? 'store-unavailable'}).
        </p>
      {:else}
        <dl class="kv ev-grid" data-testid="execution-visibility-posture">
          <div>
            <dt>Hierarchy</dt>
            <dd data-testid="ev-quality">
              {qualityLabel(detail.hierarchy.dataQuality)}
              <span class="muted"
                >&middot; {detail.hierarchy.invocationCount} step(s), {detail.hierarchy.attemptCount} attempt(s)</span
              >
            </dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd data-testid="ev-evidence">{evidenceSummary(detail.evidence)}</dd>
          </div>
          <div>
            <dt>Live log</dt>
            <dd data-testid="ev-livelog">
              {streamLabel(detail.liveLog.streamState)}
              {#if detail.liveLog.streamState === 'captured'}
                <span class="muted">&middot; {detail.liveLog.segmentCount} segment(s)</span>
              {:else if detail.liveLog.streamState === 'partial'}
                <span class="muted">&middot; {detail.liveLog.segmentCount} segment(s), {detail.liveLog.gapCount} gap(s)</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Recovery</dt>
            <dd data-testid="ev-recovery">
              {recoveryLabel(detail.recovery.posture)}
              {#if detail.recovery.reasonCode !== null}
                <span class="muted mono">({detail.recovery.reasonCode})</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>ACP state</dt>
            <dd data-testid="ev-acp" data-acp-state={detail.acp.runtimeState}>
              {acpStateLabel(detail.acp.runtimeState)}
              {#if detail.acp.profileId !== null || detail.acp.backendKind !== null}
                <span class="muted">&middot; {detail.acp.profileId ?? detail.acp.backendKind}</span>
              {/if}
              {#if detail.acp.pendingPermissions > 0}
                <span class="muted">({detail.acp.pendingPermissions} permission pending)</span>
              {/if}
            </dd>
          </div>
        </dl>
      {/if}
      <button
        type="button"
        class="btn btn-secondary btn-sm ev-refresh"
        aria-disabled={loading ? 'true' : undefined}
        data-testid="execution-visibility-refresh"
        onclick={() => {
          if (loading) return;
          void loadVisibility(wantedRootId, selectedAttemptId);
        }}
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>

    {#if detail !== null && detail.available}
      {#if visibleAttempts.length > 0}
        <section class="ev-subblock" aria-label="Execution attempts" data-testid="ev-attempts-section">
          <h3>Attempts ({visibleAttempts.length})</h3>
          <div class="ev-attempt-list" role="group" aria-label="Filter visibility by attempt">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              class:ev-attempt-selected={selectedAttemptId === null}
              aria-pressed={selectedAttemptId === null}
              data-testid="ev-attempt-all"
              onclick={() => selectAttempt(null)}
            >
              All attempts
            </button>
            {#each visibleAttempts as attempt (attempt.attemptId)}
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                class:ev-attempt-selected={selectedAttemptId === attempt.attemptId}
                aria-pressed={selectedAttemptId === attempt.attemptId}
                data-testid={`ev-attempt-${attempt.attemptId}`}
                onclick={() => selectAttempt(attempt.attemptId)}
              >
                <span class="mono">{attempt.attemptId}</span>
                <span class="muted">
                  &middot; {attempt.phaseId ?? `step ${attempt.stepIndex}`} #{attempt.attemptNumber} ({attempt.status})
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <ChangeReviewPanel lane={detail.lane} {isPrimary} />

      <section class="ev-subblock" aria-label="Phase context handoffs" data-testid="ev-handoffs-section">
        <h3>Phase handoffs ({detail.handoffs.length}) &amp; review loops ({detail.reviewLoops.length})</h3>
        {#if detail.handoffs.length === 0 && detail.reviewLoops.length === 0}
          <p class="ev-note">No Phase handoffs or review-loop ledgers recorded for this run.</p>
        {:else}
          {#if detail.handoffs.length > 0}
            <ul class="ev-list">
              {#each detail.handoffs as h (h.handoffId)}
                <li class="ev-list-row" data-testid={`ev-handoff-${h.handoffId}`}>
                  <div>
                    <strong>{h.identity.targetNodePath}</strong> (rev {h.revision}, {latestRevisionState(h)}, mode {h.approval})
                    <span class="muted"
                      >&middot; {h.sources.length} source(s), {h.omissions.length + h.omissionsUnlisted} omission(s)</span
                    >
                  </div>
                  {#if latestRevisionState(h) === 'waiting-approval'}
                    {#if isPrimary}
                      <div class="ev-actions">
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          data-testid={`ev-handoff-approve-${h.handoffId}`}
                          onclick={() => void approveHandoff(h)}
                        >
                          Approve handoff
                        </button>
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          data-testid={`ev-handoff-edit-${h.handoffId}`}
                          onclick={() => {
                            if (editingHandoffId === h.handoffId) {
                              editingHandoffId = null;
                              editingProducerAttemptId = null;
                            } else {
                              editingHandoffId = h.handoffId;
                              editingProducerAttemptId =
                                h.sources.length > 0 ? h.sources[0].producer.attemptId : null;
                            }
                          }}
                        >
                          Edit summary
                        </button>
                      </div>
                    {:else}
                      <p class="ev-note" data-testid={`ev-handoff-readonly-${h.handoffId}`}>
                        Read-only secondary window: open the primary window to approve or edit this handoff.
                      </p>
                    {/if}
                  {/if}
                  {#if isPrimary && editingHandoffId === h.handoffId}
                    <form
                      class="ev-edit-form"
                      onsubmit={(e) => {
                        e.preventDefault();
                        void submitEditedHandoff(h);
                      }}
                    >
                      {#if h.sources.length > 1}
                        <label>
                          <span>Target source producer</span>
                          <select
                            class="input"
                            bind:value={editingProducerAttemptId}
                            data-testid={`ev-handoff-source-${h.handoffId}`}
                          >
                            {#each h.sources as src (src.producer.attemptId)}
                              <option value={src.producer.attemptId}>
                                {src.producer.nodePath} ({src.producer.attemptId})
                              </option>
                            {/each}
                          </select>
                        </label>
                      {/if}
                      <label>
                        <span>Updated summary note (preserves outcomes, decisions, constraints, issues &amp; artifacts)</span>
                        <input
                          type="text"
                          class="input"
                          bind:value={editedNote}
                          required
                          maxlength="500"
                          data-testid={`ev-handoff-input-${h.handoffId}`}
                        />
                      </label>
                      <button type="submit" class="btn btn-secondary" data-testid={`ev-handoff-save-${h.handoffId}`}
                        >Save &amp; supersede</button
                      >
                    </form>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if detail.reviewLoops.length > 0}
            <ul class="ev-list" data-testid="ev-review-loops-list">
              {#each detail.reviewLoops as rl (rl.loopId)}
                <li class="ev-list-row">
                  <div>
                    Review loop <strong>{rl.nodeId}</strong> (iter {rl.iteration}):
                    <span class="tag">{rl.verdict}</span>
                    <span class="muted"
                      >&middot; {rl.openFindings} open / {rl.resolvedFindings} resolved ({rl.totalFindings} total findings)</span
                    >
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </section>
    {/if}
  </div>
</details>

<style>
  /* The open disclosure's body: the bar, the readings, the lane and the handoffs, a step apart. */
  .ev-body {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-3);
    margin-top: var(--schegent-space-2);
  }
  /* The readings at the start, Refresh at the end of their row; below them when the row is tight. */
  .ev-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--schegent-space-2) var(--schegent-space-4);
  }
  .ev-note,
  .ev-notice {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
  }
  /* Each reading's wrapper steps aside, so its term and value sit in the key and value columns. */
  .ev-grid > div {
    display: contents;
  }
  .ev-subblock {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1-5);
  }
  /* The redesign's card heading. */
  .ev-subblock h3 {
    font-size: var(--schegent-text-body);
    font-weight: 600;
  }
  .ev-attempt-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-space-1-5);
  }
  .ev-attempt-selected {
    border-color: var(--schegent-focus-border);
    font-weight: 600;
  }
  .ev-list {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1-5);
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--schegent-text-secondary);
  }
  .ev-list-row {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-2);
    padding: var(--schegent-space-2) var(--schegent-space-3);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius-sm);
  }
  .ev-actions,
  .ev-edit-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--schegent-space-1-5);
  }
  .ev-edit-form label {
    display: flex;
    flex: 1 1 16rem;
    flex-direction: column;
    gap: var(--schegent-space-1);
    color: var(--schegent-muted-fg);
  }
</style>
