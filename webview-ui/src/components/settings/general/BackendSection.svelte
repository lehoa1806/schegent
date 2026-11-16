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
    PortableWorkflowDefinition
  } from '../../../lib/snapshot-types';
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
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
    workflows: readonly PortableWorkflowDefinition[];
    fieldChanged: (key: ScalarKey) => boolean;
    fieldScopeLabel: (key: ScalarKey) => string;
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
    workflows,
    fieldChanged,
    fieldScopeLabel
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
  // The result chip's tone, read from the same state as its words: checking, healthy or not.
  const pingHealthy = $derived(ping.status === 'success');

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

<!--
  The redesign's backend card: the pulse icon; the name with its tags, the last check's result as
  a status chip and the containment line under them; the check on the right. The problems, the
  path and the backend's own settings follow, lined up under the name.
-->
<section class="card backend backend-section" data-testid={`backend-health-${kind}`}>
  <span class="kicon k-phase"><svg class="i" aria-hidden="true"><use href="#i-pulse"></use></svg></span>
  <div class="identity">
    <div class="titlerow">
      <strong>{section.label}</strong>
      {#if inUse}
        <!--
          T032 — derived from the selected runner and from nothing else. There is no
          second store of "which backend is active": the marker moves when the
          selector above writes the draft, and it is the draft rather than the saved
          projection so an operator sees what their unsaved edit will do.
        -->
        <span class="tag" data-testid={`backend-in-use-${kind}`}>In use</span>
      {/if}
      <span class="tag" data-testid={`backend-discovery-${kind}`}>
        {discovered ? 'Discovered' : 'Not found'}
      </span>
      {#if pingText}
        <!-- The words follow the mark with no space between, so the region reads as the result
             alone; the chip's gap spaces them on screen. -->
        <small
          class="chip"
          class:s-run={probing}
          class:s-ok={pingHealthy}
          class:s-err={!probing && !pingHealthy}
          role="status"
          aria-live="polite"
        >
          {#if probing}
            <span class="dot"></span>
          {:else if pingHealthy}
            <svg class="i" aria-hidden="true"><use href="#i-check"></use></svg>
          {:else}
            <svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>
          {/if}{pingText}
        </small>
      {/if}
    </div>
    {#if posture !== undefined}
      <!--
        T035 — the posture is on screen BEFORE a run, not in the failure that
        follows one. Both values are projected discriminants rendered as they
        arrived; the mechanism is shown beside the containment because "contained"
        alone cannot tell an operator why one backend differs from another.
      -->
      <p class="sub posture" data-testid={`backend-posture-${kind}`}>
        <span class="posture-label">Containment:</span>
        <code>{posture.containment}</code>
        <span class="posture-label">Mechanism:</span>
        <code data-testid={`backend-mechanism-${kind}`}>{posture.mechanism}</code>
      </p>
    {/if}
  </div>
  <div class="checks">
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      disabled={busy}
      aria-label={`Ping ${section.label} backend`}
      data-testid={`ping-backend-${kind}`}
      onclick={() => pingBackend(kind)}
      use:hoverTextAnchor={{
        controlId: 'backend-ping',
        description: GENERAL_SETTINGS_DESCRIPTIONS['backend-ping']
      }}
    >{probing ? 'Pinging…' : 'Ping'}</button>
  </div>

  <div class="detail">
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
      {workflows}
    />

    {#if posture !== undefined}
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
          <!--
            Allowing an uncontained backend is the redesign's danger action; revoking narrows a
            permission, so it is an ordinary secondary button.
          -->
          <button
            type="button"
            class="btn btn-sm grant-btn"
            class:btn-danger={!granted}
            class:btn-secondary={granted}
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
            {workflows}
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
      <p class="no-specific small muted" data-testid={`backend-no-specific-settings-${kind}`}>
        {section.label} has no backend-specific settings.
      </p>
    {/if}
  </div>
</section>

<style>
  /* The card is the redesign grid (`.sg .backend`): icon, identity, check. The lower part
     spans the last two columns, so it lines up under the name. */
  .identity,
  .detail {
    min-width: 0;
  }
  .detail {
    grid-column: 2 / -1;
  }
  .checks {
    display: flex;
    gap: var(--schegent-space-1-5);
  }
  .posture {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--schegent-space-1) var(--schegent-space-1-5);
    margin: var(--schegent-space-0-5) 0 0;
  }
  .posture-label {
    font-weight: 600;
  }
  .posture code {
    font-family: var(--schegent-mono-font);
  }
  .grant {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--schegent-space-1-5);
    margin-top: var(--schegent-space-2);
  }
  .refusal,
  .grant-problem,
  .not-found {
    margin: var(--schegent-space-2) 0 0;
    font-size: var(--schegent-text-secondary);
    line-height: 1.45;
    color: var(--schegent-status-warning-text);
  }
  .refusal {
    margin: 0;
  }
  .no-specific {
    margin: var(--schegent-space-2) 0 0;
  }
  /* Narrow: the check drops under the name rather than squeezing it. */
  @media (max-width: 560px) {
    .checks {
      grid-column: 2;
    }
  }
</style>
