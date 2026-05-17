<script lang="ts">
  import { hoverTextAnchor } from '../hover-text-anchor-action';
  import type {
    ControlDescription,
    HoverTextAnchor,
    HoverTextPreferredPlacement
  } from '../hover-text-types';

  interface Props {
    controlId: string;
    description: ControlDescription;
    anchor?: HoverTextAnchor;
    preferredPlacement?: HoverTextPreferredPlacement;
    disabled?: boolean;
    inputType?: 'input' | 'button';
  }

  const {
    controlId,
    description,
    anchor = 'bottom',
    preferredPlacement = 'auto',
    disabled = false,
    inputType = 'input'
  }: Props = $props();
</script>

{#if inputType === 'button'}
  <button
    type="button"
    id={controlId}
    data-testid="harness-control"
    use:hoverTextAnchor={{ controlId, description, anchor, preferredPlacement, disabled }}
  >ctrl</button>
{:else}
  <input
    id={controlId}
    type="text"
    data-testid="harness-control"
    use:hoverTextAnchor={{ controlId, description, anchor, preferredPlacement, disabled }}
  />
{/if}
