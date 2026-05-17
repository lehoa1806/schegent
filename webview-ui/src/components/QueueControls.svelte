<script lang="ts">
  interface Props {
    isPrimary: boolean;
    resumeDisabled: boolean;
    pauseDisabled: boolean;
    clearDoneDisabled: boolean;
    cleanDisabled: boolean;
    onResume: () => void;
    onPause: () => void;
    onClearDone: () => void;
    onClean: () => void;
  }

  const {
    isPrimary,
    resumeDisabled,
    pauseDisabled,
    clearDoneDisabled,
    cleanDisabled,
    onResume,
    onPause,
    onClearDone,
    onClean
  }: Props = $props();
</script>

<div class="queue-controls">
  <button
    type="button"
    class="btn btn-primary"
    data-testid="dashboard-queue-resume"
    onclick={onResume}
    disabled={resumeDisabled || !isPrimary}
    title="Resume the queue"
  >Resume</button>
  <button
    type="button"
    class="btn btn-secondary"
    data-testid="dashboard-queue-pause"
    onclick={onPause}
    disabled={pauseDisabled || !isPrimary}
    title="Pause the queue"
  >Pause</button>
  <button
    type="button"
    class="btn btn-ghost"
    data-testid="dashboard-queue-clear-done"
    onclick={onClearDone}
    disabled={clearDoneDisabled || !isPrimary}
    title="Clear completed tasks from Recent"
  >Clear Done</button>
  <button
    type="button"
    class="btn btn-destructive"
    data-testid="dashboard-queue-clean"
    onclick={onClean}
    disabled={cleanDisabled || !isPrimary}
    title="Clear completed and failed tasks from Recent"
  >Clean</button>
</div>

<style>
  .queue-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: var(--schegent-gap);
  }

  .btn {
    padding: 4px 12px;
    border-radius: var(--schegent-radius);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: transform 0.1s ease, opacity 0.1s ease;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn:active:not(:disabled) { transform: scale(0.93); opacity: 0.8; }
  .btn-primary { background: var(--schegent-color-active); color: var(--vscode-button-foreground); }
  .btn-primary:hover:not(:disabled) { box-shadow: var(--sch-glow-active); }
  .btn-secondary { background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); }
  .btn-ghost { background: transparent; color: var(--schegent-muted-fg); }
  .btn-ghost:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
  .btn-destructive { background: transparent; color: var(--schegent-color-error); border-color: var(--schegent-color-error); }
  .btn-destructive:hover:not(:disabled) { background: var(--schegent-color-error); color: var(--vscode-button-foreground); }
</style>
