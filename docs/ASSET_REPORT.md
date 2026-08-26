# Visual asset report

> **Corrected 2026-08-26 (`FR-R3-101`, FR-029). The two images were swapped.** This report said
> `README.md` embeds `assets/logo.png` and recommended placing `assets/banner.png` after the
> heading "if a wide marketplace-style hero is desired". `README.md`'s **first line** is
> `![Schegent logo](assets/banner.png)` — it already embeds the **banner**, under alt text that
> says "logo". So the recommendation would have added a second hero above the one already there,
> and the "keep the existing square logo or remove one of the two" advice was resolving a
> duplication that did not exist yet and would have been created by following this page.

The repository currently contains three image assets in the scanned `assets/`, `public/`, and
`docs/` trees. **`README.md` embeds `assets/banner.png`** on its first line, so the banner is
intentionally excluded from the unembedded list below. `assets/logo.png` is the extension
manifest's `icon` and is not embedded in any Markdown. No `public/` image and no physical image
below `docs/` exists in the current working tree.

**One genuine defect this correction exposes**: the README's alt text reads `Schegent logo` while
the embedded file is the banner. Alt text is what a screen reader announces, so it is wrong for
its reader rather than merely inconsistent — recorded here rather than silently changed, because
the marketplace front door is `FR-R3-101` §6's out-of-scope boundary and a one-word edit to a
README's first line belongs to whoever owns that listing.

<!-- Source: assets/logo.png -->
<!-- Source: README.md -->

## Assets not embedded in Markdown

| Asset | Physical format and dimensions | Existing product use | Suggested manual placement |
|---|---|---|---|
| `assets/banner.png` | JPEG data in a `.png`-named file, 1024×538 | **Embedded as `README.md`'s first line**, under the alt text `Schegent logo`. No manifest reference. | Nothing to place — it is already the page's hero. Its alt text describes the other asset and is wrong for a screen reader; fixing that belongs with the marketplace listing (`FR-R3-101` §6). |
| `assets/sidebar-icon.svg` | SVG | Manifest icon for the `schegent` Activity Bar container and `schegent.sidebar` view. | Place under `## 1. Open the dashboard` in `docs/tutorials/user-quickstart.md` only if the goal is to teach readers which Activity Bar glyph to select; add a caption such as “Schegent Activity Bar icon.” |

<!-- Source: assets/banner.png -->
<!-- Source: assets/sidebar-icon.svg -->
<!-- Source: package.json -->
<!-- Source: docs/tutorials/user-quickstart.md -->

## Embedded asset

| Asset | Placement | Note |
|---|---|---|
| `assets/logo.png` | **Not embedded in any Markdown** — the extension manifest's `icon` only | JPEG data in a `.png`-named file, 1024×1024. |

<!-- Source: assets/logo.png -->
<!-- Source: README.md -->
<!-- Source: package.json -->

The `.png` names for the banner and logo do not match their detected JPEG encoding. That mismatch is reported rather than repaired because renaming or transcoding visual assets is outside this documentation task and would require updating manifest and Markdown references.

<!-- Source: assets/banner.png -->
<!-- Source: assets/logo.png -->
<!-- Source: package.json -->
