<script lang="ts">
  import { postCommand } from '../lib/vscode-api';
  import { CMD_OPEN_DASHBOARD } from '../lib/messages';

  function onClick(): void {
    postCommand(CMD_OPEN_DASHBOARD);
  }
</script>

<button
  type="button"
  class="dashboard-link"
  data-testid="sidebar-open-dashboard-button"
  onclick={onClick}
>Open Dashboard</button>

<style>
  .dashboard-link {
    width: 100%;
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    border: 1px solid transparent;
    border-radius: var(--schegent-radius);
    padding: 0 var(--schegent-pad);
    font: inherit;
    cursor: pointer;
  }
  .dashboard-link:hover {
    background: var(--schegent-button-hover);
  }
  .dashboard-link:focus-visible {
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 1px;
  }
</style>
