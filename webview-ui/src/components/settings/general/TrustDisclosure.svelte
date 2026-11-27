<script lang="ts">
  // FR-R3-143 (T039) — the two `schegent.trust.*` capability keys, surfaced
  // READ-ONLY. Spec C1 records why there is no control here, and the reasoning
  // is not stylistic:
  //
  //   - A write would ack `accepted` and change nothing. The keys are `window`
  //     scoped, so `configurationTargetFor` sends them to Workspace; the ladder
  //     then reads `globalValue === false` as a first-class deny
  //     (`src/state/capability-trust-decision.ts:85`), and a user-layer `false`
  //     survives any workspace write. The operator would be told the save
  //     succeeded while the capability stayed denied.
  //   - A two-state checkbox cannot represent `null`, which is a documented
  //     third state ("silent"): its first save would convert silence into an
  //     explicit `true` (`capability-trust-decision.ts:44-56`).
  //
  // So this discloses the RESOLVED value and the step that decided it, and
  // hands the operator to the settings editor, which can target both layers.
  //
  // The `key:` literals below are also what the coverage gate detects
  // (`tests/integration/settings-surface.integration.test.ts:273`): it scans
  // `.svelte` under the settings root for single-quoted `key:`/`ipcKey:`
  // literals and never renders anything, so a read-only surface accounts for
  // both keys exactly as a control would. Their two ledger rows leave with
  // this component (T041).

  import type { WorkflowSnapshot } from '../../../lib/snapshot-types';
  import { openTrustSettings } from '../../../lib/trust-settings-ipc';
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
  import { descriptionWords, settingsSearch } from '../settings-search.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

  const { row: searchRow, group: searchGroup } = settingsSearch();

  /** The note above the two rows. The page's search also finds both rows by it. */
  const PREAMBLE =
    'These two are resolved against VS Code Workspace Trust, so Schegent shows what is in force ' +
    'rather than a switch it cannot honour.';

  type Capability = 'phases' | 'retryConditions';

  interface TrustRow {
    readonly capability: Capability;
    readonly key: string;
    readonly label: string;
  }

  const TRUST_ROWS: readonly TrustRow[] = [
    {
      capability: 'phases',
      key: 'trust.allowCustomPhases',
      label: 'Custom phase prompts'
    },
    {
      capability: 'retryConditions',
      key: 'trust.allowCustomRetryConditions',
      label: 'Custom retry-condition expressions'
    }
  ] as const;

  /**
   * The four states of spec C1, from `getResolvedScope` x `resolvedTrust`.
   *
   * `workspace-trust` splits on the effective value because the ceiling reports
   * two different facts: a denial nothing in Schegent can widen, and the silent
   * default where neither layer has an opinion. The other two steps do not
   * split — naming the deciding layer is the whole answer, and the effective
   * value is already stated beside it.
   */
  function decidedByText(
    scope: 'user' | 'workspace' | 'workspace-trust' | undefined,
    allowed: boolean
  ): string | null {
    // Absence is UNKNOWN, not a step. An older host bundle omits the field
    // (`snapshot-types.ts`), and naming the wrong layer is the defect this
    // disclosure exists to fix.
    if (scope === undefined) return null;
    if (scope === 'workspace-trust') {
      return allowed
        ? 'Allowed by default — neither your user settings nor this workspace has an opinion.'
        : 'Denied by VS Code Workspace Trust. No Schegent setting can widen this.';
    }
    if (scope === 'user') {
      return 'Decided by your user settings. A workspace setting cannot override this.';
    }
    return "Decided by this workspace's settings.";
  }

  const rows = $derived(
    TRUST_ROWS.map((row) => {
      const allowed = snapshot.resolvedTrust?.[row.capability] === true;
      return {
        ...row,
        allowed,
        decidedBy: decidedByText(snapshot.resolvedScope?.[row.capability], allowed)
      };
    })
  );
</script>

<!--
  The redesign’s trust rows: each capability as a setting row, the deciding step as its
  description and the resolved value as a status chip where a control would be. The setting key
  and the way to the settings editor sit under the chip, as a row’s scope line does.
-->
<div class="trust-disclosure" data-testid="trust-disclosure" use:searchGroup={() => [PREAMBLE]}>
  <p class="preamble small muted">{PREAMBLE}</p>
  {#each rows as row (row.key)}
    <div
      class="srow trust-row"
      data-testid="trust-row-{row.capability}"
      use:searchRow={() => [
        row.label,
        `schegent.${row.key}`,
        ...descriptionWords(GENERAL_SETTINGS_DESCRIPTIONS[`trust-${row.capability}-open-settings`])
      ]}
    >
      <div>
        <div class="lab">{row.label}</div>
        {#if row.decidedBy}
          <p class="desc decided-by" data-testid="trust-decided-by-{row.capability}">{row.decidedBy}</p>
        {:else}
          <!--
            The host did not project a deciding step. Saying "unknown" is the
            honest reading and the only one that cannot mislead; the effective
            value above is still correct.
          -->
          <p class="desc decided-by" data-testid="trust-decided-by-{row.capability}">
            Deciding layer unknown — this host build does not report it.
          </p>
        {/if}
      </div>
      <div class="ctl">
        <span
          class="chip effective"
          class:s-ok={row.allowed}
          class:s-err={!row.allowed}
          data-testid="trust-effective-{row.capability}"
        >{#if row.allowed}<svg class="i" aria-hidden="true"><use href="#i-check"></use></svg>{:else}<svg
              class="i"
              aria-hidden="true"><use href="#i-x"></use></svg>{/if}{row.allowed ? 'Allowed' : 'Denied'}</span>
        <code class="setting-key">schegent.{row.key}</code>
        <button
          type="button"
          class="btn btn-secondary btn-sm change-in-settings"
          data-testid="trust-open-settings-{row.capability}"
          onclick={openTrustSettings}
          use:hoverTextAnchor={{
            controlId: `trust-${row.capability}-open-settings`,
            description: GENERAL_SETTINGS_DESCRIPTIONS[`trust-${row.capability}-open-settings`]
          }}
        >Change in Settings</button>
      </div>
    </div>
  {/each}
</div>

<style>
  /* The rows above end without a rule; this one opens the disclosure as a row’s bottom rule
     would. */
  .trust-disclosure {
    border-top: 1px solid var(--schegent-border);
  }
  /* With no row shown above, as when a search hides them all, there is nothing to part from. */
  :global(.field-list:not(:has(> :not([hidden])))) + .trust-disclosure {
    border-top: 0;
  }
  .preamble {
    margin: var(--schegent-space-2) 0 0;
    line-height: 1.45;
  }
  .decided-by {
    margin: var(--schegent-space-1) 0 0;
    line-height: 1.4;
  }
  /* The control column is a flex column; the chip and the button keep their own width. */
  .ctl .effective,
  .ctl .change-in-settings {
    align-self: flex-start;
  }
  .ctl .setting-key {
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
    overflow-wrap: anywhere;
  }
</style>
