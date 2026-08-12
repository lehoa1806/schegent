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
>
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2"></rect>
    <path d="M8 8h8"></path><path d="M8 12h5"></path><path d="M8 16h8"></path>
  </svg>
  Open Dashboard
</button>

<style>
  .dashboard-link {
    width: 100%;
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    border: 1px solid transparent;
    border-radius: var(--schegent-radius-sm);
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
