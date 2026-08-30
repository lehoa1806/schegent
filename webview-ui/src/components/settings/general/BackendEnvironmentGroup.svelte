<!--
  FR-R3-144 (T038) — this group's field specs are DECLARED here, in the component
  that renders them, and exported for the one thing the tab still needs them for:
  folding them into the `FIELDS` array Save All iterates.

  They lived in `GeneralSettingsTab.svelte` until this task, threaded back down as
  four props (`backends`, `runnerField`, `spendFields`, `environmentFields`) whose
  only purpose was to return them to their renderer. That put the tab at 525
  physical lines against a 500-line budget — the budget doing exactly its job, by
  refusing the tab the role of holding every group's data as well as composing the
  groups.

  A `<script module>` block and not a `.ts` module, and the distinction is
  load-bearing: `tests/integration/settings-surface.integration.test.ts` proves
  every declared setting reaches a control by scanning `key:`/`ipcKey:` literals in
  `.svelte` files under this directory tree, and nothing else. Moving these specs
  to a `.ts` file would empty that gate of four settings with every test green —
  the same class of silent hole this feature exists to close. The literals stay in
  a `.svelte` file; only the TYPES live in `field-types.ts`.
-->
<script module lang="ts">
  // Imported here rather than in the instance block below because a module script
  // and an instance script share one module scope: the markup and the `$derived`
  // values read these same bindings, and importing a name in both blocks is a
  // redeclaration.
  import type { BackendSection, FieldSpec } from './field-types';
  import {
    SUPPORTED_BACKENDS,
    type BackendRunnerKind
  } from '../../../../../src/contracts/backend-kinds';
  import type { SpendDenomination } from '../../../../../src/contracts/backend-spend-denomination';
  // FR-R3-143 (T030, T034) — the mode list and the allowlist element pattern are
  // READ from the module that enforces them, not copied. A copy on the far side of
  // the IPC boundary is the one that would drift, and it would drift silently: the
  // host's allowlist filter drops a name the surface accepted without saying so, at
  // spawn time, in another process.
  //
  // That filter is deliberately not named here, and neither is the policy field the
  // fold sets. `__tests__/environment-policy-line.test.ts` forbids both strings
  // anywhere in this file — a substring scan, comments included, because a scan a
  // reimplementation could talk its way past would not be a gate. Naming them in
  // prose reads as harmless and fails the build; that is the gate working.
  //
  // This import is `src/contracts/`, and that is not incidental. The first version
  // read the same two values from `src/config/settings-schema`, which
  // `tests/lint/webview-host-import-direction.test.ts` forbids: a webview VALUE
  // import drags everything the module transitively imports into the untrusted
  // bundle, so values come from contracts or not at all. T034 moved them there,
  // and `SETTINGS_SCHEMA` now reads the same two constants.
  import {
    PROCESS_ENVIRONMENT_MODES,
    PROCESS_ENV_NAME_PATTERN_SOURCE
  } from '../../../../../src/contracts/process-environment-policy';

  // FR-R3-144 (T029, T037) — Claude's own setting, sited in Claude's section
  // rather than in a general "UI and trust" list where its name was the only clue
  // that it applies to one backend out of three. Being IN the Claude section is
  // the label FR-009 asks for; the sentence under it is the doc's own.
  const AUTO_COMPACT_FIELD: FieldSpec = {
    key: 'claudeAutoCompactPctOverride',
    ipcKey: 'claude.autoCompactPctOverride',
    label: 'Claude auto-compaction threshold (%)',
    kind: 'number-optional',
    min: 1,
    max: 100,
    placeholder: 'Unset — use CLI default',
    note: 'Honoured by Claude only. Codex and Agy have no equivalent and ignore it.'
  };

  // FR-R3-144 (T025, D-5, FR-001) — every backend's section, keyed BY BACKEND.
  //
  // This replaces `BACKEND_FIELDS`, an array whose entries `BackendHealthSection`
  // paired with its own `RUNNERS` array by index. That worked only because two
  // files happened to list three backends in the same order, and nothing checked:
  // inserting a spec at the front would have drawn Claude's path field under
  // Codex's Ping button with every test still passing.
  //
  // A `Record` and not a `Map` — the shape host code uses for the same association
  // — because a fourth member of `BackendRunnerKind` must be a COMPILE error here.
  // A `Map` or an array would compile and render three backends out of four. That
  // property is asserted directly in `backend-record-exhaustiveness.test.ts`.
  export const BACKENDS: Readonly<Record<BackendRunnerKind, BackendSection>> = {
    claude: {
      label: 'Claude',
      path: { key: 'cliPath', ipcKey: 'cli.path', label: 'Claude CLI Path', kind: 'string' },
      specific: [AUTO_COMPACT_FIELD]
    },
    codex: {
      label: 'Codex',
      path: { key: 'codexPath', ipcKey: 'codex.path', label: 'Codex CLI Path', kind: 'string' },
      specific: []
    },
    agy: {
      label: 'Agy',
      path: { key: 'agyPath', ipcKey: 'agy.path', label: 'Agy CLI Path', kind: 'string' },
      specific: []
    }
  };

  // FR-R3-144 (T031, C7-2) — the setting the whole item turns on. The product has
  // supported three backends since FR-R3-089 and the tab had no control for
  // choosing one, so `schegent.backend.runner` was reachable only by hand-editing
  // settings JSON. Options come from the platform's enumeration, so a backend
  // added there is selectable without an edit here.
  export const RUNNER_FIELD: FieldSpec = {
    key: 'backendRunner',
    ipcKey: 'backend.runner',
    label: 'Backend',
    kind: 'enum',
    options: SUPPORTED_BACKENDS,
    note: 'Applies to every workspace on this machine. Takes effect on the next invocation.'
  };

  // FR-R3-144 (T036, FR-009) — one bound per denomination, and the group renders
  // the one that matches the selected backend. Both are declared here because both
  // are real settings the manifest carries; only one is ever offered at a time,
  // because offering a dollar bound for a backend that reports no cost is how an
  // operator comes to believe they have bounded a run they have not bounded.
  export const SPEND_FIELDS: Readonly<Record<SpendDenomination, FieldSpec>> = {
    usd: {
      key: 'spendMaxUsdPerRun',
      ipcKey: 'spend.maxUsdPerRun',
      label: 'Per-run spend bound (USD)',
      kind: 'number-optional',
      min: 0.01,
      placeholder: 'Unset — no bound',
      note: 'Crossing it pauses the run, resumable by you. It never fails or cancels a run.'
    },
    tokens: {
      key: 'spendMaxTokensPerRun',
      ipcKey: 'spend.maxTokensPerRun',
      label: 'Per-run spend bound (tokens)',
      kind: 'number-optional',
      min: 1,
      placeholder: 'Unset — no bound',
      note: 'Crossing it pauses the run, resumable by you. It never fails or cancels a run.'
    }
  };

  // FR-R3-143 (T031) — the process-environment and probe settings, listed rather
  // than folded into the per-backend sections above. They stayed separate
  // originally because `BACKEND_FIELDS[i]` was paired with `RUNNERS[i]`
  // positionally, so a fourth entry there was a CLI path the section never drew.
  // FR-R3-144 (T025) removed that coupling, and they stay separate for the reason
  // that outlives it: the environment policy is not per-backend data — it applies
  // to whichever backend runs.
  //
  // The three environment settings and the probe timeout differ in when they take
  // effect, and each `note` says which — see the descriptions module for where
  // that was read from. All four are `application`-scoped, so the host writes them
  // to User settings for every workspace on this machine.
  const ENVIRONMENT_FIELDS: readonly FieldSpec[] = [
    {
      key: 'cliEnvironmentMode',
      ipcKey: 'cli.environmentMode',
      label: 'Environment Mode',
      kind: 'enum',
      options: PROCESS_ENVIRONMENT_MODES,
      note: 'Applies to every workspace on this machine. Takes effect after reloading the VS Code Extension Host.'
    },
    {
      key: 'cliEnvironmentAllowlist',
      ipcKey: 'cli.environmentAllowlist',
      label: 'Environment Allowlist',
      kind: 'string-list',
      itemPattern: PROCESS_ENV_NAME_PATTERN_SOURCE,
      invalidMessage:
        'Not a legal environment variable name — use letters, digits and underscores, and do not start with a digit.',
      note: 'Names only; values are read at spawn time and never stored here. Applies to every workspace on this machine. Takes effect after reloading the VS Code Extension Host.'
    },
    {
      key: 'cliInheritEnvironment',
      ipcKey: 'cli.inheritEnvironment',
      label: 'Inherit Host Environment (legacy)',
      kind: 'boolean',
      note: 'Superseded by Environment Mode; Off forces minimal. Applies to every workspace on this machine. Takes effect after reloading the VS Code Extension Host.'
    },
    {
      key: 'backendProbeTimeoutSeconds',
      ipcKey: 'backend.probeTimeoutSeconds',
      label: 'Backend Probe Timeout (seconds)',
      kind: 'number',
      min: 1,
      max: 30,
      note: 'Applies to every workspace on this machine. Read at the start of each probe — the next Ping uses it, no reload.'
    }
  ] as const;

  /**
   * Every spec this group renders, flattened — the tab's `FIELDS` folds it in.
   *
   * FR-R3-144 (T025) — the per-backend specs are flattened OUT OF `BACKENDS`
   * rather than listed a second time. `FIELDS` is what Save All iterates and what
   * `dirty` is computed from, so a spec that reached the screen but not that array
   * would be a control whose edit Save All silently dropped. Deriving this from
   * the same record the sections render means a backend added to
   * `SUPPORTED_BACKENDS` becomes savable at the same moment it becomes visible.
   */
  export const BACKEND_GROUP_FIELDS: readonly FieldSpec[] = [
    RUNNER_FIELD,
    SPEND_FIELDS.usd,
    SPEND_FIELDS.tokens,
    ...SUPPORTED_BACKENDS.flatMap((kind) => [BACKENDS[kind].path, ...BACKENDS[kind].specific]),
    ...ENVIRONMENT_FIELDS
  ];
</script>

<script lang="ts">
  import type { WorkflowSnapshot } from '../../../lib/snapshot-types';
  import BackendHealthSection from '../BackendHealthSection.svelte';
  import GeneralSettingFieldRow from './GeneralSettingFieldRow.svelte';
  import type { SettingsGroupProps } from './field-types';
  // FR-R3-143 (T035) — the SAME function the spawn calls. See T034's header in
  // that module for why it is reachable from here at all.
  import { resolveProcessEnvironmentPolicy } from '../../../../../src/contracts/process-environment-policy';
  // FR-R3-144 (T036) — and the same rule again for the spend denomination: which
  // bound is in force for a backend is one fact, stated in `src/contracts/` and
  // read by both the settings tab and the autonomy-bounds document.
  import { spendDenominationOf } from '../../../../../src/contracts/backend-spend-denomination';

  // FR-R3-144 (T025) — `fields` is GONE, and its absence is the point. It was
  // this group's slice of `BACKEND_FIELDS`, handed to `BackendHealthSection`,
  // which paired it with its own `RUNNERS` array by index. `BACKENDS` above is
  // keyed by backend instead, so no ordering agreement is required between two
  // files.
  //
  // FR-R3-144 (T038) — and no spec props either: the four that stood here
  // (`backends`, `runnerField`, `spendFields`, `environmentFields`) were the tab
  // handing this group back the data it declares itself. What remains is what a
  // group genuinely cannot know — the draft, the per-key save status, and the
  // callbacks that write.
  interface Props extends Omit<SettingsGroupProps, 'fields'> {
    snapshot: WorkflowSnapshot;
  }

  let {
    snapshot,
    draft = $bindable(),
    statusByKey,
    pipelines,
    fieldChanged,
    fieldScopeLabel,
    saveOne,
    resetField
  }: Props = $props();

  // FR-R3-144 (T036, FR-009) — which bound the operator is being offered follows
  // the SELECTED backend, and only one is offered at a time.
  //
  // Both controls at once is what the tab would do if this were a flat field list,
  // and it is worse than it sounds: `schegent.spend.maxUsdPerRun` applies to
  // backends that report a cost, so an operator who set a dollar bound and then
  // ran `codex` would have set nothing at all and would believe they had bounded
  // the run. The denomination is read from the contract rather than decided here,
  // for the reason the import above gives.
  const denomination = $derived<SpendDenomination>(spendDenominationOf(draft.backendRunner));
  const spendField = $derived<FieldSpec>(SPEND_FIELDS[denomination]);
  const denominationText = $derived(
    `${BACKENDS[draft.backendRunner].label} reports ` +
      (denomination === 'usd'
        ? 'a cost, so its per-run spend bound is set in US dollars.'
        : 'tokens and no cost, so its per-run spend bound is set in tokens.')
  );

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
  <!--
    FR-R3-144 (T031, T036) — the two settings that are ABOUT the choice of
    backend, above the per-backend sections because they govern which of those
    sections is the one that will run. The selector writes `backend.runner`
    through the ordinary draft path — no bespoke handler, no second write route —
    so Save All, the dirty marker and the scope label work on it exactly as they
    do on every other field.
  -->
  <div class="selection" data-testid="backend-selection">
    <GeneralSettingFieldRow
      spec={RUNNER_FIELD}
      bind:draft
      status={statusByKey[RUNNER_FIELD.key]}
      changed={fieldChanged(RUNNER_FIELD.key)}
      scopeLabel={fieldScopeLabel(RUNNER_FIELD.key)}
      {pipelines}
      onSave={() => saveOne(RUNNER_FIELD)}
      onReset={() => resetField(RUNNER_FIELD.key)}
    />
    <GeneralSettingFieldRow
      spec={spendField}
      bind:draft
      status={statusByKey[spendField.key]}
      changed={fieldChanged(spendField.key)}
      scopeLabel={fieldScopeLabel(spendField.key)}
      {pipelines}
      onSave={() => saveOne(spendField)}
      onReset={() => resetField(spendField.key)}
    />
    <!--
      Static text, like the effective-policy line below and for the same reasons:
      no `controlId`, not focusable, a summary of the two controls above rather
      than a third one. `aria-live` because changing the selector rewrites this
      sentence AND swaps the control above it without moving focus.
    -->
    <p class="denomination" data-testid="spend-denomination" aria-live="polite">
      {denominationText}
    </p>
  </div>
  <BackendHealthSection
    {snapshot}
    backends={BACKENDS}
    bind:draft
    {statusByKey}
    {fieldChanged}
    {fieldScopeLabel}
    {pipelines}
    {saveOne}
    {resetField}
  />
  <div class="field-list">
    {#each ENVIRONMENT_FIELDS as spec (spec.key)}
      <GeneralSettingFieldRow
        {spec}
        bind:draft
        status={statusByKey[spec.key]}
        changed={fieldChanged(spec.key)}
        scopeLabel={fieldScopeLabel(spec.key)}
        {pipelines}
        onSave={() => saveOne(spec)}
        onReset={() => resetField(spec.key)}
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
  .selection {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .denomination {
    margin: 0;
    padding: 4px 10px 8px;
    font-size: 0.85em;
    line-height: 1.5;
    color: var(--schegent-muted-fg);
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
