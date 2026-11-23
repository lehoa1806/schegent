<script lang="ts">
  // The Queues section's "When a task fails", as the redesign's settings page draws it: one row per
  // queue, each with its behaviour in a select.
  //
  // Feature 195 (T040, FR-014) — a queue's failure policy is the queue's own answer, not a
  // workspace setting like the two rows above the table, so each changed row is its own write
  // (through `setQueueFailurePolicy`, addressed by `queueId`). This table shows the rows and
  // reports an edit; `QueueDefaultsSection.svelte` holds the drafts and writes them on the page's
  // Save. The workspace default itself stays in the VS Code Settings editor (FR-015).

  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { QUEUE_FAILURE_POLICIES } from '../../lib/generated/queue-failure-policy';
  import { QUEUE_DEFAULTS_DESCRIPTIONS } from './QueueDefaultsSection.descriptions';
  import {
    FAILURE_POLICY_LABEL,
    FOLLOW_DEFAULT,
    followDefaultLabel,
    type FailurePolicyChoice,
    type FailurePolicyRow
  } from './queue-failure-policy-choice';
  import { descriptionWords, settingsSearch } from './settings-search.svelte';

  /** The table's heading. The page's search also finds every queue's row by it. */
  const HEADING = 'When a task fails';

  interface Props {
    /** One row per queue, in registry position order. */
    rows: readonly FailurePolicyRow[];
    /** Feature 092 (FR-065) — a window that is not the primary one shows every row and changes none. */
    readOnly: boolean;
    /** Reports the choice picked for a queue; the section keeps it as a draft. */
    onEdit: (queueId: string, choice: FailurePolicyChoice) => void;
  }
  const { rows, readOnly, onEdit }: Props = $props();

  const { row: searchRow, group: searchGroup, refusal } = settingsSearch();
  /** A queue is found by its name and by what the select does; the name is not edited here. */
  const POLICY_WORDS = descriptionWords(QUEUE_DEFAULTS_DESCRIPTIONS['queue-failure-policy']);
</script>

<section
  class="section policy"
  aria-labelledby="queue-failure-policy-heading"
  use:searchGroup={() => [HEADING]}
>
  <h3 id="queue-failure-policy-heading">{HEADING}</h3>
  <div class="table-wrap">
    <table class="t fit">
      <thead>
        <tr>
          <th scope="col">Queue</th>
          <th scope="col">Behavior</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.queueId)}
          <tr
            data-testid="queue-failure-policy-row-{row.queueId}"
            data-changed={row.changed}
            use:searchRow={() => [row.name, ...POLICY_WORDS]}
          >
            <td>
              <span class="queue-name">{row.name}</span>
              {#if row.changed}
                <span class="mod" role="img" aria-label="changed, not saved"></span>
              {/if}
            </td>
            <td>
              <select
                class="input"
                aria-label="Behavior for {row.name}"
                data-testid="queue-failure-policy-select-{row.queueId}"
                value={row.choice}
                disabled={readOnly}
                onchange={(event) =>
                  onEdit(row.queueId, event.currentTarget.value as FailurePolicyChoice)}
                use:hoverTextAnchor={{
                  controlId: `queue-failure-policy-${row.queueId}`,
                  description: QUEUE_DEFAULTS_DESCRIPTIONS['queue-failure-policy']
                }}
              >
                <option value={FOLLOW_DEFAULT}>{followDefaultLabel(row.resolved)}</option>
                {#each QUEUE_FAILURE_POLICIES as policy (policy)}
                  <option value={policy}>{FAILURE_POLICY_LABEL[policy]}</option>
                {/each}
              </select>
              <!-- Feature 195 (FR-019) — one message per row, so an answer about one queue never
                   shows on another's. The polite status region stays in place for non-refusal
                   messages; a refusal is an alert of its own outside it. -->
              <div role="status">
                {#if row.message !== null && !row.message.refused}
                  <p
                    class="small muted policy-message"
                    data-testid="queue-failure-policy-message-{row.queueId}"
                  >{row.message.text}</p>
                {/if}
              </div>
              {#if row.message !== null && row.message.refused}
                <p
                  class="small s-err policy-message"
                  role="alert"
                  data-testid="queue-failure-policy-message-{row.queueId}"
                  use:refusal
                >{row.message.text}</p>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  /* `.sg .table-wrap` and `.sg table.t` draw the table. These place what those rules have no slot
     for: the heading, a long queue name, the changed dot in a cell (the sheet draws it only in a
     settings row's label) and the message under a select. Theme tokens only. */
  .policy > h3 {
    margin: 0 0 var(--schegent-space-2);
    font-size: var(--schegent-text-subheading);
    font-weight: 600;
  }

  .queue-name {
    overflow-wrap: anywhere;
  }

  td .mod {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-left: var(--schegent-space-1-5);
    border-radius: 50%;
    background: var(--schegent-color-warning);
    vertical-align: middle;
  }

  .policy-message {
    margin: var(--schegent-space-1) 0 0;
  }
</style>
