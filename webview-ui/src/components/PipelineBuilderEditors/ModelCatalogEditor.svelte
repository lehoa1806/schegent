<script lang="ts">
  interface Props {
    models: string[];
    newModelInput: string;
    onnewmodelinput: (value: string) => void;
    onmodelchange: (index: number, value: string) => void;
    onadd: () => void;
    onremove: (index: number) => void;
    onsave: () => void;
  }

  const {
    models,
    newModelInput,
    onnewmodelinput,
    onmodelchange,
    onadd,
    onremove,
    onsave
  }: Props = $props();
</script>

<div class="models-container">
  <div class="toolbar" style="margin-bottom: 16px;">
    <form class="model-form" onsubmit={(event) => { event.preventDefault(); onadd(); }}>
      <input
        class="text-input flex-1"
        value={newModelInput}
        oninput={(event) => onnewmodelinput(event.currentTarget.value)}
        placeholder="e.g. claude-3-7-sonnet-20250219 or sonnet"
      />
      <button class="btn btn-primary" type="submit">Add Model</button>
    </form>
    <button class="btn btn-secondary" style="margin-left:auto" onclick={onsave}>Save Models</button>
  </div>
  <div class="models-list">
    {#if models.length === 0}
      <div class="empty-selection">No models defined.</div>
    {/if}
    {#each models as model, index (model + '-' + index)}
      <div class="model-list-item">
        <input
          class="text-input flex-1"
          value={model}
          oninput={(event) => onmodelchange(index, event.currentTarget.value)}
        />
        <button class="btn btn-destructive" style="margin-left: 12px;" onclick={() => onremove(index)}>Remove</button>
      </div>
    {/each}
  </div>
</div>
