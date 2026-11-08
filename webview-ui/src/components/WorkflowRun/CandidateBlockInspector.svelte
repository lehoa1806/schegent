<script lang="ts">
  // FR-R5-F32 (F32-T04, F32-T05, F32-T06) — Candidate-Block Run Inspector & History Panel.
  //
  // Renders all 10+1 candidate-block states, per-candidate used/remaining attempts,
  // eligibility/retirement/policy exclusion, readiness status/source/freshness, reset
  // estimates, next-check timestamps, notBefore constraints, shared quota identity and
  // permit wait position, distinct Phase identity, candidate attempts vs enclosing
  // business iterations, workspace recovery coverage, effect certainty, spend mode and
  // enforcement quality, overshoot notes, durable notices, evidence refs, and legal
  // operator controls routed through sendWorkflowControlCommand.

  import {
    CANDIDATE_AVAILABILITY_POLICIES,
    DEFAULT_MONITORING_WINDOW_MS,
    type CandidateAvailabilityPolicy,
    type ControlAction,
    type ControlActionKind,
    type ControlCommandEnvelope,
    type ControlLegalActionEntry,
    type ControlProjection
  } from '../../lib/snapshot-types';
  import { sendWorkflowControlCommand } from '../../lib/workflow-run-ipc';
  import {
    formatControlTimestamp,
    formatEffectCertaintyLabel,
    formatMicrousd,
    formatRecoveryCoverageLabel
  } from './candidate-block-inspector-format';

  interface Props {
    readonly projection: ControlProjection;
    readonly isPrimary?: boolean;
    readonly timeZone?: string;
    readonly referenceTimeMs?: number;
  }

  const p: Props = $props();

  const proj = $derived(p.projection);
  const candidates = $derived(proj.candidates ?? []);
  const isPrimary = $derived(p.isPrimary !== false);
  const spendMode = $derived(proj.spendMode);

  let selectedCandidateId = $state<string>('');
  let selectedPolicy = $state<CandidateAvailabilityPolicy>('first-ready');
  let allowedSubset = $state<Record<string, boolean>>({});
  let commandPending = $state(false);
  let feedbackMessage = $state<string | null>(null);
  let feedbackKind = $state<'accepted' | 'refused' | null>(null);
  let feedbackSubjectId = $state<string>('');
  let highestObservedGeneration = $state<number>(0);

  $effect(() => {
    if (proj.generation > highestObservedGeneration) {
      highestObservedGeneration = proj.generation;
    }
    if (proj.availabilityPolicy) {
      selectedPolicy = proj.availabilityPolicy;
    }
    if (
      !selectedCandidateId ||
      !candidates.some((c) => c.candidateId === selectedCandidateId)
    ) {
      selectedCandidateId =
        proj.selectedCandidateId ?? candidates.at(0)?.candidateId ?? '';
    }
    const nextSubset: Record<string, boolean> = {};
    for (const cand of candidates) {
      nextSubset[cand.candidateId] = !cand.policyExcluded;
    }
    allowedSubset = nextSubset;
  });

  const ACTION_LABELS: Record<ControlActionKind, string> = {
    'check-now': 'Check Readiness Now',
    'try-now': 'Counted Try Now',
    'select-candidate': 'Select Candidate (Next Admission)',
    'set-policy': 'Apply Policy',
    'set-allowed-candidates': 'Apply Candidate Subset',
    'renew-monitoring': 'Renew Monitoring Window',
    pause: 'Pause Block',
    resume: 'Resume Block',
    cancel: 'Cancel Block'
  };

  function actionDescriptor(action: ControlActionKind): ControlLegalActionEntry {
    return (
      proj.legalActions.find((item) => item.kind === action) ?? {
        kind: action,
        allowed: false,
        reason: 'illegal-state'
      }
    );
  }

  function toggleSubsetCandidate(candidateId: string, checked: boolean): void {
    allowedSubset = {
      ...allowedSubset,
      [candidateId]: checked
    };
  }

  function buildControlActionPayload(actionKind: ControlActionKind): ControlAction {
    const targetCandidateId =
      selectedCandidateId || candidates.at(0)?.candidateId || 'candidate-1';
    switch (actionKind) {
      case 'check-now':
        return { kind: 'check-now', candidateId: targetCandidateId };
      case 'try-now':
        return { kind: 'try-now', candidateId: targetCandidateId };
      case 'select-candidate':
        return { kind: 'select-candidate', candidateId: targetCandidateId };
      case 'set-policy':
        return { kind: 'set-policy', availabilityPolicy: selectedPolicy };
      case 'set-allowed-candidates': {
        const enabledIds = candidates
          .filter((c) => allowedSubset[c.candidateId] !== false)
          .map((c) => c.candidateId);
        return { kind: 'set-allowed-candidates', candidateIds: enabledIds };
      }
      case 'renew-monitoring':
        return { kind: 'renew-monitoring', durationMs: DEFAULT_MONITORING_WINDOW_MS };
      case 'pause':
        return { kind: 'pause' };
      case 'resume':
        return { kind: 'resume' };
      case 'cancel':
        return { kind: 'cancel' };
    }
  }

  function deterministicCommandUuid(seed: string): string {
    let h1 = 0xdeadbeef ^ seed.length;
    let h2 = 0x41c6ce57 ^ seed.length;
    let h3 = 0x9e3779b9 ^ seed.length;
    let h4 = 0x85ebca6b ^ seed.length;
    for (let i = 0; i < seed.length; i += 1) {
      const ch = seed.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
      h3 = Math.imul(h3 ^ ch, 2246822507);
      h4 = Math.imul(h4 ^ ch, 3266489909);
    }
    const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
    const p1 = hex(h1);
    const p2 = hex(h2);
    const p3 = hex(h3);
    const p4 = hex(h4);
    const variantNibble = ((parseInt(p3[0]!, 16) & 0x3) | 0x8).toString(16);
    return `${p1}-${p2.slice(0, 4)}-4${p2.slice(5, 8)}-${variantNibble}${p3.slice(1, 4)}-${p3.slice(4, 8)}${p4}`;
  }

  async function dispatchControlAction(
    actionKind: ControlActionKind,
    overrideGeneration?: number
  ): Promise<void> {
    if (commandPending || !isPrimary) return;
    const expectedGeneration = overrideGeneration ?? proj.generation;
    const subjectRootRunId = proj.rootRunId;
    const subjectInvocationId = proj.invocationId;

    if (expectedGeneration < highestObservedGeneration) {
      feedbackKind = 'refused';
      feedbackSubjectId = subjectInvocationId;
      feedbackMessage = `Refused stale ${actionKind}: generation ${expectedGeneration} is older than current generation ${highestObservedGeneration}.`;
      return;
    }

    const envelope: ControlCommandEnvelope = {
      version: 1,
      commandId: deterministicCommandUuid(
        `${subjectRootRunId}:${subjectInvocationId}:${actionKind}:${expectedGeneration}`
      ),
      rootRunId: subjectRootRunId,
      queueId: proj.queueId,
      invocationId: subjectInvocationId,
      expectedGeneration,
      action: buildControlActionPayload(actionKind)
    };

    commandPending = true;
    try {
      const outcome = await sendWorkflowControlCommand(envelope);
      // Correlate response to the current subject so an answer for another subject cannot clobber state.
      if (proj.rootRunId !== subjectRootRunId || proj.invocationId !== subjectInvocationId) {
        return;
      }
      if (outcome.outcome === 'control-acknowledged') {
        const ack = outcome.acknowledgement;
        if (
          ack.projection &&
          (ack.projection.rootRunId !== subjectRootRunId ||
            ack.projection.invocationId !== subjectInvocationId)
        ) {
          return;
        }
        if (ack.generation > highestObservedGeneration) {
          highestObservedGeneration = ack.generation;
        }
        if (ack.outcome === 'accepted') {
          feedbackKind = 'accepted';
          feedbackSubjectId = subjectInvocationId;
          feedbackMessage = `Accepted ${actionKind} at generation ${ack.generation}${ack.projection ? ` (state: ${ack.projection.state})` : ''}.`;
        } else {
          feedbackKind = 'refused';
          feedbackSubjectId = subjectInvocationId;
          feedbackMessage = `Refused ${actionKind} (${ack.reason ?? 'refused'}) at generation ${ack.generation}.`;
        }
      } else if (outcome.outcome === 'started') {
        feedbackKind = 'accepted';
        feedbackSubjectId = subjectInvocationId;
        feedbackMessage = `Applied ${actionKind} at revision ${outcome.revision}.`;
      } else if (outcome.outcome === 'rejected-stale') {
        feedbackKind = 'refused';
        feedbackSubjectId = subjectInvocationId;
        feedbackMessage = `Refused ${actionKind}: stale generation (current revision ${outcome.projection.revision}).`;
      } else if (outcome.outcome === 'rejected-state') {
        feedbackKind = 'refused';
        feedbackSubjectId = subjectInvocationId;
        feedbackMessage = `Refused ${actionKind}: ${outcome.reason}.`;
      } else if (outcome.outcome === 'not-yet-known') {
        feedbackKind = 'refused';
        feedbackSubjectId = subjectInvocationId;
        feedbackMessage = `Command ${actionKind} is still awaiting host confirmation.`;
      } else {
        feedbackKind = 'refused';
        feedbackSubjectId = subjectInvocationId;
        feedbackMessage = `Refused ${actionKind}: ${outcome.outcome}.`;
      }
    } finally {
      commandPending = false;
    }
  }
</script>

<section
  class="cb-inspector"
  data-testid="candidate-block-inspector"
  data-frame-state={proj.state}
  data-generation={proj.generation}
  aria-label="Candidate Block Run Inspector"
>
  <header class="cb-inspector-header">
    <div class="cb-inspector-title-row">
      <h4 class="cb-inspector-title">Candidate Block</h4>
      <span class="cb-state-badge" data-testid="candidate-block-inspector-state">{proj.state}</span>
      <span class="cb-meta-badge" data-testid="candidate-block-inspector-generation">Gen #{proj.generation}</span>
      <span class="cb-meta-badge" data-testid="candidate-block-inspector-policy">Policy: {proj.availabilityPolicy ?? 'first-ready'}</span>
      {#if proj.selectedCandidateId}
        <span class="cb-meta-badge" data-testid="candidate-block-inspector-selected">Selected: {proj.selectedCandidateId}</span>
      {/if}
    </div>

    <div class="cb-inspector-counters">
      <span class="cb-counter-chip" data-testid="candidate-block-inspector-block-dispatches">
        Candidate-block dispatches: {proj.attemptsUsed} / {proj.maxDispatches}
      </span>
      <span class="cb-counter-chip" data-testid="candidate-block-inspector-root-dispatches">
        Root run dispatches: {proj.rootDispatchesUsed} / {proj.rootMaxDispatches}
      </span>
      <span class="cb-counter-chip" data-testid="candidate-block-inspector-enclosing-iteration">
        Enclosing business iteration: {proj.enclosingIteration ?? 1} / {proj.enclosingMaxIterations ?? 1}
      </span>
    </div>
  </header>

  {#if proj.resultReason}
    <div class="cb-notice-banner" data-testid="candidate-block-inspector-pause-reason" role="status">
      <strong>Reason / Disposition:</strong>
      <span>{proj.resultReason}</span>
    </div>
  {/if}

  {#if proj.monitoringExpiresAt !== undefined}
    <div class="cb-deadline-row" data-testid="candidate-block-inspector-monitoring-deadline">
      <span>Monitoring deadline:</span>
      <strong>{formatControlTimestamp(proj.monitoringExpiresAt, { timeZone: p.timeZone, referenceTimeMs: p.referenceTimeMs })}</strong>
    </div>
  {/if}

  <div class="cb-honesty-grid" data-testid="candidate-block-inspector-honesty">
    <div class="cb-honesty-card">
      <span class="cb-card-label">Workspace Recovery Coverage</span>
      <strong data-testid="candidate-block-inspector-recovery-coverage">
        {formatRecoveryCoverageLabel(proj.recoveryCoverage, proj.manifestTruncated, proj.preexistingDirtyCount)}
      </strong>
    </div>

    <div class="cb-honesty-card">
      <span class="cb-card-label">Effect Certainty</span>
      <strong data-testid="candidate-block-inspector-effect-certainty">
        {formatEffectCertaintyLabel(proj.effectCertainty)}
      </strong>
    </div>

    <div class="cb-honesty-card">
      <span class="cb-card-label">Spend Mode &amp; Quality</span>
      <div>
        <strong data-testid="candidate-block-inspector-spend-mode">{spendMode}</strong>
        <span> · </span>
        <span data-testid="candidate-block-inspector-spend-quality">{proj.spendEnforcementQuality}</span>
      </div>
      <div class="cb-spend-details" data-testid="candidate-block-inspector-spend-summary">
        Verified: {formatMicrousd(proj.verifiedMicrousd)} · Estimated: {formatMicrousd(proj.estimatedMicrousd)} · Unpriced attempts: {proj.unpricedAttemptCount ?? 0}
        {#if proj.maxMicrousd !== undefined}
          · Ceiling: {formatMicrousd(proj.maxMicrousd)}
        {/if}
      </div>
    </div>
  </div>

  {#if proj.activeAttemptOvershootNote}
    <div class="cb-notice-banner" data-testid="candidate-block-inspector-overshoot-note" role="status">
      <strong>Active-attempt overshoot:</strong>
      <span>{proj.activeAttemptOvershootNote}</span>
    </div>
  {/if}

  {#if proj.durableNotices && proj.durableNotices.length > 0}
    <ul class="cb-notice-list" data-testid="candidate-block-inspector-durable-notices">
      {#each proj.durableNotices as notice, idx (idx)}
        <li data-testid="candidate-block-inspector-durable-notice-{idx}">{notice}</li>
      {/each}
    </ul>
  {/if}

  <ul class="cb-candidate-rows" data-testid="candidate-block-inspector-candidates">
    {#each candidates as cand (cand.candidateId)}
      {@const remaining = Math.max(0, cand.maxAttempts - cand.attemptsUsed)}
      <li class="cb-candidate-card" data-testid="candidate-inspector-row-{cand.candidateId}">
        <div class="cb-candidate-card-head">
          <strong data-testid="candidate-inspector-id-{cand.candidateId}">{cand.candidateId}</strong>
          <span class="cb-meta-badge">Node: {cand.nodeId}</span>
          <span class="cb-meta-badge">Backend: {cand.backend}</span>
          <span class="cb-meta-badge" data-testid="candidate-inspector-status-{cand.candidateId}">
            Status: {cand.eligibility}{#if cand.retirementReason} ({cand.retirementReason}){/if} · {cand.policyExcluded ? 'Excluded by operator policy' : 'Included'}
          </span>
        </div>

        <div class="cb-candidate-phase-identity" data-testid="candidate-inspector-phase-identity-{cand.candidateId}">
          <span>Phase: <strong>{cand.phaseName ?? cand.phaseId ?? cand.nodeId}</strong></span>
          {#if cand.operatorKind}<span> · Operator: <strong>{cand.operatorKind}</strong></span>{/if}
          {#if cand.instructionSummary}<span> · Instruction: {cand.instructionSummary}</span>{/if}
        </div>

        <div class="cb-candidate-metrics">
          <span data-testid="candidate-inspector-attempts-{cand.candidateId}">
            Attempts: {cand.attemptsUsed} / {cand.maxAttempts} ({remaining} remaining)
          </span>
          <span data-testid="candidate-inspector-availability-{cand.candidateId}">
            Readiness: {cand.availabilityStatus ?? 'unknown'} (source: {cand.availabilitySource ?? 'none'}, {cand.fresh ? 'fresh' : 'stale / unverified'})
          </span>
          {#if cand.quotaIdentity || cand.permitWaitPosition !== undefined}
            <span data-testid="candidate-inspector-quota-{cand.candidateId}">
              Quota: {cand.quotaIdentity ?? cand.backend}{#if cand.permitWaitPosition !== undefined} (wait position #{cand.permitWaitPosition}){/if}
            </span>
          {/if}
        </div>

        <div class="cb-candidate-timestamps">
          <span data-testid="candidate-inspector-reset-at-{cand.candidateId}">
            Reset estimate: {formatControlTimestamp(cand.resetAt, { timeZone: p.timeZone, referenceTimeMs: p.referenceTimeMs })}
          </span>
          <span data-testid="candidate-inspector-next-check-{cand.candidateId}">
            Next check: {formatControlTimestamp(cand.nextCheckAt, { timeZone: p.timeZone, referenceTimeMs: p.referenceTimeMs })}
          </span>
          <span data-testid="candidate-inspector-not-before-{cand.candidateId}">
            Not before: {formatControlTimestamp(cand.notBefore, { timeZone: p.timeZone, referenceTimeMs: p.referenceTimeMs })}
          </span>
        </div>
      </li>
    {/each}
  </ul>

  {#if proj.evidenceRefs.length > 0}
    <div class="cb-evidence-refs" data-testid="candidate-block-inspector-evidence-refs">
      <span class="cb-card-label">Evidence References:</span>
      {#each proj.evidenceRefs as ref (ref)}
        <code class="cb-evidence-chip">{ref}</code>
      {/each}
    </div>
  {/if}

  {#if isPrimary}
    <div class="cb-controls-panel" data-testid="candidate-block-inspector-controls">
      <div class="cb-controls-selectors">
        <label class="cb-inline-field">
          Target Candidate
          <select class="select-input" data-testid="candidate-control-target-select" aria-label="Target candidate for control action" value={selectedCandidateId} disabled={commandPending} onchange={(e) => (selectedCandidateId = e.currentTarget.value)}>
            {#each candidates as cand (cand.candidateId)}
              <option value={cand.candidateId}>{cand.candidateId} ({cand.backend})</option>
            {/each}
          </select>
        </label>

        <label class="cb-inline-field">
          Availability Policy
          <select class="select-input" data-testid="candidate-control-policy-select" aria-label="Availability policy for control action" value={selectedPolicy} disabled={commandPending} onchange={(e) => (selectedPolicy = e.currentTarget.value as CandidateAvailabilityPolicy)}>
            {#each CANDIDATE_AVAILABILITY_POLICIES as pol (pol)}
              <option value={pol}>{pol}</option>
            {/each}
          </select>
        </label>
      </div>

      <div class="cb-subset-checkboxes" data-testid="candidate-control-subset-group">
        <span class="cb-card-label">Allowed Candidates:</span>
        {#each candidates as cand (cand.candidateId)}
          <label class="cb-subset-check">
            <input type="checkbox" data-testid="candidate-control-allow-checkbox-{cand.candidateId}" checked={allowedSubset[cand.candidateId] !== false} disabled={commandPending} onchange={(e) => toggleSubsetCandidate(cand.candidateId, e.currentTarget.checked)} />
            <span>{cand.candidateId}</span>
          </label>
        {/each}
      </div>

      <div class="cb-action-buttons" data-testid="candidate-control-action-buttons">
        {#each ['check-now', 'try-now', 'select-candidate', 'set-policy', 'set-allowed-candidates', 'renew-monitoring', 'pause', 'resume', 'cancel'] as const as actionKey (actionKey)}
          {@const desc = actionDescriptor(actionKey)}
          <div class="cb-action-item">
            <button type="button" class="cb-action-btn" data-testid="candidate-control-action-{actionKey}" disabled={commandPending || !desc.allowed} title={desc.reason ?? ACTION_LABELS[actionKey]} onclick={() => dispatchControlAction(actionKey)}>
              {ACTION_LABELS[actionKey]}
            </button>
            {#if !desc.allowed && desc.reason}
              <span class="cb-action-reason" data-testid="candidate-control-reason-{actionKey}">{desc.reason}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if feedbackMessage && feedbackSubjectId === proj.invocationId}
    <div class="cb-feedback-banner" class:is-refused={feedbackKind === 'refused'} data-testid="candidate-control-feedback" data-feedback-kind={feedbackKind} data-subject-invocation-id={proj.invocationId} role="status">
      {feedbackMessage}
    </div>
  {/if}
</section>

<style>
  .cb-inspector { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); }
  .cb-inspector-header, .cb-honesty-card, .cb-candidate-card, .cb-controls-panel { display: flex; flex-direction: column; gap: 4px; }
  .cb-inspector-title-row, .cb-inspector-counters, .cb-candidate-card-head, .cb-candidate-metrics, .cb-candidate-timestamps, .cb-evidence-refs, .cb-controls-selectors, .cb-subset-checkboxes, .cb-action-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .cb-inspector-title { margin: 0; font-size: 0.9em; }
  .cb-state-badge { font-size: 0.78em; font-weight: 600; text-transform: uppercase; padding: 2px 6px; border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); }
  .cb-meta-badge, .cb-counter-chip, .cb-evidence-chip { font-size: 0.78em; opacity: 0.88; }
  .cb-honesty-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px; }
  .cb-honesty-card, .cb-candidate-card { padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); font-size: 0.8em; }
  .cb-card-label { font-size: 0.75em; opacity: 0.78; }
  .cb-spend-details, .cb-candidate-phase-identity, .cb-deadline-row { font-size: 0.8em; opacity: 0.9; }
  .cb-candidate-rows, .cb-notice-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .cb-notice-banner, .cb-feedback-banner { padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); font-size: 0.8em; display: flex; flex-wrap: wrap; gap: 6px; }
  .cb-inline-field, .cb-subset-check { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8em; }
  .cb-action-item { display: inline-flex; flex-direction: column; gap: 2px; }
  .cb-action-btn { padding: 3px 8px; font-size: 0.78em; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); cursor: pointer; }
  .cb-action-btn:disabled { cursor: default; opacity: 0.55; }
  .cb-action-reason { font-size: 0.7em; opacity: 0.75; }
</style>
