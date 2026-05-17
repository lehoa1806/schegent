<script lang="ts">
  // Feature 029 T028 — collapsed-by-default metadata strip. Renders a
  // one-line summary of the latest value per known metadata key; an
  // expand toggle reveals the full detection list (in insertion
  // order). Latest-value-wins dedup: when the same key appears
  // multiple times, the most recent value wins.

  import type { MetadataKey, MetadataLine } from '../../../lib/activity-feed/types';

  interface Props {
    readonly lines: readonly MetadataLine[];
  }

  let { lines }: Props = $props();

  let expanded = $state(false);

  const KEY_ORDER: MetadataKey[] = [
    'cwd',
    'session_id',
    'model',
    'tools',
    'duration_ms',
    'num_turns',
    'cost',
    'other'
  ];

  type DedupResult = ReadonlyMap<MetadataKey, MetadataLine>;

  function dedup(input: readonly MetadataLine[]): DedupResult {
    const map = new Map<MetadataKey, MetadataLine>();
    for (const line of input) {
      map.set(line.key, line);
    }
    return map;
  }

  const dedupedMap = $derived(dedup(lines));

  const dedupedOrdered = $derived.by(() => {
    const out: MetadataLine[] = [];
    for (const key of KEY_ORDER) {
      const v = dedupedMap.get(key);
      if (v !== undefined) out.push(v);
    }
    // Append any unknown keys that may sneak in via the 'other' bucket.
    for (const [k, v] of dedupedMap.entries()) {
      if (!KEY_ORDER.includes(k)) out.push(v);
    }
    return out;
  });

  function toggle(): void {
    expanded = !expanded;
  }

  function displayValue(line: MetadataLine): string {
    if (line.key === 'duration_ms') return `${line.value} ms`;
    if (line.key === 'cost') return `$${line.value}`;
    return line.value;
  }
</script>

{#if lines.length > 0}
  <div
    class="metadata-strip"
    data-testid="metadata-strip"
    data-expanded={expanded ? 'true' : 'false'}
  >
    <button
      type="button"
      class="toggle"
      data-testid="metadata-strip-toggle"
      aria-expanded={expanded}
      onclick={toggle}
    >
      <span class="caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span class="summary">
        {#each dedupedOrdered as line (line.key)}
          <span class="kv">
            <span class="k">{line.rawKey}</span>
            <span class="eq">=</span>
            <span class="v">{displayValue(line)}</span>
          </span>
        {/each}
      </span>
    </button>
    {#if expanded}
      <ul class="expanded-list" data-testid="metadata-strip-expanded">
        {#each lines as line, idx (idx)}
          <li class="row">
            <span class="k">{line.rawKey}</span>
            <span class="eq">=</span>
            <span class="v">{line.value}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .metadata-strip {
    border: 1px solid var(--schegent-border, var(--vscode-panel-border, transparent));
    border-radius: 3px;
    background: var(--vscode-editorWidget-background, transparent);
    padding: 0.125rem 0.25rem;
    font-size: 0.75rem;
    position: sticky;
    top: 0;
    z-index: 1;
    overflow: hidden;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    background: transparent;
    color: inherit;
    border: none;
    padding: 0.125rem 0.25rem;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .caret {
    flex-shrink: 0;
    opacity: 0.7;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }
  .kv {
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
  }
  .kv .k {
    opacity: 0.7;
  }
  .kv .eq {
    opacity: 0.5;
  }
  .expanded-list {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0.25rem;
    border-top: 1px solid var(--schegent-border, var(--vscode-panel-border, transparent));
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .row {
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-word;
  }
</style>
