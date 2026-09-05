<script lang="ts">
  // Feature 020 T037 — empty-state cards, driven by the host's classification.
  //
  // Feature 203 (T045, T046, FR-011, FR-013, FR-015, SC-003) — one card per
  // kind of nothing, seven in all. Before this the component had two
  // banner-driven cards for a vocabulary that could not tell the situations
  // apart, so most of them arrived labelled as one another or as nothing.
  //
  // The `data-empty-kind` attribute on each card is the key the member ↔ card
  // bijection is asserted through. It is the member's own spelling, so the
  // correspondence is derivable rather than tabulated — a table here would be
  // one more hand-maintained copy of the enumeration, which is the shape D1
  // exists to remove.
  //
  // `entries-present` is a member of the same vocabulary and deliberately has
  // NO card: the reading pane is its rendering. The single-valued decision is
  // exactly one member, and exactly one of {reading pane, one card}.
  //
  // The `diagnostics-disabled` CTA opens VS Code Settings scoped to the verbose
  // toggle via the shared `openVerboseSetting` helper (NEVER an inline
  // postCommand — the lint regression at
  // tests/lint/no-inline-phase-log-ipc.test.ts fails the build on any drift).
  //
  // Bug "the phase log that asked for a phase named done" (2026-09-02),
  // second finding — a variant that is NOT banner-driven and is NOT one of the
  // seven.
  //
  // The cards above need `banner`, and the host only sends one in answer
  // to a complete tuple. A selection naming a task but no phase reads
  // nothing, so `banner` stays null and this component rendered nothing —
  // while `PhaseLogReadingPane` renders nothing of its own on zero entries
  // and defers here in a comment. Neither side was wrong alone; between
  // them the operator got a blank pane with no hint that the phase strip
  // beside it was the way in. `noPhaseSelected` is webview state, not a
  // host reading, which is why it is a separate prop rather than a new
  // `VerboseDiagnosticsBanner` kind — that union is a host contract in
  // `src/services/phase-log/types` and does not describe this.

  import type { VerboseDiagnosticsBanner } from '../../../../src/services/phase-log/types';
  import { openVerboseSetting } from '../../lib/phase-log-ipc';

  interface Props {
    readonly banner: VerboseDiagnosticsBanner | null;
    /**
     * True when the selection names a task but no phase. Defaults to false so
     * every existing caller renders exactly as it did before.
     */
    readonly noPhaseSelected?: boolean;
    /**
     * Feature 203 (T046) — how many lines the read could not display, shown on
     * the `nothing-displayable` card when it is greater than zero. DISPLAY ONLY:
     * it is a number the manifest already carries, and passing it changes no
     * decision here. The entries themselves are still never handed to this
     * component.
     */
    readonly skippedLines?: number;
  }

  let { banner, noPhaseSelected = false, skippedLines = 0 }: Props = $props();
</script>

{#if noPhaseSelected}
  <!-- Ordered first on purpose: deselecting a phase can leave the previous
       tuple's banner in state for a frame, and "no log for this phase yet" is
       false once there is no this-phase. -->
  <div class="card" data-testid="phase-log-empty-no-phase">
    <p class="title">No phase selected</p>
    <p class="hint">
      Pick a phase from the strip to read its log. A run that has
      finished has no current phase, so there is nothing to follow
      until you choose one.
    </p>
  </div>
{:else if banner?.kind === 'phase-running-no-output'}
  <div
    class="card"
    data-testid="phase-log-empty-phase-running-no-output"
    data-empty-kind="phase-running-no-output"
  >
    <p class="title">This phase is running</p>
    <p class="hint">
      It has not written anything yet. Output appears here as it arrives.
    </p>
  </div>
{:else if banner?.kind === 'phase-not-recorded'}
  <div
    class="card"
    data-testid="phase-log-empty-phase-not-recorded"
    data-empty-kind="phase-not-recorded"
  >
    <p class="title">This phase has not run</p>
    <p class="hint">
      Nothing has been recorded for it. Pick a phase that has run, or start
      this one.
    </p>
  </div>
{:else if banner?.kind === 'diagnostics-disabled'}
  <div
    class="card guidance"
    data-testid="phase-log-empty-diagnostics-disabled"
    data-empty-kind="diagnostics-disabled"
  >
    <p class="title">Verbose diagnostics is off</p>
    <p class="hint">
      Nothing is being recorded for any phase until
      <code>{banner.settingKey}</code> is enabled.
    </p>
    <button
      type="button"
      data-testid="phase-log-empty-open-settings"
      onclick={openVerboseSetting}
    >
      Open Settings
    </button>
  </div>
{:else if banner?.kind === 'no-iteration-recorded'}
  <div
    class="card"
    data-testid="phase-log-empty-no-iteration-recorded"
    data-empty-kind="no-iteration-recorded"
  >
    <p class="title">This phase began and recorded nothing</p>
    <p class="hint">
      Its log directory is here and holds no iteration. What went wrong is in
      the phase, not in this log.
    </p>
  </div>
{:else if banner?.kind === 'record-path-refused'}
  <div
    class="card"
    data-testid="phase-log-empty-record-path-refused"
    data-empty-kind="record-path-refused"
  >
    <p class="title">The log path is not a readable file</p>
    <p class="hint">
      Something that is not a log is sitting where this phase's stream belongs.
      This one is worth reporting.
    </p>
  </div>
{:else if banner?.kind === 'record-vanished'}
  <div
    class="card"
    data-testid="phase-log-empty-record-vanished"
    data-empty-kind="record-vanished"
  >
    <p class="title">The log was removed while it was being read</p>
    <p class="hint">
      This iteration was listed and its stream is no longer there. Read it
      again to pick up the current state.
    </p>
  </div>
{:else if banner?.kind === 'nothing-displayable'}
  <div
    class="card"
    data-testid="phase-log-empty-nothing-displayable"
    data-empty-kind="nothing-displayable"
  >
    <p class="title">The log holds nothing this view can show</p>
    <p class="hint">
      The stream was read and none of it could be displayed.
      <!-- Deliberately NOT prefixed `phase-log-empty-`: the reachability
           harness counts cards by that prefix, and a detail inside a card is
           not a second card. -->
      {#if skippedLines > 0}
        <span data-testid="phase-log-skipped-lines">
          {skippedLines} unreadable {skippedLines === 1 ? 'line was' : 'lines were'}
          skipped.
        </span>
      {/if}
    </p>
  </div>
{/if}

<style>
  .card {
    padding: var(--schegent-pad, 0.75rem);
    border: 1px dashed var(--schegent-border, currentColor);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    opacity: 0.85;
  }
  .title {
    font-weight: 600;
    margin: 0;
  }
  .hint {
    margin: 0;
    font-size: 0.85rem;
    opacity: 0.85;
  }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
  }
  button {
    align-self: flex-start;
  }
</style>
