<script lang="ts">
  // FR-R3-144 (T025, T026, T028) — the list of backend sections.
  //
  // WHAT CHANGED AND WHY. This component drew a row per runner from a local
  // `RUNNERS` array, paired against the tab's `BACKEND_FIELDS` by INDEX
  // (`{@const spec = BACKEND_FIELDS[i]}`). The pairing was correct only because
  // the two arrays were written in the same order and nothing compared them: a
  // spec inserted at the front would have drawn Claude's path under Codex's check
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
  import {
    IDLE_GENERAL_SETTINGS,
    type BackendPingState,
    type BackendPosture,
    type BackendRunnerKind,
    type GeneralSettings,
    type PortableWorkflowDefinition,
    type WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import BackendSection from './general/BackendSection.svelte';
  import type {
    BackendSection as BackendSectionSpec,
    Draft,
    ScalarKey,
    StatusByKey
  } from './general/field-types';
  import { settingsSearch } from './settings-search.svelte';

  /** The list's heading. The page's search also finds every backend's settings by it. */
  const HEADING = 'Installed backends';

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
  }
  let {
    snapshot,
    backends,
    draft = $bindable(),
    statusByKey,
    fieldChanged,
    fieldScopeLabel,
    workflows
  }: Props = $props();

  const ping = $derived<BackendPingState>(snapshot.backendPingState ?? { status: 'idle' });
  const availableBackends = $derived(snapshot.availableBackends ?? []);
  const busy = $derived(ping.status === 'running');
  // Absent when the host predates the projection; each section renders no posture
  // block in that case rather than inventing one. See `BackendSection`'s prop doc.
  const postures = $derived<readonly BackendPosture[]>(snapshot.backendPostures ?? []);
  // FR-004 — the host's sentences about entries in the list of backends allowed to run
  // unsandboxed that name no backend. Absent when the host predates the field.
  const grantProblems = $derived<readonly string[]>(snapshot.backendGrantProblems ?? []);
  // The settings as saved, which the host's scan and a backend's last test read. The draft holds
  // what a save will write; each card shows the saved path beside what was found at it.
  const saved = $derived<GeneralSettings>(snapshot.generalSettings ?? IDLE_GENERAL_SETTINGS);

  /** The saved value of a backend's path setting, or `''` when none is saved. */
  function savedPath(key: ScalarKey): string {
    const value: unknown = saved[key];
    return typeof value === 'string' ? value : '';
  }

  const { group: searchGroup } = settingsSearch();
</script>

<!--
  The redesign's "Installed backends" section: a heading, then one card per backend. The heading
  takes the mockup's words and keeps its id, which a launch notice's "Review in Settings" scrolls
  to. The mockup draws no line under the heading, so there is none.
-->
<section
  class="section backend-health"
  aria-labelledby="backend-health-heading"
  use:searchGroup={() => [HEADING]}
>
  <h3 id="backend-health-heading">{HEADING}</h3>
  {#if grantProblems.length > 0}
    <!--
      FR-004, T023 — spec 183 makes this tab the first surface to show an entry that grants
      nothing. An entry that names a backend is said on that backend's card; one that names none
      belongs to no card, so it is said here, before all of them. The lead line describes the list
      in words, because the webview never names the setting's key (rule 3 of T024's lint). The
      host's sentences follow as text, never as markup (T046), keyed by place, since two entries
      holding the same typo bring the same sentence twice.
    -->
    <div class="grant-problems" data-testid="backend-grant-problems" role="status">
      <p>
        The list of backends you allow to run unsandboxed, in your user settings, has
        {grantProblems.length === 1 ? 'an entry that names' : 'entries that name'} no backend:
      </p>
      <ul>
        {#each grantProblems as problem, index (index)}
          <li>{problem}</li>
        {/each}
      </ul>
    </div>
  {/if}
  <div class="grid backend-list">
    {#each SUPPORTED_BACKENDS as kind (kind)}
      <BackendSection
        {kind}
        section={backends[kind]}
        posture={postures.find((row) => row.kind === kind)}
        savedPath={savedPath(backends[kind].path.key)}
        discovered={availableBackends.includes(kind)}
        inUse={draft.backendRunner === kind}
        {ping}
        {busy}
        bind:draft
        {statusByKey}
        {workflows}
        {fieldChanged}
        {fieldScopeLabel}
      />
    {/each}
  </div>
</section>

<style>
  /* In the warning colour of a card's own grant line, with the cards' gap below it. The host's
     sentences can quote a long key, a word wider than a narrow panel's line, so such a word
     breaks where the line ends and the page never scrolls sideways (WCAG 1.4.10). */
  .grant-problems {
    margin: 0 0 var(--schegent-space-3);
    font-size: var(--schegent-text-secondary);
    line-height: 1.45;
    color: var(--schegent-status-warning-text);
    overflow-wrap: anywhere;
  }
  .grant-problems p {
    margin: 0;
  }
  .grant-problems ul {
    margin: var(--schegent-space-1) 0 0;
    padding-left: var(--schegent-space-4);
  }
</style>
