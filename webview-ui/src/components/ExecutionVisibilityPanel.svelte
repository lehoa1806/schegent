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

<section class="exec-visibility" aria-label="Execution visibility and handoffs" data-testid="execution-visibility-panel">
  <header class="ev-header">
    <div>
      <h2>Execution visibility</h2>
      <p class="ev-sub">Hierarchy, evidence availability, recovery certainty, ACP state, and phase handoffs.</p>
    </div>
    <button
      type="button"
      class="btn"
      disabled={loading}
      data-testid="execution-visibility-refresh"
      onclick={() => void loadVisibility()}
    >
      {loading ? 'Refreshing…' : 'Refresh visibility'}
    </button>
  </header>

  {#if notice !== ''}
    <p class="ev-notice" role="status" aria-live="polite" data-testid="execution-visibility-notice">{notice}</p>
  {/if}

  {#if detail === null}
    <p class="ev-note">Loading execution visibility…</p>
  {:else if !detail.available}
    <p class="ev-note" data-testid="execution-visibility-unavailable">
      {availabilityPhrase('unavailable')} ({detail.unavailableReason ?? 'store-unavailable'}).
    </p>
  {:else}
    <dl class="ev-grid" data-testid="execution-visibility-posture">
      <div>
        <dt>Hierarchy &amp; quality</dt>
        <dd data-testid="ev-quality">
          <span class="badge">{qualityLabel(detail.hierarchy.dataQuality)}</span>
          &middot; {detail.hierarchy.invocationCount} step(s), {detail.hierarchy.attemptCount} attempt(s)
        </dd>
      </div>
      <div>
        <dt>Artifact evidence</dt>
        <dd data-testid="ev-evidence">
          {#if detail.evidence.length === 0}
            {availabilityPhrase('missing')}
          {:else}
            {detail.evidence.filter((e) => e.availability === 'present').length} present / {detail.evidence.length} recorded
          {/if}
        </dd>
      </div>
      <div>
        <dt>Live log stream</dt>
        <dd data-testid="ev-livelog">
          <span class="badge">{streamLabel(detail.liveLog.streamState)}</span>
          &middot; {detail.liveLog.segmentCount} seg, {detail.liveLog.gapCount} gap(s)
        </dd>
      </div>
      <div>
        <dt>Recovery certainty</dt>
        <dd data-testid="ev-recovery">
          <span class="badge">{recoveryLabel(detail.recovery.posture)}</span>
          {#if detail.recovery.reasonCode !== null}
            ({detail.recovery.reasonCode})
          {/if}
        </dd>
      </div>
      <div>
        <dt>ACP runtime state</dt>
        <dd data-testid="ev-acp">
          <span class="badge">{detail.acp.runtimeState}</span>
          {#if detail.acp.profileId !== null || detail.acp.backendKind !== null}
            &middot; {detail.acp.profileId ?? detail.acp.backendKind}
          {/if}
          {#if detail.acp.pendingPermissions > 0}
            ({detail.acp.pendingPermissions} permission pending)
          {/if}
        </dd>
      </div>
    </dl>

    <ChangeReviewPanel lane={detail.lane} {isPrimary} />

    <section class="ev-subblock" aria-label="Phase context handoffs" data-testid="ev-handoffs-section">
      <h3>Phase handoffs ({detail.handoffs.length}) &amp; review loops ({detail.reviewLoops.length})</h3>
      {#if detail.handoffs.length === 0 && detail.reviewLoops.length === 0}
        <p class="ev-note">No phase handoffs or review-loop ledgers recorded for this run.</p>
      {:else}
        {#if detail.handoffs.length > 0}
          <ul class="ev-list">
            {#each detail.handoffs as h (h.handoffId)}
              <li class="ev-list-row" data-testid={`ev-handoff-${h.handoffId}`}>
                <div>
                  <strong>{h.identity.targetNodePath}</strong> (rev {h.revision}, {latestRevisionState(h)}, mode {h.approval})
                  &middot; {h.sources.length} source(s), {h.omissions.length + h.omissionsUnlisted} omission(s)
                </div>
                {#if isPrimary && latestRevisionState(h) === 'waiting-approval'}
                  <div class="ev-actions">
                    <button
                      type="button"
                      class="btn"
                      data-testid={`ev-handoff-approve-${h.handoffId}`}
                      onclick={() => void approveHandoff(h)}
                    >
                      Approve handoff
                    </button>
                    <button
                      type="button"
                      class="btn"
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
                      <input type="text" bind:value={editedNote} required maxlength="500" data-testid={`ev-handoff-input-${h.handoffId}`} />
                    </label>
                    <button type="submit" class="btn" data-testid={`ev-handoff-save-${h.handoffId}`}>Save &amp; supersede</button>
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
                Review loop <strong>{rl.nodeId}</strong> (iter {rl.iteration}):
                <span class="badge">{rl.verdict}</span>
                &middot; {rl.openFindings} open / {rl.resolvedFindings} resolved ({rl.totalFindings} total findings)
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </section>
  {/if}
</section>

<style>
  .exec-visibility { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--schegent-divider, var(--schegent-border)); }
  .ev-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .ev-header h2, .ev-subblock h3 { margin: 0; font-size: 0.92rem; }
  .ev-sub, .ev-note, .ev-notice { margin: 2px 0 0; font-size: 0.82em; color: var(--schegent-muted-fg); }
  .ev-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 0; font-size: 0.82em; }
  .ev-grid dt { color: var(--schegent-muted-fg); }
  .ev-grid dd { margin: 2px 0 0; }
  .badge { display: inline-block; padding: 1px 6px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm, 4px); font-size: 0.85em; }
  .btn { padding: 3px 9px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm, 4px); background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); cursor: pointer; font: inherit; font-size: 0.84em; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .ev-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 0.82em; }
  .ev-list-row { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm, 4px); }
  .ev-actions, .ev-edit-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px; }
  .ev-edit-form label { display: flex; flex-direction: column; gap: 2px; }
  .ev-edit-form input { padding: 3px 6px; border: 1px solid var(--schegent-border); background: transparent; color: var(--schegent-fg); font: inherit; }
</style>
