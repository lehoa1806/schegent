<script lang="ts">
  // FR-R3-144 (FR-005, FR-008, FR-012) — what a backend card's "Details" link opens.
  //
  // The card (`BackendSection.svelte`) draws the link, decides when the region shows and owns
  // the region's box. This file is what the box holds, in reading order: why the backend was
  // not found, the path it starts from, the bound it executes under as the host projects it,
  // the host's own sentences about a grant, and the settings only this backend honours.
  //
  // Like the card, it renders `posture` and never computes it. The card's header says why, and
  // `tests/lint/webview-posture-derivation.test.ts` (T024) holds this file to the same rule.
  import type {
    BackendPosture,
    BackendRunnerKind,
    PortableWorkflowDefinition
  } from '../../../lib/snapshot-types';
  import GeneralSettingFieldRow from './GeneralSettingFieldRow.svelte';
  import type {
    BackendSection as BackendSectionSpec,
    Draft,
    ScalarKey,
    StatusByKey
  } from './field-types';

  interface Props {
    kind: BackendRunnerKind;
    section: BackendSectionSpec;
    /** This backend's projected posture, or `undefined` when the host sends none. */
    posture: BackendPosture | undefined;
    discovered: boolean;
    /**
     * The name of the item in the card's menu that gives this backend its grant, when the card
     * offers one now. The line under a refusal quotes it; with none to point at, there is no line.
     */
    grantAction: string | undefined;
    /** The element round the path field, so the card's path actions can put the caret in it. */
    pathRow?: HTMLDivElement;
    draft: Draft;
    statusByKey: StatusByKey;
    workflows: readonly PortableWorkflowDefinition[];
    fieldChanged: (key: ScalarKey) => boolean;
    fieldScopeLabel: (key: ScalarKey) => string;
  }

  let {
    kind,
    section,
    posture,
    discovered,
    grantAction,
    pathRow = $bindable(),
    draft = $bindable(),
    statusByKey,
    workflows,
    fieldChanged,
    fieldScopeLabel
  }: Props = $props();
</script>

{#if !discovered}
  <!--
    T045, FR-012 — "not found" and "refused" are two different problems with two
    different remedies, and a surface that renders one badge for both sends an
    operator to fix a path that is already right. This sentence names the path
    field directly below it; the refusal further down names the grant. A backend
    can be in both states at once, and then it says both things, in that order —
    finding the binary is the prerequisite, so it is stated first.
  -->
  <p class="not-found" data-testid={`backend-not-found-${kind}`}>
    No {section.label} binary was found at the path below. Correct the path or install
    it — this is a discovery problem, and no permission granted here will change it.
  </p>
{/if}

<div class="path-row" bind:this={pathRow}>
  <GeneralSettingFieldRow
    spec={section.path}
    bind:draft
    status={statusByKey[section.path.key]}
    changed={fieldChanged(section.path.key)}
    scopeLabel={fieldScopeLabel(section.path.key)}
    {workflows}
  />
</div>

{#if posture !== undefined}
  <!--
    T035 — the posture is on screen BEFORE a run, not in the failure that follows
    one. Both values are projected discriminants rendered as they arrived; the
    mechanism is shown beside the containment because "contained" alone cannot
    tell an operator why one backend differs from another. The card's summary says
    the same thing in one plain phrase; these are the values behind it.
  -->
  <p class="sub posture" data-testid={`backend-posture-${kind}`}>
    <span class="posture-label">Containment:</span>
    <code>{posture.containment}</code>
    <span class="posture-label">Mechanism:</span>
    <code data-testid={`backend-mechanism-${kind}`}>{posture.mechanism}</code>
  </p>

  {#if posture.problem !== undefined}
    <!--
      FR-004 — an entry that grants nothing, said where the list is shown. It
      used to reach only the runtime log, which an operator who mistyped a
      backend id has no reason to read.
    -->
    <p class="grant-problem" data-testid={`backend-grant-problem-${kind}`} role="status">
      {posture.problem}
    </p>
  {/if}

  {#if posture.refusal !== undefined}
    <!--
      T034, T035 — the enforcement's own sentence, carried by the projection and
      rendered verbatim. It names both routes out (grant this backend, or choose
      one that carries a sandbox), which is why it is shown whole rather than
      summarised. After a revoke it reappears, because the projection recomputes
      it — the section does not remember a refusal, it shows the one that is
      currently true.
    -->
    <p class="refusal" data-testid={`backend-refusal-${kind}`}>{posture.refusal}</p>
    {#if grantAction !== undefined}
      <!-- The host's sentence names the setting. This line names the control on the card that
           writes it, in the words the menu uses. -->
      <p class="pointer small muted" data-testid={`backend-grant-pointer-${kind}`}>
        To give that permission here, choose “{grantAction}” from the actions menu on this card.
      </p>
    {/if}
  {/if}
{/if}

{#if section.specific.length > 0}
  <div class="specific">
    {#each section.specific as spec (spec.key)}
      <GeneralSettingFieldRow
        {spec}
        bind:draft
        status={statusByKey[spec.key]}
        changed={fieldChanged(spec.key)}
        scopeLabel={fieldScopeLabel(spec.key)}
        {workflows}
      />
    {/each}
  </div>
{:else}
  <!--
    T030 — a sentence, not a blank region. An empty area reads as a surface that
    failed to load, and an operator who concludes that goes looking for the Codex
    equivalent of the Claude control they can see one card up. Saying there is
    none is the answer to that question.
  -->
  <p class="no-specific small muted" data-testid={`backend-no-specific-settings-${kind}`}>
    {section.label} has no backend-specific settings.
  </p>
{/if}

<style>
  /* The path row is the only row in its wrapper, so the sheet draws no line under it. */
  .path-row {
    border-bottom: 1px solid var(--schegent-border);
  }
  .posture {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--schegent-space-1) var(--schegent-space-1-5);
    margin: var(--schegent-space-2) 0 0;
  }
  .posture-label {
    font-weight: 600;
  }
  .posture code {
    font-family: var(--schegent-mono-font);
  }
  .refusal,
  .grant-problem,
  .not-found {
    margin: var(--schegent-space-2) 0 0;
    font-size: var(--schegent-text-secondary);
    line-height: 1.45;
    color: var(--schegent-status-warning-text);
  }
  .pointer {
    margin: var(--schegent-space-1) 0 0;
  }
  .specific {
    margin-top: var(--schegent-space-2);
    border-top: 1px solid var(--schegent-border);
  }
  .no-specific {
    margin: var(--schegent-space-2) 0 0;
  }
</style>
