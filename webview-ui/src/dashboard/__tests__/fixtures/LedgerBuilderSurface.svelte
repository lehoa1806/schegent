<script lang="ts">
  // Feature 105 (T587) — the second gated route. A mocked module factory runs
  // once per test file, so a held import can only be observed by the first test
  // that reaches it; the stale-resolution test gets this one, the bound gets
  // `system`.
  import { ledger } from './route-mount-ledger';

  ledger.mount('builder');
</script>

<main class="ledger-surface" data-testid="ledger-builder">builder</main>
