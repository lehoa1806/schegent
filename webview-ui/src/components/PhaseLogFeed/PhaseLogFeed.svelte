<script lang="ts">
  // Feature 020 T039 + T053 — top-level Activity Feed wrapper. Composes
  // the selectors, iteration stepper, empty-state cards, and reading
  // pane, and wires them to the per-instance phase-log store.
  //
  // Tail lifecycle (T053): when the user's selection resolves to
  //   (a) iteration === the latest known iteration for the tuple, AND
  //   (b) the selected task is the snapshot's in-flight task, AND
  //   (c) the selected phase matches the in-flight task's
  //       `currentPhase`,
  // the container auto-attaches a tail by calling `store.startTail`.
  // The `$effect` watches the derived `tailTarget`; on cleanup (target
  // change to null, selection re-cascade, or component unmount) it
  // calls `store.stopTail()`. Push messages are routed through the
  // store's `handlePush` internals — this component is intentionally
  // unaware of the wire format beyond the start/stop calls.

  import type { WorkflowSnapshot } from '../../lib/snapshot-types';
  import { createPhaseLogStore, type PhaseLogStore } from '../../lib/phase-log-store.svelte';
  import PhaseLogSelectors from './PhaseLogSelectors.svelte';
  import PhaseLogIterationStepper from './PhaseLogIterationStepper.svelte';
  import PhaseLogReadingPane from './PhaseLogReadingPane.svelte';
  import PhaseLogEmptyStates from './PhaseLogEmptyStates.svelte';
  import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
  import { parseToolArguments } from '../../lib/activity-feed/parse-tool-arguments';
  import type {
    ParsedToolArgument,
    ToolArgumentValue
  } from '../../lib/activity-feed/types';

  interface Props {
    readonly snapshot: WorkflowSnapshot;
    readonly store?: PhaseLogStore;
    readonly onSelectQueue?: (queueId: string | null) => void;
    readonly onSelectTask?: (taskId: string | null, pipelineId: string | null) => void;
    readonly onSelectPhase?: (phaseId: string | null) => void;
    readonly onJumpToCurrent?: () => void;
  }

  let {
    snapshot,
    store = createPhaseLogStore(),
    onSelectQueue,
    onSelectTask,
    onSelectPhase,
    onJumpToCurrent
  }: Props = $props();

  const state = $derived(store.state);

  const availablePhases = $derived(snapshot.availablePhases ?? []);
  const hasNoEntries = $derived(
    !state.loading && state.entries.length === 0
  );
  // When the host returns a banner (`enabled-no-sessions-for-tuple` or
  // `disabled-no-sessions`) AND the reading pane has no rows, show the
  // empty-state card in place of the reading pane. The "enabled with
  // sessions" banner is informational only — the pane renders normally.
  const showEmptyCard = $derived(
    hasNoEntries &&
      state.verboseDiagnosticsState !== null &&
      state.verboseDiagnosticsState.kind !== 'enabled-with-sessions'
  );

  // T053 — derived tail fingerprint. Encodes the (queueId, taskId,
  // pipelineId, phaseId, iterationN) tuple as a single string when
  // the selection resolves to (a) iteration === latest known iteration
  // AND (b) selected task is the in-flight task AND (c) selected phase
  // === in-flight task's currentPhase. Returns the empty string when
  // any condition fails. A string fingerprint (rather than a fresh
  // object literal) gives the downstream `$effect` a stable identity
  // so unrelated state changes (e.g., tailSessionId, new entries) do
  // NOT trip the effect's cleanup and inadvertently call `stopTail`.
  const tailFingerprint = $derived.by(() => {
    const sel = state.selection;
    if (
      sel.queueId === null ||
      sel.taskId === null ||
      sel.pipelineId === null ||
      sel.phaseId === null ||
      sel.iterationN === null
    ) {
      return '';
    }
    const inFlight = snapshot.queue.inFlight;
    if (inFlight === null) return '';
    if (inFlight.id !== sel.taskId) return '';
    if (inFlight.currentPhase !== sel.phaseId) return '';
    const iters = state.iterations;
    if (iters.length === 0) return '';
    const latest = iters[iters.length - 1];
    if (latest !== sel.iterationN) return '';
    return `${sel.queueId}${sel.taskId}${sel.pipelineId}${sel.phaseId}${sel.iterationN}`;
  });

  // Manually-tracked tail lifecycle. The $effect body re-runs on
  // any reactive read inside `tailFingerprint`, but most of those
  // re-runs see no actual change to the tuple — we compare against
  // `activeTailFingerprint` (kept in untracked module-local state
  // via the closure on a regular `let`) and only act on a true
  // transition. The $effect cleanup is reserved for component
  // unmount, where it always tears down any active tail.
  let activeTailFingerprint = '';
  $effect(() => {
    const fp = tailFingerprint;
    if (fp === activeTailFingerprint) return;
    if (activeTailFingerprint !== '') {
      void store.stopTail();
    }
    activeTailFingerprint = fp;
    if (fp === '') return;
    const parts = fp.split('');
    void store.startTail({
      selection: {
        queueId: parts[0],
        taskId: parts[1],
        pipelineId: parts[2],
        phaseId: parts[3],
        iterationN: Number(parts[4])
      }
    });
  });

  $effect(() => {
    return () => {
      if (activeTailFingerprint !== '') {
        void store.stopTail();
        activeTailFingerprint = '';
      }
    };
  });

  function handleSelectQueue(queueId: string | null): void {
    if (onSelectQueue) {
      onSelectQueue(queueId);
      return;
    }
    store.setQueue(queueId);
  }

  function handleSelectTask(
    taskId: string | null,
    pipelineId: string | null
  ): void {
    if (onSelectTask) {
      onSelectTask(taskId, pipelineId);
      return;
    }
    store.setTask(taskId, pipelineId);
  }

  function handleSelectPhase(phaseId: string | null): void {
    if (onSelectPhase) {
      onSelectPhase(phaseId);
      return;
    }
    store.setPhase(phaseId);
  }

  function handleSelectIteration(n: number): void {
    store.setIteration(n);
  }

  // T056 — atomic cascade to the currently-in-flight task / phase /
  // latest iteration. Delegated to the store so the five fields are
  // written in a single setState, avoiding the intermediate fingerprint
  // values the dependent `$effect` would otherwise observe.
  function handleJumpToCurrent(): void {
    if (onJumpToCurrent) {
      onJumpToCurrent();
      return;
    }
    void store.jumpToCurrent(snapshot);
  }
  // Feature 029 T018 \u2014 flat-text rendering for the "Copy All" button.
  // For `tool-use` entries we use the same parser the renderer uses so
  // multi-line argument strings (e.g. Write.content) keep their real
  // newlines and the result reads cleanly when pasted into a bug
  // report. Scalars render as `  key: value` lines; multi-line values
  // render as `  key:` followed by the indented content.
  function toolUseToText(e: PhaseLogDisplayEntry, prefix: string): string {
    const lines: string[] = [];
    lines.push(`${prefix}\u25b6 ${e.body.toolName ?? '(tool)'}`);
    const parsed = parseToolArguments(e);
    if (!parsed.ok) {
      lines.push(parsed.rawText);
      return lines.join('\n');
    }
    for (const arg of parsed.args) {
      argToTextLines(arg, '  ', lines);
    }
    return lines.join('\n');
  }
  function argToTextLines(
    arg: ParsedToolArgument,
    indent: string,
    out: string[]
  ): void {
    const c = arg.classification;
    if (c.kind === 'scalar') {
      out.push(`${indent}${arg.key}: ${c.display}`);
      return;
    }
    if (c.kind === 'multiline') {
      out.push(`${indent}${arg.key}:`);
      for (const ln of c.text.split('\n')) {
        out.push(`${indent}  ${ln}`);
      }
      return;
    }
    if (c.kind === 'object') {
      out.push(`${indent}${arg.key}:`);
      for (const child of c.children) {
        argToTextLines(child, `${indent}  `, out);
      }
      return;
    }
    if (c.kind === 'array') {
      out.push(`${indent}${arg.key}:`);
      for (const item of c.items) {
        argToTextLines(item, `${indent}  `, out);
      }
      if (c.truncatedAt !== undefined) {
        out.push(`${indent}  \u2026 +${c.truncatedAt - c.items.length} more`);
      }
      return;
    }
    // Defensive fallback: serialize unknown shapes.
    out.push(`${indent}${arg.key}: ${jsonOrEmpty(arg.value)}`);
  }
  function jsonOrEmpty(v: ToolArgumentValue): string {
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return '';
    }
  }
  function entryToText(e: PhaseLogDisplayEntry): string {
    const prefix = e.ts ? `[${e.ts}] ` : '';
    switch (e.kind) {
      case 'assistant-text':
        return `${prefix}${e.body.text ?? ''}`;
      case 'tool-use':
        return toolUseToText(e, prefix);
      case 'tool-result':
        return `${prefix}${e.body.isError ? '[ERROR] ' : ''}${e.body.toolResult ?? ''}`;
      case 'system':
        return `${prefix}${e.body.systemSummary ?? e.body.systemSubtype ?? ''}`;
      case 'result':
        return `${prefix}${e.body.resultSummary ?? ''}`;
      case 'truncated-head':
        return `${prefix}(${e.body.droppedEntryCount ?? 0} earlier entries hidden)`;
      case 'tail-ended':
        return `${prefix}Tail ended (${e.body.reason ?? 'unknown'})`;
      default:
        return prefix;
    }
  }

  async function handleCopyAll(): Promise<void> {
    const entries = state.entries;
    if (entries.length === 0) return;
    const text = entries.map(entryToText).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard write can fail in restricted contexts — non-fatal.
    }
  }
</script>

<section
  class="phase-log-feed"
  data-testid="phase-log-feed"
  aria-label="Activity Feed"
>
  <PhaseLogSelectors
    snapshot={{ queue: snapshot.queue, history: snapshot.history }}
    selection={state.selection}
    iterations={state.iterations}
    {availablePhases}
    entryCount={state.entries.length}
    onSelectQueue={handleSelectQueue}
    onSelectTask={handleSelectTask}
    onSelectPhase={handleSelectPhase}
    onJumpToCurrent={handleJumpToCurrent}
    onCopyAll={handleCopyAll}
  />

  <PhaseLogIterationStepper
    iterations={state.iterations}
    currentN={state.selection.iterationN}
    onChange={handleSelectIteration}
  />

  {#if showEmptyCard}
    <PhaseLogEmptyStates banner={state.verboseDiagnosticsState} />
  {:else}
    <PhaseLogReadingPane
      entries={state.entries}
      loading={state.loading}
      skippedLines={state.skippedLines}
      truncatedCount={state.truncatedCount}
      isLive={state.tailSessionId !== null}
    />
  {/if}

  {#if state.errorReason !== null}
    <p class="error" data-testid="phase-log-error">
      Could not load logs: {state.errorReason}
    </p>
  {/if}
</section>

<style>
  .phase-log-feed {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }
  .error {
    margin: 0;
    color: var(--vscode-errorForeground);
    font-size: 0.85rem;
  }
</style>
