<script lang="ts">
  // Feature 020 T037 — empty-state cards. Two variants:
  //   1. `enabled-no-sessions-for-tuple` → "no log for this phase yet"
  //      with no CTA (verbose is on; the operator just hasn't run this
  //      phase yet).
  //   2. `disabled-no-sessions` → guidance card with an "Open Settings"
  //      CTA that opens VS Code Settings scoped to the verbose toggle
  //      via the shared `openVerboseSetting` helper (NEVER an inline
  //      postCommand — the lint regression at
  //      tests/lint/no-inline-phase-log-ipc.test.ts fails the build on
  //      any drift).
  //
  // Bug "the phase log that asked for a phase named done" (2026-09-02),
  // second finding — a third variant that is NOT banner-driven.
  //
  // Both cards above need `banner`, and the host only sends one in answer
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
  }

  let { banner, noPhaseSelected = false }: Props = $props();
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
{:else if banner?.kind === 'enabled-no-sessions-for-tuple'}
  <div class="card" data-testid="phase-log-empty-no-log">
    <p class="title">No log for this phase yet</p>
    <p class="hint">
      The phase hasn't emitted any output for this iteration. It may not
      have started, or it may have completed without producing any
      observable activity.
    </p>
  </div>
{:else if banner?.kind === 'disabled-no-sessions'}
  <div class="card guidance" data-testid="phase-log-empty-disabled">
    <p class="title">Verbose diagnostics is off</p>
    <p class="hint">
      Enable <code>{banner.settingKey}</code> to capture per-phase
      stream logs. Without it the Activity Feed cannot show anything
      for selected phases.
    </p>
    <button
      type="button"
      data-testid="phase-log-empty-open-settings"
      onclick={openVerboseSetting}
    >
      Open Settings
    </button>
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
