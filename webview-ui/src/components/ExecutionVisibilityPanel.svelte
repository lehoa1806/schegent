<script lang="ts">
  import { untrack } from 'svelte';
  import { availabilityPhrase } from '../../../src/contracts/change-review';
  import type { HandoffExplanation } from '../../../src/contracts/phase-context/context-manifest';
  import type { ExecutionAttemptVisibility } from '../lib/messages';
  import {
    requestDecidePhaseHandoff,
    requestExecutionVisibility
  } from '../lib/execution-visibility-ipc';
  import ChangeReviewPanel from './ChangeReviewPanel.svelte';

  interface Props {
    rootExecutionId: string;
    isPrimary: boolean;
  }

  const { rootExecutionId, isPrimary }: Props = $props();

  let loading = $state(false);
  let detail = $state<ExecutionAttemptVisibility | null>(null);
  let notice = $state('');
  let editingHandoffId = $state<string | null>(null);
  let editedNote = $state('');

  const wantedRootId = $derived(rootExecutionId);

  $effect(() => {
    const targetRoot = wantedRootId;
    untrack(() => {
      void loadVisibility(targetRoot);
    });
  });

  async function loadVisibility(targetRoot = rootExecutionId): Promise<void> {
    loading = true;
    const env = await requestExecutionVisibility({
      op: 'attemptDetail',
      rootExecutionId: targetRoot
    });
    loading = false;
    if (env.boundaryRefusal !== null) {
      notice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'attemptDetail') {
      detail = env.response.detail;
    }
  }

  function qualityLabel(quality: ExecutionAttemptVisibility['hierarchy']['dataQuality']): string {
    if (quality === 'authoritative') return 'Authoritative';
    if (quality === 'partial') return availabilityPhrase('partial');
    return availabilityPhrase('unknown');
  }

  function streamLabel(state: ExecutionAttemptVisibility['liveLog']['streamState']): string {
    if (state === 'captured') return 'Captured';
    if (state === 'not-captured') return 'Not captured (disabled)';
    if (state === 'partial') return availabilityPhrase('partial');
    return availabilityPhrase('unknown');
  }

  function recoveryLabel(posture: ExecutionAttemptVisibility['recovery']['posture']): string {
    if (posture === 'verified') return 'Verified recovery handoff';
    if (posture === 'degraded') return 'Degraded (unsupported or refused)';
    if (posture === 'uncertain') return availabilityPhrase('uncertain');
    return 'Not recorded';
  }

  function latestRevisionState(h: HandoffExplanation): string {
    return h.revisions.find((r) => r.revision === h.revision)?.state ?? 'unknown';
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
      await loadVisibility();
    }
  }

  async function submitEditedHandoff(h: HandoffExplanation): Promise<void> {
    const replacementSources = h.sources.map((src, idx) => ({
      producer: src.producer,
      acceptedSequence: idx + 1,
      coverage: src.coverage,
      required: src.required,
      selectedBy: src.selectedBy,
      outcomes: [],
      decisions: [],
      constraints: [],
      unresolvedIssues: [],
      summary: editedNote.trim() || 'Operator-curated handoff summary',
      artifacts: []
    }));
    const env = await requestDecidePhaseHandoff({
      op: 'edit',
      handoffId: h.handoffId,
      baseRevision: h.revision,
      replacementSources
    });
    editingHandoffId = null;
    editedNote = '';
    if (env.boundaryRefusal !== null) {
      notice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'edit') {
      notice = env.response.result.ok
        ? `Saved edited handoff revision ${env.response.result.revision.revision}.`
        : `Could not edit handoff: ${env.response.result.failure}.`;
      await loadVisibility();
    }
  }
</script>

<!-- Drawn as the redesign's diagnostics disclosure (`details.diag`): a quiet summary line, then the
     readings as the redesign's key and value rows, the workspace lane and the handoffs. -->
<details class="diag exec-visibility" data-testid="execution-visibility-panel" bind:open={expanded}>
  <summary>Diagnostics: execution evidence, handoffs and change review</summary>

  <div class="ev-body">
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
            <dd data-testid="ev-evidence">
              {#if detail.evidence.length === 0}
                {availabilityPhrase('missing')}
              {:else}
                {detail.evidence.filter((e) => e.availability === 'present').length} present / {detail.evidence.length} recorded
              {/if}
            </dd>
          </div>
          <div>
            <dt>Live log</dt>
            <dd data-testid="ev-livelog">
              {streamLabel(detail.liveLog.streamState)}
              <span class="muted">&middot; {detail.liveLog.segmentCount} seg, {detail.liveLog.gapCount} gap(s)</span>
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
            <dd data-testid="ev-acp">
              {detail.acp.runtimeState}
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
        disabled={loading}
        data-testid="execution-visibility-refresh"
        onclick={() => void loadVisibility()}
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>

    {#if detail !== null && detail.available}
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
                  {#if isPrimary && latestRevisionState(h) === 'waiting-approval'}
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
                          editingHandoffId = editingHandoffId === h.handoffId ? null : h.handoffId;
                        }}
                      >
                        Edit summary
                      </button>
                    </div>
                  {/if}
                  {#if editingHandoffId === h.handoffId}
                    <form
                      class="ev-edit-form"
                      onsubmit={(e) => {
                        e.preventDefault();
                        void submitEditedHandoff(h);
                      }}
                    >
                      <label>
                        <span>Replacement summary note</span>
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
