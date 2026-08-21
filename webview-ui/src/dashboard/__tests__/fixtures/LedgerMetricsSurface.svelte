<script lang="ts">
  // Feature 105 (T587) — the fast route. Used as the second half of the
  // stale-resolution test: it mounts while another route's import is still held.
  import { ledger } from './route-mount-ledger';

  ledger.mount('metrics');
</script>

<main class="ledger-surface" data-testid="ledger-metrics">metrics</main>
