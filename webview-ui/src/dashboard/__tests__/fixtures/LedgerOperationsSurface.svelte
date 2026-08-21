<script lang="ts">
  // Feature 105 (T587b, SC-009a) — stands in for `OperationsSurface`, the one
  // route `App.svelte` renders eagerly. No loader promise has ever covered it,
  // so before the boundary a throw here had nowhere to go.
  import { ledger } from './route-mount-ledger';

  ledger.mount('operations');
</script>

<main class="ledger-surface" data-testid="ledger-operations">operations</main>
