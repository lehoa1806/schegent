<script lang="ts">
  /**
   * Feature 031 T051 — Wake-up session-log path display strip.
   *
   * Mounts in `WakeUpTab.svelte` between the model selector and the
   * "View recent runs" log list. Shows the absolute on-disk path of
   * `<globalStorageUri>/wakeup/session.log` sourced from the host
   * projection at `snapshot.wakeUp.sessionLogPath`, and offers a
   * "Reveal in OS file manager" button that posts the typed
   * read-only IPC via the SOLE call site — the shared helper at
   * `webview-ui/src/lib/reveal-wakeup-session-log.ts`.
   *
   * Render discipline (CLAUDE.md hard rule):
   *   * The path string is operator-influenced (it's the host's
   *     globalStorage path) but rendered via `{text}` only — never
   *     `{@html}`. The repo-wide lint at
   *     `tests/lint/no-html-interpolation-in-activity-feed.test.ts`
   *     scans this directory.
   *   * The webview NEVER sends the path back to the host as a
   *     payload — the host re-derives it. The reveal helper's
   *     signature carries no operator input.
   *
   * Lifecycle:
   *   * The button is disabled while an IPC is in-flight and when
   *     the path projection is null (the host did not provision the
   *     path yet — unusual; occurs only before the wake-up home is
   *     created).
   *   * Rejection reasons are surfaced inline through human-readable
   *     copy (closed-vocabulary union from the helper).
   */
  import { revealWakeupSessionLog } from '../../../lib/reveal-wakeup-session-log';
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import { WAKEUP_DESCRIPTIONS } from '../WakeUpTab.descriptions';

  interface Props {
    /**
     * Absolute path to the wake-up session.log file. Sourced from
     * `snapshot.wakeUp.sessionLogPath`. `null` when the host has not
     * yet provisioned the path (display falls through to the empty
     * state and the Reveal button is disabled).
     */
    sessionLogPath: string | null;
  }

  const { sessionLogPath }: Props = $props();

  type RevealState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'rejected'; reason: string };

  let state = $state<RevealState>({ kind: 'idle' });

  async function onClickReveal(): Promise<void> {
    if (state.kind === 'pending') return;
    if (sessionLogPath === null) return;
    state = { kind: 'pending' };
    const result = await revealWakeupSessionLog();
    if (result.status === 'success') {
      state = { kind: 'idle' };
      return;
    }
    state = { kind: 'rejected', reason: result.reason };
  }
</script>

<div class="path-display" data-testid="wakeup-session-log-path-display">
  <div class="row">
    <span class="label">{'Session log file:'}</span>
    {#if sessionLogPath !== null}
      <code class="path" data-testid="wakeup-session-log-path">{sessionLogPath}</code>
    {:else}
      <span class="empty" data-testid="wakeup-session-log-path-empty">
        {'(not yet provisioned)'}
      </span>
    {/if}
  </div>
  <div class="toolbar">
    <button
      type="button"
      class="btn"
      data-testid="wakeup-session-log-reveal-button"
      disabled={sessionLogPath === null || state.kind === 'pending'}
      onclick={onClickReveal}
      use:hoverTextAnchor={{
        controlId: 'wakeup-session-log-reveal',
        description: WAKEUP_DESCRIPTIONS['session-log-reveal']
      }}
    >{'Reveal in OS file manager'}</button>
    {#if state.kind === 'rejected'}
      <span class="reveal-error" data-testid="wakeup-session-log-reveal-error">
        {`Could not reveal: ${state.reason}`}
      </span>
    {/if}
  </div>
</div>

<style>
  .path-display {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--sch-glass-bg);
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .label {
    font-weight: 600;
  }
  .path {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    word-break: break-all;
  }
  .empty {
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  .toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .btn {
    padding: 4px 12px;
    border-radius: var(--schegent-radius);
    font-size: 0.85em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--sch-glass-border);
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--schegent-fg));
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, var(--sch-glass-bg));
  }
  .reveal-error {
    font-size: 0.85em;
    color: var(--schegent-color-error);
  }
</style>
