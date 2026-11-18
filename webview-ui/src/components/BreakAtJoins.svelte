<script lang="ts">
  // A host sentence drawn as the runs `splitAtJoins` finds, with a `<wbr>` before each run after
  // the first. A setting key or a file path in it then breaks before one of its dots or slashes
  // when it is too long for its line, not at whatever letter the line ends on. A `<wbr>` adds no
  // character, so the text, what a screen reader reads and what a copy takes are the sentence as
  // the host wrote it. The runs are text, never markup.
  import { splitAtJoins } from '../lib/split-at-joins';

  interface Props {
    /** The sentence, as the host wrote it. */
    text: string;
  }
  let { text }: Props = $props();

  const runs = $derived(splitAtJoins(text));
</script>

<!-- One line, so no space is drawn between a run and the mark before it. -->
{#each runs as run, index (index)}{#if index > 0}<wbr />{/if}{run}{/each}
