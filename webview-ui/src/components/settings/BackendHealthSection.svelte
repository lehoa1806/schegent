<script lang="ts">
  // FR-R3-144 (T025, T026, T028) — the list of backend sections.
  //
  // WHAT CHANGED AND WHY. This component drew a row per runner from a local
  // `RUNNERS` array, paired against the tab's `BACKEND_FIELDS` by INDEX
  // (`{@const spec = BACKEND_FIELDS[i]}`). The pairing was correct only because
  // the two arrays were written in the same order and nothing compared them: a
  // spec inserted at the front would have drawn Claude's path under Codex's Ping
  // button with every test still green. It also carried five `any`-typed props,
  // so nothing about the shapes flowing through it was checked at all.
  //
  // Both are gone. The backends come from `SUPPORTED_BACKENDS` — the platform's
  // own enumeration, so a backend added there gets a section without an edit here
  // — and each one's data is looked up by KEY in a `Record` the tab declares.
  // Every prop is typed against the real type.
  //
  // The per-backend rendering lives in `general/BackendSection.svelte`; this file
  // owns the heading, the shared probe state and nothing else.
  import { SUPPORTED_BACKENDS } from '../../../../src/contracts/backend-kinds';
  import type {
    BackendPingState,
    BackendPosture,
    BackendRunnerKind,
    PortableWorkflowDefinition,
    WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import BackendSection from './general/BackendSection.svelte';
  import type {
    BackendSection as BackendSectionSpec,
    Draft,
    FieldSpec,
    ScalarKey,
    StatusByKey
  } from './general/field-types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /**
     * Every backend's section data, keyed by backend.
     *
     * A `Record` rather than an array: a fourth `BackendRunnerKind` member makes
     * the tab's declaration a compile error until that backend has a section,
     * where an array would compile and silently render three of four.
     */
    backends: Readonly<Record<BackendRunnerKind, BackendSectionSpec>>;
    draft: Draft;
    statusByKey: StatusByKey;
    fieldChanged: (key: ScalarKey) => boolean;
    fieldScopeLabel: (key: ScalarKey) => string;
    workflows: readonly PortableWorkflowDefinition[];
    saveOne: (spec: FieldSpec) => void;
    resetField: (key: ScalarKey) => void;
  }
  let {
    snapshot,
    backends,
    draft = $bindable(),
    statusByKey,
    fieldChanged,
    fieldScopeLabel,
    workflows,
    saveOne,
    resetField
  }: Props = $props();

  const ping = $derived<BackendPingState>(snapshot.backendPingState ?? { status: 'idle' });
  const availableBackends = $derived(snapshot.availableBackends ?? []);
  const busy = $derived(ping.status === 'running');
  // Absent when the host predates the projection; each section renders no posture
  // block in that case rather than inventing one. See `BackendSection`'s prop doc.
  const postures = $derived<readonly BackendPosture[]>(snapshot.backendPostures ?? []);
</script>

<!--
  The redesign's "Installed backends" section: a heading, then one card per backend. The heading
  keeps its words and its id, which the "open backend settings" command scrolls to.
-->
<section class="section backend-health" aria-labelledby="backend-health-heading">
  <h3 id="backend-health-heading">Backend Health</h3>
  <p class="lead small muted" id="backend-health-description">Run a bounded, output-free availability check for a configured CLI.</p>
  <div class="grid backend-list">
    {#each SUPPORTED_BACKENDS as kind (kind)}
      <BackendSection
        {kind}
        section={backends[kind]}
        posture={postures.find((row) => row.kind === kind)}
        discovered={availableBackends.includes(kind)}
        inUse={draft.backendRunner === kind}
        {ping}
        {busy}
        bind:draft
        {statusByKey}
        {workflows}
        {fieldChanged}
        {fieldScopeLabel}
        {saveOne}
        {resetField}
      />
    {/each}
  </div>
</section>

<style>
  .lead {
    margin: 0 0 var(--schegent-space-3);
  }
</style>
