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
  //
  // HOW THE REDESIGN DRAWS IT. The card is the mockup's summary: the backend's id,
  // its tags, the last check, the path it starts from and one phrase about its
  // sandbox, with "Test" (or "Set path…" for a backend that was not found) and an
  // actions menu at the right. The mockup draws a "Details" link and leaves what
  // it opens undrawn. Here it opens a region under the summary that holds what
  // the summary has no room for: the path field, the projected values, the host's
  // sentences and the backend's own settings. `BackendDetails.svelte` draws what
  // the region holds; this file decides when it shows.
  import { tick, untrack } from 'svelte';
  import type { Action } from 'svelte/action';
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
  import SgMenu from '../../sg/SgMenu.svelte';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
  import { settingsSearch } from '../settings-search.svelte';
  import BackendDetails from './BackendDetails.svelte';
  import type {
    BackendSection as BackendSectionSpec,
    Draft,
    FieldStatus,
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
     * The posture is omitted in that case rather than filled with guesses — a
     * surface that invented a containment answer for an unknown host would be the
     * exact defect this section exists to remove.
     */
    posture: BackendPosture | undefined;
    /**
     * The backend's path as saved: the one the host's scan found or did not find, and the one
     * the last test started. The summary shows it; an edit shows in the path field until a save.
     */
    savedPath: string;
    discovered: boolean;
    /** Whether `backend.runner` currently names this backend (T032). */
    inUse: boolean;
    ping: BackendPingState;
    /** A probe is in flight somewhere on the tab; no card starts another. */
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
    savedPath,
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

  // The grant's two names in the actions menu. They are written in this file, and nowhere
  // else, because `tests/lint/no-running-state-literal.test.ts` lists it.
  const GRANT_LABEL = 'Allow running unsandboxed…';
  const REVOKE_LABEL = 'Revoke permission to run unsandboxed';
  /** The mockup's line for a backend that has no path to show. */
  const NO_PATH = 'Set a path to use this backend';

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

  // The path line is the saved path, the one "Found" or "Not found" and the last test speak of,
  // so the summary never pairs a path with what was found at another. An edit shows in the path
  // field and in the page's unsaved count until a save, after which the host scans the new path.
  // "In use" follows the draft instead (T032), as it names the backend a save will run. The host
  // projects no resolved location, so the line is the configured command or path.
  const pathText = $derived.by(() => {
    const path = savedPath.trim();
    return discovered && path !== '' ? path : NO_PATH;
  });

  // Rendered from the PROJECTED discriminant, never from a literal compared
  // against one. `grant` has three states, and the third state — the one meaning
  // no grant is required — is why this exists: there is nothing to grant, so the
  // control is absent rather than disabled. A disabled item invites an operator to
  // go looking for the permission that would enable it, and there is none.
  //
  // The state is described rather than quoted here on purpose.
  // `tests/lint/webview-posture-derivation.test.ts` (T024) forbids a grant state
  // in producing position — after `=`, `return`, `?` or `:` — and it reads the
  // file as text, so a colon before a quoted state in a COMMENT trips it exactly
  // as an object literal would. The comparisons below are the allowed form; the
  // prose does not need to repeat them.
  const grantable = $derived(posture !== undefined && posture.grant !== 'not-required');
  const granted = $derived(posture?.grant === 'granted');
  const refused = $derived(posture?.grant === 'not-granted');

  // The summary's phrase about the sandbox, in plain words. It is chosen by comparing the
  // projected grant and by whether the host sent a notice, never by reading a containment
  // value: the projection sends a notice exactly for a backend that runs with no bound and
  // whose grant is in force. A backend whose grant is listed but which keeps its own sandbox
  // gets no notice, so it still reads "Sandboxed". The projected values are in Details.
  const sandboxText = $derived.by(() => {
    if (posture === undefined) return '';
    if (refused) return 'Not allowed to run unsandboxed';
    return posture.notice === undefined ? 'Sandboxed' : 'Allowed to run unsandboxed';
  });

  function failed(status: FieldStatus | undefined): boolean {
    return status?.status === 'rejected' || status?.status === 'unknown';
  }

  // WHEN DETAILS ARE OPEN. Until the user chooses, the region is open exactly while something
  // in it needs them: the backend in use cannot run (FR-008 wants the reason on screen), the
  // host reports a problem with a grant entry, a save of one of its fields failed, one of its
  // fields holds an unsaved edit, or the page's search has found a setting inside it.
  const fieldKeys = $derived([section.path.key, ...section.specific.map((spec) => spec.key)]);
  const blocked = $derived(inUse && (refused || !discovered));
  const flagged = $derived(posture?.problem !== undefined);
  const saveFailed = $derived(fieldKeys.some((key) => failed(statusByKey[key])));
  const unsaved = $derived(fieldKeys.some((key) => fieldChanged(key)));

  /** The card. The page's search finds every setting inside it by the backend's name. */
  let card = $state<HTMLElement>();
  const { group: searchGroup, holdsMatch, reveal } = settingsSearch();
  const searchHit = $derived(holdsMatch(card));
  const needsAttention = $derived(blocked || flagged || saveFailed || unsaved || searchHit);

  /** The user's choice, made with the link or a path action; `undefined` until they make one. */
  let asked = $state<boolean | undefined>(undefined);
  const detailsOpen = $derived(asked ?? needsAttention);

  // A choice to close lasts only until something new needs the user. C7-3: after a revoke of
  // the backend in use, the refusal is what the eye lands on, also where the user had closed
  // the region before. A search that finds a setting in here lifts the choice the same way: the
  // user asked to see that setting. A choice to open is kept, so the region never closes under
  // the user. An unsaved edit is the user's own doing and reopens nothing.
  const alerts = $derived([blocked, flagged, saveFailed, searchHit]);
  let seenAlerts: readonly boolean[] | undefined;
  $effect(() => {
    const before = seenAlerts;
    seenAlerts = alerts;
    const raised = before !== undefined && alerts.some((on, index) => on && !before[index]);
    if (raised && untrack(() => asked) === false) asked = undefined;
  });

  function onTest(): void {
    // A menu item cannot take `disabled`, so the flight is checked here too.
    if (busy) return;
    pingBackend(kind);
  }

  /** The element round the path field. The Details component binds it. */
  let pathRow = $state<HTMLDivElement | undefined>(undefined);

  /**
   * Opens Details and puts the caret in the path field, once the region is on screen. A search
   * that has the field out of sight ends first: the user asked for the field.
   */
  async function editPath(): Promise<void> {
    reveal(pathRow);
    asked = true;
    await tick();
    pathRow?.querySelector('input')?.focus();
  }

  // A description opens the moment its control takes focus (spec 018), and a menu focuses its
  // first item when it opens. Focus therefore follows a moving pointer through this menu, so
  // the description on screen is the one for the item under the pointer.
  function focusItem(ev: PointerEvent): void {
    const item = ev.currentTarget as HTMLElement;
    if (document.activeElement !== item) item.focus();
  }

  /** The menu button's description. The menu applies it to the button it draws. */
  const describeActions: Action<HTMLButtonElement> = (node) => {
    const anchored = hoverTextAnchor(node, {
      controlId: `backend-actions-${kind}`,
      description: GENERAL_SETTINGS_DESCRIPTIONS['backend-actions'],
      preferredPlacement: 'top'
    });
    return { destroy: () => anchored.destroy() };
  };

  async function onGrantToggle(ev: MouseEvent): Promise<void> {
    if (posture === undefined) return;
    if (granted) {
      // C7-3 — revoke is immediate and unconfirmed. A prompt before NARROWING a
      // permission trains operators to click through the prompt that matters.
      setUncontainedBackendGrant(kind, false);
      return;
    }
    const confirmed = await useConfirm('backend.grant-uncontained', {
      // The menu item. The dialog returns focus to the menu's button when it closes.
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

<section
  class="card backend backend-section"
  data-testid={`backend-health-${kind}`}
  bind:this={card}
  use:searchGroup={() => [section.label]}
>
  <span class="kicon k-phase"><svg class="i" aria-hidden="true"><use href="#i-pulse"></use></svg></span>
  <div class="identity">
    <div class="titlerow">
      <b>{kind}</b>
      {#if inUse}
        <!--
          T032 — derived from the selected runner and from nothing else. It follows the draft,
          not the saved projection, so an operator sees what their unsaved edit will do.
        -->
        <span class="tag" data-testid={`backend-in-use-${kind}`}>In use</span>
      {/if}
      {#if !inUse || !discovered}
        <!-- One tag, as the mockup draws, except for the backend in use that was not found:
             FR-012 has a backend in two states say both. -->
        <span class="tag" data-testid={`backend-discovery-${kind}`}
          >{discovered ? 'Found' : 'Not found'}</span
        >
      {/if}
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
      {:else if !discovered}
        <!-- A standing fact, not a result, so it is not a live region. A test's result takes
             its place, and a card never shows two verdicts. -->
        <small class="chip s-err" data-testid={`backend-not-installed-${kind}`}
          ><svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>Not installed</small
        >
      {/if}
    </div>
    <div class="sub mono" data-testid={`backend-path-${kind}`}>{pathText}</div>
    <div class="sub">
      {#if posture !== undefined}
        <!-- The space after the dot is the one between this block and the link. -->
        <span class:refused data-testid={`backend-sandbox-${kind}`}>{sandboxText}</span> ·
      {/if}
      <button
        type="button"
        class="linkbtn"
        aria-expanded={detailsOpen}
        aria-controls={`backend-details-${kind}`}
        aria-label={`Details for ${kind}`}
        data-testid={`backend-details-toggle-${kind}`}
        onclick={() => (asked = !detailsOpen)}
        use:hoverTextAnchor={{
          controlId: `backend-details-${kind}`,
          description: GENERAL_SETTINGS_DESCRIPTIONS['backend-details'],
          preferredPlacement: 'top'
        }}
      >Details</button>
    </div>
  </div>
  <div class="card-actions">
    {#if discovered}
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        disabled={busy}
        aria-label={probing ? `Testing ${kind}…` : `Test ${kind}`}
        data-testid={`ping-backend-${kind}`}
        onclick={onTest}
        use:hoverTextAnchor={{
          controlId: `backend-ping-${kind}`,
          description: GENERAL_SETTINGS_DESCRIPTIONS['backend-ping']
        }}
      >{probing ? 'Testing…' : 'Test'}</button>
    {:else}
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        aria-label={`Set path for ${kind}…`}
        data-testid={`backend-set-path-${kind}`}
        onclick={editPath}
        use:hoverTextAnchor={{
          controlId: `backend-set-path-${kind}`,
          description: GENERAL_SETTINGS_DESCRIPTIONS['backend-set-path']
        }}
      >Set path…</button>
    {/if}
    <!-- Each item's description opens to the left of the menu, or above or below the whole menu
         where a narrow panel leaves no room beside it, clear of the other items. -->
    <SgMenu
      label={`Actions for ${kind}`}
      testid={`backend-actions-${kind}`}
      triggerAction={describeActions}
    >
      {#if !discovered}
        <!-- The check stays within reach for a backend that was not found: it tests the path
             as configured, which is how a user learns why the backend is missing. -->
        <button
          type="button"
          role="menuitem"
          aria-disabled={busy}
          data-testid={`ping-backend-${kind}`}
          onclick={onTest}
          onpointermove={focusItem}
          use:hoverTextAnchor={{
            controlId: `backend-ping-${kind}`,
            description: GENERAL_SETTINGS_DESCRIPTIONS['backend-ping'],
            anchor: 'left',
            preferredPlacement: 'left'
          }}
        >{probing ? 'Testing…' : 'Test'}</button>
      {/if}
      <button
        type="button"
        role="menuitem"
        data-testid={`backend-change-path-${kind}`}
        onclick={editPath}
        onpointermove={focusItem}
        use:hoverTextAnchor={{
          controlId: `backend-change-path-${kind}`,
          description: GENERAL_SETTINGS_DESCRIPTIONS['backend-change-path'],
          anchor: 'left',
          preferredPlacement: 'left'
        }}
      >Change path…</button>
      {#if grantable}
        <!-- Allowing is the redesign's danger item; revoking narrows a permission, so it is an
             ordinary one. -->
        <button
          type="button"
          role="menuitem"
          class:danger={!granted}
          data-testid={`backend-grant-${kind}`}
          onclick={onGrantToggle}
          onpointermove={focusItem}
          use:hoverTextAnchor={{
            controlId: `backend-grant-${kind}`,
            description: GENERAL_SETTINGS_DESCRIPTIONS['backend-grant'],
            anchor: 'left',
            preferredPlacement: 'left'
          }}
        >{granted ? REVOKE_LABEL : GRANT_LABEL}</button>
      {/if}
    </SgMenu>
  </div>

  <!-- Kept in the document while closed, so a field in it keeps its draft and its description. -->
  <div
    class="detail"
    id={`backend-details-${kind}`}
    data-testid={`backend-details-${kind}`}
    hidden={!detailsOpen}
  >
    <BackendDetails
      {kind}
      {section}
      {posture}
      {discovered}
      grantAction={grantable && !granted ? GRANT_LABEL : undefined}
      bind:pathRow
      bind:draft
      {statusByKey}
      {workflows}
      {fieldChanged}
      {fieldScopeLabel}
    />
  </div>
</section>

<style>
  /* The card is the redesign grid (`.sg .backend`): icon, summary, actions. The Details region
     takes a row of its own and spans the last two columns, so it lines up under the name. */
  .identity,
  .detail {
    min-width: 0;
  }
  .card-actions {
    display: flex;
    align-items: center;
    gap: var(--schegent-space-1-5);
  }
  .refused {
    color: var(--schegent-status-warning-text);
  }
  .detail {
    grid-column: 2 / -1;
    margin-top: var(--schegent-space-2);
    border-top: 1px solid var(--schegent-border);
  }
  /* Narrow: the actions drop under the name rather than squeezing it. */
  @media (max-width: 560px) {
    .card-actions {
      grid-column: 2;
    }
  }
</style>
