<script lang="ts">
  // The Settings page's Queues section, as the redesign's settings page draws it: "Runs at the
  // same time" and "Default queue" as settings rows, then "When a task fails" as a table of the
  // queues, each with its behaviour in a select (`QueueFailurePolicyTable.svelte` draws it; this
  // section holds its drafts). It replaces the Queue settings dialog the Queues list used to open;
  // that list's "Queue defaults" now opens the page on this section.
  //
  // Feature 095 (T024–T028, US3, FR-009 to FR-011) — the workspace queue settings: how many Runs
  // may execute at once, and which queue receives a Task that names none. Both values are
  // workspace-scoped and written together by the one queue-settings command (FR-010), so they
  // are this section's own rows: the general settings fields gain no row for either.
  //
  // The cap's accepted range is the host validator's. The input carries `min` and `max` as a
  // hint, and the save path does not consult them: FR-011 says the webview must not restate the
  // range as its own rule, and a value the operator types must be allowed to reach the host and
  // come back refused.
  //
  // The page's one save model (`settings-page.svelte.ts`): an edit is a draft, kept with the saved
  // value it was made against. The page header counts the drafts and nothing is written until the
  // page's Save. A draft whose saved value changes underneath it is dropped, so the host's new
  // value shows rather than an edit made against the old one.
  //
  // Feature 092 (FR-065) — a window that is not the primary one shows every value and changes
  // none: the host refuses its writes, so the section offers none and says why.

  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { refusalText, saveQueueSettings, setQueueFailurePolicy } from '../../lib/queue-control-ipc';
  import type { QueueControlResult, SetQueueFailurePolicyOutcome } from '../../lib/queue-control-ipc';
  import { adviseStreamPressure } from '../../../../src/contracts/stream-pressure-advice';
  import type { QueueFailurePolicy } from '../../lib/generated/queue-failure-policy';
  import { IDLE_QUEUE_SETTINGS, type WorkflowSnapshot } from '../../lib/snapshot-types';
  import { QUEUE_DEFAULTS_DESCRIPTIONS } from './QueueDefaultsSection.descriptions';
  import QueueFailurePolicyTable from './QueueFailurePolicyTable.svelte';
  import {
    FOLLOW_DEFAULT,
    type FailurePolicyChoice,
    type FailurePolicyMessage,
    type FailurePolicyRow
  } from './queue-failure-policy-choice';
  import { SettingsPage } from './settings-page.svelte';

  interface Props {
    /**
     * The projection both values, every queue and each queue's failure behaviour are read from.
     *
     * FR-R3-145 (T1572) — the values are prefilled from the queue-settings projection, never from
     * the configuration (FR-009). The queue-settings command writes the workspace memento, so a
     * prefill read from the configuration could not read back its own write: the section would
     * show the old number and the operator's save would look lost. Same store in, same store out.
     */
    snapshot: WorkflowSnapshot;
    /** The page whose header saves and reverts this section's drafts; a section on its own gets its own. */
    page?: SettingsPage;
  }
  const { snapshot, page = new SettingsPage() }: Props = $props();

  const READ_ONLY_TEXT = 'This window is not the primary one, so it cannot change these settings.';
  const NO_OP_TEXT = 'Already set that way.';
  // The reason the IPC module settles a wait with when the host has not answered in time.
  const TIMEOUT_REASON = 'timeout';

  // What a queue with no override and no projected answer is read as doing when a task fails.
  const FALLBACK_POLICY: QueueFailurePolicy = 'halt-on-failure';

  // Suggested bounds only. The cap's range is [1, 20]; the host is what enforces
  // it. FR-R3-145 (T1572) — this comment named a `schegent.*` configuration key
  // that no longer exists and that no scheduling path ever read.
  // `MAX_QUEUES` in `src/contracts/queue-bounds.ts` is the ceiling's one source.
  const CAP_HINT_MIN = 1;
  const CAP_HINT_MAX = 20;

  const settings = $derived(snapshot.queueSettings ?? IDLE_QUEUE_SETTINGS);
  const savedCap = $derived(settings.globalConcurrencyCap);
  const savedDefault = $derived(settings.defaultQueueId);
  // The queues by registry position: the default queue's options (FR-009) and the table's rows.
  const queues = $derived([...snapshot.queues].sort((a, b) => a.position - b.position));
  // Feature 195 (T040, FR-014) — the registry's own per-queue projection, carrying
  // `failurePolicy` (effective) and `failurePolicyOverride` (raw) for the per-queue select.
  // Read beside `snapshot.queues` rather than widening `QueueRuntime`: this is the registry's
  // summary, projected once in `queue-summary-projector.ts`. Empty for a host build that predates
  // the feature.
  const summaries = $derived(snapshot.queue.queues ?? []);
  // FR-R3-130 (T1495) — `os.totalmem()`, from the stream-pressure projection. Read as `0` when the
  // projection is absent, and `adviseStreamPressure` reads 0 as "do not warn": a snapshot without
  // it shows no warning rather than a warning computed from nothing.
  const machineMemoryBytes = $derived(snapshot.streamPressure?.machineMemoryBytes ?? 0);
  const readOnly = $derived(!snapshot.isPrimary);

  /** An edit, and the saved value it was made against. */
  interface Draft<Value, Base = Value> {
    readonly value: Value;
    readonly base: Base;
  }

  let capDraft = $state<Draft<string, number> | null>(null);
  let defaultDraft = $state<Draft<string> | null>(null);
  let policyDrafts = $state<Partial<Record<string, Draft<FailurePolicyChoice>>>>({});

  const capShown = $derived(
    capDraft !== null && capDraft.base === savedCap ? capDraft.value : String(savedCap)
  );
  const capChanged = $derived(Number(capShown) !== savedCap);
  const defaultShown = $derived(
    defaultDraft !== null && defaultDraft.base === savedDefault ? defaultDraft.value : savedDefault
  );
  const defaultChanged = $derived(defaultShown !== savedDefault);

  function summaryFor(queueId: string) {
    return summaries.find((entry) => entry.id === queueId);
  }

  function savedChoice(queueId: string): FailurePolicyChoice {
    return summaryFor(queueId)?.failurePolicyOverride ?? FOLLOW_DEFAULT;
  }

  function choiceShown(queueId: string): FailurePolicyChoice {
    const draft = policyDrafts[queueId];
    const saved = savedChoice(queueId);
    return draft !== undefined && draft.base === saved ? draft.value : saved;
  }

  function policyChanged(queueId: string): boolean {
    return choiceShown(queueId) !== savedChoice(queueId);
  }

  const changedPolicies = $derived(queues.map((queue) => queue.queueId).filter(policyChanged));
  const changeCount = $derived(
    (capChanged ? 1 : 0) + (defaultChanged ? 1 : 0) + changedPolicies.length
  );

  /**
   * FR-R3-130 (T1495) — what this cap will cost, at the moment it is typed.
   *
   * The audit of 2026-08-27's point about the cap-20 ceiling was that an operator can
   * accept it without ever seeing it. The threshold is machine-derived and the
   * coefficient comes from `docs/operations/large-workspace-resource-measurement.md`
   * — not from a constant chosen at the keyboard, which is the arithmetic `FR-R3-081`
   * ruled out.
   *
   * It WARNS. It does not stop the page saving: the cap's range is ratified, and an
   * operator on a large machine raising it is making a legitimate choice. What was
   * missing is that the choice was invisible.
   */
  const pressureAdvice = $derived.by(() => {
    const parsed = Number(capShown);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    const advice = adviseStreamPressure({ cap: parsed, machineMemoryBytes });
    return advice.level === 'warn' ? advice.message : null;
  });

  type SettingsOutcome =
    | { readonly status: 'pending' }
    | { readonly status: 'accepted' }
    | { readonly status: 'unknown'; readonly text: string }
    | { readonly status: 'rejected'; readonly text: string };

  let settingsOutcome = $state<SettingsOutcome | null>(null);
  // Feature 195 (T040, FR-019) — one message per queue row, keyed by `queueId`, so a refusal or
  // no-op on one queue's select cannot bleed onto another's while both are on screen.
  let policyMessages = $state<Partial<Record<string, FailurePolicyMessage>>>({});

  function without<T>(record: Partial<Record<string, T>>, key: string): Partial<Record<string, T>> {
    return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
  }

  // The table's rows, in the queues' position order.
  const policyRows = $derived(
    queues.map(
      (queue): FailurePolicyRow => ({
        queueId: queue.queueId,
        name: queue.name,
        choice: choiceShown(queue.queueId),
        changed: policyChanged(queue.queueId),
        resolved: summaryFor(queue.queueId)?.failurePolicy ?? FALLBACK_POLICY,
        message: policyMessages[queue.queueId] ?? null
      })
    )
  );

  // FR-R4-F05 (I6, I8, FR-024) — a late answer goes through the same text path as an on-time
  // one, so it replaces the not-yet-known text; leaving the page aborts the waits.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());

  $effect(() =>
    page.register({
      changes: () => (changeCount > 0 ? { queues: changeCount } : {}),
      canSave: () => !readOnly && changeCount > 0,
      save,
      revert
    })
  );

  // jsdom and some engines still deliver input events to a disabled control, so every edit
  // checks the window first rather than trusting `disabled` alone.
  function editCap(value: string): void {
    if (readOnly) return;
    capDraft = { value, base: savedCap };
    settingsOutcome = null;
  }

  function editDefault(value: string): void {
    if (readOnly) return;
    defaultDraft = { value, base: savedDefault };
    settingsOutcome = null;
  }

  function editPolicy(queueId: string, value: FailurePolicyChoice): void {
    if (readOnly) return;
    policyDrafts = { ...policyDrafts, [queueId]: { value, base: savedChoice(queueId) } };
    policyMessages = without(policyMessages, queueId);
  }

  // Both workspace values travel in one post, then each changed queue's behaviour in its own,
  // in position order. Every post leaves before the first answer is awaited.
  async function save(): Promise<void> {
    if (readOnly) return;
    const writes: Promise<void>[] = [];
    if (capChanged || defaultChanged) writes.push(saveSettings());
    for (const queueId of changedPolicies) writes.push(savePolicy(queueId, choiceShown(queueId)));
    await Promise.all(writes);
  }

  async function saveSettings(): Promise<void> {
    settingsOutcome = { status: 'pending' };
    // `Number()` converts; it does not judge. A value outside the range still
    // travels, and the host answers with its refusal (FR-011).
    const result = await saveQueueSettings(Number(capShown), defaultShown, {
      signal: lifetime.signal,
      onLateOutcome: showSettingsResult
    });
    showSettingsResult(result);
  }

  function showSettingsResult(result: QueueControlResult): void {
    if (result.status === 'accepted') {
      settingsOutcome = { status: 'accepted' };
      return;
    }
    settingsOutcome = {
      status: result.reason === TIMEOUT_REASON ? 'unknown' : 'rejected',
      text: refusalText(result.reason)
    };
  }

  /**
   * Feature 195 (T040, FR-018, FR-019) — the per-queue failure-policy write.
   * `choice === FOLLOW_DEFAULT` posts `policy: null`, which removes the
   * stored field rather than writing a concrete value (contract §6).
   *
   * `no-op` reads as its own sentence, never as `refused`: the host declared
   * nothing wrong with the request, only that the queue already answered
   * that way (FR-019's "no operator action against a halted queue... is
   * reported as having succeeded" holds for every other outcome here too —
   * `no-op` is not success being under-reported, it is nothing having
   * changed, and the wording says so).
   */
  async function savePolicy(queueId: string, choice: FailurePolicyChoice): Promise<void> {
    const policy = choice === FOLLOW_DEFAULT ? null : choice;
    const show = (outcome: SetQueueFailurePolicyOutcome): void => showPolicyOutcome(queueId, outcome);
    show(await setQueueFailurePolicy(queueId, policy, { signal: lifetime.signal, onLateOutcome: show }));
  }

  function showPolicyOutcome(queueId: string, outcome: SetQueueFailurePolicyOutcome): void {
    const message = policyMessageFor(outcome);
    policyMessages =
      message === null ? without(policyMessages, queueId) : { ...policyMessages, [queueId]: message };
  }

  function policyMessageFor(outcome: SetQueueFailurePolicyOutcome): FailurePolicyMessage | null {
    if (outcome.status === 'accepted') return null;
    if (outcome.status === 'no-op') return { text: NO_OP_TEXT, refused: false };
    return { text: refusalText(outcome.reason), refused: outcome.reason !== TIMEOUT_REASON };
  }

  function revert(): void {
    capDraft = null;
    defaultDraft = null;
    policyDrafts = {};
    settingsOutcome = null;
    policyMessages = {};
  }
</script>

<div class="queue-defaults" data-testid="queue-defaults">
  {#if readOnly}
    <p class="hint read-only" data-testid="queue-defaults-read-only">{READ_ONLY_TEXT}</p>
  {/if}

  <div class="srow" data-testid="queue-defaults-cap-row" data-changed={capChanged}>
    <div class="row-label">
      <div class="lab">
        <span id="queue-config-cap-label">Runs at the same time</span>
        {#if capChanged}
          <span class="mod" role="img" aria-label="changed, not saved"></span>
        {/if}
      </div>
      <!--
        FR-R3-124 (FR-003) — the consequence, at the point of decision.

        The sentence already existed in the manifest description, the operator guide
        and two architecture documents. None of them is on screen at the moment the
        number changes, which is the only moment it matters. The audit of 2026-08-27
        named shared-tree parallelism one of three dominating risks; per-Run isolation
        is DECIDED and GATED in `repo/docs/architecture/run-isolation-decision.md`, not
        shipped, so above one this text is the whole boundary. It is the row's whole
        description: the redesign's "Across all queues." leads it, and the redesign's
        "More than 1 needs isolated workspaces." gives way to it, because no such
        workspace exists to point to.

        It is `aria-describedby` rather than loose text so assistive technology
        announces it as the field's description; a paragraph merely sitting next to a
        number input is not announced with it.

        `tests/lint/concurrency-isolation-disclosure.test.ts` asserts both this text
        and the association, and fails if either is removed.
      -->
      <p class="desc" id="queue-config-cap-shared-tree" data-testid="queue-config-cap-disclosure">
        Across all queues. Above one, concurrent Runs share one working tree. They may edit the
        same files, so semantic conflicts between Runs are possible and a recovery checkpoint may be
        declined as unattributable.
      </p>
    </div>
    <div class="ctl">
      <span class="unit">
        <input
          id="queue-config-cap"
          type="number"
          class="input"
          min={CAP_HINT_MIN}
          max={CAP_HINT_MAX}
          aria-labelledby="queue-config-cap-label queue-config-cap-unit"
          aria-describedby="queue-config-cap-shared-tree"
          data-testid="queue-config-cap"
          value={capShown}
          disabled={readOnly}
          oninput={(event) => editCap(event.currentTarget.value)}
          use:hoverTextAnchor={{
            controlId: 'queue-cap',
            description: QUEUE_DEFAULTS_DESCRIPTIONS['queue-cap']
          }}
        />
        <span class="muted" id="queue-config-cap-unit">runs</span>
      </span>
      <span class="hint">Applies to: this workspace</span>
    </div>
    {#if pressureAdvice !== null}
      <p class="pressure-advice" role="status" data-testid="queue-config-pressure-advice">
        {pressureAdvice}
      </p>
    {/if}
  </div>

  <div class="srow" data-testid="queue-defaults-default-queue-row" data-changed={defaultChanged}>
    <div class="row-label">
      <div class="lab">
        <span id="queue-config-default-queue-label">Default queue</span>
        {#if defaultChanged}
          <span class="mod" role="img" aria-label="changed, not saved"></span>
        {/if}
      </div>
      <p class="desc" id="queue-config-default-queue-desc">New tasks go here unless you pick another.</p>
    </div>
    <div class="ctl">
      <!-- No option stands in for a default queue that no longer exists: the host refuses a
           queue it does not have, so the select offers only the queues there are. -->
      <select
        id="queue-config-default-queue"
        class="input"
        aria-labelledby="queue-config-default-queue-label"
        aria-describedby="queue-config-default-queue-desc"
        data-testid="queue-config-default-queue"
        value={defaultShown}
        disabled={readOnly}
        onchange={(event) => editDefault(event.currentTarget.value)}
        use:hoverTextAnchor={{
          controlId: 'queue-default',
          description: QUEUE_DEFAULTS_DESCRIPTIONS['queue-default']
        }}
      >
        {#each queues as queue (queue.queueId)}
          <option value={queue.queueId}>{queue.name}</option>
        {/each}
      </select>
      <span class="hint">Applies to: this workspace</span>
    </div>
  </div>

  <!-- One line for the one post both values travel in. The region stays in place so a screen
       reader hears each change to it; a refusal is an alert of its own. -->
  <div class="outcome" role="status">
    {#if settingsOutcome?.status === 'pending'}
      <p class="small muted" data-testid="queue-config-status">Saving…</p>
    {:else if settingsOutcome?.status === 'accepted'}
      <p class="small s-ok" data-testid="queue-config-status">Saved</p>
    {:else if settingsOutcome?.status === 'unknown'}
      <p class="small muted" data-testid="queue-config-status">{settingsOutcome.text}</p>
    {/if}
  </div>
  {#if settingsOutcome?.status === 'rejected'}
    <p class="small s-err refusal" role="alert" data-testid="queue-config-refusal">
      {settingsOutcome.text}
    </p>
  {/if}

  <!-- Feature 195 (T040, FR-014) — each queue's own answer, each changed row its own post on the
       page's Save. -->
  <QueueFailurePolicyTable rows={policyRows} {readOnly} onEdit={editPolicy} />
</div>

<style>
  /* The `.sg .srow` rules draw each row and `.sg .unit` the number with its unit. These place what
     those rules have no slot for: the description under a label, the warning across a row and the
     outcome lines. Theme tokens only: FR-R3-131 baselined 30 contrast violations and no new
     hard-coded colour is added here. */
  .row-label .desc {
    margin: var(--schegent-space-1) 0 0;
    line-height: 1.4;
  }

  .pressure-advice {
    grid-column: 1 / -1;
    margin: 0;
    padding: var(--schegent-space-1-5) var(--schegent-space-2);
    border-left: 3px solid var(--schegent-warning-fg);
    background: var(--schegent-surface);
    color: var(--schegent-fg);
    font-size: var(--schegent-text-secondary);
    overflow-wrap: anywhere;
  }

  .read-only {
    margin: 0 0 var(--schegent-space-2);
  }

  .outcome p,
  .refusal {
    margin: var(--schegent-space-2) 0 0;
  }
</style>
