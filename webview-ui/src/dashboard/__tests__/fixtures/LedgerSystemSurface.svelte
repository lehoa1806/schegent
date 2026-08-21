<script lang="ts">
  // Feature 105 (T587) — the gated route. Its module factory waits on the
  // ledger's gate, which is how a load that has not settled is expressed.
  import { ledger } from './route-mount-ledger';

  ledger.mount('system');
</script>

<main class="ledger-surface" data-testid="ledger-system">system</main>
