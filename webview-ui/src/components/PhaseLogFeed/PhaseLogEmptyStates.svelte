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

  import type { VerboseDiagnosticsBanner } from '../../../../src/services/phase-log/types';
  import { openVerboseSetting } from '../../lib/phase-log-ipc';

  interface Props {
    readonly banner: VerboseDiagnosticsBanner | null;
  }

  let { banner }: Props = $props();
</script>

{#if banner?.kind === 'enabled-no-sessions-for-tuple'}
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
