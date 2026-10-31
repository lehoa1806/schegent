<script lang="ts">
  // FR-R4-F06 (FR-007 to FR-009, FR-014; contract D, D4 to D6, and K6) -- what a Run is
  // about to run with, said where the operator presses start.
  //
  // A DISCLOSURE, NOT A GATE. It confirms nothing and blocks nothing: rendering it, hiding
  // it and following its link change no state, and a start is still judged at runner lookup
  // and by the router's trust gate (D7). It exists because a grant written in settings,
  // possibly months earlier, is the only consent an operator ever gave, and the moment it
  // applies is the moment a Run starts.
  //
  // THE HOST COMPOSES EVERY SENTENCE (hard rule 2). A posture's `notice` and a capability
  // notice's `text` arrive finished; this component chooses which to show and renders each as
  // text with `{}`, which escapes. It uses no `{@html}` and no inline handler string, so it
  // adds no markup capability (hard rule 3), and it holds no wording of its own about what a
  // backend can reach: `tests/lint/webview-posture-derivation.test.ts` forbids such a
  // sentence here, so a copy cannot drift from the policy's.
  //
  // WHICH NOTICES. The selected definition's `backends` are the backends a start would
  // actually spawn, which the host computed with the freeze's own function. A posture
  // `notice` is shown for each of those backends that carries one, so a launch that runs only
  // on a sandboxed backend shows no backend notice at all, and a launch that includes a git
  // Phase shows Claude's even on a window whose default is Codex. A backend whose posture has
  // no `notice` is shown nothing: it is either contained or not granted, and the latter is a
  // refusal at start, not a disclosure.
  //
  // REVIEW IN SETTINGS. When the dashboard shell provided a navigation capability, each
  // posture notice is followed by a button that asks it to open the Settings route. That
  // capability is webview-local and posts nothing (D5); without it, which is every mount
  // outside the dashboard, no button renders.

  import { getContext } from 'svelte';

  import { DASHBOARD_NAVIGATION, type DashboardNavigation } from '../../dashboard/navigation-context';
  import type { BackendPosture, CapabilityNotice } from '../../lib/snapshot-types';

  interface Props {
    /** The backends the selected definition would spawn, from the host's `Launchable.backends`. */
    backends: readonly BackendPosture['kind'][];
    /** Every backend's posture, as the snapshot projects them. */
    postures: readonly BackendPosture[];
    /** The selected definition's capability notices, already worded by the host. */
    capabilityNotices: readonly CapabilityNotice[];
  }

  const { backends, postures, capabilityNotices }: Props = $props();

  const navigation = getContext<DashboardNavigation | undefined>(DASHBOARD_NAVIGATION);

  const disclosed = $derived(
    backends.flatMap((kind) => {
      const posture = postures.find((candidate) => candidate.kind === kind);
      return posture?.notice === undefined ? [] : [{ kind, notice: posture.notice }];
    })
  );
</script>

{#if disclosed.length > 0 || capabilityNotices.length > 0}
  <div class="launch-authority-notice" data-testid="launch-authority-notice" role="note">
    {#each disclosed as item (item.kind)}
      <div class="notice-block">
        <p class="notice-text" data-testid="launch-authority-notice-text-{item.kind}">
          {item.notice}
        </p>
        {#if navigation !== undefined}
          <button
            type="button"
            class="notice-link"
            data-testid="launch-authority-review-settings-{item.kind}"
            onclick={() => navigation.openBackendSettings()}
          >
            Review in Settings
          </button>
        {/if}
      </div>
    {/each}
    {#each capabilityNotices as capability, index (index)}
      <p class="notice-text" data-testid="launch-authority-capability-{index}">
        {capability.text}
      </p>
    {/each}
  </div>
{/if}

<style>
  .launch-authority-notice {
    border-left: 3px solid var(--vscode-editorWarning-foreground, var(--vscode-focusBorder));
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 8px;
  }

  .notice-block {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .notice-text {
    font-size: 0.85em;
    margin: 0;
  }

  .notice-link {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 0.85em;
    padding: 0;
    text-decoration: underline;
  }

  .notice-link:hover {
    color: var(--vscode-textLink-activeForeground);
  }
</style>
