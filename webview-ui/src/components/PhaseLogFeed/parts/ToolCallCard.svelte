<script lang="ts">
  // Feature 029 T016 — render a single `tool-use` phase-log entry as a
  // distinct card with a labelled header and a key-value list of
  // arguments. Multi-line values are rendered inside a
  // `<MultiLineCodeBlock>`. The card is pure: no IPC, no clipboard
  // side effects beyond what `MultiLineCodeBlock` already exposes.
  //
  // The host has already sanitized all string leaves at the IPC
  // boundary; this component renders the typed payload as text only
  // (no `{@html}`, no innerHTML, no decoded entities).

  import type { PhaseLogDisplayEntry } from '../../../../../src/services/phase-log/types';
  import type {
    ArgValueClassification,
    ParsedToolArgument,
    ToolArgumentValue
  } from '../../../lib/activity-feed/types';
  import { parseToolArguments } from '../../../lib/activity-feed/parse-tool-arguments';
  import MultiLineCodeBlock from './MultiLineCodeBlock.svelte';

  interface Props {
    readonly entry: PhaseLogDisplayEntry;
  }

  let { entry }: Props = $props();

  const result = $derived(parseToolArguments(entry));
  const toolName = $derived(entry.body.toolName ?? '(tool)');

  // Surface host-side truncation pill. The host writes
  // `body.bodyTruncated.toolArguments.originalLength` when the typed
  // payload was over the per-field byte budget.
  const argsTruncatedBytes = $derived(
    entry.bodyTruncated?.toolArguments?.originalLength ?? null
  );

  // Surface elision/truncation sentinels stored inside the payload.
  // The host replaces the toolArguments value with these sentinels
  // when the typed payload was over budget or recursion depth was
  // exceeded; we render a small explanatory pill.
  function isSentinel(value: ToolArgumentValue): null | 'elided' | 'truncated' {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as any).__elided === true
    ) {
      return 'elided';
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as any).__truncated === true
    ) {
      return 'truncated';
    }
    return null;
  }

  function arrayItemLabel(arg: ParsedToolArgument): string {
    if (arg.classification.kind === 'scalar') return arg.classification.display;
    return `[${arg.key}]`;
  }
</script>

<article
  class="tool-call-card"
  data-testid="tool-call-card"
  data-tool={toolName}
>
  <header class="card-header">
    <span class="tool-name">{toolName}</span>
    {#if argsTruncatedBytes !== null}
      <span class="pill pill-truncated">
        truncated · original {argsTruncatedBytes} bytes
      </span>
    {/if}
  </header>

  {#if result.ok}
    {#if result.args.length === 0}
      <div class="empty">No arguments</div>
    {:else}
      <dl class="args-list">
        {#each result.args as arg (arg.key)}
          {@const sentinel = isSentinel(arg.value)}
          <dt class="arg-key">{arg.key}</dt>
          <dd class="arg-val">
            {#if sentinel === 'elided'}
              <span class="pill pill-elided">… elided (depth limit reached)</span>
            {:else if sentinel === 'truncated'}
              <span class="pill pill-truncated">… truncated (byte cap)</span>
            {:else if arg.classification.kind === 'scalar'}
              <span class="scalar-value">{arg.classification.display}</span>
            {:else if arg.classification.kind === 'multiline'}
              <MultiLineCodeBlock
                text={arg.classification.text}
                language={arg.classification.language}
              />
            {:else if arg.classification.kind === 'object'}
              <dl class="nested-list">
                {#each arg.classification.children as child (child.key)}
                  <dt class="arg-key nested">{child.key}</dt>
                  <dd class="arg-val nested">
                    {#if child.classification.kind === 'scalar'}
                      <span class="scalar-value">{child.classification.display}</span>
                    {:else if child.classification.kind === 'multiline'}
                      <MultiLineCodeBlock
                        text={child.classification.text}
                        language={child.classification.language}
                      />
                    {:else}
                      <MultiLineCodeBlock
                        text={JSON.stringify(child.value, null, 2)}
                      />
                    {/if}
                  </dd>
                {/each}
              </dl>
            {:else if arg.classification.kind === 'array'}
              <ul class="array-list">
                {#each arg.classification.items as item (item.key)}
                  <li class="array-item">
                    {#if item.classification.kind === 'scalar'}
                      <span class="scalar-value">{arrayItemLabel(item)}</span>
                    {:else if item.classification.kind === 'multiline'}
                      <MultiLineCodeBlock
                        text={item.classification.text}
                        language={item.classification.language}
                      />
                    {:else}
                      <MultiLineCodeBlock
                        text={JSON.stringify(item.value, null, 2)}
                      />
                    {/if}
                  </li>
                {/each}
                {#if arg.classification.truncatedAt !== undefined}
                  <li class="array-more">
                    … +{arg.classification.truncatedAt - arg.classification.items.length} more
                  </li>
                {/if}
              </ul>
            {/if}
          </dd>
        {/each}
      </dl>
    {/if}
  {:else}
    <div class="fallback">
      <span class="pill pill-fallback">could not parse — showing raw</span>
      <MultiLineCodeBlock text={result.rawText} />
    </div>
  {/if}
</article>

<style>
  .tool-call-card {
    border: 1px solid var(--schegent-border, var(--vscode-panel-border, transparent));
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    background: var(--vscode-editorWidget-background, transparent);
    margin: 0.25rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .tool-name {
    font-weight: 600;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9rem;
  }
  .pill {
    font-size: 0.7rem;
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    font-style: italic;
    opacity: 0.85;
    border: 1px solid var(--schegent-border, var(--vscode-panel-border, transparent));
  }
  .pill-truncated {
    background: var(--vscode-inputValidation-warningBackground, transparent);
  }
  .pill-fallback {
    background: var(--vscode-inputValidation-errorBackground, transparent);
  }
  .pill-elided {
    background: var(--vscode-inputValidation-infoBackground, transparent);
  }
  .args-list,
  .nested-list {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }
  .args-list dt,
  .nested-list dt {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.8rem;
    opacity: 0.85;
    align-self: start;
  }
  .args-list dd,
  .nested-list dd {
    margin: 0;
    font-size: 0.85rem;
    word-break: break-word;
    min-width: 0;
  }
  .nested-list {
    padding: 0.375rem 0.5rem;
    border-radius: var(--schegent-radius-sm, 4px);
    background: var(--schegent-surface-subtle, var(--vscode-list-hoverBackground, transparent));
    margin-top: 0.125rem;
  }
  .array-list {
    list-style: disc;
    margin: 0;
    padding-left: 1.25rem;
  }
  .array-item {
    font-size: 0.85rem;
  }
  .array-more {
    list-style: none;
    font-style: italic;
    opacity: 0.7;
    font-size: 0.75rem;
  }
  .empty {
    font-style: italic;
    opacity: 0.6;
    font-size: 0.8rem;
  }
  .scalar-value {
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .fallback {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
</style>
