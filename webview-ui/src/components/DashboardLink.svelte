<script lang="ts">
  import { postCommand } from '../lib/vscode-api';
  import { CMD_OPEN_DASHBOARD } from '../lib/messages';

  function onClick(): void {
    postCommand(CMD_OPEN_DASHBOARD);
  }
</script>

<button
  type="button"
  class="btn btn-primary"
  data-testid="sidebar-open-dashboard-button"
  onclick={onClick}
>Open Dashboard</button>

<style>
  /* The shared sheet draws the button. Its one action in a narrow view keeps the height it had
     before the redesign, a little taller than the sheet's controls. */
  .btn {
    min-height: 32px;
  }
</style>
