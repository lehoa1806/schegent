<script lang="ts">
  /**
   * Feature 031 T039 — Wake-up session-log expansion panel.
   *
   * Mounts inline beneath an expanded row in the wake-up "View recent
   * runs" log list. Fetches the sanitized 32 KB-capped session-log
   * projection for one invocation via the SOLE call site — the shared
   * helper at `webview-ui/src/lib/wakeup-session-log-ipc.ts`. The lint
   * regression at `tests/lint/no-inline-read-wakeup-session-log.test.ts`
   * rejects any direct postCommand inlining; the read-command constant
   * is NOT spelled out anywhere in this file so the grep-based
   * regression cannot trip on prose.
   *
   * Render discipline (CLAUDE.md hard rule):
   *   * All body text renders through `{text}` bindings only. The
   *     repo-wide lint at
   *     `tests/lint/no-html-interpolation-in-activity-feed.test.ts`
   *     extends its scan to this directory and catches drift.
   *   * The captured `OUT:` / `ERR:` stream prefixes are preserved
   *     verbatim — the body is rendered inside a `<pre>` so the
   *     interleaved log lines stay aligned.
   *
   * Lifecycle:
   *   * Mount-once IPC. The helper resolves either a typed success
   *     payload (rendered) or a closed-vocabulary rejection (rendered
   *     via the appropriate testid). No auto-retry loop.
   *   * The `correlationId` prop is a UUIDv4 (validated client-side by
   *     the helper). A malformed id short-circuits to
   *     `'invalid-correlation-id'` without ever posting.
   */
  import { onMount } from 'svelte';
  import {
    readWakeupSessionLog,
    type ReadWakeupSessionLogResult
  } from '../../../lib/wakeup-session-log-ipc';

  interface Props {
    /** UUIDv4 of the invocation whose session-log block to fetch. */
    correlationId: string;
  }

  const { correlationId }: Props = $props();

  type PanelState =
    | { kind: 'loading' }
    | { kind: 'success'; payload: Extract<ReadWakeupSessionLogResult, { status: 'success' }> }
    | { kind: 'empty' }
    | { kind: 'error'; reason: string };

  let state = $state<PanelState>({ kind: 'loading' });

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    const result = await readWakeupSessionLog(correlationId);
    if (result.status === 'success') {
      state = { kind: 'success', payload: result };
      return;
    }
    // `unknown-correlation-id` → "no session log available" empty
    // state. Every other rejection (including `'timeout'` and
    // `'not-primary-host'`) → error testid with reason verbatim.
    if (result.reason === 'unknown-correlation-id') {
      state = { kind: 'empty' };
      return;
    }
    state = { kind: 'error', reason: result.reason };
  }
</script>

<div class="panel" data-testid="wakeup-session-log-panel">
  {#if state.kind === 'loading'}
    <div class="status" data-testid="wakeup-session-log-loading">
      {'Loading session log…'}
    </div>
  {:else if state.kind === 'empty'}
    <div class="status empty" data-testid="wakeup-session-log-empty">
      {'No session log available for this run.'}
    </div>
  {:else if state.kind === 'error'}
    <div class="status error" data-testid="wakeup-session-log-error">
      {`Could not load session log (${state.reason})`}
    </div>
  {:else if state.kind === 'success'}
    <pre class="body" data-testid="wakeup-session-log-body">{state.payload.body}</pre>
    {#if state.payload.bodyTruncated}
      <div class="truncated" data-testid="wakeup-session-log-truncated">
        {`Showing the last 32 KB of a ${state.payload.fullBlockBytesOnDisk}-byte block — see the on-disk file for the full output.`}
      </div>
    {/if}
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--sch-glass-bg);
    margin-top: 8px;
  }
  .status {
    font-size: 0.9em;
    color: var(--schegent-muted-fg);
  }
  .status.empty {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  .status.error {
    color: var(--schegent-color-error);
  }
  .body {
    margin: 0;
    padding: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 50vh;
    overflow-y: auto;
  }
  .truncated {
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
</style>
