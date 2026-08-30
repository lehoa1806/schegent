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

  interface Props {
    snapshot: WorkflowSnapshot;
  }
  const { snapshot }: Props = $props();

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

<div class="trust-disclosure" data-testid="trust-disclosure">
  <p class="preamble">
    These two are resolved against VS Code Workspace Trust, so Schegent shows what is in force
    rather than a switch it cannot honour.
  </p>
  {#each rows as row (row.key)}
    <div class="trust-row" data-testid="trust-row-{row.capability}">
      <div class="row-head">
        <span class="label">{row.label}</span>
        <span
          class="effective"
          class:denied={!row.allowed}
          data-testid="trust-effective-{row.capability}"
        >{row.allowed ? 'Allowed' : 'Denied'}</span>
      </div>
      <code class="setting-key">schegent.{row.key}</code>
      {#if row.decidedBy}
        <p class="decided-by" data-testid="trust-decided-by-{row.capability}">{row.decidedBy}</p>
      {:else}
        <!--
          The host did not project a deciding step. Saying "unknown" is the
          honest reading and the only one that cannot mislead; the effective
          value above is still correct.
        -->
        <p class="decided-by" data-testid="trust-decided-by-{row.capability}">
          Deciding layer unknown — this host build does not report it.
        </p>
      {/if}
      <button
        type="button"
        class="change-in-settings"
        data-testid="trust-open-settings-{row.capability}"
        onclick={openTrustSettings}
        use:hoverTextAnchor={{
          controlId: `trust-${row.capability}-open-settings`,
          description: GENERAL_SETTINGS_DESCRIPTIONS[`trust-${row.capability}-open-settings`]
        }}
      >Change in Settings</button>
    </div>
  {/each}
</div>

<style>
  .trust-disclosure {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    border-top: 1px solid var(--schegent-divider);
  }
  .preamble {
    margin: 0;
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    line-height: 1.5;
  }
  .trust-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--schegent-divider);
    border-radius: var(--schegent-radius-sm);
  }
  .row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .label {
    font-weight: 600;
    font-size: 0.92em;
  }
  .effective {
    font-size: 0.85em;
    padding: 1px 6px;
    border-radius: var(--schegent-radius-sm);
    background: var(--vscode-textBlockQuote-background);
    color: var(--vscode-foreground);
  }
  .effective.denied {
    color: var(--schegent-error-text);
  }
  .setting-key {
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
  }
  .decided-by {
    margin: 0;
    font-size: 0.85em;
    line-height: 1.5;
    color: var(--schegent-muted-fg);
  }
  .change-in-settings {
    min-height: var(--schegent-control-height-compact);
    padding: 4px 12px;
    border-radius: var(--schegent-radius);
    font-size: 0.9em;
    cursor: pointer;
    border: 1px solid transparent;
    background: transparent;
    color: var(--schegent-muted-fg);
  }
  .change-in-settings:hover {
    background: var(--vscode-list-hoverBackground);
  }
</style>
