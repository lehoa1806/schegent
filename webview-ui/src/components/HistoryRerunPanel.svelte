<script lang="ts">
  // Feature 103 (T065-T069 — FR-033 to FR-039, FR-055, FR-059) — repeating one
  // recorded run.
  //
  // This panel states, and then gets out of the way. Everything below the
  // notices is `RunLauncher.svelte`, unchanged and unwrapped: FR-038 requires a
  // re-run to pass exactly the gates any other launch passes, and the only way
  // to be sure of that over time is for there to be one form and one submit
  // path rather than two that happen to agree today. The row's old action
  // posted `CMD_RERUN_FROM_HISTORY`, which submits immediately — correct for
  // feature 013's one-click repeat, and precisely what FR-039 rules out.
  //
  // What the notices are for is narrower than it looks. A re-run cannot repeat
  // the past: the version it froze may have been superseded, the queue it ran in
  // may have been deleted, and a run that was one node of a Workflow can only be
  // repeated as the Pipeline it actually was. All three substitutions are the
  // right behaviour and all three are wrong to make silently — a form that
  // performs them without saying so is indistinguishable from one that repeated
  // the run faithfully, and the operator finds out from the result.
  //
  // Nothing here validates. The composer submits an incomplete composition on
  // purpose (FR-045) and `validateRunRequest()` host-side answers with every
  // failing field at once, which is also FR-039's second sentence: an input that
  // can no longer be fulfilled is surfaced by the form's existing validation,
  // and the operator decides. A pre-check in this file would be a second oracle.
  //
  // Operator-authored strings — the description, Pipeline and queue names — are
  // interpolated with `{}`, which escapes. Nothing here uses `{@html}`.

  import RunLauncher from './RunLauncher/RunLauncher.svelte';
  import { resolveHistoryDescription } from '../lib/history-description-ipc';
  import { rerunUnavailableMessage, type RerunTarget } from '../lib/history-rerun';
  import type { HistoryRow } from '../lib/history-rows';
  import type { PipelineDefinition } from '../lib/snapshot-types';

  interface Props {
    readonly row: HistoryRow;
    /** Resolved by the caller at open time, never remembered (FR-034). */
    readonly target: RerunTarget;
    /**
     * The effective-catalog definition the form composes against, resolved by
     * the caller the same way `RunsSurface` resolves it. Optional because the
     * projection and the effective catalog arrive as two fields of one snapshot
     * and a render can land between them; that window gets a sentence rather
     * than a form with no controls in it.
     */
    readonly pipeline: PipelineDefinition | undefined;
    readonly onClose: () => void;
  }

  const { row, target, pipeline, onClose }: Props = $props();

  const panelState = $derived(
    target.state === 'unavailable'
      ? 'unavailable'
      : pipeline === undefined
        ? 'definition-unloaded'
        : 'ready'
  );

  /**
   * FR-033 — pre-filled from the historical run's inputs, which is the whole of
   * what history retains: the description, and — since FR-R3-071 — the FULL
   * stored one rather than its preview, resolved from the host per open. Input
   * port values are not recorded (see `HistoryEntry`), so there is nothing else
   * to seed and the note below says so rather than leaving an empty contract
   * section to imply the Pipeline asks for nothing. The preview remains the
   * fallback when the sidecar cannot be read, and the extent note appears only
   * then.
   *
   * Seeded into `instruction` because that is the control whose value the
   * composer routes to `RunRequest.instructions` — the field the host bounds
   * and the one a free-form description belongs in.
   */
  /**
   * FR-R3-071 (feature 152) — the resolved description, or `null` until the
   * host answers (and permanently when it cannot).
   *
   * The projection carries only the preview, deliberately, so the full text is
   * asked for per open rather than kept in every snapshot. `$state` rather than
   * a derived: it is an answer that arrives, not a function of the row.
   */
  let descriptionAnswer = $state<{ readonly text: string | null } | null>(null);

  $effect(() => {
    // Re-asked per row, and the answer is discarded when the row changes — a
    // late reply must never seed the launcher for a run the operator is no
    // longer looking at.
    const runId = row.runId;
    descriptionAnswer = null;
    let current = true;
    void resolveHistoryDescription(runId).then((result) => {
      if (!current) return;
      descriptionAnswer =
        result.outcome === 'resolved' || result.outcome === 'legacy'
          ? { text: result.description }
          : // `missing` / `unreadable` / `failure`: fall back to the preview and
            // its extent note. That path is already honest and says what it is.
            { text: null };
    });
    return () => {
      current = false;
    };
  });

  /**
   * The form is not mounted until the answer settles, and that is the point
   * rather than a loading nicety. `RunLauncher` snapshots `initialSupplemental`
   * with `untrack` — deliberately, so a later prop change cannot clobber what
   * the operator has typed — so a form mounted on the preview would keep the
   * truncation even after the full text arrived. Waiting means the form is
   * seeded once, correctly, and never mutates under the cursor.
   */
  const resolvingDescription = $derived(descriptionAnswer === null);

  const prefill = $derived<Record<string, string>>(
    descriptionAnswer?.text != null
      ? { instruction: descriptionAnswer.text }
      : row.descriptionPreview.length > 0
        ? { instruction: row.descriptionPreview }
        : {}
  );

  // The same extent statement the detail makes (FR-053). A truncation that does
  // not say it is one is indistinguishable from a complete record — and here it
  // would be worse than on the detail, because the operator is about to submit
  // it as the instruction for a new run.
  const showsExtent = $derived(
    descriptionAnswer?.text == null &&
      row.descriptionPreview.length > 0 &&
      row.descriptionLength !== null &&
      row.descriptionLength > row.descriptionPreview.length
  );
  // Fixed locale, so the separator does not depend on the host's.
  const extentText = $derived(
    `The description is the retained preview: ${row.descriptionPreview.length.toLocaleString('en-US')} of ${(row.descriptionLength ?? 0).toLocaleString('en-US')} characters of the original. Edit it before you launch if the rest mattered.`
  );
</script>

<section
  class="rerun-panel"
  data-testid="history-rerun-panel"
  data-state={panelState}
  aria-label="Repeat this run"
>
  <header class="rerun-header">
    <h3>Repeat this run</h3>
    <button type="button" class="close" data-testid="history-rerun-close" onclick={onClose}>
      Close
    </button>
  </header>

  {#if target.state === 'unavailable'}
    <!-- FR-037 — unavailable, with the reason said out loud. Not a hidden
         control and not a form that fails on submit: both leave the operator
         guessing at something the surface already knows. -->
    <p class="note refusal" data-testid="history-rerun-unavailable" role="status">
      {rerunUnavailableMessage(target.reason)}
    </p>
  {:else if pipeline === undefined}
    <p class="note refusal" data-testid="history-rerun-definition-unloaded" role="status">
      This Pipeline is published, but its definition has not loaded yet. Try again in a moment.
    </p>
  {:else}
    {#if target.supersededVersionId !== null}
      <!-- FR-035 — stated before anything is submitted, and naming both
           versions: "a newer version exists" does not tell an operator whether
           the change is the one they are trying to test. -->
      <p class="note" data-testid="history-rerun-version-notice" role="status">
        This will run the Active version, {target.launchable.activeVersionId}. The run you are
        repeating froze {target.supersededVersionId}, which is no longer Active.
      </p>
    {/if}

    {#if target.workflowMemberOf !== null}
      <!-- FR-055 — the row names one run, not a start node. -->
      <p class="note" data-testid="history-rerun-workflow-notice" role="status">
        This run was one Pipeline inside the Workflow {target.workflowMemberOf}. Repeating it runs
        that Pipeline alone; the Workflow is not restarted. Start the Workflow from Runs instead.
      </p>
    {/if}

    <!-- FR-059 — which queue, in either case. Substituting one silently is the
         same class of unstated substitution as a silent version swap, so
         there is no arm here that says nothing. -->
    <p
      class="note"
      data-testid="history-rerun-queue-notice"
      data-substituted={target.queue.substituted ? 'true' : 'false'}
      role="status"
    >
      {#if target.queue.substituted}
        The queue this run used no longer exists, so this will go to the default queue
        ({target.queue.name}).
      {:else}
        This will go to the same queue the run used: {target.queue.name}.
      {/if}
    </p>

    <p class="note" data-testid="history-rerun-prefill-note">
      The description below is carried over from the run. Its input values were not recorded, so
      nothing else is pre-filled — supply them as you would for any other run.
    </p>
    {#if showsExtent}
      <p class="note" data-testid="history-rerun-prefill-extent">{extentText}</p>
    {/if}

    <!-- The launch surface's own composer, mounted as it stands (FR-038). It
         submits through `launchPipeline`, which reaches the same four gates in
         the same order; `validateRunRequest()` resolves `catalogVersion` at the
         freeze site, and nothing here sends one. -->
    <!-- No `onClose`: the panel's own header owns closing, and a second Close
         inside the form would be two controls for one action. -->
    <!-- FR-R3-071 — mounted only once the recorded description has settled, so
         the composer is seeded with the full text rather than a preview it
         would then keep (it snapshots its initial values on purpose). -->
    {#if resolvingDescription}
      <p class="note" data-testid="history-rerun-description-loading">
        Reading the recorded description…
      </p>
    {:else}
      <RunLauncher {pipeline} initialSupplemental={prefill} queueId={target.queue.queueId} />
    {/if}
  {/if}
</section>

<style>
  .rerun-panel {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-gap);
    padding: var(--schegent-space-3);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-surface);
  }
  .rerun-header {
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    align-items: center;
    justify-content: space-between;
  }
  .rerun-header h3 {
    margin: 0;
    font-size: var(--schegent-text-secondary);
    font-weight: 600;
  }
  .close {
    min-height: var(--schegent-control-height);
    padding: 4px 10px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    background: transparent;
    color: var(--schegent-fg);
    font: inherit;
    cursor: pointer;
  }
  .close:hover {
    background: var(--schegent-list-hover);
  }
  .note {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    line-height: 1.45;
    text-wrap: pretty;
  }
  /* A refusal is the whole content of the panel when it appears, so it reads as
     the answer rather than as a footnote under an absent form. */
  .refusal {
    color: var(--schegent-error-text);
    font-size: var(--schegent-text-secondary);
  }
</style>
