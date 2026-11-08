<script lang="ts">
  // FR-R5-F32 (F32-T02, F32-T03) — Candidate-Block Authoring & Canvas Path Editor.
  //
  // Authors 1..8 ordered Phase-backed candidates with per-candidate attempt caps (1..20),
  // retry backoff, allowUnverifiedTrial, availability policy (first-ready / wait-for-preferred),
  // block dispatch cap (1..40), monitoring window, and optional USD ceiling.
  //
  // Phase instruction summary, backend/runner, model, and result operator kind are rendered
  // strictly read-only from the referenced Phase catalog entry so no duplicate editable copy
  // can diverge from the Phase definition.

  import {
    CANDIDATE_AVAILABILITY_POLICIES,
    DEFAULT_CANDIDATE_ATTEMPTS,
    DEFAULT_CANDIDATE_AVAILABILITY_POLICY,
    DEFAULT_CANDIDATE_BLOCK_DISPATCHES,
    DEFAULT_MONITORING_WINDOW_MS,
    MAX_CANDIDATE_ATTEMPTS,
    MAX_CANDIDATE_BLOCK_DISPATCHES,
    MAX_CANDIDATES_PER_BLOCK,
    MIN_CANDIDATES_PER_BLOCK,
    type CandidateAvailabilityPolicy,
    type PortablePhaseDefinition
  } from '../../lib/snapshot-types';
  import type { MutableWorkflow } from './types';
  import {
    addCandidateRow,
    disableCandidateBlockControl,
    enableCandidateBlockControl,
    moveCandidateRow,
    removeCandidateRow,
    updateCandidateBlockPolicy,
    updateCandidateRow,
    type CandidateBlockPolicyPatch,
    type CandidateRowPatch
  } from './workflow-catalog-state';
  import { describeCandidateBlockCanvasPath } from './workflow-flow-layout';

  interface Props {
    row: MutableWorkflow;
    phases?: readonly PortablePhaseDefinition[];
    readonly?: boolean;
    onedit: (edit: (workflow: MutableWorkflow) => MutableWorkflow) => void;
    onopenphase?: (phaseId: string) => void;
  }

  const p: Props = $props();

  const phases = $derived(p.phases ?? []);
  const isReadonly = $derived(p.readonly === true);
  const control = $derived(p.row.control);
  const descriptor = $derived(
    describeCandidateBlockCanvasPath(p.row.control, p.row.nodes, phases)
  );

  let expanded = $state(true);
  let selectedCandidateId = $state<string | null>(null);

  $effect(() => {
    if (!control || control.candidates.length === 0) {
      selectedCandidateId = null;
      return;
    }
    if (
      selectedCandidateId === null ||
      !control.candidates.some((c) => c.candidateId === selectedCandidateId)
    ) {
      selectedCandidateId = control.candidates[0].candidateId;
    }
  });

  function defaultPhaseId(): string {
    return phases[0]?.phaseId ?? 'phase-1';
  }

  function handleEnable(): void {
    if (isReadonly) return;
    p.onedit((wf) => enableCandidateBlockControl(wf, defaultPhaseId()));
  }

  function handleDisable(): void {
    if (isReadonly) return;
    p.onedit((wf) => disableCandidateBlockControl(wf));
  }

  function handleAddCandidate(): void {
    if (isReadonly) return;
    p.onedit((wf) => addCandidateRow(wf, defaultPhaseId()));
  }

  function handleRemoveCandidate(index: number): void {
    if (isReadonly) return;
    p.onedit((wf) => removeCandidateRow(wf, index));
  }

  function handleMoveCandidate(index: number, delta: number, candidateId: string): void {
    if (isReadonly) return;
    selectedCandidateId = candidateId;
    p.onedit((wf) => moveCandidateRow(wf, index, delta));
  }

  function handlePatchCandidate(index: number, patch: CandidateRowPatch): void {
    if (isReadonly) return;
    p.onedit((wf) => updateCandidateRow(wf, index, patch));
  }

  function handlePatchPolicy(patch: CandidateBlockPolicyPatch): void {
    if (isReadonly) return;
    p.onedit((wf) => updateCandidateBlockPolicy(wf, patch));
  }

  function parseBoundedInt(raw: string, min: number, max: number, fallback: number): number {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }
</script>

<section
  class="cb-editor"
  data-testid="candidate-block-editor"
  aria-label="Candidate Block Control"
>
  <div class="cb-header">
    <div class="cb-title-group">
      <h4 class="cb-heading">Candidate Block Control</h4>
      {#if control}
        <span class="wf-badge" data-testid="candidate-block-count-badge">
          {control.candidates.length} / {MAX_CANDIDATES_PER_BLOCK} candidates
        </span>
      {/if}
    </div>
    <div class="cb-header-actions">
      {#if control}
        <button type="button" class="btn btn-ghost btn-sm" data-testid="candidate-block-expand-toggle" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
          {expanded ? 'Collapse block' : 'Expand block'}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="candidate-block-disable" disabled={isReadonly} onclick={handleDisable}>
          Disable candidate block
        </button>
      {:else}
        <button type="button" class="btn btn-secondary btn-sm" data-testid="candidate-block-enable" disabled={isReadonly} onclick={handleEnable}>
          Enable candidate block
        </button>
      {/if}
    </div>
  </div>

  {#if control && descriptor}
    <div class="cb-topology-summary" data-testid="candidate-block-topology-summary">
      <span class="wf-badge" data-testid="candidate-block-selection-mode">Exclusive single-active candidate selection (no parallel execution)</span>
      <span class="wf-badge" data-testid="candidate-block-return-path">{descriptor.validatedReturnPath}</span>
      <span class="wf-badge" data-testid="candidate-block-terminal-exits">Exits: {descriptor.terminalExits.join(' · ')}</span>
    </div>

    {#if !expanded}
      <div class="cb-collapsed-summary" data-testid="candidate-block-collapsed-view">
        <span>Policy: <strong>{descriptor.availabilityPolicy}</strong> · Max dispatches: <strong>{descriptor.maxDispatches}</strong> · Candidates: <strong>{descriptor.candidates.map((c) => c.candidateId).join(' → ')}</strong></span>
      </div>
    {:else}
      <div class="cb-expanded-body" data-testid="candidate-block-expanded-view">
        <div class="cb-policy-grid" data-testid="candidate-block-policy-fields">
          <label class="wf-field">
            Availability Policy
            <select
              class="select-input"
              data-testid="candidate-block-availability-policy"
              aria-label="Candidate block availability policy"
              value={control.availabilityPolicy ?? DEFAULT_CANDIDATE_AVAILABILITY_POLICY}
              disabled={isReadonly}
              onchange={(e) => handlePatchPolicy({ availabilityPolicy: e.currentTarget.value as CandidateAvailabilityPolicy })}
            >
              {#each CANDIDATE_AVAILABILITY_POLICIES as policy (policy)}
                <option value={policy}>{policy}</option>
              {/each}
            </select>
          </label>

          <label class="wf-field">
            Max Dispatches (1–{MAX_CANDIDATE_BLOCK_DISPATCHES})
            <input
              type="number"
              class="text-input"
              min="1"
              max={MAX_CANDIDATE_BLOCK_DISPATCHES}
              data-testid="candidate-block-max-dispatches"
              aria-label="Candidate block max dispatches"
              value={control.maxDispatches ?? DEFAULT_CANDIDATE_BLOCK_DISPATCHES}
              readonly={isReadonly}
              oninput={(e) => handlePatchPolicy({ maxDispatches: parseBoundedInt(e.currentTarget.value, 1, MAX_CANDIDATE_BLOCK_DISPATCHES, DEFAULT_CANDIDATE_BLOCK_DISPATCHES) })}
            />
          </label>

          <label class="wf-field">
            Monitoring Window (ms)
            <input
              type="number"
              class="text-input"
              min="1000"
              step="1000"
              data-testid="candidate-block-monitoring-window-ms"
              aria-label="Candidate block monitoring window ms"
              value={control.monitoringWindowMs ?? DEFAULT_MONITORING_WINDOW_MS}
              readonly={isReadonly}
              oninput={(e) => {
                const parsed = Number.parseInt(e.currentTarget.value.trim(), 10);
                if (Number.isFinite(parsed) && parsed > 0) handlePatchPolicy({ monitoringWindowMs: parsed });
              }}
            />
          </label>

          <label class="wf-field">
            Spend Ceiling (micro-USD, optional)
            <input
              type="number"
              class="text-input"
              min="0"
              step="1000"
              placeholder="Count-only (no USD ceiling)"
              data-testid="candidate-block-max-microusd"
              aria-label="Candidate block spend ceiling micro-USD"
              value={control.budget?.mode === 'strict-usd' ? control.budget.limitMicrousd : ''}
              readonly={isReadonly}
              oninput={(e) => {
                const raw = e.currentTarget.value.trim();
                if (raw === '') { handlePatchPolicy({ maxMicrousd: undefined }); return; }
                const parsed = Number.parseInt(raw, 10);
                if (Number.isFinite(parsed) && parsed > 0) handlePatchPolicy({ maxMicrousd: parsed });
              }}
            />
          </label>
        </div>

        <div class="cb-candidates-header">
          <span class="form-label">Ordered Candidates (1–{MAX_CANDIDATES_PER_BLOCK})</span>
          <button type="button" class="btn btn-secondary btn-sm" data-testid="candidate-block-add-row" disabled={isReadonly || control.candidates.length >= MAX_CANDIDATES_PER_BLOCK} onclick={handleAddCandidate}>
            + Add candidate
          </button>
        </div>

        <ul class="cb-candidate-list" data-testid="candidate-block-rows">
          {#each control.candidates as cand, index (cand.candidateId)}
            {@const desc = descriptor.candidates.at(index)}
            {@const node = p.row.nodes.find((n) => n.nodeId === cand.nodeId)}
            {@const currentPhaseId = node?.phaseId ?? desc?.phaseId ?? ''}
            {@const isSelected = selectedCandidateId === cand.candidateId}
            <li class="cb-candidate-row" class:is-selected={isSelected} data-testid="candidate-row-{index}" data-candidate-id={cand.candidateId}>
              <div class="cb-candidate-row-head">
                <button type="button" class="cb-candidate-select-btn" data-testid="candidate-row-select-{cand.candidateId}" aria-pressed={isSelected} onclick={() => (selectedCandidateId = cand.candidateId)}>
                  <span class="wf-badge">#{index + 1}</span>
                  <strong data-testid="candidate-row-id-{index}">{cand.candidateId}</strong>
                  <span class="cb-node-ref">({cand.nodeId})</span>
                </button>

                <div class="cb-candidate-row-actions">
                  <button type="button" class="icon-btn" data-testid="candidate-row-up-{index}" aria-label="Move candidate {cand.candidateId} earlier" disabled={isReadonly || index === 0} onclick={() => handleMoveCandidate(index, -1, cand.candidateId)}>↑</button>
                  <button type="button" class="icon-btn" data-testid="candidate-row-down-{index}" aria-label="Move candidate {cand.candidateId} later" disabled={isReadonly || index === control.candidates.length - 1} onclick={() => handleMoveCandidate(index, 1, cand.candidateId)}>↓</button>
                  <button type="button" class="icon-btn destructive-icon" data-testid="candidate-row-remove-{index}" aria-label="Remove candidate {cand.candidateId}" disabled={isReadonly || control.candidates.length <= MIN_CANDIDATES_PER_BLOCK} onclick={() => handleRemoveCandidate(index)}>✕</button>
                </div>
              </div>

              <div class="cb-candidate-fields">
                <label class="wf-field">
                  Bound Phase
                  <select
                    class="select-input"
                    data-testid="candidate-row-phase-{index}"
                    aria-label="Candidate {cand.candidateId} bound Phase"
                    value={currentPhaseId}
                    disabled={isReadonly}
                    onchange={(e) => handlePatchCandidate(index, { phaseId: e.currentTarget.value })}
                  >
                    {#if currentPhaseId && !phases.some((ph) => ph.phaseId === currentPhaseId)}
                      <option value={currentPhaseId}>{currentPhaseId} (unresolved)</option>
                    {/if}
                    {#each phases as phase (phase.phaseId)}
                      <option value={phase.phaseId}>{phase.name} ({phase.phaseId})</option>
                    {/each}
                  </select>
                </label>

                <label class="wf-field">
                  Priority
                  <input
                    type="number"
                    class="text-input"
                    min="1"
                    max="100"
                    data-testid="candidate-row-priority-{index}"
                    aria-label="Candidate {cand.candidateId} priority"
                    value={cand.priority ?? index + 1}
                    readonly={isReadonly}
                    oninput={(e) =>
                      handlePatchCandidate(index, {
                        priority: parseBoundedInt(e.currentTarget.value, 1, 100, index + 1)
                      })}
                  />
                </label>

                <label class="wf-field">
                  Max Attempts (1–{MAX_CANDIDATE_ATTEMPTS})
                  <input
                    type="number"
                    class="text-input"
                    min="1"
                    max={MAX_CANDIDATE_ATTEMPTS}
                    data-testid="candidate-row-max-attempts-{index}"
                    aria-label="Candidate {cand.candidateId} max attempts"
                    value={cand.maxAttempts ?? DEFAULT_CANDIDATE_ATTEMPTS}
                    readonly={isReadonly}
                    oninput={(e) =>
                      handlePatchCandidate(index, {
                        maxAttempts: parseBoundedInt(
                          e.currentTarget.value,
                          1,
                          MAX_CANDIDATE_ATTEMPTS,
                          DEFAULT_CANDIDATE_ATTEMPTS
                        )
                      })}
                  />
                </label>

                <label class="wf-field">
                  Initial Retry Delay (ms)
                  <input
                    type="number"
                    class="text-input"
                    min="0"
                    step="500"
                    data-testid="candidate-row-retry-delay-{index}"
                    aria-label="Candidate {cand.candidateId} initial retry delay ms"
                    value={cand.retry?.initialDelayMs ?? 0}
                    readonly={isReadonly}
                    oninput={(e) => {
                      const delay = Math.max(0, Number.parseInt(e.currentTarget.value.trim(), 10) || 0);
                      handlePatchCandidate(index, {
                        retry: {
                          initialDelayMs: delay,
                          maxDelayMs: Math.max(delay, cand.retry?.maxDelayMs ?? delay * 4),
                          multiplier: cand.retry?.multiplier ?? 2
                        }
                      });
                    }}
                  />
                </label>
              </div>

              <div class="cb-candidate-trial-row">
                <label class="checkbox-field">
                  <input
                    type="checkbox"
                    data-testid="candidate-row-allow-unverified-trial-{index}"
                    aria-label="Candidate {cand.candidateId} allow unverified trial"
                    checked={cand.allowUnverifiedTrial === true}
                    disabled={isReadonly}
                    onchange={(e) =>
                      handlePatchCandidate(index, {
                        allowUnverifiedTrial: e.currentTarget.checked
                      })}
                  />
                  <span class="form-label">Allow counted trial when availability is unverified</span>
                </label>

                {#if currentPhaseId && p.onopenphase}
                  {@const openPhase = p.onopenphase}
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    data-testid="candidate-row-open-phase-{index}"
                    onclick={() => openPhase(currentPhaseId)}
                  >
                    Open Phase definition
                  </button>
                {/if}
              </div>

              {#if desc}
                <div
                  class="cb-phase-identity"
                  data-testid="candidate-row-phase-identity-{index}"
                  data-readonly="true"
                >
                  <div class="cb-phase-badges">
                    <span class="wf-badge" data-testid="candidate-row-runner-{index}">
                      Runner: {desc.runner ?? 'inherit'}
                    </span>
                    <span class="wf-badge" data-testid="candidate-row-model-{index}">
                      Model: {desc.model ?? 'inherit'}
                    </span>
                    <span class="wf-badge" data-testid="candidate-row-operator-kind-{index}">
                      Operator: {desc.operatorKind}
                    </span>
                    <span class="wf-badge" data-testid="candidate-row-retry-summary-{index}">
                      {desc.retrySummary}
                    </span>
                  </div>
                  <p
                    class="cb-phase-instruction"
                    data-testid="candidate-row-instruction-summary-{index}"
                  >
                    Phase instruction (read-only): {desc.instructionSummary}
                  </p>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
</section>

<style>
  .cb-editor { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); }
  .cb-header, .cb-title-group, .cb-header-actions, .cb-topology-summary, .cb-candidates-header, .cb-candidate-row-head, .cb-candidate-row-actions, .cb-candidate-trial-row, .cb-phase-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .cb-header, .cb-candidates-header, .cb-candidate-row-head, .cb-candidate-trial-row { justify-content: space-between; }
  .cb-heading { margin: 0; font-size: 0.9em; }
  .cb-expanded-body { display: flex; flex-direction: column; gap: 8px; }
  .cb-policy-grid, .cb-candidate-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px; }
  .cb-candidate-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .cb-candidate-row { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--schegent-radius); }
  .cb-candidate-row.is-selected { border-color: var(--vscode-focusBorder, var(--vscode-panel-border)); }
  .cb-candidate-select-btn { background: transparent; border: none; color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 0; text-align: left; }
  .cb-node-ref { font-size: 0.8em; opacity: 0.75; }
  .cb-phase-identity { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; border-top: 1px dashed var(--vscode-panel-border); font-size: 0.8em; }
  .cb-phase-instruction, .cb-collapsed-summary { margin: 0; font-size: 0.82em; opacity: 0.9; word-break: break-word; }
</style>
