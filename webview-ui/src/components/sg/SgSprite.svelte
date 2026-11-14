<!--
  The dashboard's icon sprite: every symbol the two redesign mockups define, drawn once, and the
  two arrows they lack (`i-up`, `i-down`), drawn in the same stroke, for the buttons that move a
  row up or down a list.

  A call site is `<svg class="i" aria-hidden="true"><use href="#i-name" /></svg>`; `sg-core.css`
  gives `svg.i` its size and stroke, and the stroke follows the status colour of the text beside it.
  A reference is always written out whole (`#i-name`), never assembled from parts, so that
  `__tests__/SgSprite.test.ts` can check every one against the symbols below.

  The dashboard shell renders the sprite. The sidebar does not: its startup bundle has no room for
  it, so no component the sidebar loads may reference a symbol. The same test holds that rule.
-->
<script lang="ts">
  // No logic. The block makes the type checker read this component as TypeScript; without it, a
  // typed module that imports the sprite is told the import has no types.
</script>

<svg class="sprite" width="0" height="0" aria-hidden="true">
  <symbol id="i-logo" viewBox="0 0 24 24"><path d="m12 3 8 4-8 4-8-4 8-4Z" /><path d="m4 11 8 4 8-4" /><path d="m4 15 8 4 8-4" /></symbol>
  <symbol id="i-phase" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M8.6 4.5 6 8.3h3L7.4 11.5" /></symbol>
  <symbol id="i-workflow" viewBox="0 0 16 16"><rect x="1.8" y="2" width="6" height="5" rx="1.2" /><rect x="8.2" y="9" width="6" height="5" rx="1.2" /><path d="M4.8 7v4.5h3.4" /></symbol>
  <symbol id="i-queue" viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" /></symbol>
  <symbol id="i-history" viewBox="0 0 16 16"><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7" /><path d="M2.5 2.5v2.8h2.8M8 5v3.2l2 1.3" /></symbol>
  <symbol id="i-chart" viewBox="0 0 16 16"><path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V7" /></symbol>
  <symbol id="i-pulse" viewBox="0 0 16 16"><path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" /></symbol>
  <symbol id="i-build" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /><path d="M7 4.5h2.5a2 2 0 0 1 2 2V9" /></symbol>
  <symbol id="i-gear" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></symbol>
  <symbol id="i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></symbol>
  <symbol id="i-plus" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></symbol>
  <symbol id="i-minus" viewBox="0 0 16 16"><path d="M3 8h10" /></symbol>
  <symbol id="i-more" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.5" cy="8" r=".9" /></symbol>
  <symbol id="i-chev" viewBox="0 0 16 16"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></symbol>
  <symbol id="i-up" viewBox="0 0 16 16"><path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" /></symbol>
  <symbol id="i-down" viewBox="0 0 16 16"><path d="M8 3v9.5M4.5 9 8 12.5 11.5 9" /></symbol>
  <symbol id="i-right" viewBox="0 0 16 16"><path d="m6.5 4 4 4-4 4" /></symbol>
  <symbol id="i-collapse" viewBox="0 0 16 16"><path d="m9.5 4-4 4 4 4" /></symbol>
  <symbol id="i-expand" viewBox="0 0 16 16"><path d="m6.5 4 4 4-4 4" /></symbol>
  <symbol id="i-x" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></symbol>
  <symbol id="i-check" viewBox="0 0 16 16"><path d="m3 8.5 3 3 7-7" /></symbol>
  <symbol id="i-warn" viewBox="0 0 16 16"><path d="M8 2 14.5 13.5h-13Z" /><path d="M8 6.5v3M8 11.6v.1" /></symbol>
  <symbol id="i-play" viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5Z" /></symbol>
  <symbol id="i-start" viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5Z" /></symbol>
  <symbol id="i-pause" viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9" /></symbol>
  <symbol id="i-dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="currentColor" /></symbol>
  <symbol id="i-copy" viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.2" /><path d="M11 5V3.7A1.2 1.2 0 0 0 9.8 2.5H3.7a1.2 1.2 0 0 0-1.2 1.2v6.1A1.2 1.2 0 0 0 3.7 11H5" /></symbol>
  <symbol id="i-refresh" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5v2.8h-2.8" /></symbol>
  <symbol id="i-grip" viewBox="0 0 16 16"><circle cx="6" cy="4" r=".8" /><circle cx="10" cy="4" r=".8" /><circle cx="6" cy="8" r=".8" /><circle cx="10" cy="8" r=".8" /><circle cx="6" cy="12" r=".8" /><circle cx="10" cy="12" r=".8" /></symbol>
  <symbol id="i-undo" viewBox="0 0 16 16"><path d="M5.5 3 2.5 6l3 3" /><path d="M2.5 6h7a4 4 0 0 1 0 8H7" /></symbol>
  <symbol id="i-redo" viewBox="0 0 16 16"><path d="m10.5 3 3 3-3 3" /><path d="M13.5 6h-7a4 4 0 0 0 0 8H9" /></symbol>
  <symbol id="i-open" viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></symbol>
  <symbol id="i-filter" viewBox="0 0 16 16"><path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5Z" /></symbol>
  <symbol id="i-table" viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 6.5h11M2.5 10h11M6.5 6.5V13" /></symbol>
  <symbol id="i-cond" viewBox="0 0 16 16"><path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" /></symbol>
  <symbol id="i-approve" viewBox="0 0 16 16"><circle cx="6.5" cy="5" r="2.5" /><path d="M2 13c.4-2.6 2.2-4 4.5-4 1 0 1.9.2 2.6.7" /><path d="m9.5 12 1.6 1.6 3-3.2" /></symbol>
  <symbol id="i-loop" viewBox="0 0 16 16"><path d="M3 8a5 5 0 1 0 1.6-3.7" /><path d="M3 2.5v2.8h2.8" /></symbol>
  <symbol id="i-repeat" viewBox="0 0 16 16"><path d="M2.5 6.5V6a2.5 2.5 0 0 1 2.5-2.5h7.5" /><path d="m10.5 1.5 2 2-2 2" /><path d="M13.5 9.5v.5a2.5 2.5 0 0 1-2.5 2.5H3.5" /><path d="m5.5 14.5-2-2 2-2" /></symbol>
  <symbol id="i-each" viewBox="0 0 16 16"><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.6" cy="4" r=".6" /><circle cx="2.6" cy="8" r=".6" /><circle cx="2.6" cy="12" r=".6" /></symbol>
  <symbol id="i-fit" viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></symbol>
  <symbol id="i-tidy" viewBox="0 0 16 16"><rect x="5" y="1.8" width="6" height="3.4" rx="1" /><rect x="1.8" y="10.8" width="5" height="3.4" rx="1" /><rect x="9.2" y="10.8" width="5" height="3.4" rx="1" /><path d="M8 5.2v2.6M4.3 10.8V7.8h7.4v3" /></symbol>
  <symbol id="i-outline" viewBox="0 0 16 16"><path d="M2.5 3.5h4M5 8h8.5M5 12.5h8.5M2.5 3.5v9" /></symbol>
  <symbol id="i-trash" viewBox="0 0 16 16"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" /></symbol>
  <symbol id="i-swap" viewBox="0 0 16 16"><path d="M2.5 5h10l-2.5-2.5M13.5 11h-10L6 13.5" /></symbol>
  <symbol id="i-export" viewBox="0 0 16 16"><path d="M8 10V2.5M5 5.5l3-3 3 3M2.5 10v3.5h11V10" /></symbol>
  <symbol id="i-import" viewBox="0 0 16 16"><path d="M8 2.5V10M5 7l3 3 3-3M2.5 10v3.5h11V10" /></symbol>
</svg>

<style>
  .sprite {
    position: absolute;
  }
</style>
