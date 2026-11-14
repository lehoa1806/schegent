<!--
  The saved reports, one row each, with a row's actions in its menu.

  Deleting asks first. "Delete…" leaves the menu and puts "Confirm delete" and "Keep" beside it,
  with focus on the confirmation; "Keep" puts the item back and hands focus to the menu's button.
  Which report waits on a confirmation is the panel's to hold, since the panel clears it once the
  delete has gone through.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import SgMenu from '../sg/SgMenu.svelte';

  /** A saved report as the table shows it: its id, its view's name and its cutoff. */
  interface SavedReportRow {
    readonly reportId: string;
    readonly report: string;
    readonly cutoff: string;
  }

  interface Props {
    reports: readonly SavedReportRow[];
    /** The report whose delete waits on a confirmation, if any. */
    confirmDeleteId: string | null;
    onRerun: (reportId: string) => void;
    onReproduce: (reportId: string) => void;
    onAskDelete: (reportId: string) => void;
    onConfirmDelete: (reportId: string) => void;
    onKeep: () => void;
  }

  const { reports, confirmDeleteId, onRerun, onReproduce, onAskDelete, onConfirmDelete, onKeep }: Props =
    $props();

  async function askDelete(reportId: string): Promise<void> {
    onAskDelete(reportId);
    await tick();
    document.getElementById(`saved-confirm-delete-${reportId}`)?.focus();
  }

  function keep(event: MouseEvent): void {
    onKeep();
    const row = event.currentTarget instanceof Element ? event.currentTarget.closest('tr') : null;
    row?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  }
</script>

<section class="section saved" aria-labelledby="saved-reports-heading" data-testid="saved-reports-section">
  <h2 id="saved-reports-heading">Saved reports</h2>
  {#if reports.length === 0}
    <p class="empty">No saved reports yet. Run a report, then choose Save report to keep it here.</p>
  {:else}
    <div class="table-wrap">
      <table class="t">
        <thead>
          <tr>
            <th scope="col">Report ID</th>
            <th scope="col">Report</th>
            <th scope="col">Cutoff</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each reports as item (item.reportId)}
            <tr>
              <td class="mono">{item.reportId}</td>
              <td>{item.report}</td>
              <td class="nowrap">{item.cutoff}</td>
              <td>
                <div class="row-actions">
                  <SgMenu label={`Actions for ${item.reportId}`} testid={`saved-actions-${item.reportId}`}>
                    <button type="button" role="menuitem" onclick={() => onRerun(item.reportId)} data-testid={`saved-rerun-${item.reportId}`}>
                      Run now
                    </button>
                    <button type="button" role="menuitem" onclick={() => onReproduce(item.reportId)} data-testid={`saved-reproduce-${item.reportId}`}>
                      Check it still matches
                    </button>
                    {#if confirmDeleteId !== item.reportId}
                      <hr />
                      <button type="button" role="menuitem" class="danger" onclick={() => void askDelete(item.reportId)} data-testid={`saved-delete-${item.reportId}`}>
                        Delete…
                      </button>
                    {/if}
                  </SgMenu>
                  {#if confirmDeleteId === item.reportId}
                    <button
                      id={`saved-confirm-delete-${item.reportId}`}
                      type="button"
                      class="btn btn-danger btn-sm"
                      onclick={() => onConfirmDelete(item.reportId)}
                      data-testid={`saved-confirm-delete-${item.reportId}`}
                    >Confirm delete</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick={keep}>Keep</button>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .row-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--schegent-space-1-5);
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
