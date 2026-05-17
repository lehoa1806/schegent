<script lang="ts">
  // Feature 029 T015 — render a multi-line string inside <pre><code>
  // with horizontal scroll, vertical max-height, a copy-to-clipboard
  // affordance, and an expand toggle for very long blocks. The
  // component is a pure renderer: it never mutates the input text.
  //
  // The host has already sanitized any string leaves before the IPC
  // boundary (see src/services/phase-log/phase-log-reader.ts) and the
  // single-sanitization-point invariant is preserved. We never use
  // `{@html}` for operator-influenced strings (FR-017).

  interface Props {
    readonly text: string;
    readonly language?: string;
    readonly maxLines?: number;
  }

  let { text, language, maxLines = 800 }: Props = $props();

  const lineCount = $derived(text.length === 0 ? 0 : text.split('\n').length);
  const canExpand = $derived(lineCount > maxLines);

  let expanded = $state(false);

  // When the block is over `maxLines`, collapse by default and show
  // only the first `maxLines` lines. The user expands explicitly.
  const displayedText = $derived(
    canExpand && !expanded ? text.split('\n').slice(0, maxLines).join('\n') : text
  );

  let copiedFlash = $state(false);
  let flashTimeout: ReturnType<typeof setTimeout> | null = null;

  async function handleCopy(): Promise<void> {
    const value = text;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback: hidden textarea + document.execCommand. Only used
        // in restricted contexts (older webviews / tests).
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand('copy');
        } finally {
          document.body.removeChild(ta);
        }
      }
      copiedFlash = true;
      if (flashTimeout !== null) clearTimeout(flashTimeout);
      flashTimeout = setTimeout(() => {
        copiedFlash = false;
        flashTimeout = null;
      }, 1500);
    } catch {
      // Non-fatal — clipboard may be restricted in some webviews.
    }
  }

  function handleExpandToggle(): void {
    expanded = !expanded;
  }
</script>

<div class="multiline-code-block" data-testid="multiline-code-block">
  <div class="toolbar">
    {#if canExpand}
      <button
        type="button"
        class="action"
        data-testid="multiline-expand"
        onclick={handleExpandToggle}
      >
        {expanded ? 'Collapse' : `Expand (${lineCount} lines)`}
      </button>
    {/if}
    <button
      type="button"
      class="action"
      data-testid="multiline-copy"
      onclick={handleCopy}
      aria-label="Copy text"
    >
      {copiedFlash ? 'Copied' : 'Copy'}
    </button>
  </div>
  <pre class="block" class:collapsed={canExpand && !expanded}><code
      data-lang={language ?? null}>{displayedText}</code></pre>
  {#if canExpand && !expanded}
    <div class="overflow-hint">
      … {lineCount - maxLines} more lines (Expand to view)
    </div>
  {/if}
</div>

<style>
  .multiline-code-block {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0.25rem 0;
  }
  .toolbar {
    display: flex;
    gap: 0.25rem;
    justify-content: flex-end;
  }
  .action {
    font-size: 0.7rem;
    padding: 0.125rem 0.5rem;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--schegent-border, var(--vscode-panel-border, transparent));
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .action:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
  }
  pre.block {
    margin: 0;
    padding: 0.5rem;
    background: var(--vscode-editor-background, var(--vscode-textCodeBlock-background, transparent));
    border: 1px solid var(--schegent-border, var(--vscode-panel-border, transparent));
    border-radius: 3px;
    overflow-x: auto;
    overflow-y: auto;
    max-height: 24rem;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.8rem;
    line-height: 1.4;
  }
  pre.block.collapsed {
    max-height: 12rem;
  }
  pre.block > code {
    /* Honour newlines and preserve column alignment. */
    white-space: pre;
    display: block;
  }
  .overflow-hint {
    font-size: 0.7rem;
    opacity: 0.6;
    font-style: italic;
    text-align: right;
  }
</style>
