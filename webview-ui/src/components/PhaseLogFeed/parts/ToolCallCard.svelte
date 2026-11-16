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

<!-- Drawn as one line of the redesign's log ("Read specs/…"): the tool's name, then its arguments
     as key and value pairs that wrap. An argument that is a block (several lines, an object, a
     list) takes lines of its own under its key. -->
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
      <div class="no-args">No arguments</div>
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
  .tool-call-card,
  .card-header,
  .args-list {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--schegent-space-1-5);
    min-width: 0;
  }
  .args-list {
    flex: 1 1 0;
    margin: 0;
  }
  .pill {
    font-size: var(--schegent-text-caption);
    font-style: italic;
  }
  .pill-truncated {
    color: var(--schegent-status-warning-text);
  }
  .pill-fallback {
    color: var(--schegent-error-text);
  }
  .pill-elided,
  .no-args,
  .array-more {
    color: var(--schegent-muted-fg);
  }
  .arg-key {
    color: var(--schegent-muted-fg);
  }
  .arg-val {
    margin: 0 var(--schegent-space-1-5) 0 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* A block argument: its key ends the line, and the block fills the next. */
  .args-list > .arg-key:has(+ .arg-val > :global(.multiline-code-block), + .arg-val > .nested-list, + .arg-val > .array-list),
  .args-list > .arg-val:has(> :global(.multiline-code-block), > .nested-list, > .array-list) {
    flex-basis: 100%;
  }
  .nested-list {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0 var(--schegent-space-2);
    margin: 0;
    padding-left: var(--schegent-space-2-5);
    border-left: 1px solid var(--schegent-border);
  }
  .nested-list > .arg-val {
    margin: 0;
  }
  .array-list {
    margin: 0;
    padding-left: var(--schegent-space-4);
  }
  .array-more {
    list-style: none;
  }
  .fallback {
    display: flex;
    flex-direction: column;
    flex-basis: 100%;
    gap: var(--schegent-space-1);
  }
</style>
