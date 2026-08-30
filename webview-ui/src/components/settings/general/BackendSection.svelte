<script lang="ts">
  // FR-R3-144 (T028, FR-005) — one backend's whole presence on the settings tab:
  // what it is, whether it was found, whether it is the one that will run, what
  // bound it executes under, and the settings only it honours.
  //
  // WHY A COMPONENT PER BACKEND RATHER THAN A LOOP BODY. The tab used to draw a
  // shared row per runner from `BACKEND_FIELDS[i]`, paired with `RUNNERS[i]` by
  // POSITION — correct only because two arrays happened to be written in the same
  // order, with nothing checking. Everything here is addressed by `kind`, and the
  // one thing that is per-backend data (`section`) arrives as one object, so a
  // backend cannot be drawn with another backend's path field.
  //
  // WHAT THIS COMPONENT DOES NOT DECIDE. It renders `posture` and never computes
  // it. Containment, mechanism, grant state and the refusal sentence are the
  // host's, derived once by `src/ui/sidebar/backend-posture-projection.ts` from the
  // same policy module that refuses the spawn — which is why the screen cannot
  // promise a run the runner will refuse.
  // `tests/lint/webview-posture-derivation.test.ts` (T024) enforces exactly that:
  // producing a containment mechanism or a grant state as a literal here fails.
  import { pingBackend } from '../../../lib/backend-ping-ipc';
  import { setUncontainedBackendGrant } from '../../../lib/uncontained-grant-ipc';
  import { useConfirm } from '../../../lib/use-confirm';
  import type {
    BackendPingState,
    BackendPosture,
    BackendRunnerKind,
    PipelineDefinition
  } from '../../../lib/snapshot-types';
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
  import GeneralSettingFieldRow from './GeneralSettingFieldRow.svelte';
  import type {
    BackendSection as BackendSectionSpec,
    Draft,
    FieldSpec,
    ScalarKey,
    StatusByKey
  } from './field-types';

  interface Props {
    kind: BackendRunnerKind;
    section: BackendSectionSpec;
    /**
     * This backend's row from `snapshot.backendPostures`.
     *
     * Optional because the projection is optional on the snapshot: a webview
     * bundle newer than the host it is loaded into receives no postures at all.
     * The posture block is omitted in that case rather than filled with guesses —
     * a surface that invented a containment answer for an unknown host would be
     * the exact defect this section exists to remove.
     */
    posture: BackendPosture | undefined;
    discovered: boolean;
    /** Whether `backend.runner` currently names this backend (T032). */
    inUse: boolean;
    ping: BackendPingState;
    /** A probe is in flight somewhere on the tab; every Ping button is disabled. */
    busy: boolean;
    draft: Draft;
    statusByKey: StatusByKey;
    pipelines: readonly PipelineDefinition[];
    fieldChanged: (key: ScalarKey) => boolean;
    fieldScopeLabel: (key: ScalarKey) => string;
    saveOne: (spec: FieldSpec) => void;
    resetField: (key: ScalarKey) => void;
  }

  let {
    kind,
    section,
    posture,
    discovered,
    inUse,
    ping,
    busy,
    draft = $bindable(),
    statusByKey,
    pipelines,
    fieldChanged,
    fieldScopeLabel,
    saveOne,
    resetField
  }: Props = $props();

  const probing = $derived(ping.status === 'running' && ping.runner === kind);

  /** The last probe's result, in words, or `''` when this backend has no result. */
  const pingText = $derived.by(() => {
    if (ping.status === 'idle' || ping.runner !== kind) return '';
    if (ping.status === 'running') return `Checking ${section.label}…`;
    if (ping.status === 'success') return `Healthy · ${ping.latencyMs} ms`;
    const exit = ping.exitCode === undefined ? '' : ` · exit ${ping.exitCode}`;
    return `Unavailable · ${ping.cause}${exit}`;
  });

  // Rendered from the PROJECTED discriminant, never from a literal compared
  // against one. `grant` has three states, and the third state — the one meaning
  // no grant is required — is why this exists: there is nothing to grant, so the
  // control is absent rather than disabled. A disabled checkbox invites an
  // operator to go looking for the permission that would enable it, and there is
  // none.
  //
  // The state is described rather than quoted here on purpose.
  // `tests/lint/webview-posture-derivation.test.ts` (T024) forbids a grant state
  // in producing position — after `=`, `return`, `?` or `:` — and it reads the
  // file as text, so a colon before a quoted state in a COMMENT trips it exactly
  // as an object literal would. The comparison below is the allowed form; the
  // prose does not need to repeat it.
  const grantable = $derived(posture !== undefined && posture.grant !== 'not-required');
  const granted = $derived(posture?.grant === 'granted');

  async function onGrantToggle(ev: MouseEvent): Promise<void> {
    if (posture === undefined) return;
    if (granted) {
      // C7-3 — revoke is immediate and unconfirmed. A prompt before NARROWING a
      // permission trains operators to click through the prompt that matters.
      setUncontainedBackendGrant(kind, false);
      return;
    }
    const confirmed = await useConfirm('backend.grant-uncontained', {
      originatingElement: ev.currentTarget as HTMLElement,
      context: {
        label: section.label,
        // The projection carries a refusal on exactly the rows whose grant is
        // `not-granted`, which is the only branch that reaches here; the fallback
        // satisfies the compiler and would show an empty body rather than a
        // fabricated one if that ever stopped being true.
        refusal: posture.refusal ?? ''
      }
    });
    if (!confirmed) return;
    setUncontainedBackendGrant(kind, true);
  }
</script>

<section class="backend-section" data-testid={`backend-health-${kind}`}>
  <div class="identity">
    <strong>{section.label}</strong>
    {#if inUse}
      <!--
        T032 — derived from the selected runner and from nothing else. There is no
        second store of "which backend is active": the marker moves when the
        selector above writes the draft, and it is the draft rather than the saved
        projection so an operator sees what their unsaved edit will do.
      -->
      <span class="in-use" data-testid={`backend-in-use-${kind}`}>In use</span>
    {/if}
    <span class:available={discovered} data-testid={`backend-discovery-${kind}`}>
      {discovered ? 'Discovered' : 'Not found'}
    </span>
    {#if pingText}
      <small role="status" aria-live="polite">{pingText}</small>
    {/if}
  </div>

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

  <GeneralSettingFieldRow
    spec={section.path}
    bind:draft
    status={statusByKey[section.path.key]}
    changed={fieldChanged(section.path.key)}
    scopeLabel={fieldScopeLabel(section.path.key)}
    {pipelines}
    onSave={() => saveOne(section.path)}
    onReset={() => resetField(section.path.key)}
  >
    {#snippet actionsAppend()}
      <button
        type="button"
        class="ping-btn"
        disabled={busy}
        aria-label={`Ping ${section.label} backend`}
        data-testid={`ping-backend-${kind}`}
        onclick={() => pingBackend(kind)}
        use:hoverTextAnchor={{
          controlId: 'backend-ping',
          description: GENERAL_SETTINGS_DESCRIPTIONS['backend-ping']
        }}
      >{probing ? 'Pinging…' : 'Ping'}</button>
    {/snippet}
  </GeneralSettingFieldRow>

  {#if posture !== undefined}
    <!--
      T035 — the posture is on screen BEFORE a run, not in the failure that
      follows one. Both values are projected discriminants rendered as they
      arrived; the mechanism is shown beside the containment because "contained"
      alone cannot tell an operator why one backend differs from another.
    -->
    <p class="posture" data-testid={`backend-posture-${kind}`}>
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

    {#if grantable}
      <div class="grant">
        <button
          type="button"
          class="grant-btn"
          class:granted
          data-testid={`backend-grant-${kind}`}
          onclick={onGrantToggle}
          use:hoverTextAnchor={{
            controlId: `backend-grant-${kind}`,
            description: GENERAL_SETTINGS_DESCRIPTIONS['backend-grant']
          }}
        >{granted ? 'Revoke uncontained permission' : 'Allow uncontained'}</button>
        {#if posture.refusal !== undefined}
          <!--
            T034, T035 — the enforcement's own sentence, carried by the projection
            and rendered verbatim. It names both routes out (grant this backend,
            or choose one that carries a sandbox), which is why it is shown whole
            rather than summarised. After a revoke it reappears, because the
            projection recomputes it — the section does not remember a refusal, it
            shows the one that is currently true.
          -->
          <p class="refusal" data-testid={`backend-refusal-${kind}`}>{posture.refusal}</p>
        {/if}
      </div>
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
          {pipelines}
          onSave={() => saveOne(spec)}
          onReset={() => resetField(spec.key)}
        />
      {/each}
    </div>
  {:else}
    <!--
      T030 — a sentence, not a blank region. An empty area under a heading reads
      as a surface that failed to load, and an operator who concludes that goes
      looking for the Codex equivalent of the Claude control they can see two
      sections up. Saying there is none is the answer to that question.
    -->
    <p class="no-specific" data-testid={`backend-no-specific-settings-${kind}`}>
      {section.label} has no backend-specific settings.
    </p>
  {/if}
</section>

<style>
  .backend-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 8px;
  }
  .identity {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 10px;
    padding-top: 10px;
  }
  .identity span {
    color: var(--vscode-notificationsWarningIcon-foreground);
    font-size: 0.8em;
  }
  .identity span.available {
    color: var(--vscode-testing-iconPassed);
  }
  .identity span.in-use {
    color: var(--schegent-button-fg);
    background: var(--schegent-button-bg);
    border-radius: var(--schegent-radius);
    padding: 1px 6px;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  small {
    flex-basis: 100%;
    color: var(--schegent-muted-fg);
  }
  .posture {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    margin: 2px 0 0;
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
  }
  .posture-label {
    font-weight: 600;
  }
  .posture code {
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .grant {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
  }
  .grant-btn {
    align-self: flex-start;
    padding: 4px 12px;
    border: 0;
    border-radius: var(--schegent-radius);
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    cursor: pointer;
  }
  .grant-btn:hover {
    background: var(--schegent-button-hover);
  }
  .grant-btn.granted {
    background: transparent;
    border: 1px solid var(--schegent-divider);
    color: var(--vscode-foreground);
  }
  .refusal,
  .grant-problem,
  .not-found {
    margin: 0;
    font-size: 0.8em;
    line-height: 1.5;
    color: var(--vscode-notificationsWarningIcon-foreground);
  }
  .specific {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .no-specific {
    margin: 4px 0 0;
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
  }
  .ping-btn {
    padding: 4px 12px;
    border: 0;
    border-radius: var(--schegent-radius);
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    cursor: pointer;
  }
  .ping-btn:hover:not(:disabled) {
    background: var(--schegent-button-hover);
  }
  .ping-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
