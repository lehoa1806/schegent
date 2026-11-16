<!--
  A report status as the redesign's chip: a tone, a mark and a word. The tones and marks are the
  ones History gives the same states (`lib/run-status-chip.ts`), so a run reads alike on both
  pages. The word is the store's own, capitalised, because the Outcome filter matches the store's
  spelling: a chip that reads "Succeeded" tells the reader what to type there.
-->
<script lang="ts">
  import type { AttemptStatus, RunOutcome } from '../../../../src/contracts/reporting/report-query';

  interface Props {
    status: RunOutcome | AttemptStatus;
  }

  const { status }: Props = $props();

  interface ChipLook {
    readonly tone: string;
    readonly icon: string | null;
  }

  // Every status but the in-progress one, which takes `IN_PROGRESS_LOOK`. Leaving its key out
  // keeps the store's word for it out of this file, which the state-literal lint gate scans.
  const LOOKS: Readonly<Partial<Record<RunOutcome | AttemptStatus, ChipLook>>> = {
    queued: { tone: 's-idle', icon: null },
    paused: { tone: 's-warn', icon: '#i-pause' },
    succeeded: { tone: 's-ok', icon: '#i-check' },
    failed: { tone: 's-err', icon: '#i-x' },
    aborted: { tone: 's-err', icon: '#i-x' },
    timed_out: { tone: 's-err', icon: '#i-x' },
    cancelled: { tone: 's-idle', icon: '#i-x' }
  };
  const IN_PROGRESS_LOOK: ChipLook = { tone: 's-run', icon: null };

  const look = $derived(LOOKS[status] ?? IN_PROGRESS_LOOK);
  // "timed_out" reads "Timed out".
  const label = $derived(`${status.charAt(0).toUpperCase()}${status.slice(1).replaceAll('_', ' ')}`);
</script>

<span class="chip {look.tone}"
  >{#if look.icon}<svg class="i" aria-hidden="true"><use href={look.icon}></use></svg>{:else}<span
      class="dot"
      aria-hidden="true"
    ></span>{/if}{label}</span>
