<script lang="ts">
  // Feature 105 (T587b) — the route whose *mount* fails once and then succeeds,
  // which is how recovery-from-cache is observed: the module never changes, only
  // the render does.
  //
  // It also stands in for a real prop-taking surface (T587e). `history` is one of
  // the routes the outlet hands `snapshot` to, so a render that arrives without
  // one is the outlet picking props for a different route — the torn-state defect
  // the browser walk found. Declaring the prop is what lets this fixture notice.
  import { untrack } from 'svelte';

  import { ledger } from './route-mount-ledger';

  const { snapshot }: { snapshot?: unknown } = $props();

  // Read at init, deliberately and once: what is being checked is the props the
  // outlet passed *when it created this component*, which is the moment the
  // torn-state defect is visible. `untrack` says so; reading `snapshot` bare
  // here earns `state_referenced_locally`, which is the right warning for code
  // that meant to stay reactive and the wrong one for this.
  if (untrack(() => snapshot) === undefined) ledger.recordPropViolation('history');
  ledger.mount('history');
</script>

<main class="ledger-surface" data-testid="ledger-history">history</main>
