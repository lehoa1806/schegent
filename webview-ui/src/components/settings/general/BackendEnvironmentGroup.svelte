<script lang="ts">
  import type { WorkflowSnapshot } from '../../../lib/snapshot-types';
  import BackendHealthSection from '../BackendHealthSection.svelte';
  import GeneralSettingFieldRow from './GeneralSettingFieldRow.svelte';
  import type { FieldSpec, SettingsGroupProps } from './field-types';
  // FR-R3-143 (T035) — the SAME function the spawn calls. See T034's header in
  // that module for why it is reachable from here at all.
  import { resolveProcessEnvironmentPolicy } from '../../../../../src/contracts/process-environment-policy';

  // `fields` is this group's slice of `BACKEND_FIELDS`, handed straight to
  // `BackendHealthSection`, which pairs it with its own `RUNNERS` by index.
  // That positional coupling and the `any`-typed props behind it belong to
  // FR-R3-144 (T1563); this group renders the section unchanged and takes
  // no position on either.
  //
  // FR-R3-143 (T031) — `environmentFields` is a SECOND slice, rendered by this
  // group directly rather than through that section, precisely because of the
  // positional pairing above: a fourth member of `fields` would be a row
  // `BackendHealthSection` never reaches.
  interface Props extends SettingsGroupProps {
    snapshot: WorkflowSnapshot;
    environmentFields: readonly FieldSpec[];
  }

  let {
    snapshot,
    fields,
    environmentFields,
    draft = $bindable(),
    statusByKey,
    pipelines,
    fieldChanged,
    fieldScopeLabel,
    saveOne,
    resetField,
    onAutoCompactInput
  }: Props = $props();

  // FR-R3-143 (T035) — reads the DRAFT, not the projection.
  //
  // Reading the saved snapshot would show the operator the policy they already
  // have, which they can find out by looking at the spawn. The question the four
  // controls above raise is what the edit in front of them will do, and it is a
  // real question: three inputs fold into one outcome, and one of them silently
  // overrides the other two.
  const effectivePolicy = $derived(
    resolveProcessEnvironmentPolicy({
      inheritEnvironment: draft.cliInheritEnvironment,
      mode: draft.cliEnvironmentMode,
      allowlist: draft.cliEnvironmentAllowlist
    })
  );

  // The line names the OVERRIDING INPUT, not just the outcome.
  //
  // "Effective policy: minimal" over a mode reading `allowlist` and a populated
  // list is the exact reading an operator disbelieves — they conclude the surface
  // is stale, edit the list again, and file a bug against the allowlist. Naming
  // the legacy boolean is the whole value of the line; the outcome alone is worse
  // than nothing.
  const forcedByLegacyBoolean = $derived(
    !draft.cliInheritEnvironment && draft.cliEnvironmentMode !== 'minimal'
  );
  const effectivePolicyText = $derived.by(() => {
    if (forcedByLegacyBoolean) {
      return (
        'minimal — forced by "Inherit Host Environment (legacy)" being off, which overrides ' +
        'the mode and allowlist above. Backend CLIs receive only the variables Schegent sets. ' +
        'Turn it on to make those two take effect.'
      );
    }
    if (effectivePolicy.mode === 'minimal') {
      return 'minimal — backend CLIs receive only the variables Schegent sets. No PATH, no HOME, no ambient credentials.';
    }
    if (effectivePolicy.mode === 'inherit') {
      return "inherit — backend CLIs receive the extension host's entire environment, including any credentials in it.";
    }
    const count = effectivePolicy.processEnvAllowlist?.length ?? 0;
    const named =
      count === 0
        ? 'nothing else'
        : `${count} name${count === 1 ? '' : 's'} listed above`;
    return `allowlist — backend CLIs receive the required bootstrap variables (PATH, home, temp, locale) plus ${named}.`;
  });
</script>

<!--
  FR-R3-143 (T005) — `open` is not a style choice. A collapsed group would put
  every description key in `orphanKeys` (hover-text-coverage collects the DOM
  unfiltered) and would hide its controls from the 44px touch-target check,
  which skips 0x0 rects.
-->
<details class="settings-group" data-testid="settings-group-backend-environment" open>
  <!--
    FR-R3-143 (T047) — singular `Backend`, verbatim from
    `docs/reference/settings.md:9`, which is the §4 grouping FR-006 requires this
    tab to present. T005 wrote `Backends`; one word, and the only one of the four
    that drifted, because nothing compared them until
    `tests/lint/settings-group-heading-parity.test.ts`.
  -->
  <summary>Backend and process environment</summary>
  <BackendHealthSection
    {snapshot}
    BACKEND_FIELDS={fields}
    bind:draft
    {statusByKey}
    {fieldChanged}
    {fieldScopeLabel}
    {pipelines}
    {saveOne}
    {resetField}
    {onAutoCompactInput}
  />
  <div class="field-list">
    {#each environmentFields as spec (spec.key)}
      <GeneralSettingFieldRow
        {spec}
        bind:draft
        status={statusByKey[spec.key]}
        changed={fieldChanged(spec.key)}
        scopeLabel={fieldScopeLabel(spec.key)}
        {pipelines}
        onSave={() => saveOne(spec)}
        onReset={() => resetField(spec.key)}
        {onAutoCompactInput}
      />
    {/each}
    <!--
      FR-R3-143 (T035) — static text, deliberately. It carries no `controlId` and
      is not focusable, so it adds no hover-text surface to account for and no
      touch target to size; it is the summary of the four controls above, not a
      fifth control.

      `aria-live="polite"` because the three inputs are elsewhere in the group:
      toggling the legacy boolean changes this sentence without moving focus, and
      a screen-reader user would otherwise never learn that their mode selection
      just stopped applying.
    -->
    <p class="effective-policy" data-testid="effective-environment-policy" aria-live="polite">
      <strong>Effective policy:</strong>
      {effectivePolicyText}
    </p>
  </div>
</details>
<style>
  .field-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border-top: 1px solid var(--schegent-divider);
    margin-top: 12px;
  }
  .effective-policy {
    margin: 0;
    padding: 8px 10px;
    font-size: 0.85em;
    line-height: 1.5;
    border-top: 1px solid var(--schegent-divider);
    color: var(--schegent-muted-fg);
  }
  .effective-policy strong {
    color: var(--vscode-foreground);
  }
  .settings-group {
    border: 1px solid var(--schegent-divider);
    border-radius: var(--schegent-radius);
  }
  .settings-group > summary {
    padding: 8px 10px;
    font-weight: 600;
    font-size: 0.95em;
    cursor: pointer;
    list-style: revert;
  }
  .settings-group > summary:hover {
    background: var(--vscode-list-hoverBackground);
  }
</style>
