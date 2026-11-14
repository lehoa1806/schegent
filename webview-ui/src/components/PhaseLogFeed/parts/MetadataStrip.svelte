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

<!-- Drawn in the redesign's quiet caption type above the log: one line of key = value pairs that
     wraps, the key and the equals sign muted, and a chevron that turns as the full list opens. -->
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
      <svg class="i caret" aria-hidden="true"><use href="#i-right"></use></svg>
      <span class="summary">
        {#each dedupedOrdered as line (line.key)}
          <span class="pair">
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
  /* Sticky at the top of the log's column, so the session's facts stay in view as it scrolls. */
  .metadata-strip {
    position: sticky;
    top: 0;
    z-index: 1;
    overflow: hidden;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius-sm);
    background: var(--schegent-surface);
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-caption);
  }
  .toggle {
    display: flex;
    align-items: flex-start;
    gap: var(--schegent-space-1-5);
    width: 100%;
    padding: var(--schegent-space-1) var(--schegent-space-2);
    border: 0;
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .toggle:hover {
    background: var(--schegent-list-hover);
  }
  /* The strip clips its overflow, so the ring sits inside the toggle. */
  .toggle:focus-visible {
    outline-offset: -2px;
  }
  .toggle .caret {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    color: var(--schegent-muted-fg);
    transition: transform var(--schegent-duration-base) var(--schegent-ease-out);
  }
  .metadata-strip[data-expanded='true'] .caret {
    transform: rotate(90deg);
  }
  .summary {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: var(--schegent-space-0-5) var(--schegent-space-3);
    min-width: 0;
  }
  .pair,
  .row {
    overflow-wrap: anywhere;
  }
  .k,
  .eq {
    color: var(--schegent-muted-fg);
  }
  .expanded-list {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-0-5);
    margin: 0;
    padding: var(--schegent-space-1-5) var(--schegent-space-2) var(--schegent-space-2);
    border-top: 1px solid var(--schegent-border);
    list-style: none;
  }
</style>
